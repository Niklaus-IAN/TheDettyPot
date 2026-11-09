import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { naira, recordContribution, recordRefund, setStage } from "./fixtures.js";
import { bearer, makeTestApp, signToken, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
});
afterAll(async () => {
  await t.close();
});

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
interface Person {
  token: string;
  id: string;
}

async function signIn(opts: { emailVerified?: boolean } = {}): Promise<Person> {
  const token = await signToken(opts);
  const me = await t.app.inject({ method: "GET", url: "/me", headers: bearer(token) });
  return { token, id: me.json().id };
}

const api = (who: Person, method: "GET" | "POST" | "PATCH", url: string, payload?: object) =>
  t.app.inject({ method, url, headers: bearer(who.token), ...(payload !== undefined && { payload }) });

const day = 24 * 3600 * 1000;
const inDays = (n: number) => new Date(Date.now() + n * day);
const dateOnly = (d: Date) => d.toISOString().slice(0, 10);

const newPot = (overrides: object = {}) => ({
  name: "December beach day",
  vibe: "beach",
  budgetKobo: naira(200_000),
  headcount: 8,
  ...overrides,
});

const join = (potId: string, userId: string, overrides: object = {}) =>
  t.db.insertInto("pot_members").values({ pot_id: potId, user_id: userId, ...overrides }).execute();

/** A pot with an organiser, a co-organiser, a member and someone waiting to join. */
async function setupPot(overrides: object = {}) {
  const [organiser, co, member, pending] = await Promise.all([signIn(), signIn(), signIn(), signIn()]);
  const res = await api(organiser, "POST", "/pots", newPot(overrides));
  expect(res.statusCode).toBe(201);
  const pot = res.json();
  await join(pot.id, co.id, { role: "co_organiser" });
  await join(pot.id, member.id);
  await join(pot.id, pending.id, { status: "pending" });
  return { pot, organiser, co, member, pending };
}

const notificationsFor = (userId: string, potId: string) =>
  t.db.selectFrom("notifications").select(["type", "payload"]).where("user_id", "=", userId).where("pot_id", "=", potId).execute();

const auditFor = (potId: string, action: string) =>
  t.db.selectFrom("audit_events").selectAll().where("pot_id", "=", potId).where("action", "=", action).execute();

const setPot = (potId: string, values: Record<string, unknown>) =>
  t.db.updateTable("pots").set(values).where("id", "=", potId).execute();

// ─────────────────────────────────────────────
describe("creating a pot", () => {
  it("makes the creator its organiser and works out each person's share", async () => {
    const organiser = await signIn();
    const res = await api(organiser, "POST", "/pots", newPot({ outingDate: dateOnly(inDays(30)), outingTime: "18:30" }));
    expect(res.statusCode).toBe(201);
    const pot = res.json();
    expect(pot).toMatchObject({
      stage: "planning",
      myRole: "organiser",
      memberCount: 1,
      shareKobo: naira(25_000),
      raisedKobo: 0,
      myOwedKobo: naira(25_000),
      outingTime: "18:30",
      currency: "NGN",
    });
    expect(await auditFor(pot.id, "pot.created")).toHaveLength(1);
  });

  it("requires sign-in", async () => {
    const res = await t.app.inject({ method: "POST", url: "/pots", payload: newPot() });
    expect(res.statusCode).toBe(401);
  });

  it.each([
    ["a budget that isn't whole naira", { budgetKobo: naira(1_000) + 50 }],
    ["a budget above the limit", { budgetKobo: naira(100_000_001) }],
    ["a headcount of one", { headcount: 1 }],
    ["a one-letter name", { name: "A" }],
    ["an unknown vibe", { vibe: "rave" }],
    ["a time that isn't HH:MM", { outingTime: "7pm" }],
    ["a stage chosen by the client", { stage: "funded" }],
    ["an organiser chosen by the client", { createdBy: "00000000-0000-0000-0000-000000000000" }],
  ])("rejects %s", async (_label, overrides) => {
    const res = await api(await signIn(), "POST", "/pots", newPot(overrides));
    expect(res.statusCode).toBe(400);
  });

  it.each([
    ["a deadline in the past", { fundingDeadline: inDays(-1).toISOString() }, "DEADLINE_IN_PAST"],
    ["an outing in the past", { outingDate: dateOnly(inDays(-2)) }, "OUTING_IN_PAST"],
    [
      "a deadline after the outing",
      { outingDate: dateOnly(inDays(10)), fundingDeadline: inDays(20).toISOString() },
      "DEADLINE_AFTER_OUTING",
    ],
  ])("rejects %s", async (_label, overrides, code) => {
    const res = await api(await signIn(), "POST", "/pots", newPot(overrides));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe(code);
  });
});

