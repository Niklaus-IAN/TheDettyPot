import { recordAudit } from "../audit.js";
import type { Db } from "../db/index.js";
import { conflict, notFound } from "../errors.js";
import { notifyUser } from "../notifications/service.js";
import { confirmPayment } from "../payments/service.js";
import type { PaystackClient } from "../payments/paystack.js";
import { finishPayout } from "../payouts/service.js";
import type { User } from "../users/service.js";

/**
 * NFR-05: every day, compare what DettyPot believes with what Paystack
 * reports. Fix what can be fixed safely (a lost webhook, a missed transfer
 * result) and record everything else as a finding for a person, with an alert.
 *
 * The window overlaps the previous run, so a payment that straddles midnight
 * or arrives late is still checked.
 */
export const RECONCILE_WINDOW_HOURS = 48;
/** The run happens once a day, after this hour in Lagos, when traffic is lowest. */
export const RECONCILE_AFTER_HOUR = 2;

type FindingKind =
  | "payment_unknown_here"
  | "payment_not_confirmed"
  | "payment_missing_at_paystack"
  | "payment_amount_mismatch"
  | "payout_unknown_here"
  | "payout_status_mismatch"
  | "ledger_mismatch";

interface Finding {
  kind: FindingKind;
  subjectType?: string;
  subjectId?: string;
  details: Record<string, unknown>;
}

const OUR_PAYMENT = /^dp-/;
const OUR_PAYOUT = /^po-/;

export async function reconcile(db: Db, paystack: PaystackClient, opts: { now?: Date } = {}) {
  const to = opts.now ?? new Date();
  const from = new Date(to.getTime() - RECONCILE_WINDOW_HOURS * 3600_000);
  const run = await db.insertInto("reconciliation_runs").values({ window_from: from, window_to: to }).returningAll().executeTakeFirstOrThrow();
  const findings: Finding[] = [];
  const healed = { paymentsConfirmed: 0, payoutsUpdated: 0 };

  try {
    // ─── Payments: Paystack's successful charges against ours ───
    const charges = (await paystack.listTransactions(from, to)).filter((c) => OUR_PAYMENT.test(c.reference));
    const successful = new Map(charges.filter((c) => c.status === "success").map((c) => [c.reference, c]));
    for (const charge of successful.values()) {
      const ours = await db.selectFrom("payments").select(["id", "status", "total_kobo"]).where("reference", "=", charge.reference).executeTakeFirst();
      if (!ours) {
        findings.push({ kind: "payment_unknown_here", subjectType: "paystack_transaction", subjectId: charge.reference, details: { amountKobo: charge.amountKobo } });
        continue;
      }
      if (ours.total_kobo !== charge.amountKobo) {
        findings.push({ kind: "payment_amount_mismatch", subjectType: "payment", subjectId: ours.id, details: { oursKobo: ours.total_kobo, paystackKobo: charge.amountKobo } });
        continue;
      }
      if (ours.status !== "succeeded") {
        // Most likely a webhook that never arrived: confirm it the normal way.
        const outcome = await confirmPayment(db, paystack, charge.reference, "expiry_check").catch(() => "error");
        if (outcome === "succeeded") healed.paymentsConfirmed++;
        else findings.push({ kind: "payment_not_confirmed", subjectType: "payment", subjectId: ours.id, details: { status: ours.status, outcome } });
      }
    }
    const counted = await db
      .selectFrom("payments")
      .select(["id", "reference", "total_kobo"])
      .where("status", "=", "succeeded")
      .where("paid_at", ">=", from)
      .where("paid_at", "<", to)
      .execute();
    for (const p of counted) {
      if (!successful.has(p.reference)) {
        findings.push({ kind: "payment_missing_at_paystack", subjectType: "payment", subjectId: p.id, details: { reference: p.reference, totalKobo: p.total_kobo } });
      }
    }

    // ─── Payouts: Paystack's transfers against ours ───
    const transfers = (await paystack.listTransfers(from, to)).filter((t) => OUR_PAYOUT.test(t.reference));
    for (const transfer of transfers) {
      const ours = await db.selectFrom("payouts").select(["id", "status"]).where("reference", "=", transfer.reference).executeTakeFirst();
      if (!ours) {
        findings.push({ kind: "payout_unknown_here", subjectType: "paystack_transfer", subjectId: transfer.reference, details: { status: transfer.status, amountKobo: transfer.amountKobo } });
        continue;
      }
      const expected: Record<string, string[]> = {
        success: ["succeeded"],
        reversed: ["reversed"],
        failed: ["failed"],
        abandoned: ["failed"],
        blocked: ["failed"],
        rejected: ["failed"],
      };
      const want = expected[transfer.status];
      if (!want || want.includes(ours.status)) continue;
      // A result we missed: apply it the normal way, which re-checks with Paystack.
      const after = await finishPayout(db, paystack, transfer.reference, "check").catch(() => "error");
      if (want.includes(after)) healed.payoutsUpdated++;
      else findings.push({ kind: "payout_status_mismatch", subjectType: "payout", subjectId: ours.id, details: { ours: after, paystack: transfer.status } });
    }

    // ─── The ledger against the records it was posted from ───
    findings.push(...(await ledgerChecks(db)));

    for (const f of findings) {
      await db
        .insertInto("reconciliation_findings")
        .values({ run_id: run.id, kind: f.kind, subject_type: f.subjectType ?? null, subject_id: f.subjectId ?? null, details: JSON.stringify(f.details) })
        .execute();
    }
    const status = findings.length ? "discrepancies" : "ok";
    const summary = { charges: successful.size, payments: counted.length, transfers: transfers.length, findings: findings.length, ...healed };
    await db.updateTable("reconciliation_runs").set({ status, summary: JSON.stringify(summary), finished_at: new Date() }).where("id", "=", run.id).execute();
    await recordAudit(db, { actorUserId: null, action: "reconciliation.finished", subjectType: "reconciliation_run", subjectId: run.id, metadata: { status, ...summary } });
    if (findings.length) await alertAdmins(db, run.id, findings.length);
    return { runId: run.id, status, summary };
  } catch (err) {
    const message = String((err as Error).message ?? err).slice(0, 500);
    await db.updateTable("reconciliation_runs").set({ status: "error", summary: JSON.stringify({ error: message }), finished_at: new Date() }).where("id", "=", run.id).execute();
    await alertAdmins(db, run.id, 0, message);
    throw err;
  }
}

