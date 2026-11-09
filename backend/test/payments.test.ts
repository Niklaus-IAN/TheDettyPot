import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expireStalePayments } from "../src/payments/service.js";
import { processPendingWebhooks, WEBHOOK_MAX_ATTEMPTS } from "../src/payments/webhooks.js";
import { apiFor, inDays, type Person } from "./api.js";
import { FakePaystack } from "./fake-paystack.js";
import { naira } from "./fixtures.js";
import { makeTestApp, type TestApp } from "./helpers.js";

const paystack = new FakePaystack();
let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp({ PAYSTACK_SECRET_KEY: paystack.secretKey }, { paystack });
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => {
  paystack.failInitialize = false;
  paystack.verifyOutages = 0;
});

const h = apiFor(() => t);

/** A collecting pot: ₦100,000 for 4, so ₦25,000 each. */
async function scene(opts: { budget?: number; headcount?: number } = {}) {
  const [organiser, member] = await Promise.all([h.signIn({ name: "Tolu" }), h.signIn({ name: "Ada" })]);
  const pot = await h.createPot(organiser, {
    budgetKobo: naira(opts.budget ?? 100_000),
    headcount: opts.headcount ?? 4,
    fundingDeadline: inDays(14).toISOString(),
  });
  await h.join(pot.id, member.id);
  expect((await h.call(organiser, "POST", `/pots/${pot.id}/stage`, { to: "collecting" })).statusCode).toBe(200);
  return { pot, organiser, member };
}

const start = (who: Person, potId: string, amountKobo: number, method = "bank_transfer") =>
  h.call(who, "POST", `/pots/${potId}/payments`, { amountKobo, method });

async function started(who: Person, potId: string, amountKobo: number, method = "bank_transfer") {
  const res = await start(who, potId, amountKobo, method);
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; reference: string; totalKobo: number; feeKobo: number; shareKobo: number };
}

const sendWebhook = (hook: { body: string; signature: string }, signature = hook.signature) =>
  t.app.inject({
    method: "POST",
    url: "/webhooks/paystack",
    headers: { "content-type": "application/json", "x-paystack-signature": signature },
    payload: hook.body,
  });

const paymentRow = (id: string) => t.db.selectFrom("payments").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

/** Every ledger entry for a payment, by account kind. */
async function ledgerFor(paymentId: string) {
  const rows = await t.db
    .selectFrom("ledger_transactions as lt")
    .innerJoin("ledger_entries as e", "e.transaction_id", "lt.id")
    .innerJoin("ledger_accounts as a", "a.id", "e.account_id")
    .select(["lt.id", "a.kind", "e.amount_kobo"])
    .where("lt.idempotency_key", "like", `payment:${paymentId}%`)
    .execute();
  return {
    transactions: new Set(rows.map((r) => r.id)).size,
    byKind: Object.fromEntries(rows.map((r) => [r.kind, r.amount_kobo])) as Record<string, number>,
    total: rows.reduce((s, r) => s + r.amount_kobo, 0),
  };
}

const potView = async (who: Person, potId: string) => (await h.call(who, "GET", `/pots/${potId}`)).json();

// ─────────────────────────────────────────────
describe("before paying", () => {
  it("shows what's owed and share + fee = total for each method, with the fee non-refundable", async () => {
    const { pot, member } = await scene();
    const res = await h.call(member, "GET", `/pots/${pot.id}/payments/options`);
    expect(res.json()).toEqual({
      owedKobo: naira(25_000),
      paidKobo: 0,
      minimumKobo: naira(1_000),
      quotes: [
        { method: "bank_transfer", shareKobo: naira(25_000), feeKobo: naira(253), totalKobo: naira(25_253), feeRefundable: false },
        { method: "card", shareKobo: naira(25_000), feeKobo: naira(1_119), totalKobo: naira(26_119), feeRefundable: false },
      ],
    });
  });
});

