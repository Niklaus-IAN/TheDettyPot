import { randomBytes } from "node:crypto";
import type { Selectable } from "kysely";
import { recordAudit } from "../audit.js";
import { authorizePot } from "../auth/pot-access.js";
import type { Database, Db } from "../db/index.js";
import { AppError, badRequest, conflict, notFound } from "../errors.js";
import { ensureAccount, post } from "../ledger/service.js";
import { naira } from "../notifications/catalog.js";
import { notifyPotMembers, notifyUser } from "../notifications/service.js";
import { paidByMember, totalRaised } from "../pots/money.js";
import { lockPot, MAX_BUDGET_KOBO, type Actor } from "../pots/service.js";
import { currentSchedule, quote, type PaymentMethod, type Quote } from "./fees.js";
import { PaystackError, type PaystackClient, type VerifiedTransaction } from "./paystack.js";

export type PaymentRow = Selectable<Database["payments"]>;

/** Smallest instalment, unless it exactly clears what the member still owes. */
export const MIN_PAYMENT_KOBO = 1_000 * 100;
/** How long a started payment waits before it's treated as abandoned. */
export const PAYMENT_TTL_MINUTES = 60;
/** Open checkouts per member per pot, so nobody floods the processor. */
export const MAX_PENDING_PER_MEMBER = 3;
/** The service fee is non-refundable for now; each payment records the rule it was made under. */
export const FEE_REFUNDABLE = false;

const PAYABLE_STAGES = ["collecting", "funded"];

const paymentsUnavailable = () =>
  new AppError(503, "PAYMENTS_UNAVAILABLE", "Payments aren't available right now. Please try again later.");

/** Lowercase hex, which suits both Paystack's transaction and transfer reference rules. */
export const newReference = (prefix: string) => `${prefix}-${randomBytes(12).toString("hex")}`;

async function owedBy(db: Db, potId: string, userId: string, shareKobo: number) {
  const paid = (await paidByMember(db, [potId])).get(potId)?.get(userId) ?? 0;
  return { paid, owed: Math.max(0, shareKobo - paid) };
}

// ─────────────────────────────────────────────
// Quoting and starting a payment
// ─────────────────────────────────────────────

export interface CheckoutQuote extends Quote {
  method: PaymentMethod;
  feeRefundable: boolean;
}

export interface PaymentOptions {
  owedKobo: number;
  paidKobo: number;
  /** The smallest amount accepted right now. */
  minimumKobo: number;
  quotes: CheckoutQuote[];
}

/** Share, fee and total for each method, before anyone pays (MON-18). */
export async function paymentOptions(db: Db, user: Actor["user"], potId: string, amountKobo?: number): Promise<PaymentOptions> {
  await authorizePot(db, user, potId, "pot.view");
  const pot = await db.selectFrom("pots").select("share_kobo").where("id", "=", potId).executeTakeFirstOrThrow();
  const { paid, owed } = await owedBy(db, potId, user.id, pot.share_kobo);
  const amount = amountKobo ?? (owed > 0 ? owed : pot.share_kobo);
  const quotes: CheckoutQuote[] = [];
  for (const method of ["bank_transfer", "card"] as const) {
    quotes.push({ method, feeRefundable: FEE_REFUNDABLE, ...quote(await currentSchedule(db, method), amount) });
  }
  return { owedKobo: owed, paidKobo: paid, minimumKobo: owed > 0 ? Math.min(MIN_PAYMENT_KOBO, owed) : MIN_PAYMENT_KOBO, quotes };
}

export interface StartedPayment {
  payment: PaymentRow;
  checkoutUrl: string;
  accessCode: string;
}

/**
 * MON-01: the server records the payment (who, which pot, exact amounts, a
 * unique reference) before the member is sent to Paystack to pay it.
 */
