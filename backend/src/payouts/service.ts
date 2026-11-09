import { randomUUID } from "node:crypto";
import type { Selectable, Transaction } from "kysely";
import { majorityOf, resolveIfDecided } from "../approvals/service.js";
import { recordAudit } from "../audit.js";
import { authorizePot } from "../auth/pot-access.js";
import type { Database, Db } from "../db/index.js";
import { AppError, badRequest, conflict, notFound } from "../errors.js";
import { ensureAccount, post } from "../ledger/service.js";
import { naira } from "../notifications/catalog.js";
import { notifyPotMembers, notifyUser } from "../notifications/service.js";
import { paidByMember, totalRaised } from "../pots/money.js";
import { lockPot, type Actor } from "../pots/service.js";
import { newReference } from "../payments/service.js";
import { PaystackError, TRANSFER_FAILED_STATUSES, type Bank, type PaystackClient, type TransferResult } from "../payments/paystack.js";

export type PayoutRow = Selectable<Database["payouts"]>;

/** MON-14: payouts to a new account, or this large, wait before they're sent. */
export const HOLD_HOURS = 24;
export const LARGE_PAYOUT_KOBO = 500_000 * 100;
export const LARGE_SHARE_OF_POT = 0.5;
/** MON-13: how long contributors have to approve a payout. */
export const PAYOUT_APPROVAL_HOURS = 48;
export const MIN_PAYOUT_KOBO = 100 * 100;
/** Payouts happen once the money is in: never while a pot is still collecting. */
const PAYOUT_STAGES = ["funded", "confirmed"];
/** A transfer whose result we haven't heard is checked with Paystack after this long. */
export const SENDING_CHECK_MINUTES = 10;

const ORGANISERS = ["organiser", "co_organiser"] as const;
const paymentsUnavailable = () =>
  new AppError(503, "PAYMENTS_UNAVAILABLE", "Payouts aren't available right now. Please try again later.");

// ─────────────────────────────────────────────
// Banks and account names
// ─────────────────────────────────────────────

let bankCache: { banks: Bank[]; at: number } | null = null;
const BANK_CACHE_MS = 24 * 3600 * 1000;

export async function listBanks(paystack: PaystackClient | null): Promise<Bank[]> {
  if (!paystack) throw paymentsUnavailable();
  if (!bankCache || Date.now() - bankCache.at > BANK_CACHE_MS) {
    bankCache = { banks: (await paystack.listBanks()).sort((a, b) => a.name.localeCompare(b.name)), at: Date.now() };
  }
  return bankCache.banks;
}

/** For tests: forget the cached bank list. */
export const clearBankCache = () => (bankCache = null);

async function bankName(paystack: PaystackClient, code: string): Promise<string> {
  const bank = (await listBanks(paystack)).find((b) => b.code === code);
  if (!bank) throw badRequest("UNKNOWN_BANK", "That bank isn't on the list");
  return bank.name;
}

/** MON-11: the account name always comes from the bank's own lookup. */
export async function resolvePayoutAccount(
  db: Db,
  paystack: PaystackClient | null,
  actor: Actor,
  potId: string,
  input: { bankCode: string; accountNumber: string },
) {
  if (!paystack) throw paymentsUnavailable();
  await authorizePot(db, actor.user, potId, "payout.request");
  const bank = await bankName(paystack, input.bankCode);
  try {
    const resolved = await paystack.resolveAccount(input.accountNumber, input.bankCode);
    return { bankCode: input.bankCode, bankName: bank, accountNumber: resolved.accountNumber, accountName: resolved.accountName };
  } catch (err) {
    if (err instanceof PaystackError && err.httpStatus !== null && err.httpStatus < 500) {
      throw badRequest("ACCOUNT_NOT_FOUND", "We couldn't find that account. Check the bank and account number.");
    }
    throw new AppError(502, "PAYMENT_PROVIDER_ERROR", "We couldn't check that account right now. Please try again.");
  }
}

