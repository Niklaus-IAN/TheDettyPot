import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { naira as formatNaira, render } from "../src/notifications/catalog.js";
import { MemoryEmailSender, type EmailMessage } from "../src/notifications/email.js";
import { notifyUser } from "../src/notifications/service.js";
import {
  deliverEmails,
  MAX_ATTEMPTS,
  sendDeadlinePassedAlerts,
  sendDeadlineWarnings,
  sendPaymentReminders,
} from "../src/worker/tasks.js";
import { apiFor, inDays, type Person } from "./api.js";
import { naira, recordContribution, sleep } from "./fixtures.js";
import { makeTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
});
afterAll(async () => {
  await t.close();
});

const h = apiFor(() => t);
const WEB = "http://localhost:5173";
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/**
 * A worker clock a second ahead. Postgres stamps rows to the microsecond while
 * JS dates stop at the millisecond, so "now" read right after queueing an email
 * can look a hair earlier than the email itself.
 */
const soon = () => new Date(Date.now() + 1000);

/** Sets aside everything already queued, so each test sees only its own emails. */
const clearOutbox = () =>
  t.db.updateTable("notification_deliveries").set({ status: "skipped" }).where("status", "=", "pending").execute();

const deliveryFor = async (userId: string, type: string) =>
  t.db
    .selectFrom("notification_deliveries as d")
    .innerJoin("notifications as n", "n.id", "d.notification_id")
    .selectAll("d")
    .where("n.user_id", "=", userId)
    .where("n.type", "=", type)
    .executeTakeFirst();

/** A collecting pot whose collection opened, and whose member joined, `daysAgo` days before `now` (default 4: past the default 3-day reminder interval). */
async function collectingPot(now: Date, opts: { daysAgo?: number; budget?: number; headcount?: number; deadline?: Date } = {}) {
  const [organiser, member] = await Promise.all([h.signIn(), h.signIn()]);
  const pot = await h.createPot(organiser, {
    budgetKobo: naira(opts.budget ?? 100_000),
    headcount: opts.headcount ?? 4,
    fundingDeadline: inDays(30).toISOString(),
  });
  await h.join(pot.id, member.id);
  await h.call(organiser, "POST", `/pots/${pot.id}/stage`, { to: "collecting" });
  const since = new Date(now.getTime() - (opts.daysAgo ?? 4) * DAY);
  await t.db.updateTable("pots").set({ stage_changed_at: since, funding_deadline: opts.deadline ?? inDays(30) }).where("id", "=", pot.id).execute();
  await t.db.updateTable("pot_members").set({ joined_at: since }).where("pot_id", "=", pot.id).execute();
  return { pot, organiser, member };
}

/** Tomorrow at the given hour in Lagos (UTC+1, no daylight saving). */
function lagos(hour: number, dayOffset = 1) {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + dayOffset, hour - 1));
}

const remindersFor = (person: Person, potId: string) =>
  t.db.selectFrom("notifications").select("payload").where("user_id", "=", person.id).where("pot_id", "=", potId).where("type", "=", "reminder").execute();

// ─────────────────────────────────────────────
describe("notification wording", () => {
  const ctx = { pot: { id: "p1", name: "Beach day", shareKobo: naira(25_000), fundingDeadline: null, timezone: "Africa/Lagos" }, webBaseUrl: WEB };

  it("formats money in naira", () => {
    expect(formatNaira(naira(1_250_000))).toBe("₦1,250,000");
  });

  it("names the pot and the amount", () => {
    expect(render("budget_changed", { ...ctx, payload: { shareKobo: naira(30_000) } }).title).toBe(
      "Your share for Beach day is now ₦30,000",
    );
  });

  it("links to the pot by default, the invite for invites, and nowhere for people who are out", () => {
    expect(render("pot_funded", { ...ctx, payload: {} }).link).toBe(`${WEB}/pots/p1`);
    expect(render("pot_invite", { ...ctx, payload: { url: `${WEB}/join/abc` } }).link).toBe(`${WEB}/join/abc`);
    expect(render("removed_from_pot", { ...ctx, payload: {} }).link).toBeNull();
  });
});