/**
 * Totals that must agree exactly: every confirmed payment's share is in the
 * ledger, every successful payout and processed refund left the pot, and no
 * pot holds a negative amount. A payout the bank reversed is posted out and
 * back, so it nets to zero and only payouts still succeeded remain.
 */
async function ledgerChecks(db: Db): Promise<Finding[]> {
  const ledgerSum = async (keyPrefix: string, accountKind: string) => {
    const row = await db
      .selectFrom("ledger_transactions as t")
      .innerJoin("ledger_entries as e", "e.transaction_id", "t.id")
      .innerJoin("ledger_accounts as a", "a.id", "e.account_id")
      .select((eb) => eb.fn.coalesce(eb.fn.sum<number>("e.amount_kobo"), eb.lit(0)).as("kobo"))
      .where("t.idempotency_key", "like", `${keyPrefix}%`)
      .where("a.kind", "=", accountKind)
      .executeTakeFirstOrThrow();
    return Number(row.kobo);
  };
  const recorded = {
    payments: await db.selectFrom("payments").select((eb) => eb.fn.coalesce(eb.fn.sum<number>("share_kobo"), eb.lit(0)).as("kobo")).where("status", "=", "succeeded").executeTakeFirstOrThrow(),
    payouts: await db.selectFrom("payouts").select((eb) => eb.fn.coalesce(eb.fn.sum<number>("amount_kobo"), eb.lit(0)).as("kobo")).where("status", "=", "succeeded").executeTakeFirstOrThrow(),
    refunds: await db.selectFrom("refunds").select((eb) => eb.fn.coalesce(eb.fn.sum<number>("amount_kobo"), eb.lit(0)).as("kobo")).where("status", "=", "processed").executeTakeFirstOrThrow(),
  };

  const checks = [
    { check: "confirmed payments", ledger: await ledgerSum("payment:", "pot_available"), records: Number(recorded.payments.kobo) },
    { check: "successful payouts", ledger: await ledgerSum("payout:", "external"), records: Number(recorded.payouts.kobo) },
    { check: "processed refunds", ledger: await ledgerSum("refund:", "external"), records: Number(recorded.refunds.kobo) },
  ];
  const findings: Finding[] = checks.filter((c) => c.ledger !== c.records).map((c) => ({ kind: "ledger_mismatch" as const, details: c }));

  const negative = await db
    .selectFrom("ledger_account_balances")
    .select(["account_id", "pot_id", "balance_kobo"])
    .where("pot_id", "is not", null)
    .where("balance_kobo", "<", 0)
    .execute();
  for (const n of negative) {
    findings.push({ kind: "ledger_mismatch", subjectType: "ledger_account", subjectId: n.account_id ?? undefined, details: { check: "pot balance below zero", potId: n.pot_id, balanceKobo: n.balance_kobo } });
  }
  return findings;
}

async function alertAdmins(db: Db, runId: string, findings: number, error?: string) {
  const admins = await db.selectFrom("users").select("id").where("is_admin", "=", true).where("deleted_at", "is", null).execute();
  for (const a of admins) {
    await notifyUser(db, a.id, null, "reconciliation_alert", { runId, findings, error: error ?? null });
  }
}

/** Runs once a day, early in the morning in Lagos, if today's run hasn't happened. */
export async function reconcileIfDue(db: Db, paystack: PaystackClient, now = new Date()) {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", hour: "numeric", hourCycle: "h23" }).format(now));
  if (hour < RECONCILE_AFTER_HOUR) return null;
  // A run's window ends at the moment it ran for, so that's what says which day it covered.
  const last = await db.selectFrom("reconciliation_runs").select("window_to").orderBy("window_to", "desc").limit(1).executeTakeFirst();
  const lagosDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(d);
  if (last && lagosDay(last.window_to) === lagosDay(now)) return null;
  return reconcile(db, paystack, { now });
}

// ─── For support ───

export async function reconciliationOverview(db: Db) {
  const runs = await db.selectFrom("reconciliation_runs").selectAll().orderBy("started_at", "desc").limit(30).execute();
  const open = await db.selectFrom("reconciliation_findings").selectAll().where("resolved_at", "is", null).orderBy("created_at", "desc").limit(200).execute();
  return { runs, openFindings: open };
}

export async function resolveFinding(db: Db, admin: User, findingId: string, resolution: string, requestId?: string) {
  const finding = await db.selectFrom("reconciliation_findings").select(["id", "resolved_at"]).where("id", "=", findingId).executeTakeFirst();
  if (!finding) throw notFound("Finding not found");
  if (finding.resolved_at) throw conflict("ALREADY_RESOLVED", "This finding is already resolved");
  await db
    .updateTable("reconciliation_findings")
    .set({ resolved_at: new Date(), resolved_by: admin.id, resolution })
    .where("id", "=", findingId)
    .execute();
  await recordAudit(db, { actorUserId: admin.id, actorType: "admin", action: "admin.finding_resolved", subjectType: "reconciliation_finding", subjectId: findingId, requestId, metadata: { resolution } });
}