// ─────────────────────────────────────────────
describe("starting a payment (MON-01)", () => {
  it("records the payment first, then opens a Paystack checkout for the exact total", async () => {
    const { pot, member } = await scene();
    const res = await start(member, pot.id, naira(25_000));
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ status: "pending", shareKobo: naira(25_000), feeKobo: naira(253), totalKobo: naira(25_253), method: "bank_transfer" });
    expect(body.checkoutUrl).toContain(body.reference);

    const sent = paystack.transactions.get(body.reference)!.input;
    expect(sent).toMatchObject({ amountKobo: naira(25_253), reference: body.reference, channels: ["bank_transfer"] });
    expect(sent.callbackUrl).toBe(`http://localhost:5173/pots/${pot.id}/payments/${body.id}`);
    expect(body.reference).toMatch(/^dp-[0-9a-f]{24}$/);
  });

  it("shows money in progress separately from money raised (FR-PAY-03)", async () => {
    const { pot, member } = await scene();
    await started(member, pot.id, naira(25_000));
    expect(await potView(member, pot.id)).toMatchObject({ raisedKobo: 0, inProgressKobo: naira(25_000), myPaidKobo: 0 });
  });

  it.each([
    ["less than ₦1,000", naira(500), "AMOUNT_TOO_SMALL"],
    ["part of a naira", naira(2_000) + 50, "WHOLE_NAIRA"],
  ])("refuses %s", async (_label, amount, code) => {
    const { pot, member } = await scene();
    const res = await start(member, pot.id, amount);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe(code);
  });

  it("allows a final instalment under ₦1,000 only if it clears the balance exactly", async () => {
    const { pot, member } = await scene();
    const first = await started(member, pot.id, naira(24_400));
    await sendWebhook(paystack.pay(first.reference));
    expect((await start(member, pot.id, naira(700))).json().error.message).toContain("₦600");
    expect((await start(member, pot.id, naira(600))).statusCode).toBe(201);
  });

  it("needs a verified email, a member, and a pot that is collecting", async () => {
    const { pot, organiser } = await scene();
    const unverified = await h.signIn({ emailVerified: false });
    await h.join(pot.id, unverified.id);
    expect((await start(unverified, pot.id, naira(5_000))).json().error.code).toBe("EMAIL_NOT_VERIFIED");
    expect((await start(await h.signIn(), pot.id, naira(5_000))).statusCode).toBe(404);

    const planning = await h.createPot(organiser);
    expect((await start(organiser, planning.id, naira(5_000))).json().error.code).toBe("POT_NOT_COLLECTING");
  });

  it("limits open checkouts per member", async () => {
    const { pot, member } = await scene();
    for (let i = 0; i < 3; i++) await started(member, pot.id, naira(1_000));
    expect((await start(member, pot.id, naira(1_000))).json().error.code).toBe("TOO_MANY_PENDING");
  });

  it("marks the payment failed and says so when Paystack can't be reached", async () => {
    const { pot, member } = await scene();
    paystack.failInitialize = true;
    const res = await start(member, pot.id, naira(5_000));
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("PAYMENT_PROVIDER_ERROR");
    const [row] = await t.db.selectFrom("payments").select("status").where("pot_id", "=", pot.id).execute();
    expect(row?.status).toBe("failed");
  });

  it("are unavailable, not broken, when Paystack isn't configured", async () => {
    const bare = await makeTestApp();
    try {
      const api = apiFor(() => bare);
      const organiser = await api.signIn();
      const pot = await api.createPot(organiser, { fundingDeadline: inDays(5).toISOString() });
      await api.call(organiser, "POST", `/pots/${pot.id}/stage`, { to: "collecting" });
      expect((await api.call(organiser, "POST", `/pots/${pot.id}/payments`, { amountKobo: naira(5_000), method: "card" })).statusCode).toBe(503);
    } finally {
      await bare.close();
    }
  });
});

