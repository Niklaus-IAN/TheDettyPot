import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authorizePot } from "../src/auth/pot-access.js";
import { addMember, createPot, createUser, testDb, type Pot, type User } from "./fixtures.js";

const db = testDb();
afterAll(() => db.destroy());

let organiser: User;
let coOrganiser: User;
let member: User;
let unverifiedMember: User;
let pending: User;
let former: User;
let outsider: User;
let pot: Pot;

beforeAll(async () => {
  const verified = { email_verified_at: new Date() };
  organiser = await createUser(db, verified);
  coOrganiser = await createUser(db, verified);
  member = await createUser(db, verified);
  unverifiedMember = await createUser(db);
  pending = await createUser(db, verified);
  former = await createUser(db, verified);
  outsider = await createUser(db, verified);
  pot = await createPot(db, organiser);
  await addMember(db, pot, coOrganiser, { role: "co_organiser" });
  await addMember(db, pot, member);
  await addMember(db, pot, unverifiedMember);
  await addMember(db, pot, pending, { status: "pending" });
  await addMember(db, pot, former, { status: "removed" });
});

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (err) {
    return err as { statusCode: number; code: string };
  }
  throw new Error("expected the check to fail");
};

describe("authorizePot", () => {
  it("lets members in with their role", async () => {
    await expect(authorizePot(db, organiser, pot.id, "pot.view")).resolves.toMatchObject({ role: "organiser" });
    await expect(authorizePot(db, coOrganiser, pot.id, "pot.edit")).resolves.toMatchObject({ role: "co_organiser" });
    await expect(authorizePot(db, member, pot.id, "ledger.view")).resolves.toMatchObject({ role: "member" });
  });

  it("tells non-members the pot does not exist, rather than forbidden", async () => {
    for (const user of [outsider, pending, former]) {
      expect(await errorOf(authorizePot(db, user, pot.id, "pot.view"))).toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
    }
  });

  it("answers the same for a pot that really does not exist, or a malformed id", async () => {
    for (const id of [randomUUID(), "not-a-uuid", "' or 1=1 --"]) {
      expect(await errorOf(authorizePot(db, organiser, id, "pot.view"))).toMatchObject({ statusCode: 404 });
    }
  });

  it("forbids members from actions their role does not allow", async () => {
    expect(await errorOf(authorizePot(db, member, pot.id, "pot.edit"))).toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
    expect(await errorOf(authorizePot(db, coOrganiser, pot.id, "payout.request"))).toMatchObject({ statusCode: 403 });
  });

  it("requires a verified email before moving money", async () => {
    await expect(authorizePot(db, member, pot.id, "contribution.make")).resolves.toBeTruthy();
    expect(await errorOf(authorizePot(db, unverifiedMember, pot.id, "contribution.make"))).toMatchObject({
      statusCode: 403,
      code: "EMAIL_NOT_VERIFIED",
    });
    // Actions that move no money do not need it.
    await expect(authorizePot(db, unverifiedMember, pot.id, "pot.view")).resolves.toBeTruthy();
  });
});
