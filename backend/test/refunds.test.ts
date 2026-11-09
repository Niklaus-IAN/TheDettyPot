import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearBankCache, progressPayouts } from "../src/payouts/service.js";
import { allocateProRata, progressRefunds } from "../src/refunds/service.js";
import { apiFor, inDays, type Person } from "./api.js";
import { FakePaystack } from "./fake-paystack.js";
import { naira, setStage } from "./fixtures.js";
import { makeTestApp, type TestApp } from "./helpers.js";

const paystack = new FakePaystack();
let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp({ PAYSTACK_SECRET_KEY: paystack.secretKey }, { paystack });
  paystack.addAccount("058", "0123456789", "KOKO BEACH RESORT LTD");
  paystack.addAccount("058", "2222222222", "ADA OBI");
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => {
  paystack.refundMode = "pending";
  paystack.transferMode = "pending";
  paystack.loseNextRefundReply = false;
  clearBankCache();
});

const h = apiFor(() => t);

const sendWebhook = (hook: { body: string; signature: string }) =>
  t.app.inject({ method: "POST", url: "/webhooks/paystack", headers: { "content-type": "application/json", "x-paystack-signature": hook.signature }, payload: hook.body });

/** Pays into a pot through the fake Paystack; returns the payment's reference. */
async function pay(who: Person, potId: string, amountKobo: number) {
  const p = (await h.call(who, "POST", `/pots/${potId}/payments`, { amountKobo, method: "bank_transfer" })).json();
  await sendWebhook(paystack.pay(p.reference));
  return p.reference as string;
}

/** A collecting pot of ₦100,000 for 4 (₦25,000 each). */
async function scene() {
  const people = await Promise.all([h.signIn({ name: "Tolu" }), h.signIn({ name: "Ada" }), h.signIn({ name: "Bayo" }), h.signIn({ name: "Chidi" })]);
  const [organiser, ...members] = people as [Person, Person, Person, Person];
  const pot = await h.createPot(organiser, { budgetKobo: naira(100_000), headcount: 4, fundingDeadline: inDays(14).toISOString() });
  for (const m of members) await h.join(pot.id, m.id);
  await h.call(organiser, "POST", `/pots/${pot.id}/stage`, { to: "collecting" });
  return { pot, organiser, members, people };
}

const refundsOf = (userId: string, potId: string) =>
  t.db.selectFrom("refunds").selectAll().where("user_id", "=", userId).where("pot_id", "=", potId).orderBy("created_at").execute();
const ledger = async (who: Person, potId: string) => (await h.call(who, "GET", `/pots/${potId}/ledger`)).json();

/** Paystack finishes every refund we've asked it for. */
async function finishAllRefunds(potId: string) {
  const refunds = await t.db.selectFrom("refunds").select("provider_refund_id").where("pot_id", "=", potId).where("status", "=", "requested").execute();
  for (const r of refunds) await sendWebhook(paystack.finishRefund(Number(r.provider_refund_id), "processed"));
}

// ─────────────────────────────────────────────
describe("splitting money in proportion (MON-17)", () => {
  it("adds up exactly, to the kobo", () => {
    const paid = new Map([["a", 25_000_00], ["b", 10_000_00], ["c", 3_333_33]]);
    for (const total of [1, 99, 7_654_321, 38_333_33]) {
      const parts = allocateProRata(total, paid);
      expect([...parts.values()].reduce((s, x) => s + x, 0)).toBe(total);
    }
  });

  it("gives each person their fair share", () => {
    const parts = allocateProRata(naira(30_000), new Map([["a", naira(50_000)], ["b", naira(25_000)], ["c", naira(25_000)]]));
    expect(Object.fromEntries(parts)).toEqual({ a: naira(15_000), b: naira(7_500), c: naira(7_500) });
  });

  it("leaves out people who paid nothing, and splits the same way every time", () => {
    const paid = new Map([["b", 1], ["a", 1], ["c", 0]]);
    expect([...allocateProRata(3, paid).entries()]).toEqual([["a", 2], ["b", 1]]);
    expect([...allocateProRata(3, paid).entries()]).toEqual([["a", 2], ["b", 1]]);
  });
});

