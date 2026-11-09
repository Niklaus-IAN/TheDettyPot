import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { majorityOf } from "../src/approvals/service.js";
import { apiFor, inDays, type Person } from "./api.js";
import { makeTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
});
afterAll(async () => {
  await t.close();
});

const h = apiFor(() => t);

/** An organiser, a nominee and `others` more members. */
async function scene(others: number) {
  const organiser = await h.signIn();
  const nominee = await h.signIn();
  const rest: Person[] = [];
  for (let i = 0; i < others; i++) rest.push(await h.signIn());
  const pot = await h.createPot(organiser);
  await h.join(pot.id, nominee.id);
  for (const person of rest) await h.join(pot.id, person.id);
  return { pot, organiser, nominee, rest };
}

const nominate = (who: Person, potId: string, userId: string) =>
  h.call(who, "POST", `/pots/${potId}/co-organisers`, { userId });
const vote = (who: Person, potId: string, requestId: string, decision: "approve" | "reject") =>
  h.call(who, "POST", `/pots/${potId}/approvals/${requestId}/votes`, { decision });
const roleOf = async (potId: string, userId: string) => (await h.membership(potId, userId))?.role;

describe("majority", () => {
  it.each([
    [1, 1],
    [2, 2],
    [3, 2],
    [4, 3],
    [5, 3],
    [10, 6],
  ])("of %i voters is %i", (voters, needed) => {
    expect(majorityOf(voters)).toBe(needed);
  });
});

describe("nominating a co-organiser", () => {
  it("opens a vote for everyone but the nominee, counting the organiser's nomination as a yes", async () => {
    const { pot, organiser, nominee, rest } = await scene(3);
    const res = await nominate(organiser, pot.id, nominee.id);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      status: "open",
      subjectUserId: nominee.id,
      eligibleVoters: 4, // organiser + 3 others
      requiredApprovals: 3,
      approvals: 1,
      myVote: "approve",
      canVote: false,
    });
    for (const person of rest) expect(await h.typesFor(person.id, pot.id)).toContain("approval_requested");
    expect(await roleOf(pot.id, nominee.id)).toBe("member");
  });

  it("passes straight away when the organiser is the only other member", async () => {
    const { pot, organiser, nominee } = await scene(0);
    const res = await nominate(organiser, pot.id, nominee.id);
    expect(res.json().status).toBe("approved");
    expect(await roleOf(pot.id, nominee.id)).toBe("co_organiser");
  });

  it("is only open to the organiser", async () => {
    const { pot, nominee, rest } = await scene(1);
    expect((await nominate(rest[0]!, pot.id, nominee.id)).statusCode).toBe(403);
  });

  it("needs an active plain member who isn't already up for a vote", async () => {
    const { pot, organiser, nominee } = await scene(2);
    expect((await nominate(organiser, pot.id, (await h.signIn()).id)).statusCode).toBe(404);
    await nominate(organiser, pot.id, nominee.id);
    expect((await nominate(organiser, pot.id, nominee.id)).json().error.code).toBe("NOMINATION_OPEN");
  });

  it("can't promote someone who already helps run the pot", async () => {
    const { pot, organiser, nominee } = await scene(0);
    await nominate(organiser, pot.id, nominee.id); // approved at once
    expect((await nominate(organiser, pot.id, nominee.id)).json().error.code).toBe("ALREADY_CO_ORGANISER");
  });
});