// ─────────────────────────────────────────────
describe("confirming a payment (MON-02)", () => {
  it("counts the money once Paystack confirms it, with the fee as two ledger lines", async () => {
    const { pot, organiser, member } = await scene();
    const p = await started(member, pot.id, naira(25_000));
    const res = await sendWebhook(paystack.pay(p.reference, { feesKobo: naira(253) }));
    expect(res.statusCode).toBe(200);

    expect(await paymentRow(p.id)).toMatchObject({ status: "succeeded", provider_fee_kobo: naira(253) });
    const ledger = await ledgerFor(p.id);
    expect(ledger).toEqual({
      transactions: 1,
      byKind: { external: -naira(25_253), pot_available: naira(25_000), platform_expense: naira(253) },
      total: 0,
    });
    expect(await potView(member, pot.id)).toMatchObject({ raisedKobo: naira(25_000), inProgressKobo: 0, myPaidKobo: naira(25_000), myOwedKobo: 0 });
    expect(await h.typesFor(member.id, pot.id)).toContain("payment_received");
    expect(await h.typesFor(organiser.id, pot.id)).toContain("contribution_received");
    expect(await h.auditFor(pot.id, "payment.succeeded")).toHaveLength(1);
  });

  it("keeps the pot whole when Paystack charges more than the fee covered: DettyPot absorbs it", async () => {
    const { pot, member } = await scene();
    const p = await started(member, pot.id, naira(25_000));
    await sendWebhook(paystack.pay(p.reference, { feesKobo: naira(400) }));
    expect((await ledgerFor(p.id)).byKind).toMatchObject({ pot_available: naira(25_000), platform_expense: naira(400), platform_revenue: -naira(147) });
  });

  it("rejects webhooks that aren't signed by Paystack", async () => {
    const { pot, member } = await scene();
    const p = await started(member, pot.id, naira(25_000));
    const hook = paystack.pay(p.reference);
    expect((await sendWebhook(hook, "0".repeat(128))).statusCode).toBe(401);
    expect((await sendWebhook(hook, "not-hex")).statusCode).toBe(401);
    const tampered = { body: hook.body.replace(`"amount":${p.totalKobo}`, `"amount":1`), signature: hook.signature };
    expect((await sendWebhook(tampered)).statusCode).toBe(401);
    expect((await paymentRow(p.id)).status).toBe("pending");
    const stored = await t.db.selectFrom("webhook_events").select("id").where("dedupe_key", "=", `charge.success:${p.reference}`).execute();
    expect(stored).toEqual([]);
  });

  it("has no extra effect when the same webhook arrives twice (MON-04)", async () => {
    const { pot, member } = await scene();
    const p = await started(member, pot.id, naira(25_000));
    const hook = paystack.pay(p.reference);
    expect((await sendWebhook(hook)).statusCode).toBe(200);
    expect((await sendWebhook(hook)).statusCode).toBe(200);
    expect((await ledgerFor(p.id)).transactions).toBe(1);
    expect((await h.typesFor(member.id, pot.id)).filter((x) => x === "payment_received")).toHaveLength(1);
  });

  it("counts a payment once even when duplicate webhooks arrive at the same moment", async () => {
    const { pot, member } = await scene();
    const p = await started(member, pot.id, naira(25_000));
    const hook = paystack.pay(p.reference);
    const results = await Promise.all([1, 2, 3, 4].map(() => sendWebhook(hook)));
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200, 200]);
    expect((await ledgerFor(p.id)).transactions).toBe(1);
    expect((await potView(member, pot.id)).myPaidKobo).toBe(naira(25_000));
  });

  it("holds a payment for review, uncounted, when Paystack reports a different amount", async () => {
    const { pot, member } = await scene();
    const p = await started(member, pot.id, naira(25_000));
    await sendWebhook(paystack.pay(p.reference, { amountKobo: naira(5_000) }));
    expect(await paymentRow(p.id)).toMatchObject({ status: "review" });
    expect((await ledgerFor(p.id)).transactions).toBe(0);
    expect((await potView(member, pot.id)).raisedKobo).toBe(0);
    expect(await h.typesFor(member.id, pot.id)).toContain("payment_review");
    expect(await h.auditFor(pot.id, "payment.needs_review")).toHaveLength(1);
  });

  it("holds a payment for review when the currency doesn't match", async () => {
    const { pot, member } = await scene();
    const p = await started(member, pot.id, naira(25_000));
    await sendWebhook(paystack.pay(p.reference, { currency: "USD" }));
    expect((await paymentRow(p.id)).status).toBe("review");
  });

  it("ignores charges that aren't DettyPot payments", async () => {
    const res = await sendWebhook(paystack.webhook("charge.success", { reference: "someone-elses-ref" }));
    expect(res.statusCode).toBe(200);
    const [event] = await t.db.selectFrom("webhook_events").select("status").where("dedupe_key", "=", "charge.success:someone-elses-ref").execute();
    expect(event?.status).toBe("ignored");
  });

  it("checks again later when Paystack hasn't confirmed the charge yet", async () => {
    const { pot, member } = await scene();
    const p = await started(member, pot.id, naira(25_000));
    // Paystack sends the webhook, but its verify endpoint still says pending.
    await sendWebhook(paystack.webhook("charge.success", { reference: p.reference }));
    const [event] = await t.db.selectFrom("webhook_events").selectAll().where("dedupe_key", "=", `charge.success:${p.reference}`).execute();
    expect(event).toMatchObject({ status: "pending", attempts: 1 });
    expect((await paymentRow(p.id)).status).toBe("pending");

    paystack.pay(p.reference);
    await processPendingWebhooks(t.db, paystack, { now: new Date(Date.now() + 10 * 60_000) });
    expect((await paymentRow(p.id)).status).toBe("succeeded");
  });

  it("keeps retrying through outages, then flags the event for a person", async () => {
    const { pot, member } = await scene();
    const p = await started(member, pot.id, naira(25_000));
    const hook = paystack.pay(p.reference);
    paystack.verifyOutages = 100;
    await sendWebhook(hook); // attempt 1 fails
    let now = Date.now();
    for (let i = 1; i < WEBHOOK_MAX_ATTEMPTS; i++) {
      now += 24 * 3600_000;
      await processPendingWebhooks(t.db, paystack, { now: new Date(now) });
    }
    const [event] = await t.db.selectFrom("webhook_events").selectAll().where("dedupe_key", "=", `charge.success:${p.reference}`).execute();
    expect(event).toMatchObject({ status: "failed", attempts: WEBHOOK_MAX_ATTEMPTS });
    expect(event?.last_error).toContain("outage");
  });

  it("moves the pot to funded the moment the target is met", async () => {
    const { pot, organiser, member } = await scene({ budget: 50_000, headcount: 2 });
    const a = await started(organiser, pot.id, naira(25_000));
    await sendWebhook(paystack.pay(a.reference));
    expect((await potView(member, pot.id)).stage).toBe("collecting");
    const b = await started(member, pot.id, naira(25_000), "card");
    await sendWebhook(paystack.pay(b.reference));
    expect((await potView(member, pot.id)).stage).toBe("funded");
    expect(await h.typesFor(member.id, pot.id)).toContain("pot_funded");
    const [change] = await h.auditFor(pot.id, "pot.stage_changed").then((rows) => rows.filter((r) => (r.metadata as { automatic?: boolean }).automatic));
    expect(change?.metadata).toMatchObject({ from: "collecting", to: "funded", automatic: true });
  });

  it("accepts instalments and paying more than the share", async () => {
    const { pot, member } = await scene();
    for (const amount of [10_000, 15_000, 5_000]) {
      const p = await started(member, pot.id, naira(amount));
      await sendWebhook(paystack.pay(p.reference));
    }
    expect(await potView(member, pot.id)).toMatchObject({ myPaidKobo: naira(30_000), myOwedKobo: 0, raisedKobo: naira(30_000) });
  });
});

