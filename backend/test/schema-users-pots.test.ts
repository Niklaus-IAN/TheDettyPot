import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, createPot, createUser, naira, setStage, sleep, testDb } from "./fixtures.js";

const db = testDb();
afterAll(() => db.destroy());

describe("users", () => {
  it("are created with safe defaults", async () => {
    const user = await createUser(db);
    expect(user.is_admin).toBe(false);
    expect(user.deleted_at).toBeNull();
  });

  it("treat email addresses case-insensitively", async () => {
    await createUser(db, { email: "Ada@Example.com" });
    await expect(createUser(db, { email: "ada@example.COM" })).rejects.toThrow(/users_email_key/);
  });

  it("require an identity while active", async () => {
    await expect(createUser(db, { auth_subject: null })).rejects.toThrow(/users_active_have_identity/);
    await expect(createUser(db, { email: null })).rejects.toThrow(/users_active_have_identity/);
  });

  it("are anonymised on deletion, keeping the row", async () => {
    const user = await createUser(db, { phone: "+2348031234567" });
    await db
      .updateTable("users")
      .set({ deleted_at: new Date(), auth_subject: null, email: null, full_name: null, phone: null })
      .where("id", "=", user.id)
      .execute();
    const row = await db.selectFrom("users").selectAll().where("id", "=", user.id).executeTakeFirstOrThrow();
    expect(row.email).toBeNull();
    expect(row.deleted_at).not.toBeNull();
  });

  it("cannot be marked deleted while still holding personal data", async () => {
    const user = await createUser(db);
    await expect(
      db.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", user.id).execute(),
    ).rejects.toThrow(/users_deleted_have_no_personal_data/);
  });

  it("cannot be hard-deleted", async () => {
    const user = await createUser(db);
    await expect(db.deleteFrom("users").where("id", "=", user.id).execute()).rejects.toThrow(
      /DELETE is not allowed on users/,
    );
  });

  it("only accept phone numbers in international format", async () => {
    await expect(createUser(db, { phone: "08031234567" })).rejects.toThrow(/users_phone_check/);
    await expect(createUser(db, { phone: "+2348031234568" })).resolves.toBeTruthy();
  });

  it("track when they were last updated", async () => {
    const user = await createUser(db);
    await sleep(5);
    const updated = await db
      .updateTable("users")
      .set({ full_name: "New Name" })
      .where("id", "=", user.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    expect(updated.updated_at.getTime()).toBeGreaterThan(user.updated_at.getTime());
  });
});

describe("pots: share per person", () => {
  let organiser: Awaited<ReturnType<typeof createUser>>;
  beforeAll(async () => {
    organiser = await createUser(db);
  });

  it.each([
    { budget: 100_000, headcount: 3, share: 33_334 }, // rounds up to the whole naira
    { budget: 90_000, headcount: 3, share: 30_000 }, // exact split stays exact
    { budget: 1_000, headcount: 7, share: 143 },
    { budget: 200_000, headcount: 8, share: 25_000 },
  ])("₦$budget ÷ $headcount = ₦$share", async ({ budget, headcount, share }) => {
    const pot = await createPot(db, organiser, { budget_kobo: naira(budget), headcount });
    expect(pot.share_kobo).toBe(naira(share));
  });

  it("follows budget and headcount edits", async () => {
    const pot = await createPot(db, organiser, { budget_kobo: naira(100_000), headcount: 4 });
    const updated = await db
      .updateTable("pots")
      .set({ headcount: 5 })
      .where("id", "=", pot.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    expect(updated.share_kobo).toBe(naira(20_000));
  });

  it("only accepts budgets in whole naira", async () => {
    await expect(createPot(db, organiser, { budget_kobo: naira(1_000) + 50 })).rejects.toThrow(/pots_budget_kobo_check/);
  });

  it("needs at least two people", async () => {
    await expect(createPot(db, organiser, { headcount: 1 })).rejects.toThrow(/pots_headcount_check/);
  });
});

describe("pots: organiser", () => {
  it("must exist when the pot is created", async () => {
    const user = await createUser(db);
    await expect(
      db.insertInto("pots").values({ created_by: user.id, name: "No organiser", budget_kobo: naira(10_000), headcount: 2 }).execute(),
    ).rejects.toThrow(/must have exactly one organiser/);
  });

  it("is unique per pot", async () => {
    const pot = await createPot(db, await createUser(db));
    await expect(addMember(db, pot, await createUser(db), { role: "organiser" })).rejects.toThrow(
      /pot_members_one_organiser/,
    );
  });

  it("cannot be demoted without a replacement", async () => {
    const organiser = await createUser(db);
    const pot = await createPot(db, organiser);
    await expect(
      db.updateTable("pot_members").set({ role: "member" }).where("pot_id", "=", pot.id).where("user_id", "=", organiser.id).execute(),
    ).rejects.toThrow(/must have exactly one organiser/);
  });

  it("can be handed over within one transaction", async () => {
    const organiser = await createUser(db);
    const successor = await createUser(db);
    const pot = await createPot(db, organiser);
    await addMember(db, pot, successor);
    await db.transaction().execute(async (trx) => {
      await trx.updateTable("pot_members").set({ role: "member" }).where("pot_id", "=", pot.id).where("user_id", "=", organiser.id).execute();
      await trx.updateTable("pot_members").set({ role: "organiser" }).where("pot_id", "=", pot.id).where("user_id", "=", successor.id).execute();
    });
    const current = await db.selectFrom("pot_members").select("user_id").where("pot_id", "=", pot.id).where("role", "=", "organiser").executeTakeFirstOrThrow();
    expect(current.user_id).toBe(successor.id);
  });
});

describe("pots: stages", () => {
  let organiser: Awaited<ReturnType<typeof createUser>>;
  beforeAll(async () => {
    organiser = await createUser(db);
  });

  it("start in planning", async () => {
    await expect(createPot(db, organiser, { stage: "collecting" })).rejects.toThrow(/start in the planning stage/);
  });

  it("follow the full lifecycle and record when the stage changed", async () => {
    const pot = await createPot(db, organiser);
    await sleep(5);
    await setStage(db, pot.id, "collecting", "funded", "confirmed", "completed");
    const row = await db.selectFrom("pots").selectAll().where("id", "=", pot.id).executeTakeFirstOrThrow();
    expect(row.stage).toBe("completed");
    expect(row.stage_changed_at.getTime()).toBeGreaterThan(pot.stage_changed_at.getTime());
  });

  it.each(["planning", "collecting", "funded", "confirmed"])("can be cancelled from %s", async (from) => {
    const pot = await createPot(db, organiser);
    const path = ["collecting", "funded", "confirmed"];
    await setStage(db, pot.id, ...path.slice(0, path.indexOf(from) + 1));
    await expect(setStage(db, pot.id, "cancelled")).resolves.toBeUndefined();
  });

  it.each([
    { path: [], to: "funded" }, // skipping collecting
    { path: [], to: "completed" },
    { path: ["collecting"], to: "planning" }, // going backwards
    { path: ["collecting", "funded", "confirmed", "completed"], to: "cancelled" }, // completed is final
    { path: ["cancelled"], to: "collecting" }, // cancelled is final
  ])("reject moving to $to after [$path]", async ({ path, to }) => {
    const pot = await createPot(db, organiser);
    await setStage(db, pot.id, ...path);
    await expect(setStage(db, pot.id, to)).rejects.toThrow(/invalid pot stage change/);
  });

  it("allow budget edits while collecting", async () => {
    const pot = await createPot(db, organiser);
    await setStage(db, pot.id, "collecting");
    await expect(
      db.updateTable("pots").set({ budget_kobo: naira(150_000) }).where("id", "=", pot.id).execute(),
    ).resolves.toBeTruthy();
  });

  it("lock budget and headcount once funded", async () => {
    const pot = await createPot(db, organiser);
    await setStage(db, pot.id, "collecting", "funded");
    await expect(
      db.updateTable("pots").set({ budget_kobo: naira(150_000) }).where("id", "=", pot.id).execute(),
    ).rejects.toThrow(/locked once a pot is funded/);
    await expect(db.updateTable("pots").set({ headcount: 9 }).where("id", "=", pot.id).execute()).rejects.toThrow(
      /locked once a pot is funded/,
    );
  });

  it("never change who created them", async () => {
    const pot = await createPot(db, organiser);
    const other = await createUser(db);
    await expect(
      db.updateTable("pots").set({ created_by: other.id }).where("id", "=", pot.id).execute(),
    ).rejects.toThrow(/created_by cannot change/);
  });

  it("cannot be deleted", async () => {
    const pot = await createPot(db, organiser);
    await expect(db.deleteFrom("pots").where("id", "=", pot.id).execute()).rejects.toThrow(/DELETE is not allowed on pots/);
  });
});

describe("pot members", () => {
  it("join once per pot", async () => {
    const pot = await createPot(db, await createUser(db));
    const user = await createUser(db);
    await addMember(db, pot, user);
    await expect(addMember(db, pot, user)).rejects.toThrow(/pot_members_pot_id_user_id_key/);
  });

  it("get joined_at only when active", async () => {
    const pot = await createPot(db, await createUser(db));
    const active = await addMember(db, pot, await createUser(db));
    const pending = await addMember(db, pot, await createUser(db), { status: "pending" });
    expect(active.joined_at).not.toBeNull();
    expect(pending.joined_at).toBeNull();
  });

  it("must be active to hold an elevated role", async () => {
    const pot = await createPot(db, await createUser(db));
    await expect(
      addMember(db, pot, await createUser(db), { role: "co_organiser", status: "pending" }),
    ).rejects.toThrow(/pot_members_elevated_roles_are_active/);
  });

  it("record when their status changes", async () => {
    const pot = await createPot(db, await createUser(db));
    const member = await addMember(db, pot, await createUser(db));
    await sleep(5);
    const left = await db
      .updateTable("pot_members")
      .set({ status: "left" })
      .where("id", "=", member.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    expect(left.status_changed_at.getTime()).toBeGreaterThan(member.status_changed_at.getTime());
  });

  it("default to reminders every three days and reject unknown frequencies", async () => {
    const pot = await createPot(db, await createUser(db));
    const member = await addMember(db, pot, await createUser(db));
    expect(member.reminder_frequency).toBe("every_3_days");
    await expect(
      db.updateTable("pot_members").set({ reminder_frequency: "hourly" }).where("id", "=", member.id).execute(),
    ).rejects.toThrow(/pot_members_reminder_frequency_check/);
  });

  it("cannot move to another pot or user", async () => {
    const pot = await createPot(db, await createUser(db));
    const otherPot = await createPot(db, await createUser(db));
    const member = await addMember(db, pot, await createUser(db));
    await expect(
      db.updateTable("pot_members").set({ pot_id: otherPot.id }).where("id", "=", member.id).execute(),
    ).rejects.toThrow(/cannot change/);
  });

  it("cannot be deleted", async () => {
    const pot = await createPot(db, await createUser(db));
    const member = await addMember(db, pot, await createUser(db));
    await expect(db.deleteFrom("pot_members").where("id", "=", member.id).execute()).rejects.toThrow(
      /DELETE is not allowed on pot_members/,
    );
  });
});
