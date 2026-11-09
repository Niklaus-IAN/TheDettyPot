import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearBankCache } from "../src/payouts/service.js";
import { closeDueRollovers } from "../src/rollovers/service.js";
import { apiFor, inDays, type Person } from "./api.js";
import { FakePaystack } from "./fake-paystack.js";
import { naira, setStage } from "./fixtures.js";
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
  paystack.refundMode = "pending";
  clearBankCache();
});

const h = apiFor(() => t);
const sendWebhook = (hook: { body: string; signature: string }) =>
  t.app.inject({ method: "POST", url: "/webhooks/paystack", headers: { "content-type": "application/json", "x-paystack-signature": hook.signature }, payload: hook.body });

async function pay(who: Person, potId: string, amountKobo: number) {
  const p = (await h.call(who, "POST", `/pots/${potId}/payments`, { amountKobo, method: "bank_transfer" })).json();
  await sendWebhook(paystack.pay(p.reference));
  return p.reference as string;
}

/**
 * Last outing (A) is confirmed with ₦100,000 left: Tolu ₦40k, Ada ₦30k, Bayo ₦20k, Chidi ₦10k.
 * Tolu also organises the next outing (B), still collecting.
 */
async function scene(opts: { nextHeadcount?: number; nextBudget?: number } = {}) {
  const people = await Promise.all(["Tolu", "Ada", "Bayo", "Chidi"].map((name) => h.signIn({ name })));
  const [tolu, ada, bayo, chidi] = people as [Person, Person, Person, Person];
  const last = await h.createPot(tolu, { name: "December beach day", budgetKobo: naira(100_000), headcount: 4, fundingDeadline: inDays(10).toISOString() });
  for (const p of [ada, bayo, chidi]) await h.join(last.id, p.id);
  await h.call(tolu, "POST", `/pots/${last.id}/stage`, { to: "collecting" });
  for (const [p, amount] of [[tolu, 40_000], [ada, 30_000], [bayo, 20_000], [chidi, 10_000]] as const) await pay(p, last.id, naira(amount));
  await setStage(t.db, last.id, "confirmed");

  const next = await h.createPot(tolu, {
    name: "Easter getaway",
    budgetKobo: naira(opts.nextBudget ?? 600_000),
    headcount: opts.nextHeadcount ?? 6,
    fundingDeadline: inDays(30).toISOString(),
  });
  await h.call(tolu, "POST", `/pots/${next.id}/stage`, { to: "collecting" });
  return { last, next, tolu, ada, bayo, chidi };
}

const offer = (who: Person, potId: string, targetPotId: string) => h.call(who, "POST", `/pots/${potId}/settle`, { mode: "rollover", targetPotId });
const choose = (who: Person, rolloverId: string, choice: "move" | "refund") => h.call(who, "POST", `/rollovers/${rolloverId}/choice`, { choice });
const ledger = async (who: Person, potId: string) => (await h.call(who, "GET", `/pots/${potId}/ledger`)).json();
const potView = async (who: Person, potId: string) => (await h.call(who, "GET", `/pots/${potId}`)).json();

// ─────────────────────────────────────────────
describe("offering a roll-over", () => {
  it("sets each contributor's part aside, in proportion, and asks each of them", async () => {
    const { last, next, tolu, ada } = await scene();
    const res = await offer(tolu, last.id, next.id);
    expect(res.json()).toMatchObject({ mode: "rollover", leftoverKobo: naira(100_000) });
    expect(await ledger(tolu, last.id)).toMatchObject({ availableKobo: 0, reservedKobo: naira(100_000) });

    const mine = (await h.call(ada, "GET", `/rollovers/${res.json().rolloverId}`)).json();
    expect(mine).toMatchObject({ amountKobo: naira(30_000), choice: "pending", fromPot: { name: "December beach day" }, toPot: { name: "Easter getaway" } });
    expect(await h.typesFor(ada.id, last.id)).toContain("rollover_offer");
  });

  it("can't go into someone else's pot, a closed pot, or the same pot", async () => {
    const { last, next, tolu } = await scene();
    const stranger = await h.signIn();
    const theirs = await h.createPot(stranger);
    expect((await offer(tolu, last.id, theirs.id)).statusCode).toBe(403);
    expect((await offer(tolu, last.id, last.id)).json().error.code).toBe("SAME_POT");
    await setStage(t.db, next.id, "funded");
    expect((await offer(tolu, last.id, next.id)).json().error.code).toBe("TARGET_NOT_OPEN");
  });

  it("waits until the outing is confirmed, and is one offer at a time", async () => {
    const { last, next, tolu } = await scene();
    await offer(tolu, last.id, next.id);
    expect((await offer(tolu, last.id, next.id)).json().error.code).toBe("ROLLOVER_OPEN");
    const early = await h.createPot(tolu, { fundingDeadline: inDays(5).toISOString() });
    expect((await offer(tolu, early.id, next.id)).json().error.code).toBe("NOT_READY_TO_SETTLE");
  });
});