// ─────────────────────────────────────────────
describe("leaving or being removed before any payout (MON-16)", () => {
  it("refunds the member's share, newest payment first, without the fee", async () => {
    const { pot, members } = await scene();
    const [ada] = members;
    const first = await pay(ada, pot.id, naira(10_000));
    const second = await pay(ada, pot.id, naira(5_000));

    expect((await h.call(ada, "POST", `/pots/${pot.id}/leave`)).statusCode).toBe(200);
    // Both refunds are created in one transaction, so they share a timestamp:
    // match each to its payment rather than relying on their order.
    const refundFor = async (reference: string) => {
      const payment = await t.db.selectFrom("payments").select("id").where("reference", "=", reference).executeTakeFirstOrThrow();
      return t.db.selectFrom("refunds").selectAll().where("payment_id", "=", payment.id).executeTakeFirstOrThrow();
    };
    const [newer, older] = [await refundFor(second), await refundFor(first)];
    expect([newer.amount_kobo, newer.status, newer.reason]).toEqual([naira(5_000), "requested", "member_left"]);
    expect([older.amount_kobo, older.status, older.reason]).toEqual([naira(10_000), "requested", "member_left"]);
    expect(paystack.refundFor(second)).toMatchObject({ amountKobo: naira(5_000), merchantNote: `DettyPot refund ${newer.id}` });
    expect(paystack.refundFor(first)?.amountKobo).toBe(naira(10_000)); // the share only; the ₦101 fee stays
    expect(await h.typesFor(ada.id, pot.id)).toContain("refund_started");
  });

  it("settles when Paystack confirms the refund", async () => {
    const { pot, organiser, members } = await scene();
    const [ada] = members;
    await pay(ada, pot.id, naira(25_000));
    await h.call(ada, "POST", `/pots/${pot.id}/leave`);
    await finishAllRefunds(pot.id);

    expect((await refundsOf(ada.id, pot.id))[0]?.status).toBe("processed");
    expect(await ledger(organiser, pot.id)).toMatchObject({ availableKobo: 0, reservedKobo: 0, refundedKobo: naira(25_000), raisedKobo: 0 });
    expect(await h.typesFor(ada.id, pot.id)).toContain("refund_processed");
  });

  it("refunds someone the organiser removes, too", async () => {
    const { pot, organiser, members } = await scene();
    await pay(members[1], pot.id, naira(25_000));
    expect((await h.call(organiser, "POST", `/pots/${pot.id}/members/${members[1].id}/remove`)).statusCode).toBe(200);
    expect((await refundsOf(members[1].id, pot.id))[0]).toMatchObject({ reason: "member_removed", amount_kobo: naira(25_000) });
  });

  it("isn't possible once the pot is funded: the money is committed", async () => {
    const { pot, members } = await scene();
    await pay(members[0], pot.id, naira(25_000));
    await setStage(t.db, pot.id, "funded");
    expect((await h.call(members[0], "POST", `/pots/${pot.id}/leave`)).json().error.code).toBe("MEMBER_HAS_PAID");
  });
});

// ─────────────────────────────────────────────
describe("cancelling a pot that holds money (MON-15)", () => {
  it("refunds everyone what they paid", async () => {
    const { pot, organiser, people } = await scene();
    const amounts = [25_000, 10_000, 5_000, 0];
    for (const [i, a] of amounts.entries()) if (a) await pay(people[i]!, pot.id, naira(a));

    const res = await h.call(organiser, "POST", `/pots/${pot.id}/cancel`, { reason: "Venue closed" });
    expect(res.json().stage).toBe("cancelled");
    for (const [i, a] of amounts.entries()) {
      const total = (await refundsOf(people[i]!.id, pot.id)).reduce((s, r) => s + r.amount_kobo, 0);
      expect(total).toBe(naira(a));
    }
    await finishAllRefunds(pot.id);
    expect(await ledger(organiser, pot.id)).toMatchObject({ availableKobo: 0, reservedKobo: 0, refundedKobo: naira(40_000) });
  });

  it("splits what's left in proportion when part was already paid out", async () => {
    const { pot, organiser, people } = await scene();
    for (const p of people) await pay(p, pot.id, naira(25_000)); // funded
    const payout = (await h.call(organiser, "POST", `/pots/${pot.id}/payouts`, { bankCode: "058", accountNumber: "0123456789", amountKobo: naira(40_000) })).json();
    await progressPayouts(t.db, paystack, { now: new Date(Date.now() + 25 * 3600_000) });
    const ref = (await t.db.selectFrom("payouts").select("reference").where("id", "=", payout.id).executeTakeFirstOrThrow()).reference;
    await sendWebhook(paystack.finishTransfer(ref, "success"));

    await h.call(organiser, "POST", `/pots/${pot.id}/cancel`, {});
    for (const p of people) {
      expect((await refundsOf(p.id, pot.id)).reduce((s, r) => s + r.amount_kobo, 0)).toBe(naira(15_000));
    }
  });

  it("waits for payouts in progress to land first", async () => {
    const { pot, organiser, people } = await scene();
    for (const p of people) await pay(p, pot.id, naira(25_000));
    await h.call(organiser, "POST", `/pots/${pot.id}/payouts`, { bankCode: "058", accountNumber: "0123456789", amountKobo: naira(10_000) });
    expect((await h.call(organiser, "POST", `/pots/${pot.id}/cancel`, {})).json().error.code).toBe("PAYOUTS_IN_PROGRESS");
  });
});

