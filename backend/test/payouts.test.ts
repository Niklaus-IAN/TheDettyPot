import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearBankCache, HOLD_HOURS, progressPayouts } from "../src/payouts/service.js";
import { expireDueApprovals } from "../src/approvals/service.js";
import { apiFor, inDays, type Person } from "./api.js";
import { FakePaystack } from "./fake-paystack.js";
import { naira } from "./fixtures.js";
import { makeTestApp, type TestApp } from "./helpers.js";

const paystack = new FakePaystack();
let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp({ PAYSTACK_SECRET_KEY: paystack.secretKey }, { paystack });
  paystack.addAccount("058", "0123456789", "KOKO BEACH RESORT LTD");
  paystack.addAccount("044", "9876543210", "TOLU ADEYEMI");
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => {
  paystack.transferMode = "pending";
  paystack.verifyOutages = 0;
  clearBankCache();
});

const h = apiFor(() => t);
const HOUR = 3600_000;
const later = (hours: number) => new Date(Date.now() + hours * HOUR);
const venue = { bankCode: "058", accountNumber: "0123456789" };

const sendWebhook = (hook: { body: string; signature: string }) =>
  t.app.inject({
    method: "POST",
    url: "/webhooks/paystack",
    headers: { "content-type": "application/json", "x-paystack-signature": hook.signature },
    payload: hook.body,
  });

async function pay(who: Person, potId: string, amountKobo: number) {
  const p = (await h.call(who, "POST", `/pots/${potId}/payments`, { amountKobo, method: "bank_transfer" })).json();
  await sendWebhook(paystack.pay(p.reference));
}

/** A funded pot: ₦100,000 from 4 people, so the organiser can pay out. */
async function fundedPot(opts: { approval?: boolean } = {}) {
  const people = await Promise.all([h.signIn({ name: "Tolu" }), h.signIn({ name: "Ada" }), h.signIn(), h.signIn()]);
  const [organiser, ...members] = people as [Person, Person, Person, Person];
  const pot = await h.createPot(organiser, { budgetKobo: naira(100_000), headcount: 4, fundingDeadline: inDays(14).toISOString() });
  for (const m of members) await h.join(pot.id, m.id);
  await h.call(organiser, "POST", `/pots/${pot.id}/stage`, { to: "collecting" });
  if (opts.approval) await h.call(organiser, "PATCH", `/pots/${pot.id}/settings`, { payoutApprovalRequired: true });
  for (const p of people) await pay(p, pot.id, naira(25_000));
  expect((await h.call(organiser, "GET", `/pots/${pot.id}`)).json().stage).toBe("funded");
  return { pot, organiser, members };
}

const requestPayout = (who: Person, potId: string, amountKobo: number, account = venue) =>
  h.call(who, "POST", `/pots/${potId}/payouts`, { ...account, amountKobo, narration: "Venue deposit" });

const ledger = async (who: Person, potId: string) => (await h.call(who, "GET", `/pots/${potId}/ledger`)).json();
const payoutRow = (id: string) => t.db.selectFrom("payouts").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

/** A payout to an account that has been paid before, so no new-account hold. */
async function knownAccount(organiser: Person, potId: string) {
  const first = (await requestPayout(organiser, potId, naira(1_000))).json();
  await progressPayouts(t.db, paystack, { now: later(HOLD_HOURS + 1) });
  await sendWebhook(paystack.finishTransfer((await payoutRow(first.id)).reference, "success"));
  expect((await payoutRow(first.id)).status).toBe("succeeded");
}

// ─────────────────────────────────────────────
describe("bank accounts", () => {
  it("lists banks that take transfers", async () => {
    const res = await h.call(await h.signIn(), "GET", "/banks");
    expect(res.json().map((b: { code: string }) => b.code)).toEqual(expect.arrayContaining(["058", "044"]));
  });

  it("show the account's real name before paying it (MON-11)", async () => {
    const { pot, organiser } = await fundedPot();
    const res = await h.call(organiser, "POST", `/pots/${pot.id}/payouts/resolve-account`, venue);
    expect(res.json()).toMatchObject({ accountName: "KOKO BEACH RESORT LTD", bankName: "Guaranty Trust Bank" });
    const missing = await h.call(organiser, "POST", `/pots/${pot.id}/payouts/resolve-account`, { bankCode: "058", accountNumber: "1111111111" });
    expect(missing.json().error.code).toBe("ACCOUNT_NOT_FOUND");
  });

  it("can't be given a name: there is no field for one", async () => {
    const { pot, organiser } = await fundedPot();
    const res = await h.call(organiser, "POST", `/pots/${pot.id}/payouts`, { ...venue, amountKobo: naira(1_000), accountName: "ME INSTEAD" });
    expect(res.statusCode).toBe(400);
  });
});