// ─────────────────────────────────────────────
describe("abandoned payments (MON-05)", () => {
  const expireAll = () => t.db.updateTable("payments").set({ expires_at: new Date(Date.now() - 60_000) }).where("status", "=", "pending").execute();

  it("expire and stop counting as in progress", async () => {
    const { pot, member } = await scene();
    const p = await started(member, pot.id, naira(25_000));
    await expireAll();
    await expireStalePayments(t.db, paystack);
    expect((await paymentRow(p.id)).status).toBe("expired");
    expect((await potView(member, pot.id)).inProgressKobo).toBe(0);
  });

  it("are confirmed instead if the money did arrive but the webhook got lost", async () => {
    const { pot, member } = await scene();
    const p = await started(member, pot.id, naira(25_000));
    paystack.pay(p.reference); // webhook never delivered
    await expireAll();
    await expireStalePayments(t.db, paystack);
    expect((await paymentRow(p.id)).status).toBe("succeeded");
  });

  it("are left for the next run when Paystack can't be reached", async () => {
    const { pot, member } = await scene();
    const p = await started(member, pot.id, naira(25_000));
    await expireAll();
    paystack.verifyOutages = 1;
    await expireStalePayments(t.db, paystack);
    expect((await paymentRow(p.id)).status).toBe("pending");
  });

  it("still count if the money arrives after they expired (a slow bank transfer)", async () => {
    const { pot, member } = await scene();
    const p = await started(member, pot.id, naira(25_000));
    await expireAll();
    await expireStalePayments(t.db, paystack);
    await sendWebhook(paystack.pay(p.reference));
    expect((await paymentRow(p.id)).status).toBe("succeeded");
    const [entry] = await h.auditFor(pot.id, "payment.succeeded");
    expect(entry?.metadata).toMatchObject({ lateAfterExpiry: true });
  });
});

