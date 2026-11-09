import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiFor, inDays, type Person } from "./api.js";
import { naira, recordContribution, setStage } from "./fixtures.js";
import { makeTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
});
afterAll(async () => {
  await t.close();
});

const h = apiFor(() => t);

/** An organiser's pot with a co-organiser and a member already in it. */
async function scene(potOverrides: object = {}) {
  const [organiser, co, member] = await Promise.all([h.signIn(), h.signIn(), h.signIn()]);
  const pot = await h.createPot(organiser, potOverrides);
  await h.join(pot.id, co.id, { role: "co_organiser" });
  await h.join(pot.id, member.id);
  return { pot, organiser, co, member };
}

const joinWith = (who: Person, token: string) => h.call(who, "POST", `/invites/${token}/join`);

// ─────────────────────────────────────────────
describe("invite links", () => {
  it("are created by organisers, shown once, and stored only as a hash", async () => {
    const { pot, co } = await scene();
    const invite = await h.createInvite(co, pot.id, { maxUses: 5 });
    expect(invite.token).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(invite.url).toBe(`http://localhost:5173/join/${invite.token}`);

    const row = await t.db.selectFrom("pot_invites").selectAll().where("id", "=", invite.id).executeTakeFirstOrThrow();
    expect(row.token_hash.equals(createHash("sha256").update(invite.token).digest())).toBe(true);
    expect(JSON.stringify(row)).not.toContain(invite.token);

    const listed = (await h.call(co, "GET", `/pots/${pot.id}/invites`)).json();
    expect(listed).toEqual([expect.objectContaining({ id: invite.id, maxUses: 5, useCount: 0, active: true })]);
    expect(listed[0].token).toBeUndefined();
  });

  it("can't be created by plain members", async () => {
    const { pot, member } = await scene();
    expect((await h.call(member, "POST", `/pots/${pot.id}/invites`, {})).statusCode).toBe(403);
  });

  it("stop working when revoked", async () => {
    const { pot, organiser } = await scene();
    const invite = await h.createInvite(organiser, pot.id);
    expect((await h.call(organiser, "POST", `/pots/${pot.id}/invites/${invite.id}/revoke`)).statusCode).toBe(200);
    expect((await h.call(null, "GET", `/invites/${invite.token}`)).statusCode).toBe(404);
    expect((await joinWith(await h.signIn(), invite.token)).json().error.code).toBe("INVITE_INVALID");
    expect((await h.call(organiser, "GET", `/pots/${pot.id}/invites`)).json()[0].active).toBe(false);
  });

  it("stop working when they expire", async () => {
    const { pot, organiser } = await scene();
    const invite = await h.createInvite(organiser, pot.id, { expiresInDays: 1 });
    await t.db.updateTable("pot_invites").set({ expires_at: inDays(-1) }).where("id", "=", invite.id).execute();
    expect((await joinWith(await h.signIn(), invite.token)).statusCode).toBe(404);
  });

  it("can't be created once a pot stops taking members", async () => {
    const { pot, organiser } = await scene();
    await setStage(t.db, pot.id, "collecting", "funded");
    const res = await h.call(organiser, "POST", `/pots/${pot.id}/invites`, {});
    expect(res.json().error.code).toBe("POT_NOT_JOINABLE");
  });
});

