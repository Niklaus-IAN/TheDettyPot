import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sendPaymentReminders } from "../src/worker/tasks.js";
import { apiFor, inDays, type Person } from "./api.js";
import { naira, recordContribution } from "./fixtures.js";
import { makeTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
let admin: Person;
beforeAll(async () => {
  t = await makeTestApp();
  admin = await h.signIn({ name: "Support" });
  await t.db.updateTable("users").set({ is_admin: true }).where("id", "=", admin.id).execute();
});
afterAll(async () => {
  await t.close();
});

const h = apiFor(() => t);

async function scene() {
  const [organiser, member] = await Promise.all([h.signIn({ name: "Kemi" }), h.signIn()]);
  const pot = await h.createPot(organiser, { name: `Owambe ${Math.random().toString(36).slice(2, 8)}`, fundingDeadline: inDays(10).toISOString() });
  await h.join(pot.id, member.id);
  return { pot, organiser, member };
}

describe("admin access", () => {
  it.each(["/admin/pots", "/admin/users", "/admin/audit"])("hides %s from non-admins", async (url) => {
    expect((await h.call(await h.signIn(), "GET", url)).statusCode).toBe(404);
    expect((await h.call(null, "GET", url)).statusCode).toBe(401);
  });
});

describe("finding pots and people", () => {
  it("searches pots by name, organiser email or id, with money raised", async () => {
    const { pot, member } = await scene();
    await recordContribution(t.db, pot.id, member.id, naira(5_000));
    const potRow = await t.db.selectFrom("pots").select("name").where("id", "=", pot.id).executeTakeFirstOrThrow();

    const byName = (await h.call(admin, "GET", `/admin/pots?q=${encodeURIComponent(potRow.name)}`)).json();
    expect(byName).toEqual([expect.objectContaining({ id: pot.id, organiser_name: "Kemi", raised_kobo: naira(5_000) })]);
    expect((await h.call(admin, "GET", `/admin/pots?q=${pot.id}`)).json()[0].id).toBe(pot.id);
  });

  it("treats search text literally", async () => {
    await scene();
    expect((await h.call(admin, "GET", `/admin/pots?q=${encodeURIComponent("%")}`)).json()).toEqual([]);
  });

  it("shows a pot's full record", async () => {
    const { pot, organiser, member } = await scene();
    await recordContribution(t.db, pot.id, member.id, naira(7_000));
    const record = (await h.call(admin, "GET", `/admin/pots/${pot.id}`)).json();
    expect(record.pot.id).toBe(pot.id);
    expect(record.members.map((m: { user_id: string }) => m.user_id).sort()).toEqual([organiser.id, member.id].sort());
    expect(record.members[0].email).toContain("@example.com");
    expect(record.ledger).toEqual([expect.objectContaining({ kind: "contribution", member_user_id: member.id, pot_amount_kobo: naira(7_000) })]);
    expect(record.audit.map((a: { action: string }) => a.action)).toContain("pot.created");
  });

  it("searches users and reads the audit log", async () => {
    const person = await h.signIn({ email: "findable.person@example.com" });
    expect((await h.call(admin, "GET", "/admin/users?q=findable.person")).json()).toEqual([
      expect.objectContaining({ id: person.id, email: "findable.person@example.com", active_pots: 0 }),
    ]);
    const { pot } = await scene();
    const log = (await h.call(admin, "GET", `/admin/audit?potId=${pot.id}`)).json();
    expect(log.every((e: { pot_id: string }) => e.pot_id === pot.id)).toBe(true);
  });
});

describe("freezing a pot", () => {
  it("makes it read-only for members, tells them, and is audited as an admin action", async () => {
    const { pot, organiser, member } = await scene();
    const invite = await h.createInvite(organiser, pot.id);
    const res = await h.call(admin, "POST", `/admin/pots/${pot.id}/freeze`, { reason: "Reported by a member" });
    expect(res.statusCode).toBe(200);

    expect(await h.typesFor(member.id, pot.id)).toContain("pot_frozen");
    const [entry] = await h.auditFor(pot.id, "admin.pot_frozen");
    expect(entry).toMatchObject({ actor_type: "admin", actor_user_id: admin.id, metadata: { reason: "Reported by a member" } });

    expect((await h.call(member, "GET", `/pots/${pot.id}`)).statusCode).toBe(200);
    for (const [method, url, body] of [
      ["PATCH", `/pots/${pot.id}`, { name: "Changed" }],
      ["POST", `/pots/${pot.id}/stage`, { to: "collecting" }],
      ["POST", `/pots/${pot.id}/invites`, {}],
    ] as const) {
      const blocked = await h.call(organiser, method, url, body);
      expect(blocked.statusCode).toBe(423);
      expect(blocked.json().error.code).toBe("POT_FROZEN");
    }
    expect((await h.call(await h.signIn(), "POST", `/invites/${invite.token}/join`)).statusCode).toBe(423);
    expect((await h.call(null, "GET", `/invites/${invite.token}`)).json().joinable).toBe(false);
  });

  it("stops reminders", async () => {
    const { pot, organiser, member } = await scene();
    await h.call(organiser, "POST", `/pots/${pot.id}/stage`, { to: "collecting" });
    await t.db.updateTable("pot_members").set({ joined_at: inDays(-5) }).where("pot_id", "=", pot.id).execute();
    await t.db.updateTable("pots").set({ stage_changed_at: inDays(-5) }).where("id", "=", pot.id).execute();
    await h.call(admin, "POST", `/admin/pots/${pot.id}/freeze`, { reason: "Investigating" });
    const now = new Date();
    now.setUTCHours(10); // 11:00 in Lagos
    await sendPaymentReminders(t.db, { now });
    expect(await h.typesFor(member.id, pot.id)).not.toContain("reminder");
  });

  it("can be lifted, and can't be applied twice", async () => {
    const { pot, organiser } = await scene();
    await h.call(admin, "POST", `/admin/pots/${pot.id}/freeze`, { reason: "Checking" });
    expect((await h.call(admin, "POST", `/admin/pots/${pot.id}/freeze`, { reason: "Again" })).json().error.code).toBe("ALREADY_FROZEN");
    expect((await h.call(admin, "POST", `/admin/pots/${pot.id}/unfreeze`)).statusCode).toBe(200);
    expect((await h.call(organiser, "PATCH", `/pots/${pot.id}`, { name: "Back to normal" })).statusCode).toBe(200);
    expect((await h.call(admin, "POST", `/admin/pots/${pot.id}/unfreeze`)).json().error.code).toBe("NOT_FROZEN");
  });

  it("isn't open to the pot's own organiser", async () => {
    const { pot, organiser } = await scene();
    expect((await h.call(organiser, "POST", `/admin/pots/${pot.id}/freeze`, { reason: "Nope" })).statusCode).toBe(404);
  });
});