// ─────────────────────────────────────────────
describe("choosing", () => {
  it("moves a part into the new pot, where it counts as paid and the member joins", async () => {
    const { last, next, tolu, ada } = await scene();
    const { rolloverId } = (await offer(tolu, last.id, next.id)).json();
    expect((await choose(ada, rolloverId, "move")).statusCode).toBe(200);

    const there = await potView(ada, next.id);
    expect(there).toMatchObject({ myRole: "member", myPaidKobo: naira(30_000), raisedKobo: naira(30_000) });
    expect((await ledger(tolu, last.id)).lines[0].description).toBe("Ada moved ₦30,000 to Easter getaway");
    expect((await ledger(tolu, next.id)).lines[0].description).toBe("Ada brought ₦30,000 over from December beach day");
    expect(await h.typesFor(ada.id, next.id)).toContain("rollover_moved");
    expect(await h.typesFor(tolu.id, next.id)).toContain("contribution_received");
  });

  it("refunds a part to anyone who asks for that instead", async () => {
    const { last, next, tolu, bayo } = await scene();
    const { rolloverId } = (await offer(tolu, last.id, next.id)).json();
    await choose(bayo, rolloverId, "refund");
    const refunds = await t.db.selectFrom("refunds").selectAll().where("pot_id", "=", last.id).where("user_id", "=", bayo.id).execute();
    expect(refunds.map((r) => [r.amount_kobo, r.reason, r.status])).toEqual([[naira(20_000), "leftover", "requested"]]);
  });

  it("is one choice per person, made only by that person", async () => {
    const { last, next, tolu, ada } = await scene();
    const { rolloverId } = (await offer(tolu, last.id, next.id)).json();
    expect((await choose(await h.signIn(), rolloverId, "move")).statusCode).toBe(404);
    await choose(ada, rolloverId, "move");
    expect((await choose(ada, rolloverId, "refund")).json().error.code).toBe("ALREADY_CHOSEN");
  });

  it("counts a double-tap once", async () => {
    const { last, next, tolu, ada } = await scene();
    const { rolloverId } = (await offer(tolu, last.id, next.id)).json();
    const results = await Promise.all([choose(ada, rolloverId, "move"), choose(ada, rolloverId, "move")]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await potView(ada, next.id)).myPaidKobo).toBe(naira(30_000));
  });

  it("can't move into a full pot: the member is asked to choose a refund", async () => {
    const { last, next, tolu, ada } = await scene({ nextHeadcount: 2, nextBudget: 100_000 });
    const filler = await h.signIn();
    await h.join(next.id, filler.id); // Tolu + filler: full
    const { rolloverId } = (await offer(tolu, last.id, next.id)).json();
    expect((await choose(ada, rolloverId, "move")).json().error.code).toBe("POT_FULL");
    expect((await choose(ada, rolloverId, "refund")).statusCode).toBe(200);
  });

  it("can fund the new pot on its own", async () => {
    const { last, next, tolu, ada } = await scene({ nextBudget: 60_000, nextHeadcount: 2 });
    const { rolloverId } = (await offer(tolu, last.id, next.id)).json();
    await choose(tolu, rolloverId, "move");
    expect((await potView(tolu, next.id)).stage).toBe("collecting");
    await choose(ada, rolloverId, "move");
    expect((await potView(tolu, next.id)).stage).toBe("funded");
  });
});

// ─────────────────────────────────────────────
describe("the deadline", () => {
  it("refunds everyone who didn't choose, then closes the offer", async () => {
    const { last, next, tolu, ada, bayo, chidi } = await scene();
    const { rolloverId } = (await offer(tolu, last.id, next.id)).json();
    await choose(ada, rolloverId, "move");

    await closeDueRollovers(t.db, { now: new Date(Date.now() + 73 * 3600_000) });
    for (const [p, amount] of [[tolu, 40_000], [bayo, 20_000], [chidi, 10_000]] as const) {
      const refunded = await t.db.selectFrom("refunds").select("amount_kobo").where("pot_id", "=", last.id).where("user_id", "=", p.id).execute();
      expect(refunded.reduce((s, r) => s + r.amount_kobo, 0)).toBe(naira(amount));
    }
    const choices = await t.db.selectFrom("rollover_choices").select(["user_id", "choice", "decided_by"]).where("rollover_id", "=", rolloverId).execute();
    expect(choices.filter((c) => c.decided_by === "deadline")).toHaveLength(3);
    expect((await h.call(tolu, "GET", `/pots/${last.id}/rollovers`)).json()[0].status).toBe("closed");
    expect((await choose(bayo, rolloverId, "move")).json().error.code).toBe("ALREADY_CHOSEN");
  });

  it("won't take a late choice from someone the deadline already decided for", async () => {
    const { last, next, tolu, ada } = await scene();
    const { rolloverId } = (await offer(tolu, last.id, next.id)).json();
    await t.db.updateTable("rollovers").set({ consent_deadline: new Date(Date.now() - 1000) }).where("id", "=", rolloverId).execute();
    expect((await choose(ada, rolloverId, "move")).json().error.code).toBe("ROLLOVER_CLOSED");
  });
});

// ─────────────────────────────────────────────
describe("money that moved can still be refunded", () => {
  it("against the payment it originally came from", async () => {
    const { last, next, tolu, ada } = await scene();
    const original = await t.db.selectFrom("payments").select(["id", "reference"]).where("pot_id", "=", last.id).where("user_id", "=", ada.id).executeTakeFirstOrThrow();
    const { rolloverId } = (await offer(tolu, last.id, next.id)).json();
    await choose(ada, rolloverId, "move");

    await h.call(tolu, "POST", `/pots/${next.id}/cancel`, { reason: "Plans changed" });
    const [refund] = await t.db.selectFrom("refunds").selectAll().where("pot_id", "=", next.id).where("user_id", "=", ada.id).execute();
    expect(refund).toMatchObject({ payment_id: original.id, amount_kobo: naira(30_000), reason: "pot_cancelled" });
    expect(paystack.refundFor(original.reference)?.amountKobo).toBe(naira(30_000));
  });
});
