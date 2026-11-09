import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureAccount, post } from "../src/ledger/service.js";
import { clearBankCache, progressPayouts } from "../src/payouts/service.js";
import { reconcile, reconcileIfDue } from "../src/reconciliation/service.js";
import { apiFor, inDays, type Person } from "./api.js";
import { FakePaystack } from "./fake-paystack.js";
import { naira } from "./fixtures.js";
import { makeTestApp, type TestApp } from "./helpers.js";

const paystack = new FakePaystack();
let t: TestApp;
let admin: Person;
beforeAll(async () => {
  t = await makeTestApp({ PAYSTACK_SECRET_KEY: paystack.secretKey }, { paystack });
  paystack.addAccount("058", "0123456789", "KOKO BEACH RESORT LTD");
  admin = await h.signIn();
  await t.db.updateTable("users").set({ is_admin: true }).where("id", "=", admin.id).execute();
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => {
  paystack.transferMode = "pending";
  clearBankCache();
});

const h = apiFor(() => t);
const sendWebhook = (hook: { body: string; signature: string }) =>
  t.app.inject({ method: "POST", url: "/webhooks/paystack", headers: { "content-type": "application/json", "x-paystack-signature": hook.signature }, payload: hook.body });

async function collectingPot(people = 2) {
  const all = await Promise.all(Array.from({ length: people }, () => h.signIn()));
  const [organiser] = all as [Person];
  const pot = await h.createPot(organiser, { budgetKobo: naira(25_000 * people), headcount: people, fundingDeadline: inDays(10).toISOString() });
  for (const p of all.slice(1)) await h.join(pot.id, p.id);
  await h.call(organiser, "POST", `/pots/${pot.id}/stage`, { to: "collecting" });
  return { pot, people: all };
}

const startPayment = async (who: Person, potId: string, amountKobo = naira(25_000)) =>
  (await h.call(who, "POST", `/pots/${potId}/payments`, { amountKobo, method: "bank_transfer" })).json() as { id: string; reference: string };

/** Findings from a run about one subject (other test files leave their own data in the database). */
const findingsAbout = (runId: string, subjectId: string) =>
  t.db.selectFrom("reconciliation_findings").select(["kind", "details"]).where("run_id", "=", runId).where("subject_id", "=", subjectId).execute();

// ─────────────────────────────────────────────
describe("payments", () => {
  it("are confirmed when Paystack has them but the webhook never came", async () => {
    const { pot, people } = await collectingPot();
    const p = await startPayment(people[0]!, pot.id);
    paystack.pay(p.reference); // the webhook is lost

    const { runId } = await reconcile(t.db, paystack);
    const row = await t.db.selectFrom("payments").select("status").where("id", "=", p.id).executeTakeFirstOrThrow();
    expect(row.status).toBe("succeeded");
    expect(await findingsAbout(runId, p.id)).toEqual([]);
  });

  it("are flagged when Paystack has a DettyPot payment we have no record of", async () => {
    paystack.transactions.set("dp-0000000000000000orphan01", {
      id: 1, input: { email: "x@example.com", amountKobo: naira(9_000), reference: "dp-0000000000000000orphan01", channels: ["card"], callbackUrl: "", metadata: {} },
      status: "success", amountKobo: naira(9_000), currency: "NGN", feesKobo: 0, channel: "card", paidAt: new Date(),
    });
    const { runId } = await reconcile(t.db, paystack);
    expect(await findingsAbout(runId, "dp-0000000000000000orphan01")).toEqual([
      { kind: "payment_unknown_here", details: { amountKobo: naira(9_000) } },
    ]);
  });

  it("are flagged when we count one Paystack has no successful charge for", async () => {
    const { pot, people } = await collectingPot();
    const p = await startPayment(people[0]!, pot.id);
    await sendWebhook(paystack.pay(p.reference));
    paystack.transactions.get(p.reference)!.status = "reversed"; // e.g. a chargeback

    const { runId } = await reconcile(t.db, paystack);
    expect((await findingsAbout(runId, p.id)).map((f) => f.kind)).toEqual(["payment_missing_at_paystack"]);
  });

  it("are flagged, not counted, when Paystack's amount differs", async () => {
    const { pot, people } = await collectingPot();
    const p = await startPayment(people[0]!, pot.id);
    paystack.pay(p.reference, { amountKobo: naira(100) });
    const { runId } = await reconcile(t.db, paystack);
    expect((await findingsAbout(runId, p.id)).map((f) => f.kind)).toEqual(["payment_amount_mismatch"]);
    expect((await t.db.selectFrom("payments").select("status").where("id", "=", p.id).executeTakeFirstOrThrow()).status).toBe("pending");
  });
});

// ─────────────────────────────────────────────
describe("payouts", () => {
  async function sendingPayout() {
    const { pot, people } = await collectingPot();
    for (const p of people) await sendWebhook(paystack.pay((await startPayment(p, pot.id)).reference));
    const payout = (await h.call(people[0]!, "POST", `/pots/${pot.id}/payouts`, { bankCode: "058", accountNumber: "0123456789", amountKobo: naira(10_000) })).json();
    await progressPayouts(t.db, paystack, { now: new Date(Date.now() + 25 * 3600_000) });
    const row = await t.db.selectFrom("payouts").selectAll().where("id", "=", payout.id).executeTakeFirstOrThrow();
    expect(row.status).toBe("sending");
    return { pot, people, payout: row };
  }

  it("pick up a transfer result whose webhook never came", async () => {
    const { payout } = await sendingPayout();
    paystack.finishTransfer(payout.reference, "success"); // webhook lost
    const { summary } = await reconcile(t.db, paystack);
    expect((await t.db.selectFrom("payouts").select("status").where("id", "=", payout.id).executeTakeFirstOrThrow()).status).toBe("succeeded");
    expect(summary.payoutsUpdated).toBeGreaterThanOrEqual(1);
  });

  it.each(["blocked", "rejected", "abandoned"] as const)("treat a %s transfer as failed and return the money", async (status) => {
    const { pot, people, payout } = await sendingPayout();
    paystack.finishTransfer(payout.reference, status);
    await reconcile(t.db, paystack);
    const row = await t.db.selectFrom("payouts").selectAll().where("id", "=", payout.id).executeTakeFirstOrThrow();
    expect(row.status).toBe("failed");
    expect(row.failure_reason).toContain(status);
    const ledger = (await h.call(people[0]!, "GET", `/pots/${pot.id}/ledger`)).json();
    expect(ledger).toMatchObject({ availableKobo: naira(50_000), reservedKobo: 0 });
  });

  it("are also noticed by the payout worker when it checks a quiet transfer", async () => {
    const { payout } = await sendingPayout();
    paystack.finishTransfer(payout.reference, "blocked");
    await t.db.updateTable("payouts").set({ sent_at: new Date(Date.now() - 11 * 60_000) }).where("id", "=", payout.id).execute();
    await progressPayouts(t.db, paystack);
    expect((await t.db.selectFrom("payouts").select("status").where("id", "=", payout.id).executeTakeFirstOrThrow()).status).toBe("failed");
  });
});

// ─────────────────────────────────────────────
describe("runs", () => {
  it("alert admins when something needs a person", async () => {
    const { runId } = await reconcile(t.db, paystack); // earlier tests left findings in place
    const alert = await t.db
      .selectFrom("notifications")
      .select("payload")
      .where("user_id", "=", admin.id)
      .where("type", "=", "reconciliation_alert")
      .orderBy("created_at", "desc")
      .executeTakeFirst();
    expect(alert?.payload).toMatchObject({ runId });
  });

  it("happen once a day, after 02:00 in Lagos", async () => {
    await sql`truncate reconciliation_findings, reconciliation_runs`.execute(t.db);
    const day = new Date();
    const at = (hourLagos: number) => new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1, hourLagos - 1));
    expect(await reconcileIfDue(t.db, paystack, at(1))).toBeNull();
    expect(await reconcileIfDue(t.db, paystack, at(3))).not.toBeNull();
    expect(await reconcileIfDue(t.db, paystack, at(9))).toBeNull();
  });

  it("are recorded as errors, with an alert, when Paystack can't be reached", async () => {
    const original = paystack.listTransactions.bind(paystack);
    paystack.listTransactions = async () => {
      throw new Error("Paystack unreachable");
    };
    try {
      await expect(reconcile(t.db, paystack)).rejects.toThrow(/unreachable/);
    } finally {
      paystack.listTransactions = original;
    }
    const last = await t.db.selectFrom("reconciliation_runs").selectAll().orderBy("started_at", "desc").executeTakeFirstOrThrow();
    expect(last.status).toBe("error");
  });

  it("can be reviewed, run and resolved by admins only", async () => {
    expect((await h.call(await h.signIn(), "GET", "/admin/reconciliation")).statusCode).toBe(404);
    const run = await h.call(admin, "POST", "/admin/reconciliation/run");
    expect(run.statusCode).toBe(200);
    const { openFindings } = (await h.call(admin, "GET", "/admin/reconciliation")).json();
    if (openFindings.length) {
      const id = openFindings[0].id;
      expect((await h.call(admin, "POST", `/admin/reconciliation/findings/${id}/resolve`, { resolution: "Checked with Paystack" })).statusCode).toBe(200);
      expect((await h.call(admin, "POST", `/admin/reconciliation/findings/${id}/resolve`, { resolution: "Again" })).json().error.code).toBe("ALREADY_RESOLVED");
    }
  });
});

// Last, because it leaves the ledger deliberately wrong for the rest of this file.
describe("the ledger", () => {
  it("is checked against the records it was posted from", async () => {
    const { pot } = await collectingPot();
    await t.db.transaction().execute(async (trx) => {
      await post(trx, {
        kind: "contribution",
        potId: pot.id,
        idempotencyKey: "payment:not-a-real-payment",
        description: "money with no payment behind it",
        entries: [
          { accountId: await ensureAccount(trx, "external"), amountKobo: -naira(1_000) },
          { accountId: await ensureAccount(trx, "pot_available", pot.id), amountKobo: naira(1_000) },
        ],
      });
    });
    const { runId } = await reconcile(t.db, paystack);
    const mismatches = await t.db.selectFrom("reconciliation_findings").select("details").where("run_id", "=", runId).where("kind", "=", "ledger_mismatch").execute();
    expect(mismatches.map((m) => (m.details as { check: string }).check)).toContain("confirmed payments");
  });
});