// ─────────────────────────────────────────────
describe("fee schedules", () => {
  it("apply to new payments only; a started payment keeps the fee it was quoted", async () => {
    const admin = await h.signIn();
    await t.db.updateTable("users").set({ is_admin: true }).where("id", "=", admin.id).execute();
    const { pot, member } = await scene();
    const before = await started(member, pot.id, naira(25_000));

    const set = await h.call(admin, "POST", "/admin/fees", {
      method: "bank_transfer", percentBps: 100, flatKobo: 0, capKobo: naira(300), marginBps: 0, marginFlatKobo: naira(50), note: "test margin",
    });
    expect(set.statusCode).toBe(201);
    try {
      const after = await started(member, pot.id, naira(25_000));
      expect(after.feeKobo).toBeGreaterThan(before.feeKobo);
      await sendWebhook(paystack.pay(before.reference));
      expect(await paymentRow(before.id)).toMatchObject({ status: "succeeded", fee_kobo: naira(253) });
    } finally {
      // Put the launch default back for the tests that follow.
      await h.call(admin, "POST", "/admin/fees", { method: "bank_transfer", percentBps: 100, flatKobo: 0, capKobo: naira(300), marginBps: 0, marginFlatKobo: 0 });
    }
  });

  it("can't be changed by anyone but an admin", async () => {
    const res = await h.call(await h.signIn(), "POST", "/admin/fees", { method: "card", percentBps: 0, flatKobo: 0, capKobo: null, marginBps: 0, marginFlatKobo: 0 });
    expect(res.statusCode).toBe(404);
  });
});

// ─────────────────────────────────────────────
describe("the pot's ledger (MON-08)", () => {
  it("tells every member where the money came from, fee lines included", async () => {
    const { pot, organiser, member } = await scene();
    const p = await started(member, pot.id, naira(25_000));
    await sendWebhook(paystack.pay(p.reference, { feesKobo: naira(253) }));
    await started(organiser, pot.id, naira(10_000));

    const res = await h.call(organiser, "GET", `/pots/${pot.id}/ledger`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      availableKobo: naira(25_000),
      raisedKobo: naira(25_000),
      paidOutKobo: 0,
      inProgressKobo: naira(10_000),
      lines: [
        {
          kind: "contribution",
          description: "Ada paid ₦25,000 by bank transfer (fee ₦253)",
          memberName: "Ada",
          potAmountKobo: naira(25_000),
          processorFeeKobo: naira(253),
          platformFeeKobo: 0,
        },
      ],
    });
  });

  it("is open to members but not outsiders", async () => {
    const { pot, member } = await scene();
    expect((await h.call(member, "GET", `/pots/${pot.id}/ledger`)).statusCode).toBe(200);
    expect((await h.call(await h.signIn(), "GET", `/pots/${pot.id}/ledger`)).statusCode).toBe(404);
  });
});

describe("seeing payments", () => {
  it("lets members see their own, and organisers see everyone's", async () => {
    const { pot, organiser, member } = await scene();
    const other = await h.signIn();
    await h.join(pot.id, other.id);
    const p = await started(member, pot.id, naira(5_000));
    expect((await h.call(member, "GET", `/pots/${pot.id}/payments/${p.id}`)).statusCode).toBe(200);
    expect((await h.call(organiser, "GET", `/pots/${pot.id}/payments/${p.id}`)).statusCode).toBe(200);
    expect((await h.call(other, "GET", `/pots/${pot.id}/payments/${p.id}`)).statusCode).toBe(404);
    expect((await h.call(member, "GET", `/pots/${pot.id}/payments/mine`)).json()).toHaveLength(1);
  });
});

describe("payment records", () => {
  it("can't have their amounts changed, or un-succeed", async () => {
    const { pot, member } = await scene();
    const p = await started(member, pot.id, naira(5_000));
    await expect(t.db.updateTable("payments").set({ share_kobo: naira(1) }).where("id", "=", p.id).execute()).rejects.toThrow(/cannot change/);
    await sendWebhook(paystack.pay(p.reference));
    await expect(t.db.updateTable("payments").set({ status: "failed" }).where("id", "=", p.id).execute()).rejects.toThrow(/cannot change status/);
  });
});