// ─────────────────────────────────────────────
describe("in-app notifications", () => {
  it("queue an email only for the types that send one", async () => {
    const person = await h.signIn();
    await notifyUser(t.db, person.id, null, "join_requested", { name: "Ada" });
    await notifyUser(t.db, person.id, null, "member_joined", { name: "Ada" });
    expect(await deliveryFor(person.id, "join_requested")).toBeTruthy();
    expect(await deliveryFor(person.id, "member_joined")).toBeUndefined();
  });

  it("are listed newest first with readable text and an unread count", async () => {
    const { pot, organiser, member } = await collectingPot(new Date());
    await h.call(organiser, "PATCH", `/pots/${pot.id}`, { budgetKobo: naira(120_000) });
    const res = await h.call(member, "GET", "/notifications");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items[0]).toMatchObject({ type: "budget_changed", potId: pot.id, read: false, link: `${WEB}/pots/${pot.id}` });
    expect(body.items[0].title).toContain("₦30,000");
    expect(body.unreadCount).toBe(body.items.length);
  });

  it("page backwards with `before`", async () => {
    const person = await h.signIn();
    for (const type of ["join_approved", "co_organiser_added", "pot_funded"] as const) {
      await notifyUser(t.db, person.id, null, type, {});
      await sleep(5);
    }
    const first = (await h.call(person, "GET", "/notifications?limit=2")).json();
    expect(first.items.map((i: { type: string }) => i.type)).toEqual(["pot_funded", "co_organiser_added"]);
    const next = (await h.call(person, "GET", `/notifications?limit=2&before=${encodeURIComponent(first.items[1].createdAt)}`)).json();
    expect(next.items.map((i: { type: string }) => i.type)).toEqual(["join_approved"]);
  });

  it("are marked read one by one or all at once, only for their owner", async () => {
    const [me, other] = await Promise.all([h.signIn(), h.signIn()]);
    await notifyUser(t.db, me.id, null, "join_approved", {});
    await notifyUser(t.db, me.id, null, "pot_funded", {});
    await notifyUser(t.db, other.id, null, "pot_funded", {});
    const mine = (await h.call(me, "GET", "/notifications")).json().items;
    const theirs = (await h.call(other, "GET", "/notifications")).json().items;

    expect((await h.call(me, "POST", "/notifications/read", { ids: [mine[0].id, theirs[0].id] })).json().unreadCount).toBe(1);
    expect((await h.call(other, "GET", "/notifications")).json().unreadCount).toBe(1); // untouched
    expect((await h.call(me, "POST", "/notifications/read", {})).json().unreadCount).toBe(0);
  });

  it("need sign-in", async () => {
    expect((await h.call(null, "GET", "/notifications")).statusCode).toBe(401);
  });
});

