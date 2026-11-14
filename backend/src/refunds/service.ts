import { randomUUID } from "node:crypto";
import type { Selectable, Transaction } from "kysely";
import { recordAudit } from "../audit.js";
import type { Database, Db } from "../db/index.js";
import { AppError, badRequest, conflict, notFound } from "../errors.js";
import { ensureAccount, post } from "../ledger/service.js";
import { naira } from "../notifications/catalog.js";
import { notifyUser } from "../notifications/service.js";
import { isRefusal, type PaystackClient, type RefundResult } from "../payments/paystack.js";
import { paidByMember } from "../pots/money.js";
import { authorizePot } from "../auth/pot-access.js";
import { lockPot, type Actor } from "../pots/service.js";
import { accountLookupError, listBanks } from "../payouts/service.js";

export type RefundRow = Selectable<Database["refunds"]>;
export type RefundReason = "pot_cancelled" | "member_left" | "member_removed" | "leftover";

/** A request to Paystack whose answer never came is checked again after this long. */
const REQUEST_LEASE_MINUTES = 10;
const MINUTE = 60_000;

const REASON_TEXT: Record<RefundReason, string> = {
  pot_cancelled: "the pot was cancelled",
  member_left: "they left the pot",
  member_removed: "they were removed from the pot",
  leftover: "money was left over",
};

/**
 * Splits an amount in proportion to what each person paid (MON-17), to the
 * kobo, so the parts add up exactly. Leftover kobo from rounding go to the
 * largest remainders, ties broken by user id, so the split is the same every time.
 */
