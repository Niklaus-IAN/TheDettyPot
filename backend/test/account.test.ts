import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sendPaymentReminders } from "../src/worker/tasks.js";
import { apiFor, inDays, type Person } from "./api.js";
import { FakePaystack } from "./fake-paystack.js";
import { naira } from "./fixtures.js";
import { bearer, makeTestApp, signToken, type TestApp } from "./helpers.js";

const paystack = new FakePaystack();
let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp({ PAYSTACK_SECRET_KEY: paystack.secretKey }, { paystack });
});
afterAll(async () => {
  await t.close();
});

const h = apiFor(() => t);
const sendWebhook = (hook: { body: string; signature: string }) =>
  t.app.inject({ method: "POST", url: "/webhooks/paystack", headers: { "content-type": "application/json", "x-paystack-signature": hook.signature }, payload: hook.body });
const pay = async (who: Person, potId: string, amountKobo: number) => {
  const p = (await h.call(who, "POST", `/pots/${potId}/payments`, { amountKobo, method: "bank_transfer" })).json();
  await sendWebhook(paystack.pay(p.reference));
};

async function collectingPot() {
  const [organiser, member] = await Promise.all([h.signIn({ name: "Tolu" }), h.signIn({ name: "Ada" })]);
  const pot = await h.createPot(organiser, { name: "Friday dinner", budgetKobo: naira(50_000), headcount: 4, fundingDeadline: inDays(10).toISOString() });
  await h.join(pot.id, member.id);
  await h.call(organiser, "POST", `/pots/${pot.id}/stage`, { to: "collecting" });
  return { pot, organiser, member };
}

const deleteAccount = (who: Person, body: object = { confirm: "DELETE" }) => h.call(who, "POST", "/me/delete", body);

// ─────────────────────────────────────────────
describe("reminder frequency (FR-NOT-03)", () => {
  it("is each member's own choice, per pot, and shows on the pot page", async () => {
    const { pot, member, organiser } = await collectingPot();
    expect((await h.call(member, "GET", `/pots/${pot.id}`)).json().myReminderFrequency).toBe("every_3_days");
    const res = await h.call(member, "PATCH", `/pots/${pot.id}/me`, { reminderFrequency: "weekly" });
    expect(res.json()).toEqual({ reminderFrequency: "weekly" });
    expect((await h.call(member, "GET", `/pots/${pot.id}`)).json().myReminderFrequency).toBe("weekly");
    expect((await h.call(organiser, "GET", `/pots/${pot.id}`)).json().myReminderFrequency).toBe("every_3_days");
  });

  it("switched off, stops reminders", async () => {
    const { pot, member } = await collectingPot();
    await h.call(member, "PATCH", `/pots/${pot.id}/me`, { reminderFrequency: "off" });
    await t.db.updateTable("pot_members").set({ joined_at: inDays(-10) }).where("pot_id", "=", pot.id).execute();
    await t.db.updateTable("pots").set({ stage_changed_at: inDays(-10) }).where("id", "=", pot.id).execute();
    const now = new Date();
    now.setUTCHours(10); // 11:00 in Lagos
    await sendPaymentReminders(t.db, { now });
    expect(await h.typesFor(member.id, pot.id)).not.toContain("reminder");
  });

  it("only takes the four choices, and only from members", async () => {
    const { pot, member } = await collectingPot();
    expect((await h.call(member, "PATCH", `/pots/${pot.id}/me`, { reminderFrequency: "hourly" })).statusCode).toBe(400);
    expect((await h.call(await h.signIn(), "PATCH", `/pots/${pot.id}/me`, { reminderFrequency: "daily" })).statusCode).toBe(404);
  });
});

// ─────────────────────────────────────────────
describe("exporting my data (NFR-08)", () => {
  it("includes my profile, pots, payments and activity, and nobody else's", async () => {
    const { pot, member, organiser } = await collectingPot();
    await pay(member, pot.id, naira(5_000));
    await pay(organiser, pot.id, naira(7_000));

    const res = await h.call(member, "GET", "/me/export");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain("dettypot-my-data.json");
    const data = res.json();
    expect(data.profile).toMatchObject({ fullName: "Ada", emailVerified: true });
    expect(data.memberships).toEqual([expect.objectContaining({ pot_name: "Friday dinner", role: "member", status: "active" })]);
    expect(data.payments).toHaveLength(1);
    expect(data.payments[0]).toMatchObject({ share_kobo: naira(5_000), status: "succeeded" });
    expect(JSON.stringify(data)).not.toContain(organiser.id);
  });
});