describe("voting", () => {
  it("promotes the nominee once a majority approves, and tells everyone", async () => {
    const { pot, organiser, nominee, rest } = await scene(3); // needs 3 of 4
    const { id } = (await nominate(organiser, pot.id, nominee.id)).json();
    expect((await vote(rest[0]!, pot.id, id, "approve")).json().status).toBe("open");
    const res = await vote(rest[1]!, pot.id, id, "approve");
    expect(res.json()).toMatchObject({ status: "approved", approvals: 3 });
    expect(await roleOf(pot.id, nominee.id)).toBe("co_organiser");
    expect(await h.typesFor(nominee.id, pot.id)).toContain("co_organiser_approved");
    expect(await h.typesFor(rest[2]!.id, pot.id)).toContain("co_organiser_added");
    expect(await h.auditFor(pot.id, "approval.approved")).toHaveLength(1);
  });

  it("rejects as soon as a majority is out of reach", async () => {
    const { pot, organiser, nominee, rest } = await scene(3); // needs 3 of 4
    const { id } = (await nominate(organiser, pot.id, nominee.id)).json();
    expect((await vote(rest[0]!, pot.id, id, "reject")).json().status).toBe("open"); // 3 could still approve
    expect((await vote(rest[1]!, pot.id, id, "reject")).json().status).toBe("rejected"); // only 2 left
    expect(await roleOf(pot.id, nominee.id)).toBe("member");
    expect(await h.typesFor(organiser.id, pot.id)).toContain("co_organiser_rejected");
  });

  it("gives the new co-organiser their rights", async () => {
    const { pot, organiser, nominee } = await scene(0);
    expect((await h.call(nominee, "POST", `/pots/${pot.id}/invites`, {})).statusCode).toBe(403);
    await nominate(organiser, pot.id, nominee.id);
    expect((await h.call(nominee, "POST", `/pots/${pot.id}/invites`, {})).statusCode).toBe(201);
  });

  it("doesn't let the nominee vote on themselves, or anyone vote twice", async () => {
    const { pot, organiser, nominee, rest } = await scene(3);
    const { id } = (await nominate(organiser, pot.id, nominee.id)).json();
    expect((await vote(nominee, pot.id, id, "approve")).statusCode).toBe(403);
    await vote(rest[0]!, pot.id, id, "approve");
    expect((await vote(rest[0]!, pot.id, id, "reject")).json().error.code).toBe("ALREADY_VOTED");
  });

  it("isn't open to outsiders", async () => {
    const { pot, organiser, nominee } = await scene(2);
    const { id } = (await nominate(organiser, pot.id, nominee.id)).json();
    expect((await vote(await h.signIn(), pot.id, id, "approve")).statusCode).toBe(404);
  });

  it("isn't open to people who joined after the vote opened", async () => {
    const { pot, organiser, nominee } = await scene(2);
    const { id } = (await nominate(organiser, pot.id, nominee.id)).json();
    const latecomer = await h.signIn();
    await h.join(pot.id, latecomer.id);
    expect((await vote(latecomer, pot.id, id, "approve")).statusCode).toBe(403);
    const listed = (await h.call(latecomer, "GET", `/pots/${pot.id}/approvals`)).json();
    expect(listed[0].canVote).toBe(false);
  });

  it("closes when time runs out", async () => {
    const { pot, organiser, nominee, rest } = await scene(3);
    // A vote's deadline can't be moved once it opens, so open one that has already passed.
    const expired = await t.db
      .insertInto("pot_approval_requests")
      .values({
        pot_id: pot.id,
        kind: "co_organiser_promotion",
        requested_by: organiser.id,
        subject_user_id: nominee.id,
        eligible_voters: 4,
        required_approvals: 3,
        expires_at: inDays(-1),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    expect((await vote(rest[0]!, pot.id, expired.id, "approve")).json().error.code).toBe("APPROVAL_CLOSED");
    const listed = (await h.call(rest[0]!, "GET", `/pots/${pot.id}/approvals`)).json();
    expect(listed.find((a: { id: string }) => a.id === expired.id).status).toBe("expired");
  });

  it("decides exactly once when the deciding votes arrive together", async () => {
    const { pot, organiser, nominee, rest } = await scene(3); // needs 3 of 4; organiser's yes is in
    const { id } = (await nominate(organiser, pot.id, nominee.id)).json();

    // Make every vote pause just before it commits, after it has counted the
    // votes, so the two votes below are guaranteed to count while the other is
    // still uncommitted. Without the lock on the request, each would see only
    // two approvals and the nomination would stay open forever.
    await sql`create function test_slow_vote() returns trigger language plpgsql as $$
      begin perform pg_sleep(0.3); return null; end $$`.execute(t.db);
    await sql`create constraint trigger test_slow_vote after insert on pot_approval_votes
      deferrable initially deferred for each row execute function test_slow_vote()`.execute(t.db);
    try {
      const results = await Promise.all([vote(rest[0]!, pot.id, id, "approve"), vote(rest[1]!, pot.id, id, "approve")]);
      expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    } finally {
      await sql`drop trigger test_slow_vote on pot_approval_votes`.execute(t.db);
      await sql`drop function test_slow_vote()`.execute(t.db);
    }
    expect(await roleOf(pot.id, nominee.id)).toBe("co_organiser");
    expect(await h.auditFor(pot.id, "approval.approved")).toHaveLength(1);
  });
});

describe("withdrawing and reversing", () => {
  it("lets the organiser withdraw an open nomination", async () => {
    const { pot, organiser, nominee, rest } = await scene(2);
    const { id } = (await nominate(organiser, pot.id, nominee.id)).json();
    expect((await h.call(rest[0]!, "POST", `/pots/${pot.id}/approvals/${id}/cancel`)).statusCode).toBe(403);
    expect((await h.call(organiser, "POST", `/pots/${pot.id}/approvals/${id}/cancel`)).statusCode).toBe(200);
    expect((await vote(rest[0]!, pot.id, id, "approve")).json().error.code).toBe("APPROVAL_CLOSED");
  });

  it("closes the vote if the nominee leaves", async () => {
    const { pot, organiser, nominee, rest } = await scene(2);
    const { id } = (await nominate(organiser, pot.id, nominee.id)).json();
    await h.call(nominee, "POST", `/pots/${pot.id}/leave`);
    expect((await vote(rest[0]!, pot.id, id, "approve")).json().error.code).toBe("APPROVAL_CLOSED");
  });

  it("lets the organiser take co-organiser rights back without a vote", async () => {
    const { pot, organiser, nominee } = await scene(0);
    await nominate(organiser, pot.id, nominee.id);
    expect((await h.call(nominee, "POST", `/pots/${pot.id}/members/${nominee.id}/demote`)).statusCode).toBe(403);
    expect((await h.call(organiser, "POST", `/pots/${pot.id}/members/${nominee.id}/demote`)).statusCode).toBe(200);
    expect(await roleOf(pot.id, nominee.id)).toBe("member");
    expect(await h.typesFor(nominee.id, pot.id)).toContain("co_organiser_removed");
    expect((await h.call(organiser, "POST", `/pots/${pot.id}/members/${nominee.id}/demote`)).statusCode).toBe(404);
  });
});