export function allocateProRata(totalKobo: number, paid: Map<string, number>): Map<string, number> {
  const entries = [...paid.entries()].filter(([, p]) => p > 0).sort(([a], [b]) => a.localeCompare(b));
  const weight = entries.reduce((s, [, p]) => s + p, 0);
  const out = new Map<string, number>();
  if (weight === 0 || totalKobo <= 0) return out;
  const parts = entries.map(([user, p]) => {
    const exact = (totalKobo * p) / weight;
    return { user, base: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let left = totalKobo - parts.reduce((s, p) => s + p.base, 0);
  for (const p of [...parts].sort((a, b) => b.remainder - a.remainder || a.user.localeCompare(b.user))) {
    if (left <= 0) break;
    p.base++;
    left--;
  }
  for (const p of parts) if (p.base > 0) out.set(p.user, p.base);
  return out;
}

/**
 * Sets money aside to refund a member, against the payments it came from,
 * newest first. Never more than each payment's share: the fee isn't refunded
 * (and the database checks this at commit). Paystack is asked afterwards, by
 * requestRefund, outside this transaction.
 */
export async function refundMember(
  trx: Transaction<Database>,
  input: { potId: string; userId: string; amountKobo: number; reason: RefundReason; settlementId?: string },
): Promise<string[]> {
  if (input.amountKobo <= 0) return [];
  const payments = await trx
    .selectFrom("payments as p")
    .select((eb) => [
      "p.id",
      "p.share_kobo",
      eb
        .selectFrom("refunds as r")
        .select((inner) => inner.fn.coalesce(inner.fn.sum<number>("r.amount_kobo"), inner.lit(0)).as("s"))
        .whereRef("r.payment_id", "=", "p.id")
        .where("r.status", "<>", "failed")
        .as("refunded"),
    ])
    .where("p.user_id", "=", input.userId)
    .where("p.status", "=", "succeeded")
    // Money a member rolled in from another pot is refunded against the
    // payment it originally came from, in that other pot.
    .where((eb) =>
      eb.or([
        eb("p.pot_id", "=", input.potId),
        eb(
          "p.pot_id",
          "in",
          eb
            .selectFrom("rollovers as ro")
            .innerJoin("rollover_choices as rc", "rc.rollover_id", "ro.id")
            .select("ro.from_pot_id")
            .where("ro.to_pot_id", "=", input.potId)
            .where("rc.user_id", "=", input.userId)
            .where("rc.choice", "=", "move"),
        ),
      ]),
    )
    .orderBy("p.paid_at", "desc")
    // Two payments confirmed in the same millisecond still come out in a fixed order.
    .orderBy("p.created_at", "desc")
    .execute();

  const member = await trx.selectFrom("users").select("full_name").where("id", "=", input.userId).executeTakeFirstOrThrow();
  const ids: string[] = [];
  let left = input.amountKobo;
  for (const p of payments) {
    if (left <= 0) break;
    const room = p.share_kobo - Number(p.refunded ?? 0);
    const amount = Math.min(room, left);
    if (amount <= 0) continue;
    const refundId = randomUUID();
    const reserveTxnId = await post(trx, {
      kind: "refund",
      potId: input.potId,
      memberUserId: input.userId,
      idempotencyKey: `refund:${refundId}:reserve`,
      description: `${naira(amount)} being refunded to ${member.full_name ?? "a member"} because ${REASON_TEXT[input.reason]}`,
      metadata: { paymentId: p.id, reason: input.reason },
      entries: [
        { accountId: await ensureAccount(trx, "pot_available", input.potId), amountKobo: -amount },
        { accountId: await ensureAccount(trx, "pot_reserved", input.potId), amountKobo: amount },
      ],
    });
    const { id } = await trx
      .insertInto("refunds")
      .values({
        id: refundId,
        pot_id: input.potId,
        user_id: input.userId,
        payment_id: p.id,
        amount_kobo: amount,
        reason: input.reason,
        settlement_id: input.settlementId ?? null,
        reserve_txn_id: reserveTxnId,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    ids.push(id);
    left -= amount;
  }
  if (left > 0) throw new Error(`could not find ${left} kobo of refundable payments for member ${input.userId}`);
  await notifyUser(trx, input.userId, input.potId, "refund_started", { amountKobo: input.amountKobo, reason: input.reason });
  return ids;
}

/** Refunds everyone in proportion to what they paid, from what the pot has available. */
export async function refundAllProRata(
  trx: Transaction<Database>,
  potId: string,
  reason: RefundReason,
  settlementId?: string,
): Promise<{ totalKobo: number; refundIds: string[] }> {
  const available = await trx
    .selectFrom("ledger_account_balances")
    .select("balance_kobo")
    .where("pot_id", "=", potId)
    .where("kind", "=", "pot_available")
    .executeTakeFirst();
  const total = available?.balance_kobo ?? 0;
  const paid = (await paidByMember(trx, [potId])).get(potId) ?? new Map();
  const refundIds: string[] = [];
  for (const [userId, amount] of allocateProRata(total, paid)) {
    refundIds.push(...(await refundMember(trx, { potId, userId, amountKobo: amount, reason, settlementId })));
  }
  return { totalKobo: total, refundIds };
}

// ─────────────────────────────────────────────
// Asking Paystack, and hearing back
// ─────────────────────────────────────────────

const merchantNote = (refundId: string) => `DettyPot refund ${refundId}`;

/**
 * Asks Paystack to refund one reserved refund. Paystack refunds carry no
 * idempotency key, so a request whose answer was lost is never simply sent
 * again: first we look for a refund carrying this refund's note, and adopt it.
 */
export async function requestRefund(db: Db, paystack: PaystackClient, refundId: string): Promise<string> {
  const leaseCutoff = new Date(Date.now() - REQUEST_LEASE_MINUTES * MINUTE);
  const before = await db.selectFrom("refunds").select("requested_at").where("id", "=", refundId).executeTakeFirst();
  const claimed = await db
    .updateTable("refunds")
    .set({ requested_at: new Date() })
    .where("id", "=", refundId)
    .where("status", "=", "reserved")
    .where((eb) => eb.or([eb("requested_at", "is", null), eb("requested_at", "<=", leaseCutoff)]))
    .returningAll()
    .executeTakeFirst();
  if (!claimed) return "not_due";
  const payment = await db.selectFrom("payments").select("reference").where("id", "=", claimed.payment_id).executeTakeFirstOrThrow();

  let result: RefundResult | undefined;
  try {
    if (before?.requested_at) {
      // An earlier attempt got no answer: did Paystack create it anyway?
      const recent = await paystack.listRefundsSince(new Date(before.requested_at.getTime() - 5 * MINUTE));
      result = recent.find((r) => r.merchantNote === merchantNote(refundId));
    }
    result ??= await paystack.createRefund({
      transactionReference: payment.reference,
      amountKobo: claimed.amount_kobo,
      merchantNote: merchantNote(refundId),
    });
  } catch (err) {
    if (isRefusal(err)) {
      await db.transaction().execute((trx) => failRefund(trx, refundId, `Paystack refused the refund: ${err.message}`));
      return "failed";
    }
    return "unknown"; // checked again once the lease runs out
  }

  await db
    .updateTable("refunds")
    .set({ status: "requested", provider_refund_id: result.id, provider_status: result.status })
    .where("id", "=", refundId)
    .where("status", "=", "reserved")
    .execute();
  return applyRefundStatus(db, refundId, result);
}

/** What Paystack's view of a refund means for ours. Always called with Paystack's latest answer. */
async function applyRefundStatus(db: Db, refundId: string, result: RefundResult): Promise<string> {
  return db.transaction().execute(async (trx) => {
    const refund = await trx.selectFrom("refunds").selectAll().where("id", "=", refundId).forUpdate().executeTakeFirstOrThrow();
    if (refund.status === "processed" || refund.status === "failed") return refund.status;
    await trx.updateTable("refunds").set({ provider_status: result.status }).where("id", "=", refundId).execute();

    if (result.status === "processed") {
      const member = await trx.selectFrom("users").select("full_name").where("id", "=", refund.user_id).executeTakeFirstOrThrow();
      const settleTxnId = await post(trx, {
        kind: "refund",
        potId: refund.pot_id,
        memberUserId: refund.user_id,
        idempotencyKey: `refund:${refund.id}:settle`,
        description: `Refunded ${naira(refund.amount_kobo)} to ${member.full_name ?? "a member"}`,
        metadata: { refundId: refund.id, providerRefundId: result.id },
        entries: [
          { accountId: await ensureAccount(trx, "pot_reserved", refund.pot_id), amountKobo: -refund.amount_kobo },
          { accountId: await ensureAccount(trx, "external"), amountKobo: refund.amount_kobo },
        ],
      });
      // If Paystack takes more than the refund itself, DettyPot pays the difference.
      const extra = (result.deductedKobo ?? refund.amount_kobo) - refund.amount_kobo;
      if (extra > 0) {
        await post(trx, {
          kind: "fee",
          potId: refund.pot_id,
          idempotencyKey: `refund:${refund.id}:fee`,
          description: `DettyPot paid ${naira(extra)} in refund charges`,
          metadata: { refundId: refund.id },
          entries: [
            { accountId: await ensureAccount(trx, "platform_revenue"), amountKobo: -extra },
            { accountId: await ensureAccount(trx, "platform_expense"), amountKobo: extra },
          ],
        });
      }
      await trx
        .updateTable("refunds")
        .set({ status: "processed", settle_txn_id: settleTxnId, provider_deducted_kobo: result.deductedKobo, completed_at: new Date() })
        .where("id", "=", refund.id)
        .execute();
      await notifyUser(trx, refund.user_id, refund.pot_id, "refund_processed", { amountKobo: refund.amount_kobo });
      await recordAudit(trx, { actorUserId: null, action: "refund.processed", potId: refund.pot_id, subjectType: "refund", subjectId: refund.id });
      return "processed";
    }

    if (result.status === "failed") {
      await failRefund(trx, refund.id, "Paystack couldn't complete the refund");
      return "failed";
    }

    if (result.status === "needs-attention" && refund.status !== "needs_details") {
      await trx.updateTable("refunds").set({ status: "needs_details" }).where("id", "=", refund.id).execute();
      await notifyUser(trx, refund.user_id, refund.pot_id, "refund_needs_details", { amountKobo: refund.amount_kobo, refundId: refund.id });
      return "needs_details";
    }
    return refund.status;
  });
}

/** Puts the money back in the pot and flags the refund for support. */
async function failRefund(trx: Transaction<Database>, refundId: string, reason: string) {
  const refund = await trx.selectFrom("refunds").selectAll().where("id", "=", refundId).forUpdate().executeTakeFirstOrThrow();
  if (refund.status === "processed" || refund.status === "failed") return;
  const releaseTxnId = await post(trx, {
    kind: "refund",
    potId: refund.pot_id,
    memberUserId: refund.user_id,
    idempotencyKey: `refund:${refund.id}:release`,
    description: `A ${naira(refund.amount_kobo)} refund didn't go through; the money is back in the pot`,
    metadata: { refundId: refund.id, reason },
    entries: [
      { accountId: await ensureAccount(trx, "pot_reserved", refund.pot_id), amountKobo: -refund.amount_kobo },
      { accountId: await ensureAccount(trx, "pot_available", refund.pot_id), amountKobo: refund.amount_kobo },
    ],
  });
  await trx
    .updateTable("refunds")
    .set({ status: "failed", release_txn_id: releaseTxnId, failure_reason: reason.slice(0, 500), completed_at: new Date() })
    .where("id", "=", refund.id)
    .execute();
  await notifyUser(trx, refund.user_id, refund.pot_id, "refund_failed", { amountKobo: refund.amount_kobo });
  await recordAudit(trx, { actorUserId: null, action: "refund.failed", potId: refund.pot_id, subjectType: "refund", subjectId: refund.id, metadata: { reason } });
}

/** Paystack told us (by webhook) a refund for a payment changed: find ours and check with Paystack. */
export async function checkRefundsForPayment(db: Db, paystack: PaystackClient, transactionReference: string): Promise<number> {
  const open = await db
    .selectFrom("refunds as r")
    .innerJoin("payments as p", "p.id", "r.payment_id")
    .select(["r.id", "r.provider_refund_id"])
    .where("p.reference", "=", transactionReference)
    .where("r.status", "in", ["requested", "needs_details"])
    .execute();
  for (const r of open) {
    if (r.provider_refund_id !== null) await applyRefundStatus(db, r.id, await paystack.fetchRefund(Number(r.provider_refund_id)));
  }
  return open.length;
}

/** The worker's job: ask Paystack for reserved refunds, and check on requested ones. */
export async function progressRefunds(db: Db, paystack: PaystackClient) {
  const stats = { requested: 0, checked: 0 };
  const reserved = await db.selectFrom("refunds").select("id").where("status", "=", "reserved").execute();
  for (const r of reserved) {
    if ((await requestRefund(db, paystack, r.id)) !== "not_due") stats.requested++;
  }
  const open = await db.selectFrom("refunds").select(["id", "provider_refund_id"]).where("status", "in", ["requested", "needs_details"]).execute();
  for (const r of open) {
    if (r.provider_refund_id === null) continue;
    try {
      await applyRefundStatus(db, r.id, await paystack.fetchRefund(Number(r.provider_refund_id)));
      stats.checked++;
    } catch {
      // Paystack unreachable: try again next time.
    }
  }
  return stats;
}

// ─────────────────────────────────────────────
// The member's side
// ─────────────────────────────────────────────

export async function myRefunds(db: Db, user: Actor["user"]) {
  return db
    .selectFrom("refunds as r")
    .innerJoin("pots as p", "p.id", "r.pot_id")
    .select(["r.id", "r.pot_id", "p.name as pot_name", "r.amount_kobo", "r.reason", "r.status", "r.created_at", "r.completed_at"])
    .where("r.user_id", "=", user.id)
    .orderBy("r.created_at", "desc")
    .limit(100)
    .execute();
}

/**
 * When Paystack can't send a refund back on its own (common for bank
 * transfers), the member tells us where to send it. The bank confirms the
 * account exists before we pass it on.
 */
export async function provideRefundAccount(
  db: Db,
  paystack: PaystackClient | null,
  actor: Actor,
  refundId: string,
  input: { bankCode: string; accountNumber: string },
): Promise<{ status: string; accountName: string }> {
  if (!paystack) throw new AppError(503, "PAYMENTS_UNAVAILABLE", "Refunds aren't available right now");
  const refund = await db.selectFrom("refunds").selectAll().where("id", "=", refundId).executeTakeFirst();
  if (!refund || refund.user_id !== actor.user.id) throw notFound("Refund not found");
  if (refund.status !== "needs_details" || refund.provider_refund_id === null) {
    throw conflict("DETAILS_NOT_NEEDED", "This refund doesn't need your bank details");
  }
  const bank = (await listBanks(paystack)).find((b) => b.code === input.bankCode);
  if (!bank) throw badRequest("UNKNOWN_BANK", "That bank isn't on the list");
  let accountName: string;
  try {
    accountName = (await paystack.resolveAccount(input.accountNumber, input.bankCode)).accountName;
  } catch (err) {
    throw accountLookupError(err);
  }
  const result = await paystack.retryRefundWithAccount(Number(refund.provider_refund_id), { accountNumber: input.accountNumber, bankId: bank.id });
  await db
    .updateTable("refunds")
    .set({ status: "requested", refund_bank_code: input.bankCode, refund_account_last4: input.accountNumber.slice(-4) })
    .where("id", "=", refundId)
    .where("status", "=", "needs_details")
    .execute();
  await recordAudit(db, {
    actorUserId: actor.user.id,
    action: "refund.account_provided",
    potId: refund.pot_id,
    subjectType: "refund",
    subjectId: refundId,
    requestId: actor.requestId,
    metadata: { bankCode: input.bankCode, accountLast4: input.accountNumber.slice(-4) },
  });
  return { status: await applyRefundStatus(db, refundId, result), accountName };
}

// ─────────────────────────────────────────────
// Settling up after the outing (MON-17)
// ─────────────────────────────────────────────

const PAYOUTS_IN_FLIGHT = ["waiting", "flagged", "ready", "sending", "needs_attention"];

export async function payoutsInFlight(db: Db, potId: string): Promise<boolean> {
  const row = await db.selectFrom("payouts").select("id").where("pot_id", "=", potId).where("status", "in", PAYOUTS_IN_FLIGHT).executeTakeFirst();
  return Boolean(row);
}

/** The organiser returns what's left, in proportion to what each person paid. */
export async function settleLeftover(db: Db, actor: Actor, potId: string) {
  return db.transaction().execute(async (trx) => {
    await authorizePot(trx, actor.user, potId, "pot.settle");
    const pot = await lockPot(trx, potId);
    if (!["confirmed", "completed"].includes(pot.stage)) {
      throw conflict("NOT_READY_TO_SETTLE", "Leftover money is settled once the outing is confirmed");
    }
    if (await payoutsInFlight(trx, potId)) {
      throw conflict("PAYOUTS_IN_PROGRESS", "Finish or cancel the payouts in progress first");
    }
    const available = await trx
      .selectFrom("ledger_account_balances")
      .select("balance_kobo")
      .where("pot_id", "=", potId)
      .where("kind", "=", "pot_available")
      .executeTakeFirst();
    const leftover = available?.balance_kobo ?? 0;
    if (leftover <= 0) throw conflict("NOTHING_LEFT", "There's no money left in the pot to settle");

    const settlement = await trx
      .insertInto("settlements")
      .values({ pot_id: potId, mode: "refund", leftover_kobo: leftover, created_by: actor.user.id })
      .returningAll()
      .executeTakeFirstOrThrow();
    const { refundIds } = await refundAllProRata(trx, potId, "leftover", settlement.id);
    await recordAudit(trx, {
      actorUserId: actor.user.id,
      action: "pot.settled",
      potId,
      subjectType: "settlement",
      subjectId: settlement.id,
      requestId: actor.requestId,
      metadata: { leftoverKobo: leftover, refunds: refundIds.length },
    });
    return { settlementId: settlement.id, leftoverKobo: leftover, refundIds };
  });
}

/** Asks Paystack for refunds just created, best effort; the worker picks up anything left. */
export async function startRefunds(db: Db, paystack: PaystackClient | null, refundIds: string[]) {
  if (!paystack) return;
  for (const id of refundIds) {
    await requestRefund(db, paystack, id).catch(() => undefined);
  }
}