// ─────────────────────────────────────────────
// Requesting a payout
// ─────────────────────────────────────────────

const potBalance = async (db: Db, potId: string, kind: "pot_available" | "pot_reserved") => {
  const row = await db
    .selectFrom("ledger_account_balances")
    .select("balance_kobo")
    .where("pot_id", "=", potId)
    .where("kind", "=", kind)
    .executeTakeFirst();
  return row?.balance_kobo ?? 0;
};

const describeAccount = (a: { account_name: string; bank_name: string }) => `${a.account_name} (${a.bank_name})`;

/**
 * MON-09/10: only the organiser, only up to what's available after earlier and
 * pending payouts. The payout is recorded and its money reserved in the same
 * transaction, before anything is sent, so two requests can't both pass.
 */
export async function requestPayout(
  db: Db,
  paystack: PaystackClient | null,
  actor: Actor,
  potId: string,
  input: { bankCode: string; accountNumber: string; amountKobo: number; narration?: string },
): Promise<PayoutRow> {
  if (!paystack) throw paymentsUnavailable();
  await authorizePot(db, actor.user, potId, "payout.request");
  if (input.amountKobo % 100 !== 0) throw badRequest("WHOLE_NAIRA", "Pay out a whole naira amount");
  if (input.amountKobo < MIN_PAYOUT_KOBO) throw badRequest("AMOUNT_TOO_SMALL", `Pay out at least ${naira(MIN_PAYOUT_KOBO)}`);

  // Network calls happen before any lock is taken.
  const account = await resolvePayoutAccount(db, paystack, actor, potId, input);
  let saved = await db
    .selectFrom("bank_accounts")
    .selectAll()
    .where("created_by", "=", actor.user.id)
    .where("bank_code", "=", account.bankCode)
    .where("account_number", "=", account.accountNumber)
    .executeTakeFirst();
  if (!saved || saved.account_name !== account.accountName || !saved.provider_recipient_code) {
    const recipientCode = await paystack.createTransferRecipient({
      name: account.accountName,
      accountNumber: account.accountNumber,
      bankCode: account.bankCode,
    });
    saved = await db
      .insertInto("bank_accounts")
      .values({
        created_by: actor.user.id,
        bank_code: account.bankCode,
        bank_name: account.bankName,
        account_number: account.accountNumber,
        account_name: account.accountName,
        provider_recipient_code: recipientCode,
      })
      .onConflict((oc) =>
        oc.columns(["created_by", "bank_code", "account_number"]).doUpdateSet({
          account_name: account.accountName,
          bank_name: account.bankName,
          provider_recipient_code: recipientCode,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  const bankAccount = saved;

  return db.transaction().execute(async (trx) => {
    const pot = await lockPot(trx, potId);
    if (!PAYOUT_STAGES.includes(pot.stage)) {
      throw conflict("PAYOUTS_NOT_OPEN", "Payouts open once the pot is funded");
    }
    const available = await potBalance(trx, potId, "pot_available");
    if (input.amountKobo > available) {
      throw conflict("INSUFFICIENT_FUNDS", `Only ${naira(available)} is available to pay out`);
    }

    // MON-14: hold payouts to a new account, or large ones, so members can see them first.
    const paidBefore = await trx
      .selectFrom("payouts")
      .select("id")
      .where("bank_account_id", "=", bankAccount.id)
      .where("status", "=", "succeeded")
      .executeTakeFirst();
    const raised = totalRaised((await paidByMember(trx, [potId])).get(potId));
    const holdReasons = [
      ...(paidBefore ? [] : ["new_account"]),
      ...(input.amountKobo > LARGE_PAYOUT_KOBO ? ["large_amount"] : []),
      ...(raised > 0 && input.amountKobo > raised * LARGE_SHARE_OF_POT ? ["large_share_of_pot"] : []),
    ];

    const payoutId = randomUUID();
    const reserveTxnId = await post(trx, {
      kind: "payout",
      potId,
      idempotencyKey: `payout:${payoutId}:reserve`,
      description: `${naira(input.amountKobo)} set aside to pay ${describeAccount(bankAccount)}`,
      createdBy: actor.user.id,
      metadata: { payoutId },
      entries: [
        { accountId: await ensureAccount(trx, "pot_available", potId), amountKobo: -input.amountKobo },
        { accountId: await ensureAccount(trx, "pot_reserved", potId), amountKobo: input.amountKobo },
      ],
    });

    await trx
      .insertInto("payouts")
      .values({
        id: payoutId,
        pot_id: potId,
        requested_by: actor.user.id,
        bank_account_id: bankAccount.id,
        amount_kobo: input.amountKobo,
        narration: input.narration ?? null,
        reference: newReference("po"),
        status: "waiting",
        hold_until: holdReasons.length ? new Date(Date.now() + HOLD_HOURS * 3600 * 1000) : null,
        hold_reasons: holdReasons,
        reserve_txn_id: reserveTxnId,
      })
      .execute();

    // MON-13: when the pot asks for it, contributors approve the payout first.
    if (pot.payout_approval_required) {
      await openPayoutApproval(trx, actor, potId, payoutId, input.amountKobo, bankAccount);
    }

    await notifyPotMembers(trx, potId, "payout_requested", {
      amountKobo: input.amountKobo,
      accountName: bankAccount.account_name,
      bankName: bankAccount.bank_name,
      holdUntil: holdReasons.length ? new Date(Date.now() + HOLD_HOURS * 3600 * 1000).toISOString() : null,
      needsApproval: pot.payout_approval_required,
    });
    await recordAudit(trx, {
      actorUserId: actor.user.id,
      action: "payout.requested",
      potId,
      subjectType: "payout",
      subjectId: payoutId,
      requestId: actor.requestId,
      metadata: {
        amountKobo: input.amountKobo,
        accountName: bankAccount.account_name,
        bankCode: bankAccount.bank_code,
        accountNumberLast4: bankAccount.account_number.slice(-4),
        holdReasons,
        approvalRequired: pot.payout_approval_required,
      },
    });

    await evaluatePayout(trx, payoutId);
    return trx.selectFrom("payouts").selectAll().where("id", "=", payoutId).executeTakeFirstOrThrow();
  });
}

/** Opens the contributors' vote. The organiser's request counts as their yes if they've paid in. */
async function openPayoutApproval(
  trx: Transaction<Database>,
  actor: Actor,
  potId: string,
  payoutId: string,
  amountKobo: number,
  account: { account_name: string; bank_name: string },
) {
  const paid = (await paidByMember(trx, [potId])).get(potId) ?? new Map<string, number>();
  const active = await trx.selectFrom("pot_members").select("user_id").where("pot_id", "=", potId).where("status", "=", "active").execute();
  const contributors = active.map((m) => m.user_id).filter((id) => (paid.get(id) ?? 0) > 0);
  if (contributors.length === 0) {
    throw conflict("NO_CONTRIBUTORS", "Nobody has paid in yet, so nobody can approve a payout");
  }

  const request = await trx
    .insertInto("pot_approval_requests")
    .values({
      pot_id: potId,
      kind: "payout",
      payout_id: payoutId,
      requested_by: actor.user.id,
      eligible_voters: contributors.length,
      required_approvals: majorityOf(contributors.length),
      expires_at: new Date(Date.now() + PAYOUT_APPROVAL_HOURS * 3600 * 1000),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await trx
    .insertInto("pot_approval_voters")
    .values(contributors.map((user_id) => ({ request_id: request.id, user_id })))
    .execute();
  await trx.updateTable("payouts").set({ approval_request_id: request.id }).where("id", "=", payoutId).execute();
  if (contributors.includes(actor.user.id)) {
    await trx.insertInto("pot_approval_votes").values({ request_id: request.id, user_id: actor.user.id, decision: "approve" }).execute();
  }
  for (const userId of contributors.filter((id) => id !== actor.user.id)) {
    await notifyUser(trx, userId, potId, "payout_vote", {
      requestId: request.id,
      amountKobo,
      accountName: account.account_name,
      bankName: account.bank_name,
    });
  }
  await resolveIfDecided(trx, request, actor);
}

// ─────────────────────────────────────────────
// Moving a payout along
// ─────────────────────────────────────────────

/**
 * Decides whether a waiting payout can go: approval (if any) given and hold
 * (if any) over. Rejected or expired approval releases the money. Call with
 * nothing locked on the payout; it locks it.
 */
export async function evaluatePayout(trx: Transaction<Database>, payoutId: string, now = new Date()): Promise<string> {
  const payout = await trx.selectFrom("payouts").selectAll().where("id", "=", payoutId).forUpdate().executeTakeFirstOrThrow();
  if (payout.status !== "waiting") return payout.status;

  if (payout.approval_request_id) {
    const approval = await trx
      .selectFrom("pot_approval_requests")
      .select(["status", "expires_at"])
      .where("id", "=", payout.approval_request_id)
      .executeTakeFirstOrThrow();
    const lapsed = approval.status === "open" && approval.expires_at <= now;
    if (approval.status === "rejected" || approval.status === "expired" || approval.status === "cancelled" || lapsed) {
      if (lapsed) {
        await trx.updateTable("pot_approval_requests").set({ status: "expired" }).where("id", "=", payout.approval_request_id).execute();
      }
      await release(trx, payout, "rejected", "Contributors didn't approve this payout in time");
      await notifyPotMembers(trx, payout.pot_id, "payout_rejected", { amountKobo: payout.amount_kobo }, { roles: ORGANISERS });
      return "rejected";
    }
    if (approval.status !== "approved") return "waiting";
  }
  if (payout.hold_until && payout.hold_until > now) return "waiting";

  await trx.updateTable("payouts").set({ status: "ready" }).where("id", "=", payoutId).execute();
  return "ready";
}

/** Returns reserved money to the pot when a payout doesn't happen. */
async function release(
  trx: Transaction<Database>,
  payout: PayoutRow,
  status: "failed" | "rejected" | "cancelled" | "reversed",
  reason: string,
) {
  const account = await trx.selectFrom("bank_accounts").selectAll().where("id", "=", payout.bank_account_id).executeTakeFirstOrThrow();
  const releaseTxnId = await post(trx, {
    kind: "payout",
    potId: payout.pot_id,
    idempotencyKey: `payout:${payout.id}:release`,
    description: `${naira(payout.amount_kobo)} back in the pot: the payout to ${describeAccount(account)} didn't go ahead`,
    metadata: { payoutId: payout.id, reason },
    entries: [
      { accountId: await ensureAccount(trx, "pot_reserved", payout.pot_id), amountKobo: -payout.amount_kobo },
      { accountId: await ensureAccount(trx, "pot_available", payout.pot_id), amountKobo: payout.amount_kobo },
    ],
  });
  await trx
    .updateTable("payouts")
    .set({ status, release_txn_id: releaseTxnId, failure_reason: reason.slice(0, 500), completed_at: new Date() })
    .where("id", "=", payout.id)
    .execute();
  await recordAudit(trx, {
    actorUserId: null,
    action: `payout.${status}`,
    potId: payout.pot_id,
    subjectType: "payout",
    subjectId: payout.id,
    metadata: { reason },
  });
}

/**
 * Sends a ready payout to Paystack. Claims it first, so only one worker or
 * request ever sends it; the payout's reference makes the transfer idempotent
 * at Paystack too, so a retry can never pay twice.
 */
export async function sendPayout(db: Db, paystack: PaystackClient, payoutId: string): Promise<string> {
  const claimed = await db
    .updateTable("payouts")
    .set({ status: "sending", sent_at: new Date() })
    .where("id", "=", payoutId)
    .where("status", "=", "ready")
    .returningAll()
    .executeTakeFirst();
  if (!claimed) return "not_ready";

  const account = await db.selectFrom("bank_accounts").selectAll().where("id", "=", claimed.bank_account_id).executeTakeFirstOrThrow();
  const pot = await db.selectFrom("pots").select("name").where("id", "=", claimed.pot_id).executeTakeFirstOrThrow();
  let result: TransferResult;
  try {
    result = await paystack.initiateTransfer({
      amountKobo: claimed.amount_kobo,
      recipientCode: account.provider_recipient_code!,
      reference: claimed.reference,
      reason: (claimed.narration ?? `DettyPot: ${pot.name}`).slice(0, 100),
    });
  } catch (err) {
    // A clear refusal (e.g. not enough balance) means no transfer exists: release.
    // No answer at all means we don't know: leave it sending and check later.
    if (err instanceof PaystackError && err.httpStatus !== null && err.httpStatus < 500) {
      await db.transaction().execute(async (trx) => {
        const locked = await trx.selectFrom("payouts").selectAll().where("id", "=", payoutId).forUpdate().executeTakeFirstOrThrow();
        if (locked.status !== "sending") return;
        await release(trx, locked, "failed", `Paystack refused the transfer: ${err.message}`);
        await notifyPotMembers(trx, locked.pot_id, "payout_failed", { amountKobo: locked.amount_kobo, accountName: account.account_name }, { roles: ORGANISERS });
      });
      return "failed";
    }
    return "unknown";
  }
  return applyTransferResult(db, paystack, claimed, result, "send");
}

/** What a transfer's state means for the payout. */
async function applyTransferResult(
  db: Db,
  paystack: PaystackClient,
  payout: { id: string; reference: string },
  result: TransferResult,
  source: "send" | "webhook" | "check",
): Promise<string> {
  const payoutId = payout.id;
  if (result.status === "otp") {
    await db
      .updateTable("payouts")
      .set({
        status: "needs_attention",
        transfer_code: result.transferCode,
        failure_reason: "Paystack asked for an OTP. Switch off transfer OTP in the Paystack dashboard, then retry from admin.",
      })
      .where("id", "=", payoutId)
      .where("status", "=", "sending")
      .execute();
    await recordAudit(db, { actorUserId: null, action: "payout.needs_attention", subjectType: "payout", subjectId: payoutId, metadata: { reason: "otp" } });
    return "needs_attention";
  }
  if (result.status === "success" || result.status === "reversed" || TRANSFER_FAILED_STATUSES.includes(result.status)) {
    return finishPayout(db, paystack, payout.reference, source);
  }
  if (result.transferCode) {
    await db.updateTable("payouts").set({ transfer_code: result.transferCode }).where("id", "=", payoutId).execute();
  }
  return "sending";
}

/**
 * MON-12: Paystack's final answer, always confirmed with Paystack's verify
 * call (a webhook only says when to ask). Success settles the reserved money;
 * failure releases it; a reversal of a completed transfer puts it back.
 */
export async function finishPayout(db: Db, paystack: PaystackClient, reference: string, source: "send" | "webhook" | "check"): Promise<string> {
  const known = await db.selectFrom("payouts").select(["id", "reference"]).where("reference", "=", reference).executeTakeFirst();
  if (!known) return "unknown";
  const verified = await paystack.verifyTransfer(known.reference);

  return db.transaction().execute(async (trx) => {
    const payout = await trx.selectFrom("payouts").selectAll().where("id", "=", known.id).forUpdate().executeTakeFirstOrThrow();
    const account = await trx.selectFrom("bank_accounts").selectAll().where("id", "=", payout.bank_account_id).executeTakeFirstOrThrow();

    if (verified.amountKobo !== payout.amount_kobo) {
      await trx
        .updateTable("payouts")
        .set({ status: payout.status === "succeeded" ? payout.status : "needs_attention", failure_reason: `Paystack reports ${verified.amountKobo} kobo, expected ${payout.amount_kobo}` })
        .where("id", "=", payout.id)
        .execute();
      await recordAudit(trx, { actorUserId: null, action: "payout.mismatch", potId: payout.pot_id, subjectType: "payout", subjectId: payout.id, metadata: { source, verifiedAmountKobo: verified.amountKobo } });
      return "needs_attention";
    }

    if (verified.status === "success" && ["sending", "needs_attention"].includes(payout.status)) {
      const settleTxnId = await post(trx, {
        kind: "payout",
        potId: payout.pot_id,
        idempotencyKey: `payout:${payout.id}:settle`,
        description: `Paid ${naira(payout.amount_kobo)} to ${describeAccount(account)}${payout.narration ? `: ${payout.narration}` : ""}`,
        metadata: { payoutId: payout.id, reference: payout.reference, transferCode: verified.transferCode },
        entries: [
          { accountId: await ensureAccount(trx, "pot_reserved", payout.pot_id), amountKobo: -payout.amount_kobo },
          { accountId: await ensureAccount(trx, "external"), amountKobo: payout.amount_kobo },
        ],
      });
      // DettyPot pays the transfer fee, never the pot.
      if (verified.feeKobo && verified.feeKobo > 0) {
        await post(trx, {
          kind: "fee",
          potId: payout.pot_id,
          idempotencyKey: `payout:${payout.id}:fee`,
          description: `DettyPot paid the ${naira(verified.feeKobo)} transfer fee`,
          metadata: { payoutId: payout.id },
          entries: [
            { accountId: await ensureAccount(trx, "platform_revenue"), amountKobo: -verified.feeKobo },
            { accountId: await ensureAccount(trx, "platform_expense"), amountKobo: verified.feeKobo },
          ],
        });
      }
      await trx
        .updateTable("payouts")
        .set({ status: "succeeded", settle_txn_id: settleTxnId, provider_fee_kobo: verified.feeKobo, transfer_code: verified.transferCode, completed_at: new Date(), failure_reason: null })
        .where("id", "=", payout.id)
        .execute();
      await notifyPotMembers(trx, payout.pot_id, "payout_succeeded", { amountKobo: payout.amount_kobo, accountName: account.account_name, bankName: account.bank_name });
      await recordAudit(trx, { actorUserId: null, action: "payout.succeeded", potId: payout.pot_id, subjectType: "payout", subjectId: payout.id, metadata: { source, feeKobo: verified.feeKobo } });
      return "succeeded";
    }

    // Paystack has several ways of saying a transfer didn't happen.
    if (TRANSFER_FAILED_STATUSES.includes(verified.status) && ["sending", "needs_attention"].includes(payout.status)) {
      await release(trx, payout, "failed", `The bank transfer ${verified.status === "failed" ? "failed" : `was ${verified.status}`}`);
      await notifyPotMembers(trx, payout.pot_id, "payout_failed", { amountKobo: payout.amount_kobo, accountName: account.account_name }, { roles: ORGANISERS });
      return "failed";
    }

    if (verified.status === "reversed") {
      if (payout.status === "succeeded") {
        // The money left and came back: put it back in the pot.
        const reversalTxnId = await post(trx, {
          kind: "reversal",
          potId: payout.pot_id,
          reversesId: payout.settle_txn_id!,
          idempotencyKey: `payout:${payout.id}:reversal`,
          description: `${naira(payout.amount_kobo)} back in the pot: the bank reversed the payment to ${describeAccount(account)}`,
          metadata: { payoutId: payout.id },
          entries: [
            { accountId: await ensureAccount(trx, "external"), amountKobo: -payout.amount_kobo },
            { accountId: await ensureAccount(trx, "pot_available", payout.pot_id), amountKobo: payout.amount_kobo },
          ],
        });
        await trx.updateTable("payouts").set({ status: "reversed", release_txn_id: reversalTxnId, completed_at: new Date() }).where("id", "=", payout.id).execute();
      } else if (["sending", "needs_attention"].includes(payout.status)) {
        await release(trx, payout, "reversed", "The bank reversed the transfer");
      } else {
        return payout.status;
      }
      await notifyPotMembers(trx, payout.pot_id, "payout_reversed", { amountKobo: payout.amount_kobo, accountName: account.account_name });
      await recordAudit(trx, { actorUserId: null, action: "payout.reversed", potId: payout.pot_id, subjectType: "payout", subjectId: payout.id, metadata: { source } });
      return "reversed";
    }

    return payout.status;
  });
}

// ─────────────────────────────────────────────
// Members and support stepping in
// ─────────────────────────────────────────────

/** Any member can flag a payout during its hold: it pauses and support takes a look. */
export async function flagPayout(db: Db, actor: Actor, potId: string, payoutId: string, reason: string): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await authorizePot(trx, actor.user, potId, "payout.flag");
    const payout = await trx.selectFrom("payouts").selectAll().where("id", "=", payoutId).where("pot_id", "=", potId).forUpdate().executeTakeFirst();
    if (!payout) throw notFound("Payout not found");
    if (payout.status !== "waiting" || !payout.hold_until) {
      throw conflict("NOT_FLAGGABLE", "Payouts can be flagged while they're on hold");
    }
    await trx.updateTable("payouts").set({ status: "flagged", flagged_by: actor.user.id, flag_reason: reason }).where("id", "=", payoutId).execute();
    await notifyPotMembers(trx, potId, "payout_flagged", { amountKobo: payout.amount_kobo }, { roles: ORGANISERS });
    await recordAudit(trx, {
      actorUserId: actor.user.id,
      action: "payout.flagged",
      potId,
      subjectType: "payout",
      subjectId: payoutId,
      requestId: actor.requestId,
      metadata: { reason },
    });
  });
}

/** The organiser withdraws a payout that hasn't been sent; its money returns to the pot. */
export async function cancelPayout(db: Db, actor: Actor, potId: string, payoutId: string): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await authorizePot(trx, actor.user, potId, "payout.request");
    const payout = await trx.selectFrom("payouts").selectAll().where("id", "=", payoutId).where("pot_id", "=", potId).forUpdate().executeTakeFirst();
    if (!payout) throw notFound("Payout not found");
    // A flagged payout is support's call now.
    if (!["waiting", "ready"].includes(payout.status)) throw conflict("NOT_CANCELLABLE", `This payout is ${payout.status}`);
    if (payout.approval_request_id) {
      await trx.updateTable("pot_approval_requests").set({ status: "cancelled" }).where("id", "=", payout.approval_request_id).where("status", "=", "open").execute();
    }
    await release(trx, payout, "cancelled", "Withdrawn by the organiser");
    await notifyPotMembers(trx, potId, "payout_cancelled", { amountKobo: payout.amount_kobo }, { exceptUserId: actor.user.id });
  });
}

