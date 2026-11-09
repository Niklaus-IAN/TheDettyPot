import type { Db } from "../db/index.js";

/**
 * Queues an in-app notification for every active member of a pot. Delivery to
 * outside channels (email now, WhatsApp later) is added by the notification
 * worker. Call inside the same transaction as the change being announced, so a
 * rolled-back change never notifies anyone.
 */
export async function notifyPotMembers(
  db: Db,
  potId: string,
  type: string,
  payload: Record<string, unknown>,
  opts: { exceptUserId?: string; roles?: readonly string[] } = {},
): Promise<void> {
  let query = db.selectFrom("pot_members").select("user_id").where("pot_id", "=", potId).where("status", "=", "active");
  if (opts.exceptUserId) query = query.where("user_id", "<>", opts.exceptUserId);
  if (opts.roles) query = query.where("role", "in", [...opts.roles]);
  const recipients = await query.execute();
  if (recipients.length === 0) return;

  await db
    .insertInto("notifications")
    .values(recipients.map((r) => ({ user_id: r.user_id, pot_id: potId, type, payload: JSON.stringify(payload) })))
    .execute();
}

/** Queues an in-app notification for one person. */
export async function notifyUser(
  db: Db,
  userId: string,
  potId: string | null,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await db
    .insertInto("notifications")
    .values({ user_id: userId, pot_id: potId, type, payload: JSON.stringify(payload) })
    .execute();
}