// ─────────────────────────────────────────────
describe("deleting my account (NFR-08)", () => {
  it("needs an explicit confirmation", async () => {
    expect((await deleteAccount(await h.signIn(), {})).statusCode).toBe(400);
    expect((await deleteAccount(await h.signIn(), { confirm: "yes" })).statusCode).toBe(400);
  });

  it("removes everything that identifies me, leaves my live pots, and clears my inbox", async () => {
    const { pot, member } = await collectingPot();
    await h.call(member, "PATCH", "/me", { fullName: "Ada Obi", avatarEmoji: "💃" });
    expect((await deleteAccount(member)).statusCode).toBe(200);

    const row = await t.db.selectFrom("users").selectAll().where("id", "=", member.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ email: null, full_name: null, avatar_emoji: null, auth_subject: null, is_admin: false });
    expect(row.deleted_at).not.toBeNull();
    expect((await h.membership(pot.id, member.id))?.status).toBe("left");
    expect(await h.typesFor(member.id)).toEqual([]);
    expect((await h.call(member, "GET", "/me")).statusCode).toBe(200); // a fresh account, see below
  });

  it("keeps money records, attributed to an anonymous member", async () => {
    const { pot, member, organiser } = await collectingPot();
    await pay(member, pot.id, naira(5_000));
    await t.db.updateTable("pots").set({ stage: "funded" }).where("id", "=", pot.id).execute();
    await t.db.updateTable("pots").set({ stage: "confirmed" }).where("id", "=", pot.id).execute();
    await t.db.updateTable("pots").set({ stage: "completed" }).where("id", "=", pot.id).execute();

    expect((await deleteAccount(member)).statusCode).toBe(200);
    const ledger = (await h.call(organiser, "GET", `/pots/${pot.id}/ledger`)).json();
    expect(ledger.lines.find((l: { kind: string }) => l.kind === "contribution")).toMatchObject({ memberUserId: member.id, memberName: null, potAmountKobo: naira(5_000) });
    expect(await t.db.selectFrom("payments").select("id").where("user_id", "=", member.id).execute()).toHaveLength(1);
  });

  it("starts a brand-new account if the same person signs in again", async () => {
    const subject = "test|comes-back";
    const first = await h.signIn({ subject, email: "back.again@example.com" });
    await deleteAccount(first);
    const again = await t.app.inject({ method: "GET", url: "/me", headers: bearer(await signToken({ subject, email: "back.again@example.com" })) });
    expect(again.statusCode).toBe(200);
    expect(again.json().id).not.toBe(first.id);
  });

  it("is refused while I organise a live pot", async () => {
    const { organiser } = await collectingPot();
    const res = await deleteAccount(organiser);
    expect(res.json().error).toMatchObject({ code: "STILL_ORGANISING" });
    expect(res.json().error.message).toContain("Friday dinner");
  });

  it("is refused while I have money in a live pot", async () => {
    const { pot, member } = await collectingPot();
    await pay(member, pot.id, naira(5_000));
    expect((await deleteAccount(member)).json().error.code).toBe("MONEY_IN_POTS");
  });

  it("is refused while a payment or a refund of mine is still under way", async () => {
    const { pot, member } = await collectingPot();
    await h.call(member, "POST", `/pots/${pot.id}/payments`, { amountKobo: naira(5_000), method: "card" });
    expect((await deleteAccount(member)).json().error.code).toBe("PAYMENTS_IN_PROGRESS");

    const other = await collectingPot();
    await pay(other.member, other.pot.id, naira(5_000));
    await h.call(other.member, "POST", `/pots/${other.pot.id}/leave`); // refund requested, not finished
    expect((await deleteAccount(other.member)).json().error.code).toBe("REFUNDS_IN_PROGRESS");
  });
});
