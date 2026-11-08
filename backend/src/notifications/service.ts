import type { Selectable } from "kysely";
import type { Database, Db } from "../db/index.js";
import { render, sendsEmail, type NotificationType, type Rendered } from "./catalog.js";

export type NotificationRow = Selectable<Database["notifications"]>;

/**
 * Notifications are written in the same transaction as the change they
 * announce, so a rolled-back change never notifies anyone. Each one is an
 * in-app notification; types marked for email also get a delivery row that
 * the worker sends, with retries (FR-NOT-02).
 */
async function insertNotifications(
  db: Db,
  rows: { user_id: string | null; recipient_email?: string | null; pot_id: string | null; type: NotificationType; payload: Record<string, unknown> }[],
): Promise<void> {
  if (rows.length === 0) return;
  const inserted = await db
    .insertInto("notifications")
    .values(rows.map((r) => ({ ...r, recipient_email: r.recipient_email ?? null, payload: JSON.stringify(r.payload) })))
    .returning(["id", "type"])
    .execute();
  const emails = inserted.filter((n) => sendsEmail(n.type));
  if (emails.length > 0) {
    await db
      .insertInto("notification_deliveries")
      .values(emails.map((n) => ({ notification_id: n.id, channel: "email" })))
      .execute();
  }
}

/** Notifies every active member of a pot, optionally only some roles or all but one person. */
export async function notifyPotMembers(
  db: Db,
  potId: string,
  type: NotificationType,
  payload: Record<string, unknown>,
  opts: { exceptUserId?: string; roles?: readonly string[] } = {},
): Promise<void> {
  let query = db.selectFrom("pot_members").select("user_id").where("pot_id", "=", potId).where("status", "=", "active");
  if (opts.exceptUserId) query = query.where("user_id", "<>", opts.exceptUserId);
  if (opts.roles) query = query.where("role", "in", [...opts.roles]);
  const recipients = await query.execute();
  await insertNotifications(
    db,
    recipients.map((r) => ({ user_id: r.user_id, pot_id: potId, type, payload })),
  );
}

export async function notifyUser(
  db: Db,
  userId: string,
  potId: string | null,
  type: NotificationType,
  payload: Record<string, unknown>,
): Promise<void> {
  await insertNotifications(db, [{ user_id: userId, pot_id: potId, type, payload }]);
}

/** Notifies an email address: the account behind it if there is one, otherwise just the address. */
export async function notifyEmailAddress(
  db: Db,
  email: string,
  potId: string | null,
  type: NotificationType,
  payload: Record<string, unknown>,
): Promise<void> {
  const user = await db.selectFrom("users").select("id").where("email", "=", email).where("deleted_at", "is", null).executeTakeFirst();
  await insertNotifications(db, [
    { user_id: user?.id ?? null, recipient_email: user ? null : email, pot_id: potId, type, payload },
  ]);
}

/** Renders notifications for display, looking up the pots they mention in one query. */
export async function renderNotifications(
  db: Db,
  rows: Pick<NotificationRow, "id" | "type" | "pot_id" | "payload">[],
  webBaseUrl: string,
): Promise<Map<string, Rendered>> {
  const potIds = [...new Set(rows.map((r) => r.pot_id).filter((id): id is string => id !== null))];
  const pots = potIds.length
    ? await db.selectFrom("pots").select(["id", "name", "share_kobo", "funding_deadline", "timezone"]).where("id", "in", potIds).execute()
    : [];
  const byId = new Map(pots.map((p) => [p.id, p]));
  const out = new Map<string, Rendered>();
  for (const row of rows) {
    const pot = row.pot_id ? byId.get(row.pot_id) : undefined;
    out.set(
      row.id,
      render(row.type, {
        pot: pot
          ? { id: pot.id, name: pot.name, shareKobo: pot.share_kobo, fundingDeadline: pot.funding_deadline, timezone: pot.timezone }
          : null,
        payload: (row.payload ?? {}) as Record<string, unknown>,
        webBaseUrl,
      }),
    );
  }
  return out;
}

export interface InboxItem {
  row: NotificationRow;
  rendered: Rendered;
}

export async function listInbox(
  db: Db,
  userId: string,
  opts: { limit: number; before?: Date; webBaseUrl: string },
): Promise<{ items: InboxItem[]; unreadCount: number }> {
  let query = db.selectFrom("notifications").selectAll().where("user_id", "=", userId);
  if (opts.before) query = query.where("created_at", "<", opts.before);
  const rows = await query.orderBy("created_at", "desc").orderBy("id", "desc").limit(opts.limit).execute();
  const rendered = await renderNotifications(db, rows, opts.webBaseUrl);
  return {
    items: rows.map((row) => ({ row, rendered: rendered.get(row.id)! })),
    unreadCount: await unreadCount(db, userId),
  };
}

export async function unreadCount(db: Db, userId: string): Promise<number> {
  const { n } = await db
    .selectFrom("notifications")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("user_id", "=", userId)
    .where("read_at", "is", null)
    .executeTakeFirstOrThrow();
  return Number(n);
}

export async function markRead(db: Db, userId: string, ids?: string[]): Promise<number> {
  let query = db.updateTable("notifications").set({ read_at: new Date() }).where("user_id", "=", userId).where("read_at", "is", null);
  if (ids) query = query.where("id", "in", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
  await query.execute();
  return unreadCount(db, userId);
}
