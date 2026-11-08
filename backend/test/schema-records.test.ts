import { sql } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { createUser, testDb } from "./fixtures.js";

const db = testDb();
afterAll(() => db.destroy());

describe("audit log", () => {
  const record = (overrides: Record<string, unknown> = {}) =>
    db
      .insertInto("audit_events")
      .values({ actor_type: "system", action: "pot.created", ...overrides })
      .returningAll()
      .executeTakeFirstOrThrow();

  it("accepts new events", async () => {
    const user = await createUser(db);
    const event = await record({ actor_type: "user", actor_user_id: user.id, metadata: { via: "test" } });
    expect(event.id).toBeGreaterThan(0);
  });

  it("can never be edited, deleted or truncated", async () => {
    const event = await record();
    await expect(
      db.updateTable("audit_events").set({ action: "pot.deleted" }).where("id", "=", event.id).execute(),
    ).rejects.toThrow(/UPDATE is not allowed on audit_events/);
    await expect(db.deleteFrom("audit_events").where("id", "=", event.id).execute()).rejects.toThrow(
      /DELETE is not allowed on audit_events/,
    );
    await expect(sql`truncate audit_events`.execute(db)).rejects.toThrow(/TRUNCATE is not allowed on audit_events/);
  });

  it("names a user for user and admin actions, and none for system actions", async () => {
    await expect(record({ actor_type: "user" })).rejects.toThrow(/audit_events_actor/);
    const user = await createUser(db);
    await expect(record({ actor_type: "system", actor_user_id: user.id })).rejects.toThrow(/audit_events_actor/);
  });

  it("uses dotted lowercase action names", async () => {
    await expect(record({ action: "Pot Created!" })).rejects.toThrow(/audit_events_action_check/);
  });
});

describe("notifications", () => {
  const notify = async (type = "payment_received") => {
    const user = await createUser(db);
    return db.insertInto("notifications").values({ user_id: user.id, type }).returningAll().executeTakeFirstOrThrow();
  };

  it("use snake_case event types", async () => {
    await expect(notify("Payment Received")).rejects.toThrow(/notifications_type_check/);
  });

  it("have at most one delivery per channel", async () => {
    const n = await notify();
    await db.insertInto("notification_deliveries").values({ notification_id: n.id, channel: "email" }).execute();
    await expect(
      db.insertInto("notification_deliveries").values({ notification_id: n.id, channel: "email" }).execute(),
    ).rejects.toThrow(/notification_deliveries_notification_id_channel_key/);
  });

  it("record when a delivery was sent", async () => {
    const n = await notify();
    const d = await db
      .insertInto("notification_deliveries")
      .values({ notification_id: n.id, channel: "email" })
      .returningAll()
      .executeTakeFirstOrThrow();
    await expect(
      db.updateTable("notification_deliveries").set({ status: "sent" }).where("id", "=", d.id).execute(),
    ).rejects.toThrow(/notification_deliveries_sent_has_time/);
    await expect(
      db.updateTable("notification_deliveries").set({ status: "sent", sent_at: new Date() }).where("id", "=", d.id).execute(),
    ).resolves.toBeTruthy();
  });
});