// ─────────────────────────────────────────────
describe("settling up leftover money (MON-17)", () => {
  async function confirmedWithLeftover() {
    const s = await scene();
    const amounts = [40_000, 30_000, 20_000, 10_000];
    for (const [i, a] of amounts.entries()) await pay(s.people[i]!, s.pot.id, naira(a));
    await setStage(t.db, s.pot.id, "confirmed");
    return { ...s, amounts };
  }

  it("lets the organiser refund what's left, in proportion to what each paid", async () => {
    const { pot, organiser, people, amounts } = await confirmedWithLeftover();
    const res = await h.call(organiser, "POST", `/pots/${pot.id}/settle`);
    expect(res.json()).toMatchObject({ leftoverKobo: naira(100_000), refunds: 4 });
    for (const [i, a] of amounts.entries()) {
      expect((await refundsOf(people[i]!.id, pot.id)).reduce((s, r) => s + r.amount_kobo, 0)).toBe(naira(a));
    }
  });

  it("is the organiser's call alone, once confirmed, and only when something is left", async () => {
    const { pot, organiser, members } = await confirmedWithLeftover();
    await t.db.updateTable("pot_members").set({ role: "co_organiser" }).where("user_id", "=", members[0].id).execute();
    expect((await h.call(members[0], "POST", `/pots/${pot.id}/settle`)).statusCode).toBe(403);
    await h.call(organiser, "POST", `/pots/${pot.id}/settle`);
    expect((await h.call(organiser, "POST", `/pots/${pot.id}/settle`)).json().error.code).toBe("NOTHING_LEFT");

    const { pot: early, organiser: o2 } = await scene();
    expect((await h.call(o2, "POST", `/pots/${early.id}/settle`)).json().error.code).toBe("NOT_READY_TO_SETTLE");
  });
});

// ─────────────────────────────────────────────
describe("when the bank needs the member's account", () => {
  it("asks the member, checks the account with the bank, and passes it to Paystack", async () => {
    const { pot, members } = await scene();
    const [ada] = members;
    await pay(ada, pot.id, naira(25_000));
    paystack.refundMode = "needs-attention";
    await h.call(ada, "POST", `/pots/${pot.id}/leave`);

    const [refund] = await refundsOf(ada.id, pot.id);
    expect(refund?.status).toBe("needs_details");
    const note = (await h.call(ada, "GET", "/notifications")).json().items.find((n: { type: string }) => n.type === "refund_needs_details");
    expect(note.link).toBe(`http://localhost:5173/refunds/${refund!.id}`);

    expect((await h.call(members[1], "POST", `/refunds/${refund!.id}/account`, { bankCode: "058", accountNumber: "2222222222" })).statusCode).toBe(404);
    expect((await h.call(ada, "POST", `/refunds/${refund!.id}/account`, { bankCode: "058", accountNumber: "9999999999" })).json().error.code).toBe("ACCOUNT_NOT_FOUND");

    const res = await h.call(ada, "POST", `/refunds/${refund!.id}/account`, { bankCode: "058", accountNumber: "2222222222" });
    expect(res.json()).toEqual({ status: "requested", accountName: "ADA OBI" });
    expect(paystack.refunds.get(Number(refund!.provider_refund_id))?.account).toEqual({ accountNumber: "2222222222", bankId: 9 });
    expect((await refundsOf(ada.id, pot.id))[0]).toMatchObject({ refund_account_last4: "2222" });

    await finishAllRefunds(pot.id);
    expect((await refundsOf(ada.id, pot.id))[0]?.status).toBe("processed");
  });
});