/** Support's decision on a flagged or stuck payout. */
export async function adminDecidePayout(
  db: Db,
  admin: Actor["user"],
  payoutId: string,
  decision: "release" | "cancel" | "retry",
  requestId?: string,
): Promise<string> {
  return db.transaction().execute(async (trx) => {
    const payout = await trx.selectFrom("payouts").selectAll().where("id", "=", payoutId).forUpdate().executeTakeFirst();
    if (!payout) throw notFound("Payout not found");
    let outcome: string;
    if (decision === "release") {
      if (payout.status !== "flagged") throw conflict("NOT_FLAGGED", "Only flagged payouts can be released");
      await trx.updateTable("payouts").set({ status: "waiting", hold_until: new Date() }).where("id", "=", payoutId).execute();
      outcome = await evaluatePayout(trx, payoutId);
    } else if (decision === "cancel") {
      if (!["flagged", "waiting", "ready", "needs_attention"].includes(payout.status)) throw conflict("NOT_CANCELLABLE", `This payout is ${payout.status}`);
      if (payout.status === "needs_attention" && payout.transfer_code) {
        throw conflict("TRANSFER_EXISTS", "Paystack already has this transfer; resolve it there before cancelling");
      }
      await release(trx, payout, "cancelled", "Cancelled by DettyPot support");
      outcome = "cancelled";
    } else {
      if (payout.status !== "needs_attention") throw conflict("NOT_STUCK", "Only payouts needing attention can be retried");
      await trx.updateTable("payouts").set({ status: "ready", failure_reason: null }).where("id", "=", payoutId).execute();
      outcome = "ready";
    }
    await recordAudit(trx, {
      actorUserId: admin.id,
      actorType: "admin",
      action: `admin.payout_${decision}`,
      potId: payout.pot_id,
      subjectType: "payout",
      subjectId: payoutId,
      requestId,
    });
    return outcome;
  });
}