export async function startPayment(
  db: Db,
  paystack: PaystackClient | null,
  actor: Actor,
  potId: string,
  input: { amountKobo: number; method: PaymentMethod },
  webBaseUrl: string,
): Promise<StartedPayment> {
  if (!paystack) throw paymentsUnavailable();
  await authorizePot(db, actor.user, potId, "contribution.make");

  const pot = await db.selectFrom("pots").selectAll().where("id", "=", potId).executeTakeFirstOrThrow();
  if (!PAYABLE_STAGES.includes(pot.stage)) {
    throw conflict("POT_NOT_COLLECTING", "This pot isn't collecting money right now");
  }

  const amount = input.amountKobo;
  if (amount % 100 !== 0) throw badRequest("WHOLE_NAIRA", "Pay a whole naira amount");
  if (amount > MAX_BUDGET_KOBO) throw badRequest("AMOUNT_TOO_LARGE", "That's more than a single payment can be");
  const { owed } = await owedBy(db, potId, actor.user.id, pot.share_kobo);
  const clearsBalance = owed > 0 && amount === owed;
  if (amount < MIN_PAYMENT_KOBO && !clearsBalance) {
    throw badRequest(
      "AMOUNT_TOO_SMALL",
      owed > 0 && owed < MIN_PAYMENT_KOBO
        ? `Pay at least ${naira(MIN_PAYMENT_KOBO)}, or exactly the ${naira(owed)} you still owe`
        : `Pay at least ${naira(MIN_PAYMENT_KOBO)}`,
    );
  }

  const { n } = await db
    .selectFrom("payments")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("pot_id", "=", potId)
    .where("user_id", "=", actor.user.id)
    .where("status", "=", "pending")
    .where("expires_at", ">", new Date())
    .executeTakeFirstOrThrow();
  if (Number(n) >= MAX_PENDING_PER_MEMBER) {
    throw new AppError(429, "TOO_MANY_PENDING", "Finish or wait out your open payments before starting another");
  }

  const schedule = await currentSchedule(db, input.method);
  const q = quote(schedule, amount);
  const payment = await db
    .insertInto("payments")
    .values({
      pot_id: potId,
      user_id: actor.user.id,
      reference: newReference("dp"),
      method: input.method,
      share_kobo: q.shareKobo,
      fee_kobo: q.feeKobo,
      total_kobo: q.totalKobo,
      fee_schedule_id: schedule.id,
      fee_refundable: FEE_REFUNDABLE,
      expires_at: new Date(Date.now() + PAYMENT_TTL_MINUTES * 60 * 1000),
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  try {
    const checkout = await paystack.initializeTransaction({
      email: actor.user.email!,
      amountKobo: q.totalKobo,
      reference: payment.reference,
      channels: [input.method],
      callbackUrl: new URL(`/pots/${potId}/payments/${payment.id}`, webBaseUrl).toString(),
      metadata: { payment_id: payment.id, pot_id: potId, user_id: actor.user.id },
    });
    const updated = await db
      .updateTable("payments")
      .set({ provider_access_code: checkout.accessCode, provider_checkout_url: checkout.authorizationUrl })
      .where("id", "=", payment.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await recordAudit(db, {
      actorUserId: actor.user.id,
      action: "payment.started",
      potId,
      subjectType: "payment",
      subjectId: payment.id,
      requestId: actor.requestId,
      metadata: { method: input.method, shareKobo: q.shareKobo, feeKobo: q.feeKobo, totalKobo: q.totalKobo },
    });
    return { payment: updated, checkoutUrl: checkout.authorizationUrl, accessCode: checkout.accessCode };
  } catch (err) {
    await db
      .updateTable("payments")
      .set({ status: "failed", failure_reason: String((err as Error).message).slice(0, 500) })
      .where("id", "=", payment.id)
      .execute();
    if (err instanceof PaystackError) {
      throw new AppError(502, "PAYMENT_PROVIDER_ERROR", "We couldn't reach the payment provider. Please try again.");
    }
    throw err;
  }
}

// ─────────────────────────────────────────────
// Confirming a payment
// ─────────────────────────────────────────────

export type ConfirmOutcome = "succeeded" | "already_succeeded" | "not_paid" | "review" | "unknown";

/**
 * MON-02: money counts only once Paystack itself confirms it and the amount,
 * currency and reference all match what we recorded. Paystack's verify call is
 * the source of truth; a webhook only tells us when to ask. Safe to call any
 * number of times (MON-04).
 */
export async function confirmPayment(
  db: Db,
  paystack: PaystackClient,
  reference: string,
  source: "webhook" | "expiry_check",
): Promise<ConfirmOutcome> {
  const known = await db.selectFrom("payments").select(["id", "status"]).where("reference", "=", reference).executeTakeFirst();
  if (!known) return "unknown";
  if (known.status === "succeeded") return "already_succeeded";

  // Ask Paystack before taking any lock, so no lock is held during the network call.
  const verified = await paystack.verifyTransaction(reference);

  return db.transaction().execute(async (trx) => {
    const payment = await trx.selectFrom("payments").selectAll().where("id", "=", known.id).forUpdate().executeTakeFirstOrThrow();
    if (payment.status === "succeeded") return "already_succeeded";
    // Already set aside for a person to check; repeats change nothing.
    if (payment.status === "review") return "review";
    if (verified.status !== "success") return "not_paid";

    const mismatch = describeMismatch(payment, verified);
    if (mismatch) {
      await trx.updateTable("payments").set({ status: "review", failure_reason: mismatch }).where("id", "=", payment.id).execute();
      await notifyUser(trx, payment.user_id, payment.pot_id, "payment_review", { reference });
      await recordAudit(trx, {
        actorUserId: null,
        action: "payment.needs_review",
        potId: payment.pot_id,
        subjectType: "payment",
        subjectId: payment.id,
        metadata: { reason: mismatch, source, reportedAmountKobo: verified.amountKobo, reportedCurrency: verified.currency },
      });
      return "review";
    }

    const ledgerTransactionId = await postContribution(trx, payment, verified);
    await trx
      .updateTable("payments")
      .set({
        status: "succeeded",
        paid_at: verified.paidAt ?? new Date(),
        channel: verified.channel,
        provider_transaction_id: verified.id,
        provider_fee_kobo: verified.feesKobo,
        ledger_transaction_id: ledgerTransactionId,
        failure_reason: null,
      })
      .where("id", "=", payment.id)
      .execute();

    const payer = await trx.selectFrom("users").select("full_name").where("id", "=", payment.user_id).executeTakeFirstOrThrow();
    await notifyUser(trx, payment.user_id, payment.pot_id, "payment_received", {
      shareKobo: payment.share_kobo,
      feeKobo: payment.fee_kobo,
      totalKobo: payment.total_kobo,
    });
    await notifyPotMembers(
      trx,
      payment.pot_id,
      "contribution_received",
      { name: payer.full_name, amountKobo: payment.share_kobo },
      { exceptUserId: payment.user_id, roles: ["organiser", "co_organiser"] },
    );
    await recordAudit(trx, {
      actorUserId: null,
      action: "payment.succeeded",
      potId: payment.pot_id,
      subjectType: "payment",
      subjectId: payment.id,
      metadata: { source, lateAfterExpiry: payment.status === "expired", providerFeeKobo: verified.feesKobo },
    });
    await markFundedIfTargetMet(trx, payment.pot_id);
    return "succeeded";
  });
}

function describeMismatch(payment: PaymentRow, verified: VerifiedTransaction): string | null {
  if (verified.reference !== payment.reference) return `reference ${verified.reference} doesn't match`;
  if (verified.currency !== payment.currency) return `currency ${verified.currency} doesn't match`;
  if (verified.amountKobo !== payment.total_kobo) {
    return `amount ${verified.amountKobo} kobo doesn't match the expected ${payment.total_kobo} kobo`;
  }
  return null;
}

/**
 * One ledger transaction per payment. The share goes into the pot; the fee is
 * two lines (MON-18): what Paystack kept, and what is left for DettyPot. If
 * Paystack kept more than the fee covered, DettyPot's line is negative: it
 * absorbs the difference, never the pot.
 */
async function postContribution(trx: Parameters<typeof post>[0], payment: PaymentRow, verified: VerifiedTransaction) {
  const providerFee = verified.feesKobo ?? 0;
  const payer = await trx.selectFrom("users").select("full_name").where("id", "=", payment.user_id).executeTakeFirstOrThrow();
  const how = payment.method === "card" ? "by card" : "by bank transfer";
  return post(trx, {
    kind: "contribution",
    potId: payment.pot_id,
    memberUserId: payment.user_id,
    idempotencyKey: `payment:${payment.id}`,
    description: `${payer.full_name ?? "A member"} paid ${naira(payment.share_kobo)} ${how} (fee ${naira(payment.fee_kobo)})`,
    metadata: {
      paymentId: payment.id,
      reference: payment.reference,
      providerFeeKobo: providerFee,
      providerFeeReported: verified.feesKobo !== null,
      platformFeeKobo: payment.fee_kobo - providerFee,
    },
    entries: [
      { accountId: await ensureAccount(trx, "external"), amountKobo: -payment.total_kobo },
      { accountId: await ensureAccount(trx, "pot_available", payment.pot_id), amountKobo: payment.share_kobo },
      { accountId: await ensureAccount(trx, "platform_expense"), amountKobo: providerFee },
      { accountId: await ensureAccount(trx, "platform_revenue"), amountKobo: payment.fee_kobo - providerFee },
    ],
  });
}

/** Moves a collecting pot to funded the moment confirmed money reaches the target. */
async function markFundedIfTargetMet(trx: Db, potId: string) {
  const pot = await lockPot(trx, potId);
  if (pot.stage !== "collecting") return;
  const raised = totalRaised((await paidByMember(trx, [potId])).get(potId));
  if (raised < pot.budget_kobo) return;
  await trx.updateTable("pots").set({ stage: "funded" }).where("id", "=", potId).execute();
  await notifyPotMembers(trx, potId, "pot_funded", { stage: "funded" });
  await recordAudit(trx, {
    actorUserId: null,
    action: "pot.stage_changed",
    potId,
    metadata: { from: "collecting", to: "funded", automatic: true, raisedKobo: raised },
  });
}

// ─────────────────────────────────────────────
// Abandoned payments (MON-05)
// ─────────────────────────────────────────────

/**
 * Payments still pending after their window are checked with Paystack once
 * more: if the money did arrive (a late webhook), it's confirmed; otherwise
 * the payment expires and never counts. A payment that later succeeds anyway
 * (a slow bank transfer) is still confirmed, because the money is real.
 */
export async function expireStalePayments(db: Db, paystack: PaystackClient | null, opts: { now?: Date; limit?: number } = {}) {
  const now = opts.now ?? new Date();
  const stale = await db
    .selectFrom("payments")
    .select(["id", "reference"])
    .where("status", "=", "pending")
    .where("expires_at", "<=", now)
    .orderBy("expires_at")
    .limit(opts.limit ?? 50)
    .execute();

  const result = { confirmed: 0, expired: 0, unchecked: 0 };
  for (const p of stale) {
    let outcome: ConfirmOutcome | "not_found";
    try {
      outcome = paystack ? await confirmPayment(db, paystack, p.reference, "expiry_check") : "not_paid";
    } catch (err) {
      // Paystack has no record of a checkout that was never opened.
      if (err instanceof PaystackError && err.httpStatus === 404) outcome = "not_found";
      else {
        result.unchecked++; // try again on the next run
        continue;
      }
    }
    if (outcome === "succeeded") result.confirmed++;
    if (outcome === "not_paid" || outcome === "not_found") {
      const expired = await db
        .updateTable("payments")
        .set({ status: "expired" })
        .where("id", "=", p.id)
        .where("status", "=", "pending")
        .executeTakeFirst();
      result.expired += Number(expired.numUpdatedRows);
    }
  }
  return result;
}

// ─────────────────────────────────────────────
// Reading
// ─────────────────────────────────────────────

export async function getPayment(db: Db, user: Actor["user"], potId: string, paymentId: string): Promise<PaymentRow> {
  const access = await authorizePot(db, user, potId, "pot.view");
  const payment = await db
    .selectFrom("payments")
    .selectAll()
    .where("id", "=", paymentId)
    .where("pot_id", "=", potId)
    .executeTakeFirst();
  // Members see their own payments; organisers see everyone's.
  if (!payment || (payment.user_id !== user.id && access.role === "member")) throw notFound("Payment not found");
  return payment;
}

export async function myPayments(db: Db, user: Actor["user"], potId: string): Promise<PaymentRow[]> {
  await authorizePot(db, user, potId, "pot.view");
  return db
    .selectFrom("payments")
    .selectAll()
    .where("pot_id", "=", potId)
    .where("user_id", "=", user.id)
    .orderBy("created_at", "desc")
    .limit(50)
    .execute();
}