// ─────────────────────────────────────────────
describe("dashboard", () => {
  it("lists only pots I'm an active member of", async () => {
    const me = await signIn();
    const other = await signIn();
    const mine = (await api(me, "POST", "/pots", newPot({ name: "Mine" }))).json();
    await api(other, "POST", "/pots", newPot({ name: "Not mine" }));
    const pendingIn = (await api(other, "POST", "/pots", newPot({ name: "Waiting to join" }))).json();
    const removedFrom = (await api(other, "POST", "/pots", newPot({ name: "Removed from" }))).json();
    await join(pendingIn.id, me.id, { status: "pending" });
    await join(removedFrom.id, me.id, { status: "removed" });

    const res = await api(me, "GET", "/pots");
    expect(res.statusCode).toBe(200);
    expect(res.json().map((p: { id: string }) => p.id)).toEqual([mine.id]);
  });

  it("shows what I've paid and still owe, counting refunds and confirmed money only", async () => {
    const { pot, organiser, member } = await setupPot({ budgetKobo: naira(100_000), headcount: 4 }); // ₦25,000 each
    await recordContribution(t.db, pot.id, member.id, naira(10_000));
    await recordContribution(t.db, pot.id, member.id, naira(10_000)); // instalments
    await recordRefund(t.db, pot.id, member.id, naira(5_000));
    await recordContribution(t.db, pot.id, organiser.id, naira(25_000));

    const memberView = (await api(member, "GET", "/pots")).json()[0];
    expect(memberView).toMatchObject({ myPaidKobo: naira(15_000), myOwedKobo: naira(10_000), raisedKobo: naira(40_000) });
    const organiserView = (await api(organiser, "GET", "/pots")).json()[0];
    expect(organiserView).toMatchObject({ myPaidKobo: naira(25_000), myOwedKobo: 0, memberCount: 3 });
  });

  it("puts live pots before finished ones", async () => {
    const me = await signIn();
    const done = (await api(me, "POST", "/pots", newPot({ name: "Done" }))).json();
    const live = (await api(me, "POST", "/pots", newPot({ name: "Live" }))).json();
    await api(me, "POST", `/pots/${done.id}/cancel`, {});
    const names = (await api(me, "GET", "/pots")).json().map((p: { name: string }) => p.name);
    expect(names).toEqual(["Live", "Done"]);
    expect(live.id).toBeTruthy();
  });
});