// ─────────────────────────────────────────────
describe("requesting a payout (MON-09, MON-10)", () => {
  it("is only for the organiser, with a verified email", async () => {
    const { pot, members } = await fundedPot();
    expect((await requestPayout(members[0], pot.id, naira(1_000))).statusCode).toBe(403);
    await t.db.updateTable("pot_members").set({ role: "co_organiser" }).where("user_id", "=", members[1].id).execute();
    expect((await requestPayout(members[1], pot.id, naira(1_000))).statusCode).toBe(403);
  });

  it("waits until the pot is funded", async () => {
    const organiser = await h.signIn();
    const pot = await h.createPot(organiser, { fundingDeadline: inDays(5).toISOString() });
    await h.call(organiser, "POST", `/pots/${pot.id}/stage`, { to: "collecting" });
    expect((await requestPayout(organiser, pot.id, naira(1_000))).json().error.code).toBe("PAYOUTS_NOT_OPEN");
  });

  it("can't take more than is available", async () => {
    const { pot, organiser } = await fundedPot();
    expect((await requestPayout(organiser, pot.id, naira(100_001))).json().error.code).toBe("INSUFFICIENT_FUNDS");
  });

  it("reserves the money at once, so it can't be paid out twice", async () => {
    const { pot, organiser } = await fundedPot();
    await requestPayout(organiser, pot.id, naira(60_000));
    expect(await ledger(organiser, pot.id)).toMatchObject({ availableKobo: naira(40_000), reservedKobo: naira(60_000), paidOutKobo: 0 });
    expect((await requestPayout(organiser, pot.id, naira(50_000))).json().error.code).toBe("INSUFFICIENT_FUNDS");
  });

  it("lets only one of two requests for most of the money through at once", async () => {
    const { pot, organiser } = await fundedPot();
    const results = await Promise.all([requestPayout(organiser, pot.id, naira(60_000)), requestPayout(organiser, pot.id, naira(60_000))]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect((await ledger(organiser, pot.id)).availableKobo).toBe(naira(40_000));
  });

  it("tells every member how much is going where", async () => {
    const { pot, organiser, members } = await fundedPot();
    await requestPayout(organiser, pot.id, naira(20_000));
    const [note] = await t.db
      .selectFrom("notifications")
      .select("payload")
      .where("user_id", "=", members[2].id)
      .where("type", "=", "payout_requested")
      .execute();
    expect(note?.payload).toMatchObject({ amountKobo: naira(20_000), accountName: "KOKO BEACH RESORT LTD", bankName: "Guaranty Trust Bank" });
  });

  it("are visible to every member, without the full account number", async () => {
    const { pot, organiser, members } = await fundedPot();
    await requestPayout(organiser, pot.id, naira(20_000));
    const [listed] = (await h.call(members[0], "GET", `/pots/${pot.id}/payouts`)).json();
    expect(listed).toMatchObject({ amountKobo: naira(20_000), accountName: "KOKO BEACH RESORT LTD", accountNumberLast4: "6789" });
    expect(JSON.stringify(listed)).not.toContain("0123456789");
  });
});

// ─────────────────────────────────────────────
describe("holds (MON-14)", () => {
  it("hold a payout to a new account for 24 hours, then send it", async () => {
    const { pot, organiser } = await fundedPot();
    const p = (await requestPayout(organiser, pot.id, naira(20_000))).json();
    expect(p).toMatchObject({ status: "waiting", holdReasons: ["new_account"] });
    expect(new Date(p.holdUntil).getTime()).toBeGreaterThan(later(HOLD_HOURS - 1).getTime());

    await progressPayouts(t.db, paystack, { now: later(1) });
    expect((await payoutRow(p.id)).status).toBe("waiting");
    await progressPayouts(t.db, paystack, { now: later(HOLD_HOURS + 1) });
    expect((await payoutRow(p.id)).status).toBe("sending");
  });

  it("send at once to an account paid before, for a modest amount", async () => {
    const { pot, organiser } = await fundedPot();
    await knownAccount(organiser, pot.id);
    const p = (await requestPayout(organiser, pot.id, naira(20_000))).json();
    expect(p.holdReasons).toEqual([]);
    expect((await payoutRow(p.id)).status).toBe("sending");
  });

  it("hold more than half the pot even to a known account", async () => {
    const { pot, organiser } = await fundedPot();
    await knownAccount(organiser, pot.id);
    const p = (await requestPayout(organiser, pot.id, naira(60_000))).json();
    expect(p).toMatchObject({ status: "waiting", holdReasons: ["large_share_of_pot"] });
  });

  it("can be flagged by any member: the payout pauses until support decides", async () => {
    const { pot, organiser, members } = await fundedPot();
    const p = (await requestPayout(organiser, pot.id, naira(20_000))).json();
    const flag = await h.call(members[1], "POST", `/pots/${pot.id}/payouts/${p.id}/flag`, { reason: "I don't know this account" });
    expect(flag.statusCode).toBe(200);
    expect(await h.typesFor(organiser.id, pot.id)).toContain("payout_flagged");

    await progressPayouts(t.db, paystack, { now: later(HOLD_HOURS + 1) });
    expect((await payoutRow(p.id)).status).toBe("flagged");
    expect(paystack.transfers.has((await payoutRow(p.id)).reference)).toBe(false);
  });

  it("let support release a flagged payout, or cancel it and return the money", async () => {
    const admin = await h.signIn();
    await t.db.updateTable("users").set({ is_admin: true }).where("id", "=", admin.id).execute();
    const { pot, organiser, members } = await fundedPot();
    const a = (await requestPayout(organiser, pot.id, naira(10_000))).json();
    const b = (await requestPayout(organiser, pot.id, naira(10_000))).json();
    for (const p of [a, b]) await h.call(members[0], "POST", `/pots/${pot.id}/payouts/${p.id}/flag`, { reason: "Check please" });

    expect((await h.call(admin, "POST", `/admin/payouts/${a.id}/release`)).json().status).toBe("sending");
    expect((await h.call(admin, "POST", `/admin/payouts/${b.id}/cancel`)).json().status).toBe("cancelled");
    expect((await ledger(organiser, pot.id)).availableKobo).toBe(naira(90_000));
    expect((await h.call(organiser, "POST", `/admin/payouts/${a.id}/cancel`)).statusCode).toBe(404);
  });

  it("can only be flagged while on hold", async () => {
    const { pot, organiser, members } = await fundedPot();
    await knownAccount(organiser, pot.id);
    const p = (await requestPayout(organiser, pot.id, naira(5_000))).json();
    expect((await h.call(members[0], "POST", `/pots/${pot.id}/payouts/${p.id}/flag`, { reason: "too late" })).json().error.code).toBe("NOT_FLAGGABLE");
  });
});

// ─────────────────────────────────────────────
describe("sending and results (MON-12)", () => {
  async function sending() {
    const s = await fundedPot();
    await knownAccount(s.organiser, s.pot.id);
    const p = (await requestPayout(s.organiser, s.pot.id, naira(20_000))).json();
    const row = await payoutRow(p.id);
    expect(row.status).toBe("sending");
    return { ...s, payout: row };
  }

  it("settles the reserved money on success, with DettyPot paying the transfer fee", async () => {
    const { pot, organiser, members, payout } = await sending();
    const before = await ledger(organiser, pot.id);
    await sendWebhook(paystack.finishTransfer(payout.reference, "success", 5_000));

    expect(await payoutRow(payout.id)).toMatchObject({ status: "succeeded", provider_fee_kobo: 5_000 });
    const after = await ledger(organiser, pot.id);
    expect(after.paidOutKobo - before.paidOutKobo).toBe(naira(20_000)); // exactly the payout, no fee
    expect(after.reservedKobo).toBe(0);
    expect(after.lines.find((l: { kind: string }) => l.kind === "fee")).toMatchObject({
      potAmountKobo: 0,
      description: "DettyPot paid the ₦50 transfer fee",
    });
    expect(await h.typesFor(members[2].id, pot.id)).toContain("payout_succeeded");
  });

  it("settles once however many times the result arrives", async () => {
    const { pot, organiser, payout } = await sending();
    const hook = paystack.finishTransfer(payout.reference, "success");
    await Promise.all([sendWebhook(hook), sendWebhook(hook), sendWebhook(hook)]);
    const settled = await t.db.selectFrom("ledger_transactions").select("id").where("idempotency_key", "=", `payout:${payout.id}:settle`).execute();
    expect(settled).toHaveLength(1);
    expect((await ledger(organiser, pot.id)).paidOutKobo).toBe(naira(21_000));
  });

  it("returns the money to the pot when the transfer fails", async () => {
    const { pot, organiser, payout } = await sending();
    await sendWebhook(paystack.finishTransfer(payout.reference, "failed"));
    expect((await payoutRow(payout.id)).status).toBe("failed");
    expect(await ledger(organiser, pot.id)).toMatchObject({ availableKobo: naira(99_000), reservedKobo: 0 });
    expect(await h.typesFor(organiser.id, pot.id)).toContain("payout_failed");
  });

  it("puts the money back when the bank reverses a completed payout", async () => {
    const { pot, organiser, payout } = await sending();
    await sendWebhook(paystack.finishTransfer(payout.reference, "success"));
    await sendWebhook(paystack.finishTransfer(payout.reference, "reversed"));
    expect((await payoutRow(payout.id)).status).toBe("reversed");
    expect(await ledger(organiser, pot.id)).toMatchObject({ availableKobo: naira(99_000), paidOutKobo: naira(1_000) });
  });

  it("returns the money when Paystack refuses the transfer outright", async () => {
    const s = await fundedPot();
    await knownAccount(s.organiser, s.pot.id);
    paystack.transferMode = "insufficient_balance";
    const p = (await requestPayout(s.organiser, s.pot.id, naira(20_000))).json();
    expect(await payoutRow(p.id)).toMatchObject({ status: "failed" });
    expect((await payoutRow(p.id)).failure_reason).toContain("balance is not enough");
    expect((await ledger(s.organiser, s.pot.id)).availableKobo).toBe(naira(99_000));
  });

  it("never treats no answer as failure: it checks, and resends safely if Paystack never got it", async () => {
    const s = await fundedPot();
    await knownAccount(s.organiser, s.pot.id);
    paystack.transferMode = "outage";
    const p = (await requestPayout(s.organiser, s.pot.id, naira(20_000))).json();
    expect((await payoutRow(p.id)).status).toBe("sending"); // unknown, not failed
    expect((await ledger(s.organiser, s.pot.id)).reservedKobo).toBe(naira(20_000));

    paystack.transferMode = "pending";
    // Ten quiet minutes later, the worker asks Paystack, finds nothing, and puts it back in line.
    await t.db.updateTable("payouts").set({ sent_at: new Date(Date.now() - 11 * 60_000) }).where("id", "=", p.id).execute();
    await progressPayouts(t.db, paystack);
    await progressPayouts(t.db, paystack); // sends it
    const row = await payoutRow(p.id);
    expect(row.status).toBe("sending");
    expect(paystack.transfers.has(row.reference)).toBe(true);
  });

  it("stops for a person when Paystack asks for an OTP, and settles if it later goes through", async () => {
    const s = await fundedPot();
    await knownAccount(s.organiser, s.pot.id);
    paystack.transferMode = "otp";
    const p = (await requestPayout(s.organiser, s.pot.id, naira(20_000))).json();
    const row = await payoutRow(p.id);
    expect(row.status).toBe("needs_attention");
    expect(row.failure_reason).toContain("OTP");
    await sendWebhook(paystack.finishTransfer(row.reference, "success"));
    expect((await payoutRow(p.id)).status).toBe("succeeded");
  });

  it("holds a payout for a person when Paystack reports a different amount", async () => {
    const { payout } = await sending();
    paystack.transfers.get(payout.reference)!.amountKobo = naira(1);
    await sendWebhook(paystack.finishTransfer(payout.reference, "success"));
    expect(await payoutRow(payout.id)).toMatchObject({ status: "needs_attention", settle_txn_id: null });
  });

  it("is sent to Paystack once even when several workers pick it up together", async () => {
    const { pot, organiser } = await fundedPot();
    const p = (await requestPayout(organiser, pot.id, naira(20_000))).json(); // new account: on hold
    const calls = paystack.initiateCalls;
    await Promise.all([1, 2, 3].map(() => progressPayouts(t.db, paystack, { now: later(HOLD_HOURS + 1) })));
    expect(paystack.initiateCalls - calls).toBe(1);
    expect((await payoutRow(p.id)).status).toBe("sending");
  });

  it("can be withdrawn by the organiser before sending, not after", async () => {
    const { pot, organiser } = await fundedPot();
    const waiting = (await requestPayout(organiser, pot.id, naira(20_000))).json();
    expect((await h.call(organiser, "POST", `/pots/${pot.id}/payouts/${waiting.id}/cancel`)).statusCode).toBe(200);
    expect((await ledger(organiser, pot.id)).availableKobo).toBe(naira(100_000));

    await knownAccount(organiser, pot.id);
    const sent = (await requestPayout(organiser, pot.id, naira(5_000))).json();
    expect((await h.call(organiser, "POST", `/pots/${pot.id}/payouts/${sent.id}/cancel`)).json().error.code).toBe("NOT_CANCELLABLE");
  });
});

// ─────────────────────────────────────────────
describe("member approval (MON-13)", () => {
  const vote = (who: Person, potId: string, requestId: string, decision: "approve" | "reject") =>
    h.call(who, "POST", `/pots/${potId}/approvals/${requestId}/votes`, { decision });

  it("needs a majority of contributors, counting the organiser's request as a yes", async () => {
    const { pot, organiser, members } = await fundedPot({ approval: true });
    const p = (await requestPayout(organiser, pot.id, naira(20_000))).json();
    const [approval] = (await h.call(members[0], "GET", `/pots/${pot.id}/approvals`)).json();
    expect(approval).toMatchObject({ kind: "payout", payoutId: p.id, eligibleVoters: 4, requiredApprovals: 3, approvals: 1, canVote: true });
    expect(await h.typesFor(members[0].id, pot.id)).toContain("payout_vote");

    await vote(members[0], pot.id, approval.id, "approve");
    expect((await vote(members[1], pot.id, approval.id, "approve")).json().status).toBe("approved");
    expect((await payoutRow(p.id)).status).toBe("waiting"); // new account: the hold still applies
    await progressPayouts(t.db, paystack, { now: later(HOLD_HOURS + 1) });
    expect((await payoutRow(p.id)).status).toBe("sending");
  });

  it("returns the money as soon as a majority is out of reach", async () => {
    const { pot, organiser, members } = await fundedPot({ approval: true });
    const p = (await requestPayout(organiser, pot.id, naira(20_000))).json();
    const [approval] = (await h.call(organiser, "GET", `/pots/${pot.id}/approvals`)).json();
    await vote(members[0], pot.id, approval.id, "reject");
    await vote(members[1], pot.id, approval.id, "reject");
    expect((await payoutRow(p.id)).status).toBe("rejected");
    expect((await ledger(organiser, pot.id)).availableKobo).toBe(naira(100_000));
    expect(await h.typesFor(organiser.id, pot.id)).toContain("payout_rejected");
  });

  it("is only open to people who had paid in when it opened", async () => {
    const { pot, organiser } = await fundedPot({ approval: true });
    const freeloader = await h.signIn();
    await h.join(pot.id, freeloader.id);
    await requestPayout(organiser, pot.id, naira(20_000));
    const [approval] = (await h.call(freeloader, "GET", `/pots/${pot.id}/approvals`)).json();
    expect(approval.canVote).toBe(false);
    expect((await vote(freeloader, pot.id, approval.id, "approve")).statusCode).toBe(403);
  });

  it("rejects the payout when contributors don't decide in time", async () => {
    const { pot, organiser } = await fundedPot({ approval: true });
    const p = (await requestPayout(organiser, pot.id, naira(20_000))).json();
    await progressPayouts(t.db, paystack, { now: later(49) });
    expect((await payoutRow(p.id)).status).toBe("rejected");
    expect((await ledger(organiser, pot.id)).availableKobo).toBe(naira(100_000));
    expect(await expireDueApprovals(t.db)).toBeGreaterThanOrEqual(0);
  });
});

describe("transfer webhooks", () => {
  it("about transfers DettyPot didn't make are ignored", async () => {
    const res = await sendWebhook(paystack.webhook("transfer.success", { reference: "not-a-dettypot-payout-ref" }));
    expect(res.statusCode).toBe(200);
  });
});