// ─────────────────────────────────────────────
describe("when a refund can't be done", () => {
  it("puts the money back in the pot, tells the member, and shows support", async () => {
    const admin = await h.signIn();
    await t.db.updateTable("users").set({ is_admin: true }).where("id", "=", admin.id).execute();
    const { pot, organiser, members } = await scene();
    await pay(members[0], pot.id, naira(25_000));
    paystack.refundMode = "reject";
    await h.call(members[0], "POST", `/pots/${pot.id}/leave`);

    expect((await refundsOf(members[0].id, pot.id))[0]?.status).toBe("failed");
    expect(await ledger(organiser, pot.id)).toMatchObject({ availableKobo: naira(25_000), reservedKobo: 0 });
    expect(await h.typesFor(members[0].id, pot.id)).toContain("refund_failed");
    expect((await h.call(admin, "GET", "/admin/refunds?status=failed")).json().map((r: { pot_id: string }) => r.pot_id)).toContain(pot.id);
  });

  it("never refunds twice when Paystack's answer gets lost", async () => {
    const { pot, members } = await scene();
    const ref = await pay(members[0], pot.id, naira(25_000));
    paystack.loseNextRefundReply = true; // Paystack creates it, but we never hear back
    await h.call(members[0], "POST", `/pots/${pot.id}/leave`);
    const [refund] = await refundsOf(members[0].id, pot.id);
    expect(refund?.status).toBe("reserved");

    await progressRefunds(t.db, paystack); // too soon to ask again
    await t.db.updateTable("refunds").set({ requested_at: new Date(Date.now() - 11 * 60_000) }).where("id", "=", refund!.id).execute();
    await progressRefunds(t.db, paystack); // finds the one Paystack already made

    expect([...paystack.refunds.values()].filter((r) => r.transactionReference === ref)).toHaveLength(1);
    expect((await refundsOf(members[0].id, pot.id))[0]?.status).toBe("requested");
  });

  it("is asked for once even when several workers run at once", async () => {
    const { pot, members } = await scene();
    const ref = await pay(members[0], pot.id, naira(25_000));
    paystack.loseNextRefundReply = true;
    await h.call(members[0], "POST", `/pots/${pot.id}/leave`);
    await t.db.updateTable("refunds").set({ requested_at: new Date(Date.now() - 11 * 60_000) }).where("pot_id", "=", pot.id).execute();
    await Promise.all([1, 2, 3].map(() => progressRefunds(t.db, paystack)));
    expect([...paystack.refunds.values()].filter((r) => r.transactionReference === ref)).toHaveLength(1);
  });
});

describe("refund records", () => {
  it("can never add up to more than a payment's share", async () => {
    const { pot, members } = await scene();
    await pay(members[0], pot.id, naira(25_000));
    await h.call(members[0], "POST", `/pots/${pot.id}/leave`);
    const [refund] = await refundsOf(members[0].id, pot.id);
    await expect(
      t.db.insertInto("refunds").values({ pot_id: pot.id, user_id: members[0].id, payment_id: refund!.payment_id, amount_kobo: 100, reason: "leftover", reserve_txn_id: refund!.reserve_txn_id }).execute(),
    ).rejects.toThrow(/would exceed its share/);
  });

  it("are listed for the member across pots", async () => {
    const { pot, members } = await scene();
    await pay(members[0], pot.id, naira(25_000));
    await h.call(members[0], "POST", `/pots/${pot.id}/leave`);
    const mine = (await h.call(members[0], "GET", "/refunds/mine")).json();
    expect(mine[0]).toMatchObject({ potId: pot.id, amountKobo: naira(25_000), reason: "member_left" });
  });

  it("webhooks about refunds that aren't DettyPot's are ignored", async () => {
    expect((await sendWebhook(paystack.webhook("refund.processed", { transaction_reference: "someone-else", amount: "100" }))).statusCode).toBe(200);
  });
});