// ─────────────────────────────────────────────
describe("pot page", () => {
  it("shows members and what each has paid", async () => {
    const { pot, member, co } = await setupPot();
    await recordContribution(t.db, pot.id, member.id, naira(5_000));
    const res = await api(co, "GET", `/pots/${pot.id}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.myRole).toBe("co_organiser");
    expect(body.members).toHaveLength(3); // pending members are not listed
    expect(body.members.find((m: { userId: string }) => m.userId === member.id).paidKobo).toBe(naira(5_000));
  });

  it("is hidden from outsiders and people still waiting to join", async () => {
    const { pot, pending } = await setupPot();
    expect((await api(await signIn(), "GET", `/pots/${pot.id}`)).statusCode).toBe(404);
    expect((await api(pending, "GET", `/pots/${pot.id}`)).statusCode).toBe(404);
  });
});

// ─────────────────────────────────────────────
describe("editing a pot", () => {
  it("is open to the organiser and co-organiser, not members", async () => {
    const { pot, organiser, co, member } = await setupPot();
    expect((await api(organiser, "PATCH", `/pots/${pot.id}`, { name: "Renamed" })).statusCode).toBe(200);
    expect((await api(co, "PATCH", `/pots/${pot.id}`, { area: "Lekki, Lagos" })).json().area).toBe("Lekki, Lagos");
    expect((await api(member, "PATCH", `/pots/${pot.id}`, { name: "Hijacked" })).statusCode).toBe(403);
  });

  it("tells every other active member when the budget changes their share", async () => {
    const { pot, organiser, co, member, pending } = await setupPot({ budgetKobo: naira(200_000), headcount: 8 });
    const res = await api(organiser, "PATCH", `/pots/${pot.id}`, { budgetKobo: naira(240_000) });
    expect(res.json().shareKobo).toBe(naira(30_000));

    for (const person of [co, member]) {
      expect(await notificationsFor(person.id, pot.id)).toEqual([
        expect.objectContaining({
          type: "budget_changed",
          payload: expect.objectContaining({ shareKobo: naira(30_000), previousShareKobo: naira(25_000) }),
        }),
      ]);
    }
    expect(await notificationsFor(organiser.id, pot.id)).toEqual([]);
    expect(await notificationsFor(pending.id, pot.id)).toEqual([]);
  });

  it("doesn't notify anyone for changes that don't affect money", async () => {
    const { pot, organiser, member } = await setupPot();
    await api(organiser, "PATCH", `/pots/${pot.id}`, { name: "New name" });
    expect(await notificationsFor(member.id, pot.id)).toEqual([]);
  });

  it("clears optional details with null", async () => {
    const { pot, organiser } = await setupPot({ area: "Ikoyi", outingDate: dateOnly(inDays(20)) });
    const res = await api(organiser, "PATCH", `/pots/${pot.id}`, { area: null, outingDate: null });
    expect(res.json()).toMatchObject({ area: null, outingDate: null });
  });

  it("won't set the headcount below the people already in the pot", async () => {
    const { pot, organiser } = await setupPot();
    const res = await api(organiser, "PATCH", `/pots/${pot.id}`, { headcount: 2 }); // 3 active members
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("HEADCOUNT_TOO_LOW");
  });

  it("is locked once the pot is funded", async () => {
    const { pot, organiser } = await setupPot();
    await setStage(t.db, pot.id, "collecting", "funded");
    const res = await api(organiser, "PATCH", `/pots/${pot.id}`, { name: "Too late" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("POT_LOCKED");
  });

  it("is recorded in the audit log", async () => {
    const { pot, organiser } = await setupPot();
    await api(organiser, "PATCH", `/pots/${pot.id}`, { name: "Audited", headcount: 9 });
    const [entry] = await auditFor(pot.id, "pot.updated");
    expect(entry?.actor_user_id).toBe(organiser.id);
    expect(entry?.metadata).toEqual({ fields: ["name", "headcount"] });
  });
});

// ─────────────────────────────────────────────
describe("pot settings", () => {
  it("can only be changed by the organiser", async () => {
    const { pot, organiser, co } = await setupPot();
    expect((await api(co, "PATCH", `/pots/${pot.id}/settings`, { joinApprovalRequired: true })).statusCode).toBe(403);
    const res = await api(organiser, "PATCH", `/pots/${pot.id}/settings`, { joinApprovalRequired: true });
    expect(res.json().joinApprovalRequired).toBe(true);
  });

  it("let payout approval be switched on any time, but off only while planning", async () => {
    const { pot, organiser, member } = await setupPot({ fundingDeadline: inDays(14).toISOString() });
    await api(organiser, "POST", `/pots/${pot.id}/stage`, { to: "collecting" });

    const on = await api(organiser, "PATCH", `/pots/${pot.id}/settings`, { payoutApprovalRequired: true });
    expect(on.json().payoutApprovalRequired).toBe(true);
    expect((await notificationsFor(member.id, pot.id)).map((n) => n.type)).toContain("payout_approval_changed");

    const off = await api(organiser, "PATCH", `/pots/${pot.id}/settings`, { payoutApprovalRequired: false });
    expect(off.statusCode).toBe(409);
    expect(off.json().error.code).toBe("PAYOUT_APPROVAL_LOCKED");
  });

  it("let payout approval be switched off while still planning", async () => {
    const { pot, organiser } = await setupPot({ payoutApprovalRequired: true });
    const res = await api(organiser, "PATCH", `/pots/${pot.id}/settings`, { payoutApprovalRequired: false });
    expect(res.json().payoutApprovalRequired).toBe(false);
  });
});

// ─────────────────────────────────────────────
describe("moving through stages", () => {
  it("needs a future funding deadline before collecting money", async () => {
    const { pot, organiser, member } = await setupPot();
    const blocked = await api(organiser, "POST", `/pots/${pot.id}/stage`, { to: "collecting" });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe("DEADLINE_REQUIRED");

    await api(organiser, "PATCH", `/pots/${pot.id}`, { fundingDeadline: inDays(7).toISOString() });
    const res = await api(organiser, "POST", `/pots/${pot.id}/stage`, { to: "collecting" });
    expect(res.json().stage).toBe("collecting");
    expect((await notificationsFor(member.id, pot.id)).map((n) => n.type)).toEqual(["pot_collecting"]);
    expect(await auditFor(pot.id, "pot.stage_changed")).toHaveLength(1);
  });

  it("are not open to plain members", async () => {
    const { pot, member } = await setupPot({ fundingDeadline: inDays(7).toISOString() });
    expect((await api(member, "POST", `/pots/${pot.id}/stage`, { to: "collecting" })).statusCode).toBe(403);
  });

  it("can't be skipped", async () => {
    const { pot, organiser } = await setupPot();
    const res = await api(organiser, "POST", `/pots/${pot.id}/stage`, { to: "confirmed" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("INVALID_STAGE_CHANGE");
  });

  it("reach funded once confirmed money meets the target", async () => {
    const { pot, organiser, co, member } = await setupPot({ budgetKobo: naira(30_000), headcount: 3, fundingDeadline: inDays(7).toISOString() });
    await api(organiser, "POST", `/pots/${pot.id}/stage`, { to: "collecting" });
    for (const person of [organiser, co, member]) await recordContribution(t.db, pot.id, person.id, naira(10_000));
    const res = await api(co, "POST", `/pots/${pot.id}/stage`, { to: "funded" });
    expect(res.json().stage).toBe("funded");
  });

  it("let only the organiser go ahead with less, and only after the deadline", async () => {
    const { pot, organiser, co, member } = await setupPot({ fundingDeadline: inDays(7).toISOString() });
    await api(organiser, "POST", `/pots/${pot.id}/stage`, { to: "collecting" });
    await recordContribution(t.db, pot.id, member.id, naira(25_000)); // far short of ₦200,000

    const early = await api(organiser, "POST", `/pots/${pot.id}/stage`, { to: "funded" });
    expect(early.json().error.code).toBe("TARGET_NOT_MET");

    await setPot(pot.id, { funding_deadline: inDays(-1) });
    expect((await api(co, "POST", `/pots/${pot.id}/stage`, { to: "funded" })).statusCode).toBe(403);
    expect((await api(organiser, "POST", `/pots/${pot.id}/stage`, { to: "funded" })).json().stage).toBe("funded");
  });

  it("won't go ahead when nothing was raised", async () => {
    const { pot, organiser } = await setupPot({ fundingDeadline: inDays(7).toISOString() });
    await api(organiser, "POST", `/pots/${pot.id}/stage`, { to: "collecting" });
    await setPot(pot.id, { funding_deadline: inDays(-1) });
    const res = await api(organiser, "POST", `/pots/${pot.id}/stage`, { to: "funded" });
    expect(res.json().error.code).toBe("NOTHING_RAISED");
  });

  it("complete only on or after the outing date", async () => {
    const { pot, organiser } = await setupPot({ outingDate: dateOnly(inDays(10)) });
    await setStage(t.db, pot.id, "collecting", "funded");
    expect((await api(organiser, "POST", `/pots/${pot.id}/stage`, { to: "confirmed" })).json().stage).toBe("confirmed");

    const early = await api(organiser, "POST", `/pots/${pot.id}/stage`, { to: "completed" });
    expect(early.json().error.code).toBe("OUTING_NOT_PASSED");

    await setPot(pot.id, { outing_date: dateOnly(inDays(-1)) });
    expect((await api(organiser, "POST", `/pots/${pot.id}/stage`, { to: "completed" })).json().stage).toBe("completed");
  });

  it("let exactly one of two simultaneous identical requests through", async () => {
    const { pot, organiser, co } = await setupPot({ fundingDeadline: inDays(7).toISOString() });
    const results = await Promise.all([
      api(organiser, "POST", `/pots/${pot.id}/stage`, { to: "collecting" }),
      api(co, "POST", `/pots/${pot.id}/stage`, { to: "collecting" }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(await auditFor(pot.id, "pot.stage_changed")).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────
describe("cancelling a pot", () => {
  it("is done by the organiser, tells members why, and is audited", async () => {
    const { pot, organiser, member } = await setupPot();
    const res = await api(organiser, "POST", `/pots/${pot.id}/cancel`, { reason: "Venue fell through" });
    expect(res.json()).toMatchObject({ stage: "cancelled", myOwedKobo: 0 });
    expect(await notificationsFor(member.id, pot.id)).toEqual([
      expect.objectContaining({ type: "pot_cancelled", payload: { reason: "Venue fell through" } }),
    ]);
    expect((await auditFor(pot.id, "pot.cancelled"))[0]?.metadata).toMatchObject({ reason: "Venue fell through" });
  });

  it("isn't open to co-organisers", async () => {
    const { pot, co } = await setupPot();
    expect((await api(co, "POST", `/pots/${pot.id}/cancel`, {})).statusCode).toBe(403);
  });

  it("is final", async () => {
    const { pot, organiser } = await setupPot({ fundingDeadline: inDays(7).toISOString() });
    await api(organiser, "POST", `/pots/${pot.id}/cancel`, {});
    expect((await api(organiser, "POST", `/pots/${pot.id}/cancel`, {})).json().error.code).toBe("POT_CLOSED");
    expect((await api(organiser, "PATCH", `/pots/${pot.id}`, { name: "Back?" })).json().error.code).toBe("POT_LOCKED");
    expect((await api(organiser, "POST", `/pots/${pot.id}/stage`, { to: "collecting" })).json().error.code).toBe(
      "INVALID_STAGE_CHANGE",
    );
  });
});
