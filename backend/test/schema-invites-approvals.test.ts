import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { addMember, createPot, createUser, testDb, tokenHash, type Pot, type User } from "./fixtures.js";

const db = testDb();
afterAll(() => db.destroy());

const inOneDay = () => new Date(Date.now() + 24 * 3600 * 1000);

describe("invites", () => {
  let organiser: User;
  let pot: Pot;
  beforeEach(async () => {
    organiser = await createUser(db);
    pot = await createPot(db, organiser);
  });

  const invite = (overrides: Record<string, unknown> = {}) =>
    db
      .insertInto("pot_invites")
      .values({ pot_id: pot.id, created_by: organiser.id, kind: "link", token_hash: tokenHash(), ...overrides })
      .returningAll()
      .executeTakeFirstOrThrow();

  it("store only a 32-byte token hash, never a short or raw token", async () => {
    await expect(invite({ token_hash: Buffer.from("raw-token") })).rejects.toThrow(/pot_invites_token_hash_check/);
  });

  it("cannot share a token hash", async () => {
    const hash = tokenHash();
    await invite({ token_hash: hash });
    await expect(invite({ token_hash: hash })).rejects.toThrow(/pot_invites_token_hash_key/);
  });

  it("cannot be used more times than allowed", async () => {
    const inv = await invite({ max_uses: 1 });
    await db.updateTable("pot_invites").set({ use_count: 1 }).where("id", "=", inv.id).execute();
    await expect(
      db.updateTable("pot_invites").set({ use_count: 2 }).where("id", "=", inv.id).execute(),
    ).rejects.toThrow(/pot_invites_within_max_uses/);
  });

  it("need an address when sent by email or phone", async () => {
    await expect(invite({ kind: "email" })).rejects.toThrow(/pot_invites_email_has_address/);
    await expect(invite({ kind: "phone" })).rejects.toThrow(/pot_invites_phone_has_number/);
    await expect(invite({ kind: "email", invitee_email: "friend@example.com" })).resolves.toBeTruthy();
  });

  it("record who revoked them", async () => {
    const inv = await invite();
    await expect(
      db.updateTable("pot_invites").set({ revoked_at: new Date() }).where("id", "=", inv.id).execute(),
    ).rejects.toThrow(/pot_invites_revoked_by_someone/);
  });

  it("cannot be deleted", async () => {
    const inv = await invite();
    await expect(db.deleteFrom("pot_invites").where("id", "=", inv.id).execute()).rejects.toThrow(
      /DELETE is not allowed on pot_invites/,
    );
  });
});

describe("co-organiser approvals", () => {
  let organiser: User;
  let nominee: User;
  let voterA: User;
  let voterB: User;
  let pot: Pot;

  beforeEach(async () => {
    organiser = await createUser(db);
    nominee = await createUser(db);
    voterA = await createUser(db);
    voterB = await createUser(db);
    pot = await createPot(db, organiser);
    for (const user of [nominee, voterA, voterB]) await addMember(db, pot, user);
  });

  // Majority of active members other than the nominee: 3 eligible, 2 needed.
  const openRequest = (overrides: Record<string, unknown> = {}) =>
    db
      .insertInto("pot_approval_requests")
      .values({
        pot_id: pot.id,
        kind: "co_organiser_promotion",
        requested_by: organiser.id,
        subject_user_id: nominee.id,
        eligible_voters: 3,
        required_approvals: 2,
        expires_at: inOneDay(),
        ...overrides,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

  const vote = (requestId: string, user: User, decision = "approve") =>
    db.insertInto("pot_approval_votes").values({ request_id: requestId, user_id: user.id, decision }).execute();

  it("accept one vote per active member", async () => {
    const req = await openRequest();
    await vote(req.id, voterA);
    await expect(vote(req.id, voterA, "reject")).rejects.toThrow(/pot_approval_votes_pkey/);
  });

  it("do not let the nominee vote on their own promotion", async () => {
    const req = await openRequest();
    await expect(vote(req.id, nominee)).rejects.toThrow(/cannot vote on a decision about themselves/);
  });

  it("do not let outsiders or former members vote", async () => {
    const req = await openRequest();
    await expect(vote(req.id, await createUser(db))).rejects.toThrow(/only active members/);
    await db.updateTable("pot_members").set({ status: "left" }).where("pot_id", "=", pot.id).where("user_id", "=", voterB.id).execute();
    await expect(vote(req.id, voterB)).rejects.toThrow(/only active members/);
  });

  it("treat votes as final", async () => {
    const req = await openRequest();
    await vote(req.id, voterA);
    await expect(
      db.updateTable("pot_approval_votes").set({ decision: "reject" }).where("request_id", "=", req.id).execute(),
    ).rejects.toThrow(/UPDATE is not allowed on pot_approval_votes/);
    await expect(db.deleteFrom("pot_approval_votes").where("request_id", "=", req.id).execute()).rejects.toThrow(
      /DELETE is not allowed on pot_approval_votes/,
    );
  });

  it("allow only one open request per nominee", async () => {
    await openRequest();
    await expect(openRequest()).rejects.toThrow(/pot_approval_requests_one_open/);
  });

  it("allow a new request once the previous one is resolved", async () => {
    const req = await openRequest();
    await db.updateTable("pot_approval_requests").set({ status: "rejected" }).where("id", "=", req.id).execute();
    await expect(openRequest()).resolves.toBeTruthy();
  });

  it("are final once resolved and stamp the resolution time", async () => {
    const req = await openRequest();
    const approved = await db
      .updateTable("pot_approval_requests")
      .set({ status: "approved" })
      .where("id", "=", req.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    expect(approved.resolved_at).not.toBeNull();
    await expect(
      db.updateTable("pot_approval_requests").set({ status: "open" }).where("id", "=", req.id).execute(),
    ).rejects.toThrow(/already approved/);
    await expect(vote(req.id, voterA)).rejects.toThrow(/is closed/);
  });

  it("reject votes after the deadline", async () => {
    const req = await openRequest({ expires_at: new Date(Date.now() - 1000) });
    await expect(vote(req.id, voterA)).rejects.toThrow(/is closed/);
  });

  it("cannot have their rules changed after opening", async () => {
    const req = await openRequest();
    await expect(
      db.updateTable("pot_approval_requests").set({ required_approvals: 1 }).where("id", "=", req.id).execute(),
    ).rejects.toThrow(/only the status of an approval request can change/);
  });

  it("need a threshold that can actually be reached", async () => {
    await expect(openRequest({ required_approvals: 4 })).rejects.toThrow(/pot_approval_requests_threshold/);
    await expect(openRequest({ required_approvals: 0 })).rejects.toThrow(/pot_approval_requests_threshold/);
  });

  it("need a nominee for a promotion", async () => {
    await expect(openRequest({ subject_user_id: null })).rejects.toThrow(/pot_approval_requests_promotion_has_subject/);
  });
});