// ─────────────────────────────────────────────
describe("invite preview", () => {
  it("shows enough to decide, without signing in and without revealing members", async () => {
    const organiser = await h.signIn({ name: "Tolu A." });
    const pot = await h.createPot(organiser, { budgetKobo: naira(160_000), headcount: 8, area: "Lekki" });
    const invite = await h.createInvite(organiser, pot.id);

    const res = await h.call(null, "GET", `/invites/${invite.token}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      joinable: true,
      pot: { area: "Lekki", shareKobo: naira(20_000), memberCount: 1, organiserName: "Tolu A." },
    });
    expect(Object.keys(body.pot)).not.toContain("members");
    expect(JSON.stringify(body)).not.toContain(organiser.id);
  });

  it("says a full pot can't be joined", async () => {
    const { pot, organiser } = await scene({ headcount: 3 });
    const invite = await h.createInvite(organiser, pot.id);
    expect((await h.call(null, "GET", `/invites/${invite.token}`)).json().joinable).toBe(false);
  });

  it("answers unknown tokens with not found", async () => {
    const res = await h.call(null, "GET", "/invites/AAAAAAAAAAAAAAAA");
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("INVITE_INVALID");
  });
});

// ─────────────────────────────────────────────
describe("joining with a link", () => {
  it("adds the person as a member, tells the others, and counts the use", async () => {
    const { pot, organiser, member } = await scene();
    const invite = await h.createInvite(organiser, pot.id);
    const newcomer = await h.signIn();

    const res = await joinWith(newcomer, invite.token);
    expect(res.json()).toEqual({ potId: pot.id, status: "active", alreadyMember: false });
    expect(await h.membership(pot.id, newcomer.id)).toMatchObject({ role: "member", status: "active", invite_id: invite.id });
    expect(await h.typesFor(member.id, pot.id)).toContain("member_joined");
    expect(await h.typesFor(newcomer.id, pot.id)).not.toContain("member_joined");
    expect(await h.auditFor(pot.id, "member.joined")).toHaveLength(1);
    expect((await h.call(organiser, "GET", `/pots/${pot.id}/invites`)).json()[0].useCount).toBe(1);
  });

  it("is harmless to repeat", async () => {
    const { pot, organiser } = await scene();
    const invite = await h.createInvite(organiser, pot.id);
    const newcomer = await h.signIn();
    await joinWith(newcomer, invite.token);
    expect((await joinWith(newcomer, invite.token)).json()).toMatchObject({ status: "active", alreadyMember: true });
    expect((await h.call(organiser, "GET", `/pots/${pot.id}/invites`)).json()[0].useCount).toBe(1);
  });

  it("waits for approval when the pot asks for it, and tells only the organisers", async () => {
    const { pot, organiser, co, member } = await scene({ joinApprovalRequired: true });
    const invite = await h.createInvite(organiser, pot.id);
    const newcomer = await h.signIn();

    expect((await joinWith(newcomer, invite.token)).json().status).toBe("pending");
    expect(await h.typesFor(organiser.id, pot.id)).toContain("join_requested");
    expect(await h.typesFor(co.id, pot.id)).toContain("join_requested");
    expect(await h.typesFor(member.id, pot.id)).not.toContain("join_requested");
    expect((await h.call(newcomer, "GET", `/pots/${pot.id}`)).statusCode).toBe(404);
  });

  it("respects the link's use limit", async () => {
    const { pot, organiser } = await scene();
    const invite = await h.createInvite(organiser, pot.id, { maxUses: 1 });
    expect((await joinWith(await h.signIn(), invite.token)).statusCode).toBe(200);
    expect((await joinWith(await h.signIn(), invite.token)).json().error.code).toBe("INVITE_INVALID");
  });

  it("lets only one of two people racing for a link's last use in", async () => {
    const { pot, organiser } = await scene();
    const invite = await h.createInvite(organiser, pot.id, { maxUses: 1 });
    const [a, b] = await Promise.all([h.signIn(), h.signIn()]);
    const results = await Promise.all([joinWith(a, invite.token), joinWith(b, invite.token)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 404]);
    const row = await t.db.selectFrom("pot_invites").select("use_count").where("id", "=", invite.id).executeTakeFirstOrThrow();
    expect(row.use_count).toBe(1);
  });

  it("stops at the headcount, even when two people race for the last place", async () => {
    const { pot, organiser } = await scene({ headcount: 4 }); // 3 in, 1 place left
    // Separate links, so only the pot itself can keep the two apart.
    const [linkA, linkB] = [await h.createInvite(organiser, pot.id), await h.createInvite(organiser, pot.id)];
    const [a, b] = await Promise.all([h.signIn(), h.signIn()]);
    const results = await Promise.all([joinWith(a, linkA.token), joinWith(b, linkB.token)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.statusCode === 409)!.json().error.code).toBe("POT_FULL");
  });

  it("is closed once the pot is funded", async () => {
    const { pot, organiser } = await scene();
    const invite = await h.createInvite(organiser, pot.id);
    await setStage(t.db, pot.id, "collecting", "funded");
    expect((await joinWith(await h.signIn(), invite.token)).json().error.code).toBe("POT_NOT_JOINABLE");
  });

  it("can't bring back someone the organiser removed, but welcomes back someone who left", async () => {
    const { pot, organiser } = await scene();
    const invite = await h.createInvite(organiser, pot.id);
    const [removed, leaver] = await Promise.all([h.signIn(), h.signIn()]);
    await joinWith(removed, invite.token);
    await joinWith(leaver, invite.token);
    await h.call(organiser, "POST", `/pots/${pot.id}/members/${removed.id}/remove`);
    await h.call(leaver, "POST", `/pots/${pot.id}/leave`);

    expect((await joinWith(removed, invite.token)).json().error.code).toBe("REMOVED_FROM_POT");
    expect((await joinWith(leaver, invite.token)).json()).toMatchObject({ status: "active", alreadyMember: false });
  });

  it("needs sign-in", async () => {
    const { pot, organiser } = await scene();
    const invite = await h.createInvite(organiser, pot.id);
    expect((await h.call(null, "POST", `/invites/${invite.token}/join`)).statusCode).toBe(401);
  });
});

// ─────────────────────────────────────────────
describe("join requests", () => {
  async function pendingScene() {
    const s = await scene({ joinApprovalRequired: true });
    const invite = await h.createInvite(s.organiser, s.pot.id);
    const applicant = await h.signIn({ name: "Applicant" });
    await joinWith(applicant, invite.token);
    return { ...s, invite, applicant };
  }

  it("are listed for organisers only", async () => {
    const { pot, co, member, applicant } = await pendingScene();
    const list = (await h.call(co, "GET", `/pots/${pot.id}/join-requests`)).json();
    expect(list).toEqual([expect.objectContaining({ userId: applicant.id, fullName: "Applicant" })]);
    expect((await h.call(member, "GET", `/pots/${pot.id}/join-requests`)).statusCode).toBe(403);
  });

  it("let the person in once approved", async () => {
    const { pot, co, applicant } = await pendingScene();
    expect((await h.call(co, "POST", `/pots/${pot.id}/join-requests/${applicant.id}/approve`)).statusCode).toBe(200);
    expect(await h.typesFor(applicant.id, pot.id)).toContain("join_approved");
    expect((await h.call(applicant, "GET", `/pots/${pot.id}`)).statusCode).toBe(200);
  });

  it("tell the person when declined, and let them ask again", async () => {
    const { pot, organiser, applicant, invite } = await pendingScene();
    await h.call(organiser, "POST", `/pots/${pot.id}/join-requests/${applicant.id}/decline`);
    expect((await h.membership(pot.id, applicant.id))?.status).toBe("declined");
    expect(await h.typesFor(applicant.id, pot.id)).toContain("join_declined");
    expect((await joinWith(applicant, invite.token)).json().status).toBe("pending");
  });

  it("can't be approved past the headcount", async () => {
    const { pot, organiser, applicant } = await pendingScene();
    await h.call(organiser, "PATCH", `/pots/${pot.id}`, { headcount: 3 });
    const res = await h.call(organiser, "POST", `/pots/${pot.id}/join-requests/${applicant.id}/approve`);
    expect(res.json().error.code).toBe("POT_FULL");
  });

  it("must exist to be decided", async () => {
    const { pot, organiser, member } = await scene();
    expect((await h.call(organiser, "POST", `/pots/${pot.id}/join-requests/${member.id}/approve`)).statusCode).toBe(404);
  });
});

// ─────────────────────────────────────────────
describe("removing members", () => {
  it("is done by organisers, tells the person, and shuts them out", async () => {
    const { pot, organiser, member } = await scene();
    expect((await h.call(organiser, "POST", `/pots/${pot.id}/members/${member.id}/remove`)).statusCode).toBe(200);
    expect(await h.membership(pot.id, member.id)).toMatchObject({ status: "removed", status_changed_by: organiser.id });
    expect(await h.typesFor(member.id, pot.id)).toContain("removed_from_pot");
    expect(await h.auditFor(pot.id, "member.removed")).toHaveLength(1);
    expect((await h.call(member, "GET", `/pots/${pot.id}`)).statusCode).toBe(404);
  });

  it("lets co-organisers remove plain members only", async () => {
    const { pot, organiser, co, member } = await scene();
    const otherCo = await h.signIn();
    await h.join(pot.id, otherCo.id, { role: "co_organiser" });
    expect((await h.call(co, "POST", `/pots/${pot.id}/members/${organiser.id}/remove`)).statusCode).toBe(403);
    expect((await h.call(co, "POST", `/pots/${pot.id}/members/${otherCo.id}/remove`)).statusCode).toBe(403);
    expect((await h.call(co, "POST", `/pots/${pot.id}/members/${member.id}/remove`)).statusCode).toBe(200);
  });

  it("isn't open to plain members, or for removing yourself", async () => {
    const { pot, organiser, co, member } = await scene();
    expect((await h.call(member, "POST", `/pots/${pot.id}/members/${co.id}/remove`)).statusCode).toBe(403);
    expect((await h.call(organiser, "POST", `/pots/${pot.id}/members/${organiser.id}/remove`)).json().error.code).toBe(
      "CANNOT_REMOVE_SELF",
    );
  });

  it("drops a removed co-organiser's rights for good", async () => {
    const { pot, organiser, co } = await scene();
    await h.call(organiser, "POST", `/pots/${pot.id}/members/${co.id}/remove`);
    expect((await h.membership(pot.id, co.id))?.role).toBe("member");
  });

  it("is refused for someone who has paid in, until refunds exist", async () => {
    const { pot, organiser, member } = await scene();
    await recordContribution(t.db, pot.id, member.id, naira(5_000));
    const res = await h.call(organiser, "POST", `/pots/${pot.id}/members/${member.id}/remove`);
    expect(res.json().error.code).toBe("MEMBER_HAS_PAID");
  });
});

// ─────────────────────────────────────────────
describe("leaving", () => {
  it("takes the member out and tells the organisers", async () => {
    const { pot, organiser, member } = await scene();
    expect((await h.call(member, "POST", `/pots/${pot.id}/leave`)).statusCode).toBe(200);
    expect((await h.call(member, "GET", `/pots/${pot.id}`)).statusCode).toBe(404);
    expect(await h.typesFor(organiser.id, pot.id)).toContain("member_left");
  });

  it("isn't open to the organiser", async () => {
    const { pot, organiser } = await scene();
    expect((await h.call(organiser, "POST", `/pots/${pot.id}/leave`)).json().error.code).toBe("ORGANISER_CANNOT_LEAVE");
  });

  it("is refused for someone who has paid into an open pot", async () => {
    const { pot, member } = await scene();
    await recordContribution(t.db, pot.id, member.id, naira(1_000));
    expect((await h.call(member, "POST", `/pots/${pot.id}/leave`)).json().error.code).toBe("MEMBER_HAS_PAID");
  });
});
