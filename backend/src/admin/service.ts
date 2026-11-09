import { recordAudit } from "../audit.js";
import type { Db } from "../db/index.js";
import { conflict, notFound } from "../errors.js";
import { currentSchedule, PAYMENT_METHODS, type PaymentMethod } from "../payments/fees.js";
import { notifyPotMembers } from "../notifications/service.js";
import { paidByMember, totalRaised } from "../pots/money.js";
import type { User } from "../users/service.js";

/**
 * Internal support tools (FR-ADM-01). Only users with is_admin set can reach
 * them; everyone else is told the routes don't exist. Every change an admin
 * makes is written to the audit log as an admin action.
 */
export function assertAdmin(user: User) {
  if (!user.is_admin) throw notFound("Route not found");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Turns free text into a safe ILIKE pattern. */
const contains = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function searchPots(db: Db, q: string, limit = 25) {
  let query = db
    .selectFrom("pots as p")
    .innerJoin("pot_members as m", (j) => j.onRef("m.pot_id", "=", "p.id").on("m.role", "=", "organiser"))
    .innerJoin("users as u", "u.id", "m.user_id")
    .select([
      "p.id",
      "p.name",
      "p.stage",
      "p.budget_kobo",
      "p.frozen_at",
      "p.created_at",
      "u.email as organiser_email",
      "u.full_name as organiser_name",
    ]);
  const term = q.trim();
  if (UUID.test(term)) {
    query = query.where("p.id", "=", term);
  } else if (term) {
    query = query.where((eb) => eb.or([eb("p.name", "ilike", contains(term)), eb("u.email", "ilike", contains(term))]));
  }
  const rows = await query.orderBy("p.created_at", "desc").limit(limit).execute();
  const paid = await paidByMember(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({ ...r, raised_kobo: totalRaised(paid.get(r.id)) }));
}

/** Everything support needs to look into a pot: members, money, invites and history. */
export async function potRecord(db: Db, potId: string) {
  if (!UUID.test(potId)) throw notFound("Pot not found");
  const pot = await db.selectFrom("pots").selectAll().where("id", "=", potId).executeTakeFirst();
  if (!pot) throw notFound("Pot not found");

  const members = await db
    .selectFrom("pot_members as m")
    .innerJoin("users as u", "u.id", "m.user_id")
    .select(["m.user_id", "m.role", "m.status", "m.joined_at", "m.status_changed_at", "u.email", "u.full_name"])
    .where("m.pot_id", "=", potId)
    .orderBy("m.created_at")
    .execute();

  const ledger = await db
    .selectFrom("ledger_transactions as t")
    .leftJoin("ledger_entries as e", "e.transaction_id", "t.id")
    .leftJoin("ledger_accounts as a", (j) => j.onRef("a.id", "=", "e.account_id").on("a.pot_id", "=", potId))
    .select((eb) => [
      "t.id",
      "t.kind",
      "t.description",
      "t.member_user_id",
      "t.created_at",
      eb.fn.coalesce(eb.fn.sum<number>("e.amount_kobo").filterWhere("a.id", "is not", null), eb.lit(0)).as("pot_amount_kobo"),
    ])
    .where("t.pot_id", "=", potId)
    .groupBy("t.id")
    .orderBy("t.created_at")
    .execute();

  const audit = await db
    .selectFrom("audit_events")
    .selectAll()
    .where("pot_id", "=", potId)
    .orderBy("occurred_at", "desc")
    .limit(100)
    .execute();

  const invites = await db
    .selectFrom("pot_invites")
    .select(["id", "kind", "invitee_email", "use_count", "max_uses", "expires_at", "revoked_at", "created_at"])
    .where("pot_id", "=", potId)
    .orderBy("created_at", "desc")
    .execute();

  return { pot, members, ledger: ledger.map((l) => ({ ...l, pot_amount_kobo: Number(l.pot_amount_kobo) })), audit, invites };
}

export async function setFrozen(
  db: Db,
  admin: User,
  potId: string,
  frozen: { reason: string } | null,
  requestId?: string,
): Promise<void> {
  if (!UUID.test(potId)) throw notFound("Pot not found");
  await db.transaction().execute(async (trx) => {
    const pot = await trx.selectFrom("pots").select(["id", "frozen_at"]).where("id", "=", potId).forUpdate().executeTakeFirst();
    if (!pot) throw notFound("Pot not found");
    if (frozen && pot.frozen_at) throw conflict("ALREADY_FROZEN", "This pot is already frozen");
    if (!frozen && !pot.frozen_at) throw conflict("NOT_FROZEN", "This pot isn't frozen");

    await trx
      .updateTable("pots")
      .set(
        frozen
          ? { frozen_at: new Date(), frozen_by: admin.id, frozen_reason: frozen.reason }
          : { frozen_at: null, frozen_by: null, frozen_reason: null },
      )
      .where("id", "=", potId)
      .execute();
    // Members learn the pot is paused, not the internal reason.
    await notifyPotMembers(trx, potId, frozen ? "pot_frozen" : "pot_unfrozen", {});
    await recordAudit(trx, {
      actorUserId: admin.id,
      actorType: "admin",
      action: frozen ? "admin.pot_frozen" : "admin.pot_unfrozen",
      potId,
      requestId,
      metadata: frozen ? { reason: frozen.reason } : {},
    });
  });
}

export async function searchUsers(db: Db, q: string, limit = 25) {
  const term = q.trim();
  let query = db
    .selectFrom("users as u")
    .select((eb) => [
      "u.id",
      "u.email",
      "u.full_name",
      "u.email_verified_at",
      "u.is_admin",
      "u.deleted_at",
      "u.created_at",
      eb
        .selectFrom("pot_members as m")
        .select(eb.fn.countAll<number>().as("n"))
        .whereRef("m.user_id", "=", "u.id")
        .where("m.status", "=", "active")
        .as("active_pots"),
    ]);
  if (UUID.test(term)) query = query.where("u.id", "=", term);
  else if (term) query = query.where((eb) => eb.or([eb("u.email", "ilike", contains(term)), eb("u.full_name", "ilike", contains(term))]));
  const rows = await query.orderBy("u.created_at", "desc").limit(limit).execute();
  return rows.map((r) => ({ ...r, active_pots: Number(r.active_pots ?? 0) }));
}

export async function auditLog(db: Db, filter: { potId?: string; actorUserId?: string; limit: number }) {
  let query = db.selectFrom("audit_events").selectAll();
  if (filter.potId) query = query.where("pot_id", "=", filter.potId);
  if (filter.actorUserId) query = query.where("actor_user_id", "=", filter.actorUserId);
  return query.orderBy("occurred_at", "desc").limit(filter.limit).execute();
}

// ─── Fees (MON-18) ───

export async function feeSchedules(db: Db) {
  const current = [];
  for (const method of PAYMENT_METHODS) current.push(await currentSchedule(db, method));
  const history = await db.selectFrom("fee_schedules").selectAll().orderBy("effective_from", "desc").limit(50).execute();
  return { current, history };
}

export interface NewFeeSchedule {
  method: PaymentMethod;
  percentBps: number;
  flatKobo: number;
  capKobo: number | null;
  marginBps: number;
  marginFlatKobo: number;
  note?: string;
}

/** A change is a new schedule; payments already started keep the one they were quoted under. */
export async function setFeeSchedule(db: Db, admin: User, input: NewFeeSchedule, requestId?: string) {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .insertInto("fee_schedules")
      .values({
        method: input.method,
        percent_bps: input.percentBps,
        flat_kobo: input.flatKobo,
        cap_kobo: input.capKobo,
        margin_bps: input.marginBps,
        margin_flat_kobo: input.marginFlatKobo,
        note: input.note ?? null,
        created_by: admin.id,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await recordAudit(trx, {
      actorUserId: admin.id,
      actorType: "admin",
      action: "admin.fee_schedule_set",
      subjectType: "fee_schedule",
      subjectId: row.id,
      requestId,
      metadata: { ...input },
    });
    return row;
  });
}

// ─── Money needing a person ───

export async function paymentsByStatus(db: Db, status: string, limit = 100) {
  return db
    .selectFrom("payments as p")
    .innerJoin("users as u", "u.id", "p.user_id")
    .select(["p.id", "p.pot_id", "p.reference", "p.method", "p.status", "p.share_kobo", "p.fee_kobo", "p.total_kobo", "p.failure_reason", "p.created_at", "u.email"])
    .where("p.status", "=", status)
    .orderBy("p.created_at", "desc")
    .limit(limit)
    .execute();
}

export async function webhooksByStatus(db: Db, status: string, limit = 100) {
  return db
    .selectFrom("webhook_events")
    .select(["id", "event_type", "dedupe_key", "status", "attempts", "last_error", "received_at", "processed_at"])
    .where("status", "=", status)
    .orderBy("received_at", "desc")
    .limit(limit)
    .execute();
}