// ─────────────────────────────────────────────
describe("email delivery", () => {
  beforeEach(clearOutbox);

  it("sends each queued email once, rendered with its wording", async () => {
    const person = await h.signIn({ email: "deliver.me@example.com" });
    await notifyUser(t.db, person.id, null, "join_approved", {});
    const sender = new MemoryEmailSender();

    expect(await deliverEmails(t.db, sender, { webBaseUrl: WEB, now: soon() })).toMatchObject({ sent: 1 });
    expect(sender.sent).toEqual([expect.objectContaining({ to: "deliver.me@example.com", subject: expect.stringContaining("You're in") })]);
    expect((await deliveryFor(person.id, "join_approved"))?.status).toBe("sent");

    expect(await deliverEmails(t.db, sender, { webBaseUrl: WEB, now: soon() })).toMatchObject({ sent: 0 });
    expect(sender.sent).toHaveLength(1);
  });

  it("retries after a failure, waiting before the next attempt", async () => {
    const person = await h.signIn();
    await notifyUser(t.db, person.id, null, "pot_funded", {});
    const sender = new MemoryEmailSender();
    sender.failuresLeft = 1;
    const now = soon();

    expect(await deliverEmails(t.db, sender, { webBaseUrl: WEB, now })).toMatchObject({ retrying: 1 });
    const waiting = await deliveryFor(person.id, "pot_funded");
    expect(waiting).toMatchObject({ status: "pending", attempts: 1, last_error: "simulated provider outage" });
    expect(waiting!.next_attempt_at.getTime()).toBe(now.getTime() + 60_000);

    expect(await deliverEmails(t.db, sender, { webBaseUrl: WEB, now })).toMatchObject({ sent: 0 }); // too soon
    expect(await deliverEmails(t.db, sender, { webBaseUrl: WEB, now: new Date(now.getTime() + 2 * 60_000) })).toMatchObject({ sent: 1 });
  });

  it("gives up after the last attempt", async () => {
    const person = await h.signIn();
    await notifyUser(t.db, person.id, null, "pot_funded", {});
    const sender = new MemoryEmailSender();
    sender.failuresLeft = 100;
    let now = soon();
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await deliverEmails(t.db, sender, { webBaseUrl: WEB, now });
      now = new Date(now.getTime() + DAY);
    }
    expect(await deliveryFor(person.id, "pot_funded")).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS });
  });

  it("skips people who deleted their account after the email was queued", async () => {
    const person = await h.signIn();
    await notifyUser(t.db, person.id, null, "pot_funded", {});
    await t.db
      .updateTable("users")
      .set({ deleted_at: new Date(), auth_subject: null, email: null, email_verified_at: null, full_name: null })
      .where("id", "=", person.id)
      .execute();
    expect(await deliverEmails(t.db, new MemoryEmailSender(), { webBaseUrl: WEB, now: soon() })).toMatchObject({ skipped: 1 });
  });

  it("never sends the same email twice when several workers run at once", async () => {
    const people = await Promise.all(Array.from({ length: 6 }, () => h.signIn()));
    for (const p of people) await notifyUser(t.db, p.id, null, "pot_funded", {});

    // A slow provider keeps each worker mid-send, so they overlap.
    const sent: EmailMessage[] = [];
    const slow = { send: async (m: EmailMessage) => (await sleep(40), sent.push(m), { messageId: `slow-${sent.length}` }) };
    await Promise.all([1, 2, 3].map(() => deliverEmails(t.db, slow, { webBaseUrl: WEB, now: soon() })));

    expect(sent).toHaveLength(6);
    expect(new Set(sent.map((m) => m.to)).size).toBe(6);
  });
});

