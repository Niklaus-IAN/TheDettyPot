import type { Db } from "../db/index.js";
import type { EmailSender } from "../notifications/email.js";
import { notifyPotMembers, notifyUser, renderNotifications } from "../notifications/service.js";
import type { Rendered } from "../notifications/catalog.js";
import { paidByMember, totalRaised } from "../pots/money.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// ─────────────────────────────────────────────
// Email delivery
// ─────────────────────────────────────────────

/** Wait before each retry. After the last one the delivery is marked failed. */
export const RETRY_DELAYS_MINUTES = [1, 5, 30, 120, 360];
export const MAX_ATTEMPTS = RETRY_DELAYS_MINUTES.length + 1;

export const emailText = (r: Rendered) =>
  [r.title, r.body, r.link ? `Open DettyPot: ${r.link}` : "", "—\nDettyPot · Plan together. Fund together. Live together."]
    .filter(Boolean)
    .join("\n\n");

export interface DeliveryStats {
  sent: number;
  retrying: number;
  failed: number;
  skipped: number;
}

/**
 * Sends pending emails, one row at a time. Each row is locked with SKIP LOCKED,
 * so several workers can run side by side without sending anything twice.
 */
export async function deliverEmails(
  db: Db,
  sender: EmailSender,
  opts: { webBaseUrl: string; limit?: number; now?: Date },
): Promise<DeliveryStats> {
  const now = opts.now ?? new Date();
  const stats: DeliveryStats = { sent: 0, retrying: 0, failed: 0, skipped: 0 };

  for (let i = 0; i < (opts.limit ?? 25); i++) {
    const handled = await db.transaction().execute(async (trx) => {
      const delivery = await trx
        .selectFrom("notification_deliveries")
        .selectAll()
        .where("status", "=", "pending")
        .where("channel", "=", "email")
        .where("next_attempt_at", "<=", now)
        .orderBy("next_attempt_at")
        .limit(1)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!delivery) return false;

      const notification = await trx
        .selectFrom("notifications as n")
        .leftJoin("users as u", "u.id", "n.user_id")
        .select(["n.id", "n.type", "n.pot_id", "n.payload", "n.recipient_email", "u.email as user_email"])
        .where("n.id", "=", delivery.notification_id)
        .executeTakeFirstOrThrow();
      const to = notification.user_email ?? notification.recipient_email;
      const attempts = delivery.attempts + 1;

      if (!to) {
        // The account was deleted after the notification was queued.
        await trx
          .updateTable("notification_deliveries")
          .set({ status: "skipped", attempts, last_error: "recipient has no email address" })
          .where("id", "=", delivery.id)
          .execute();
        stats.skipped++;
        return true;
      }

      const rendered = (await renderNotifications(trx, [notification], opts.webBaseUrl)).get(notification.id)!;
      try {
        const { messageId } = await sender.send({ to, subject: rendered.title, text: emailText(rendered) });
        await trx
          .updateTable("notification_deliveries")
          .set({ status: "sent", attempts, sent_at: now, provider_message_id: messageId, last_error: null })
          .where("id", "=", delivery.id)
          .execute();
        stats.sent++;
      } catch (err) {
        const last_error = String((err as Error).message ?? err).slice(0, 500);
        if (attempts >= MAX_ATTEMPTS) {
          await trx
            .updateTable("notification_deliveries")
            .set({ status: "failed", attempts, last_error })
            .where("id", "=", delivery.id)
            .execute();
          stats.failed++;
        } else {
          const delay = RETRY_DELAYS_MINUTES[attempts - 1]! * MINUTE;
          await trx
            .updateTable("notification_deliveries")
            .set({ attempts, last_error, next_attempt_at: new Date(now.getTime() + delay) })
            .where("id", "=", delivery.id)
            .execute();
          stats.retrying++;
        }
      }
      return true;
    });
    if (!handled) break;
  }
  return stats;
}

// ─────────────────────────────────────────────
// Payment reminders (FR-NOT-01/03)
// ─────────────────────────────────────────────

export const REMINDER_INTERVAL_DAYS = { daily: 1, every_3_days: 3, weekly: 7 } as const;
/** Reminders only go out between these local hours, never at night. */
export const REMINDER_HOURS = { from: 9, until: 20 };

const localHour = (now: Date, timeZone: string) =>
  Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "numeric", hourCycle: "h23" }).format(now));

/**
 * Reminds members who still owe money, at the frequency each member chose.
 * The first reminder comes one interval after they joined or collection
 * opened, whichever is later.
 */
