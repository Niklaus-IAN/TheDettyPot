import { createHash } from "node:crypto";
import { recordAudit } from "../audit.js";
import type { Db } from "../db/index.js";
import { finishPayout } from "../payouts/service.js";
import { checkRefundsForPayment } from "../refunds/service.js";
import { confirmPayment } from "./service.js";
import type { PaystackClient } from "./paystack.js";

export interface PaystackEvent {
  event: string;
  data?: Record<string, unknown>;
}

/** Wait before each retry; after the last, the event is marked failed for a person to look at. */
export const WEBHOOK_RETRY_MINUTES = [1, 5, 15, 60, 180];
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_MINUTES.length + 1;
/** While an event is being processed it is leased; if the process dies, it's picked up again after this. */
const LEASE_MINUTES = 5;

/** The same real-world event always gets the same key, however many times it's delivered (MON-04). */
export function dedupeKey(event: PaystackEvent, rawBody: Buffer): string {
  const d = event.data ?? {};
  const ref = d.reference ?? d.refund_reference ?? d.transaction_reference ?? d.transfer_code;
  if (typeof ref === "string" || typeof ref === "number") return `${event.event}:${ref}`;
  return `${event.event}:sha256:${createHash("sha256").update(rawBody).digest("hex")}`;
}

/** Stores a verified event before anything is done with it. Returns null if it was already stored. */
export async function storeWebhook(db: Db, event: PaystackEvent, rawBody: Buffer): Promise<string | null> {
  const row = await db
    .insertInto("webhook_events")
    .values({
      provider: "paystack",
      event_type: event.event,
      dedupe_key: dedupeKey(event, rawBody),
      payload: JSON.stringify(event),
    })
    .onConflict((oc) => oc.columns(["provider", "dedupe_key"]).doNothing())
    .returning("id")
    .executeTakeFirst();
  return row?.id ?? null;
}

class RetryLater extends Error {}

/** What each event means for DettyPot. Events this stage doesn't handle yet are kept but ignored. */
async function handle(db: Db, paystack: PaystackClient, event: PaystackEvent): Promise<"processed" | "ignored"> {
  if (event.event === "charge.success") {
    const reference = event.data?.reference;
    if (typeof reference !== "string") return "ignored";
    const outcome = await confirmPayment(db, paystack, reference, "webhook");
    if (outcome === "unknown") return "ignored"; // not a DettyPot payment
    // Paystack said success but verify doesn't agree yet: ask again later.
    if (outcome === "not_paid") throw new RetryLater("Paystack has not confirmed this charge yet");
    return "processed";
  }
  if (event.event === "transfer.success" || event.event === "transfer.failed" || event.event === "transfer.reversed") {
    const reference = event.data?.reference;
    if (typeof reference !== "string") return "ignored";
    const outcome = await finishPayout(db, paystack, reference, "webhook");
    if (outcome === "unknown") return "ignored";
    // Paystack's verify still shows the transfer in progress: ask again later.
    if (outcome === "sending") throw new RetryLater("Paystack has not confirmed this transfer's result yet");
    return "processed";
  }
  if (event.event.startsWith("refund.")) {
    const reference = event.data?.transaction_reference;
    if (typeof reference !== "string") return "ignored";
    // Whatever the event says, Paystack's refund record is checked for the truth.
    return (await checkRefundsForPayment(db, paystack, reference)) > 0 ? "processed" : "ignored";
  }
  return "ignored";
}

/**
 * Takes the lease on one event: a specific one that just arrived, or the next
 * one due. A specific event is claimed regardless of its timestamp: Postgres
 * stamps it to the microsecond and a JS clock only to the millisecond, so
 * "due by now" could wrongly skip an event stored a moment ago.
 */
async function claim(db: Db, now: Date, eventId?: string) {
  return db.transaction().execute(async (trx) => {
    let query = trx.selectFrom("webhook_events").selectAll().where("status", "=", "pending");
    query = eventId ? query.where("id", "=", eventId) : query.where("next_attempt_at", "<=", now);
    const row = await query.orderBy("next_attempt_at").limit(1).forUpdate().skipLocked().executeTakeFirst();
    if (!row) return null;
    await trx
      .updateTable("webhook_events")
      .set({ attempts: row.attempts + 1, next_attempt_at: new Date(now.getTime() + LEASE_MINUTES * 60_000) })
      .where("id", "=", row.id)
      .execute();
    return { ...row, attempts: row.attempts + 1 };
  });
}

async function processClaimed(db: Db, paystack: PaystackClient, row: NonNullable<Awaited<ReturnType<typeof claim>>>, now: Date) {
  try {
    const status = await handle(db, paystack, row.payload as unknown as PaystackEvent);
    await db.updateTable("webhook_events").set({ status, processed_at: new Date(), last_error: null }).where("id", "=", row.id).execute();
    return status;
  } catch (err) {
    const last_error = String((err as Error).message ?? err).slice(0, 500);
    if (row.attempts >= WEBHOOK_MAX_ATTEMPTS) {
      await db.updateTable("webhook_events").set({ status: "failed", last_error }).where("id", "=", row.id).execute();
      await recordAudit(db, {
        actorUserId: null,
        action: "webhook.failed",
        subjectType: "webhook_event",
        subjectId: row.id,
        metadata: { eventType: row.event_type, error: last_error },
      });
      return "failed";
    }
    const delay = WEBHOOK_RETRY_MINUTES[row.attempts - 1]! * 60_000;
    await db
      .updateTable("webhook_events")
      .set({ last_error, next_attempt_at: new Date(now.getTime() + delay) })
      .where("id", "=", row.id)
      .execute();
    return "retrying";
  }
}

/** Processes one stored event straight away (used right after it arrives). */
export async function processWebhookEvent(db: Db, paystack: PaystackClient, eventId: string, now = new Date()) {
  const row = await claim(db, now, eventId);
  return row ? processClaimed(db, paystack, row, now) : "skipped";
}

/** The worker's job: everything due, oldest first. Safe to run on several workers. */
export async function processPendingWebhooks(db: Db, paystack: PaystackClient, opts: { now?: Date; limit?: number } = {}) {
  const now = opts.now ?? new Date();
  const stats = { processed: 0, ignored: 0, retrying: 0, failed: 0 };
  for (let i = 0; i < (opts.limit ?? 50); i++) {
    const row = await claim(db, now);
    if (!row) break;
    stats[await processClaimed(db, paystack, row, now)]++;
  }
  return stats;
}