// ─────────────────────────────────────────────
describe("payment reminders", () => {
  it("go to members who still owe, at their chosen frequency", async () => {
    const now = lagos(10);
    const { pot, member } = await collectingPot(now); // ₦25,000 each
    await recordContribution(t.db, pot.id, member.id, naira(10_000));

    await sendPaymentReminders(t.db, { now });
    expect(await remindersFor(member, pot.id)).toEqual([{ payload: { owedKobo: naira(15_000) } }]);

    await sendPaymentReminders(t.db, { now: new Date(now.getTime() + HOUR) }); // too soon (every 3 days)
    expect(await remindersFor(member, pot.id)).toHaveLength(1);
    await sendPaymentReminders(t.db, { now: new Date(now.getTime() + 3 * DAY) });
    expect(await remindersFor(member, pot.id)).toHaveLength(2);
  });

  it("skip members who have paid in full or switched reminders off", async () => {
    const now = lagos(11);
    const { pot, organiser, member } = await collectingPot(now);
    await recordContribution(t.db, pot.id, organiser.id, naira(25_000));
    await t.db.updateTable("pot_members").set({ reminder_frequency: "off" }).where("user_id", "=", member.id).execute();
    await sendPaymentReminders(t.db, { now });
    expect(await remindersFor(organiser, pot.id)).toEqual([]);
    expect(await remindersFor(member, pot.id)).toEqual([]);
  });

  it("wait a full interval: a week for weekly reminders", async () => {
    const now = lagos(12);
    const { pot, member } = await collectingPot(now, { daysAgo: 5 });
    await t.db.updateTable("pot_members").set({ reminder_frequency: "weekly" }).where("user_id", "=", member.id).execute();
    await sendPaymentReminders(t.db, { now });
    expect(await remindersFor(member, pot.id)).toEqual([]);
  });

  it("never go out at night", async () => {
    const night = lagos(22);
    const { pot, member } = await collectingPot(night);
    await sendPaymentReminders(t.db, { now: night });
    expect(await remindersFor(member, pot.id)).toEqual([]);
  });

  it("stop for frozen pots and once the deadline has passed", async () => {
    const now = lagos(10);
    const frozen = await collectingPot(now);
    await t.db.updateTable("pots").set({ frozen_at: now, frozen_by: frozen.organiser.id, frozen_reason: "check" }).where("id", "=", frozen.pot.id).execute();
    const late = await collectingPot(now, { deadline: new Date(now.getTime() - HOUR) });
    await sendPaymentReminders(t.db, { now });
    expect(await remindersFor(frozen.member, frozen.pot.id)).toEqual([]);
    expect(await remindersFor(late.member, late.pot.id)).toEqual([]);
  });

  it("go out once even when several workers run at once", async () => {
    const now = lagos(13);
    const { pot, member } = await collectingPot(now);
    await Promise.all([1, 2, 3].map(() => sendPaymentReminders(t.db, { now })));
    expect(await remindersFor(member, pot.id)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────
describe("deadline alerts", () => {
  it("warn members who still owe, once, two days before the deadline", async () => {
    const now = new Date();
    const { pot, organiser, member } = await collectingPot(now, { deadline: new Date(now.getTime() + DAY) });
    await recordContribution(t.db, pot.id, organiser.id, naira(25_000));

    await sendDeadlineWarnings(t.db, { now });
    await sendDeadlineWarnings(t.db, { now });
    expect(await h.typesFor(member.id, pot.id)).toEqual(expect.arrayContaining(["deadline_near"]));
    expect((await h.typesFor(member.id, pot.id)).filter((x) => x === "deadline_near")).toHaveLength(1);
    expect(await h.typesFor(organiser.id, pot.id)).not.toContain("deadline_near");
  });

  it("warn again when the deadline is moved", async () => {
    const now = new Date();
    const { pot, organiser, member } = await collectingPot(now, { deadline: new Date(now.getTime() + DAY) });
    await sendDeadlineWarnings(t.db, { now });
    await h.call(organiser, "PATCH", `/pots/${pot.id}`, { fundingDeadline: new Date(now.getTime() + 36 * HOUR).toISOString() });
    await sendDeadlineWarnings(t.db, { now });
    expect((await h.typesFor(member.id, pot.id)).filter((x) => x === "deadline_near")).toHaveLength(2);
  });

  it("ask the organisers to decide when the target is missed", async () => {
    const now = new Date();
    const { pot, organiser, member } = await collectingPot(now, { deadline: new Date(now.getTime() - HOUR) });
    await recordContribution(t.db, pot.id, member.id, naira(10_000));
    await sendDeadlinePassedAlerts(t.db, { now });
    await sendDeadlinePassedAlerts(t.db, { now });
    const alerts = await t.db
      .selectFrom("notifications")
      .select(["user_id", "payload"])
      .where("pot_id", "=", pot.id)
      .where("type", "=", "deadline_passed")
      .execute();
    expect(alerts).toEqual([{ user_id: organiser.id, payload: { raisedKobo: naira(10_000), budgetKobo: naira(100_000) } }]);
  });

  it("stay quiet when the target was met", async () => {
    const now = new Date();
    const { pot, organiser, member } = await collectingPot(now, { budget: 20_000, headcount: 2, deadline: new Date(now.getTime() - HOUR) });
    await recordContribution(t.db, pot.id, organiser.id, naira(10_000));
    await recordContribution(t.db, pot.id, member.id, naira(10_000));
    await sendDeadlinePassedAlerts(t.db, { now });
    expect(await h.typesFor(organiser.id, pot.id)).not.toContain("deadline_passed");
  });
});

// ─────────────────────────────────────────────
describe("email invites", () => {
  beforeEach(clearOutbox);

  async function invitedScene(email: string) {
    const organiser = await h.signIn({ name: "Ngozi" });
    const pot = await h.createPot(organiser);
    const res = await h.call(organiser, "POST", `/pots/${pot.id}/invites/email`, { email });
    return { organiser, pot, res };
  }

  async function emailedLink(to: string) {
    const sender = new MemoryEmailSender();
    await deliverEmails(t.db, sender, { webBaseUrl: WEB, now: soon() });
    const message = sender.sent.find((m) => m.to === to);
    const token = message?.text.match(/\/join\/([A-Za-z0-9_-]{16})/)?.[1];
    return { message, token: token! };
  }

  it("reach people who don't have an account yet, with a working link", async () => {
    const { res } = await invitedScene("new.friend@example.com");
    expect(res.statusCode).toBe(201);
    expect(res.json().kind).toBe("email");
    const { message, token } = await emailedLink("new.friend@example.com");
    expect(message?.subject).toBe("Ngozi invited you to December beach day");
    expect(message?.text).toContain("₦25,000");
    expect(token).toBeTruthy();
  });

  it("only work for the invited, verified address, and only once", async () => {
    const { pot, res } = await invitedScene("only.me@example.com");
    expect(res.statusCode).toBe(201);
    const { token } = await emailedLink("only.me@example.com");

    expect((await h.call(await h.signIn(), "POST", `/invites/${token}/join`)).statusCode).toBe(403);
    // The invited person signs in before verifying their email: not yet.
    const subject = "test|only-me";
    const unverified = await h.signIn({ subject, email: "only.me@example.com", emailVerified: false });
    expect((await h.call(unverified, "POST", `/invites/${token}/join`)).statusCode).toBe(403);
    // Same person, now verified (case of the address doesn't matter).
    const invited = await h.signIn({ subject, email: "ONLY.ME@example.com" });
    expect((await h.call(invited, "POST", `/invites/${token}/join`)).json()).toMatchObject({ potId: pot.id, status: "active" });
    expect((await h.call(invited, "POST", `/invites/${token}/join`)).json().alreadyMember).toBe(true);
  });

  it("go to an existing account's in-app notifications too", async () => {
    const friend = await h.signIn({ email: "has.account@example.com" });
    await invitedScene("has.account@example.com");
    expect(await h.typesFor(friend.id)).toContain("pot_invite");
  });

  it("aren't sent to someone already in the pot", async () => {
    const organiser = await h.signIn();
    const member = await h.signIn({ email: "already.in@example.com" });
    const pot = await h.createPot(organiser);
    await h.join(pot.id, member.id);
    const res = await h.call(organiser, "POST", `/pots/${pot.id}/invites/email`, { email: "already.in@example.com" });
    expect(res.json().error.code).toBe("ALREADY_MEMBER");
  });

  it("are capped per pot per day", async () => {
    const organiser = await h.signIn();
    const pot = await h.createPot(organiser);
    const { hashToken, newInviteToken } = await import("../src/members/service.js");
    await t.db
      .insertInto("pot_invites")
      .values(
        Array.from({ length: 50 }, (_, i) => ({
          pot_id: pot.id,
          created_by: organiser.id,
          kind: "email",
          token_hash: hashToken(newInviteToken()),
          invitee_email: `bulk${i}@example.com`,
          max_uses: 1,
        })),
      )
      .execute();
    const res = await h.call(organiser, "POST", `/pots/${pot.id}/invites/email`, { email: "one.more@example.com" });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("TOO_MANY_INVITES");
  });
});