// ─────────────────────────────────────────────
// The worker's job, and reading
// ─────────────────────────────────────────────

/** Moves waiting payouts on, sends ready ones, and checks on transfers we haven't heard back about. */
export async function progressPayouts(db: Db, paystack: PaystackClient, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const stats = { released: 0, sent: 0, checked: 0 };

  const waiting = await db.selectFrom("payouts").select("id").where("status", "=", "waiting").execute();
  for (const p of waiting) {
    const status = await db.transaction().execute((trx) => evaluatePayout(trx, p.id, now));
    if (status === "ready") stats.released++;
  }

  const ready = await db.selectFrom("payouts").select("id").where("status", "=", "ready").execute();
  for (const p of ready) {
    if ((await sendPayout(db, paystack, p.id)) !== "not_ready") stats.sent++;
  }

  // "Haven't heard back for a while" is measured on the real clock, because the
  // send time is real: a payout another worker is sending right now must never
  // look stale, whatever `now` the holds are being judged against.
  const quiet = await db
    .selectFrom("payouts")
    .select(["id", "reference"])
    .where("status", "=", "sending")
    .where("sent_at", "<=", new Date(Date.now() - SENDING_CHECK_MINUTES * 60_000))
    .execute();
  for (const p of quiet) {
    stats.checked++;
    try {
      const result = await paystack.verifyTransfer(p.reference);
      await applyTransferResult(db, paystack, p, result, "check");
    } catch (err) {
      // Paystack never received it: put it back in line; the same reference keeps a resend safe.
      if (err instanceof PaystackError && err.httpStatus === 404) {
        await db.updateTable("payouts").set({ status: "ready" }).where("id", "=", p.id).where("status", "=", "sending").execute();
      }
    }
  }
  return stats;
}

export interface PayoutView {
  payout: PayoutRow;
  accountName: string;
  bankName: string;
  accountNumberLast4: string;
  requestedByName: string | null;
}

/** Every member sees every payout: how much, to whom, and where it stands. */
export async function listPayouts(db: Db, user: Actor["user"], potId: string): Promise<PayoutView[]> {
  await authorizePot(db, user, potId, "pot.view");
  const rows = await db
    .selectFrom("payouts as p")
    .innerJoin("bank_accounts as b", "b.id", "p.bank_account_id")
    .innerJoin("users as u", "u.id", "p.requested_by")
    .selectAll("p")
    .select(["b.account_name", "b.bank_name", "b.account_number", "u.full_name"])
    .where("p.pot_id", "=", potId)
    .orderBy("p.created_at", "desc")
    .execute();
  return rows.map(({ account_name, bank_name, account_number, full_name, ...payout }) => ({
    payout,
    accountName: account_name,
    bankName: bank_name,
    accountNumberLast4: account_number.slice(-4),
    requestedByName: full_name,
  }));
}