export async function sendPaymentReminders(db: Db, opts: { now?: Date } = {}): Promise<number> {
  const now = opts.now ?? new Date();
  const candidates = await db
    .selectFrom("pot_members as m")
    .innerJoin("pots as p", "p.id", "m.pot_id")
    .select([
      "m.id",
      "m.user_id",
      "m.pot_id",
      "m.reminder_frequency",
      "m.last_reminded_at",
      "m.joined_at",
      "p.stage_changed_at",
      "p.share_kobo",
      "p.timezone",
    ])
    .where("p.stage", "=", "collecting")
    .where("p.frozen_at", "is", null)
    .where("m.status", "=", "active")
    .where("m.reminder_frequency", "<>", "off")
    .where((eb) => eb.or([eb("p.funding_deadline", "is", null), eb("p.funding_deadline", ">", now)]))
    .execute();

  const due = candidates.filter((c) => {
    const hour = localHour(now, c.timezone);
    if (hour < REMINDER_HOURS.from || hour >= REMINDER_HOURS.until) return false;
    const interval = REMINDER_INTERVAL_DAYS[c.reminder_frequency as keyof typeof REMINDER_INTERVAL_DAYS] * DAY;
    const since = c.last_reminded_at ?? new Date(Math.max(c.joined_at?.getTime() ?? 0, c.stage_changed_at.getTime()));
    return since.getTime() <= now.getTime() - interval;
  });
  if (due.length === 0) return 0;

  const paid = await paidByMember(db, [...new Set(due.map((c) => c.pot_id))]);
  let sent = 0;
  for (const c of due) {
    const owed = c.share_kobo - (paid.get(c.pot_id)?.get(c.user_id) ?? 0);
    if (owed <= 0) continue;
    const interval = REMINDER_INTERVAL_DAYS[c.reminder_frequency as keyof typeof REMINDER_INTERVAL_DAYS] * DAY;
    const cutoff = new Date(now.getTime() - interval);
    await db.transaction().execute(async (trx) => {
      // Claim the reminder first; another worker that got here first wins.
      const claimed = await trx
        .updateTable("pot_members")
        .set({ last_reminded_at: now })
        .where("id", "=", c.id)
        .where((eb) => eb.or([eb("last_reminded_at", "is", null), eb("last_reminded_at", "<=", cutoff)]))
        .executeTakeFirst();
      if (Number(claimed.numUpdatedRows) === 0) return;
      await notifyUser(trx, c.user_id, c.pot_id, "reminder", { owedKobo: owed });
      sent++;
    });
  }
  return sent;
}

// ─────────────────────────────────────────────
// Deadline alerts
// ─────────────────────────────────────────────

export const DEADLINE_WARNING_HOURS = 48;

/** Two days before the deadline, tells everyone who still owes money. Once per deadline. */
export async function sendDeadlineWarnings(db: Db, opts: { now?: Date } = {}): Promise<number> {
  const now = opts.now ?? new Date();
  const pots = await db
    .selectFrom("pots")
    .select(["id", "share_kobo"])
    .where("stage", "=", "collecting")
    .where("frozen_at", "is", null)
    .where("deadline_warning_sent_at", "is", null)
    .where("funding_deadline", ">", now)
    .where("funding_deadline", "<=", new Date(now.getTime() + DEADLINE_WARNING_HOURS * HOUR))
    .execute();

  let warned = 0;
  for (const pot of pots) {
    await db.transaction().execute(async (trx) => {
      const claimed = await trx
        .updateTable("pots")
        .set({ deadline_warning_sent_at: now })
        .where("id", "=", pot.id)
        .where("deadline_warning_sent_at", "is", null)
        .executeTakeFirst();
      if (Number(claimed.numUpdatedRows) === 0) return;

      const members = await trx
        .selectFrom("pot_members")
        .select("user_id")
        .where("pot_id", "=", pot.id)
        .where("status", "=", "active")
        .execute();
      const paid = (await paidByMember(trx, [pot.id])).get(pot.id);
      for (const m of members) {
        const owed = pot.share_kobo - (paid?.get(m.user_id) ?? 0);
        if (owed > 0) {
          await notifyUser(trx, m.user_id, pot.id, "deadline_near", { owedKobo: owed });
          warned++;
        }
      }
    });
  }
  return warned;
}

/**
 * When the deadline passes without the target met, asks the organisers to
 * decide: extend, go ahead with less, or cancel (MON-15). Once per deadline.
 */
export async function sendDeadlinePassedAlerts(db: Db, opts: { now?: Date } = {}): Promise<number> {
  const now = opts.now ?? new Date();
  const pots = await db
    .selectFrom("pots")
    .select(["id", "budget_kobo"])
    .where("stage", "=", "collecting")
    .where("frozen_at", "is", null)
    .where("deadline_passed_sent_at", "is", null)
    .where("funding_deadline", "<=", now)
    .execute();
  if (pots.length === 0) return 0;

  const paid = await paidByMember(
    db,
    pots.map((p) => p.id),
  );
  let alerted = 0;
  for (const pot of pots) {
    const raised = totalRaised(paid.get(pot.id));
    if (raised >= pot.budget_kobo) continue;
    await db.transaction().execute(async (trx) => {
      const claimed = await trx
        .updateTable("pots")
        .set({ deadline_passed_sent_at: now })
        .where("id", "=", pot.id)
        .where("deadline_passed_sent_at", "is", null)
        .executeTakeFirst();
      if (Number(claimed.numUpdatedRows) === 0) return;
      await notifyPotMembers(
        trx,
        pot.id,
        "deadline_passed",
        { raisedKobo: raised, budgetKobo: pot.budget_kobo },
        { roles: ["organiser", "co_organiser"] },
      );
      alerted++;
    });
  }
  return alerted;
}
