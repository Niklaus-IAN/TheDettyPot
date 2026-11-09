import type { Selectable, Transaction } from "kysely";
import { recordAudit } from "../audit.js";
import { authorizePot } from "../auth/pot-access.js";
import type { Database, Db } from "../db/index.js";
import { AppError, conflict, forbidden, notFound } from "../errors.js";
import { ensureAccount, post } from "../ledger/service.js";
import { naira } from "../notifications/catalog.js";
import { notifyPotMembers, notifyUser } from "../notifications/service.js";
import { markFundedIfTargetMet } from "../payments/service.js";
import { paidByMember } from "../pots/money.js";
import { lockPot, type Actor } from "../pots/service.js";
import { allocateProRata, payoutsInFlight, refundMember } from "../refunds/service.js";

export type RolloverRow = Selectable<Database["rollovers"]>;

/** How long contributors have to choose before their part is refunded. */
export const ROLLOVER_CONSENT_HOURS = 72;

/**
 * The organiser offers to move what's left into a new outing they organise
 * (MON-17, "unless the group agrees otherwise"). Each contributor's part is
 * set aside straight away, so it can't be paid out while they decide.
 */
export async function offerRollover(db: Db, actor: Actor, potId: string, targetPotId: string) {
  return db.transaction().execute(async (trx) => {
    await authorizePot(trx, actor.user, potId, "pot.settle");
    const pot = await lockPot(trx, potId);
    if (!["confirmed", "completed"].includes(pot.stage)) {
      throw conflict("NOT_READY_TO_SETTLE", "Leftover money is settled once the outing is confirmed");
    }
    if (await payoutsInFlight(trx, potId)) throw conflict("PAYOUTS_IN_PROGRESS", "Finish or cancel the payouts in progress first");
    if (targetPotId === potId) throw conflict("SAME_POT", "Choose a different pot to move the money into");

    // The organiser must run the new pot too, and it must still be open to new members and money.
    await authorizePot(trx, actor.user, targetPotId, "pot.settle").catch(() => {
      throw forbidden("You can only move money into a pot you organise");
    });
    const target = await lockPot(trx, targetPotId);
    if (!["planning", "collecting"].includes(target.stage)) {
      throw conflict("TARGET_NOT_OPEN", "The new pot has to be planning or collecting");
    }

    const open = await trx.selectFrom("rollovers").select("id").where("from_pot_id", "=", potId).where("status", "=", "open").executeTakeFirst();
    if (open) throw conflict("ROLLOVER_OPEN", "There's already an open offer for this pot");

    const available = await trx
      .selectFrom("ledger_account_balances")
      .select("balance_kobo")
      .where("pot_id", "=", potId)
      .where("kind", "=", "pot_available")
      .executeTakeFirst();
    const leftover = available?.balance_kobo ?? 0;
    if (leftover <= 0) throw conflict("NOTHING_LEFT", "There's no money left in the pot to settle");

    const rollover = await trx
      .insertInto("rollovers")
      .values({
        from_pot_id: potId,
        to_pot_id: targetPotId,
        created_by: actor.user.id,
        leftover_kobo: leftover,
        consent_deadline: new Date(Date.now() + ROLLOVER_CONSENT_HOURS * 3600 * 1000),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const paid = (await paidByMember(trx, [potId])).get(potId) ?? new Map();
    for (const [userId, amount] of allocateProRata(leftover, paid)) {
      const holdTxnId = await post(trx, {
        kind: "refund",
        potId,
        memberUserId: userId,
        idempotencyKey: `rollover:${rollover.id}:${userId}:hold`,
        description: `${naira(amount)} set aside while its owner decides whether to move it to ${target.name}`,
        metadata: { rolloverId: rollover.id },
        entries: [
          { accountId: await ensureAccount(trx, "pot_available", potId), amountKobo: -amount },
          { accountId: await ensureAccount(trx, "pot_reserved", potId), amountKobo: amount },
        ],
      });
      await trx.insertInto("rollover_choices").values({ rollover_id: rollover.id, user_id: userId, amount_kobo: amount, hold_txn_id: holdTxnId }).execute();
      await notifyUser(trx, userId, potId, "rollover_offer", {
        rolloverId: rollover.id,
        amountKobo: amount,
        targetPotName: target.name,
        deadline: rollover.consent_deadline.toISOString(),
      });
    }

    await recordAudit(trx, {
      actorUserId: actor.user.id,
      action: "pot.rollover_offered",
      potId,
      subjectType: "rollover",
      subjectId: rollover.id,
      requestId: actor.requestId,
      metadata: { targetPotId, leftoverKobo: leftover },
    });
    return rollover;
  });
}

/** Releases a held part back to the pot and refunds it to its owner. */
async function refundPart(trx: Transaction<Database>, rollover: RolloverRow, userId: string, amount: number): Promise<string[]> {
  await post(trx, {
    kind: "refund",
    potId: rollover.from_pot_id,
    memberUserId: userId,
    idempotencyKey: `rollover:${rollover.id}:${userId}:release`,
    description: `${naira(amount)} no longer set aside for a move; refunding it instead`,
    metadata: { rolloverId: rollover.id },
    entries: [
      { accountId: await ensureAccount(trx, "pot_reserved", rollover.from_pot_id), amountKobo: -amount },
      { accountId: await ensureAccount(trx, "pot_available", rollover.from_pot_id), amountKobo: amount },
    ],
  });
  return refundMember(trx, { potId: rollover.from_pot_id, userId, amountKobo: amount, reason: "leftover" });
}

/** Moves a held part into the new pot, where it counts as what the member has paid. */
async function movePart(trx: Transaction<Database>, rollover: RolloverRow, userId: string, amount: number) {
  const target = await lockPot(trx, rollover.to_pot_id);
  if (!["planning", "collecting"].includes(target.stage) || target.frozen_at) {
    throw conflict("TARGET_NOT_OPEN", "The new pot isn't taking money any more. Choose a refund instead.");
  }

  const membership = await trx
    .selectFrom("pot_members")
    .selectAll()
    .where("pot_id", "=", target.id)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (membership?.status === "removed") {
    throw new AppError(403, "REMOVED_FROM_POT", "You were removed from the new pot. Choose a refund instead.");
  }
  if (membership?.status !== "active") {
    const { n } = await trx
      .selectFrom("pot_members")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("pot_id", "=", target.id)
      .where("status", "=", "active")
      .executeTakeFirstOrThrow();
    if (Number(n) >= target.headcount) {
      throw conflict("POT_FULL", "The new pot is full. Choose a refund instead, or ask the organiser to make room.");
    }
    const joined = { role: "member", status: "active", joined_at: new Date(), status_changed_by: userId };
    if (membership) await trx.updateTable("pot_members").set(joined).where("id", "=", membership.id).execute();
    else await trx.insertInto("pot_members").values({ pot_id: target.id, user_id: userId, ...joined }).execute();
  }

  const member = await trx.selectFrom("users").select("full_name").where("id", "=", userId).executeTakeFirstOrThrow();
  const from = await trx.selectFrom("pots").select("name").where("id", "=", rollover.from_pot_id).executeTakeFirstOrThrow();
  const transit = await ensureAccount(trx, "internal_transfer");
  await post(trx, {
    kind: "refund",
    potId: rollover.from_pot_id,
    memberUserId: userId,
    idempotencyKey: `rollover:${rollover.id}:${userId}:out`,
    description: `${member.full_name ?? "A member"} moved ${naira(amount)} to ${target.name}`,
    metadata: { rolloverId: rollover.id, toPotId: target.id },
    entries: [
      { accountId: await ensureAccount(trx, "pot_reserved", rollover.from_pot_id), amountKobo: -amount },
      { accountId: transit, amountKobo: amount },
    ],
  });
  await post(trx, {
    kind: "contribution",
    potId: target.id,
    memberUserId: userId,
    idempotencyKey: `rollover:${rollover.id}:${userId}:in`,
    description: `${member.full_name ?? "A member"} brought ${naira(amount)} over from ${from.name}`,
    metadata: { rolloverId: rollover.id, fromPotId: rollover.from_pot_id },
    entries: [
      { accountId: transit, amountKobo: -amount },
      { accountId: await ensureAccount(trx, "pot_available", target.id), amountKobo: amount },
    ],
  });
  await notifyUser(trx, userId, target.id, "rollover_moved", { amountKobo: amount, targetPotName: target.name, targetPotId: target.id });
  await notifyPotMembers(trx, target.id, "contribution_received", { name: member.full_name, amountKobo: amount }, { exceptUserId: userId, roles: ["organiser", "co_organiser"] });
  await markFundedIfTargetMet(trx, target.id);
}

async function closeIfDecided(trx: Transaction<Database>, rolloverId: string) {
  const pending = await trx.selectFrom("rollover_choices").select("user_id").where("rollover_id", "=", rolloverId).where("choice", "=", "pending").executeTakeFirst();
  if (!pending) {
    await trx.updateTable("rollovers").set({ status: "closed", closed_at: new Date() }).where("id", "=", rolloverId).where("status", "=", "open").execute();
  }
}

/** A contributor decides what happens to their part. Returns refunds to start, if any. */
export async function chooseRollover(db: Db, actor: Actor, rolloverId: string, choice: "move" | "refund"): Promise<string[]> {
  return db.transaction().execute(async (trx) => {
    const rollover = await trx.selectFrom("rollovers").selectAll().where("id", "=", rolloverId).forUpdate().executeTakeFirst();
    const mine = rollover
      ? await trx.selectFrom("rollover_choices").selectAll().where("rollover_id", "=", rolloverId).where("user_id", "=", actor.user.id).forUpdate().executeTakeFirst()
      : undefined;
    if (!rollover || !mine) throw notFound("Offer not found");
    if (mine.choice !== "pending") throw conflict("ALREADY_CHOSEN", "You've already made your choice");
    if (rollover.status !== "open" || rollover.consent_deadline <= new Date()) {
      throw conflict("ROLLOVER_CLOSED", "This offer has closed; your part is being refunded");
    }

    let refundIds: string[] = [];
    if (choice === "move") await movePart(trx, rollover, actor.user.id, mine.amount_kobo);
    else refundIds = await refundPart(trx, rollover, actor.user.id, mine.amount_kobo);

    await trx
      .updateTable("rollover_choices")
      .set({ choice, decided_by: "member", decided_at: new Date() })
      .where("rollover_id", "=", rolloverId)
      .where("user_id", "=", actor.user.id)
      .execute();
    await recordAudit(trx, {
      actorUserId: actor.user.id,
      action: `rollover.${choice}`,
      potId: rollover.from_pot_id,
      subjectType: "rollover",
      subjectId: rolloverId,
      requestId: actor.requestId,
      metadata: { amountKobo: mine.amount_kobo },
    });
    await closeIfDecided(trx, rolloverId);
    return refundIds;
  });
}

/** The worker's job: when the deadline passes, everyone who hasn't chosen is refunded. */
export async function closeDueRollovers(db: Db, opts: { now?: Date } = {}): Promise<string[]> {
  const now = opts.now ?? new Date();
  const due = await db.selectFrom("rollovers").select("id").where("status", "=", "open").where("consent_deadline", "<=", now).execute();
  const refundIds: string[] = [];
  for (const { id } of due) {
    const ids = await db.transaction().execute(async (trx) => {
      const rollover = await trx.selectFrom("rollovers").selectAll().where("id", "=", id).forUpdate().executeTakeFirstOrThrow();
      if (rollover.status !== "open") return [];
      const pending = await trx.selectFrom("rollover_choices").selectAll().where("rollover_id", "=", id).where("choice", "=", "pending").execute();
      const created: string[] = [];
      for (const c of pending) {
        created.push(...(await refundPart(trx, rollover, c.user_id, c.amount_kobo)));
        await trx
          .updateTable("rollover_choices")
          .set({ choice: "refund", decided_by: "deadline", decided_at: now })
          .where("rollover_id", "=", id)
          .where("user_id", "=", c.user_id)
          .execute();
      }
      await closeIfDecided(trx, id);
      await recordAudit(trx, { actorUserId: null, action: "rollover.closed", potId: rollover.from_pot_id, subjectType: "rollover", subjectId: id, metadata: { refundedByDeadline: pending.length } });
      return created;
    });
    refundIds.push(...ids);
  }
  return refundIds;
}

// ─── Reading ───

/** What a contributor sees about their part of an offer. */
export async function getMyRollover(db: Db, user: Actor["user"], rolloverId: string) {
  const row = await db
    .selectFrom("rollover_choices as c")
    .innerJoin("rollovers as r", "r.id", "c.rollover_id")
    .innerJoin("pots as fp", "fp.id", "r.from_pot_id")
    .innerJoin("pots as tp", "tp.id", "r.to_pot_id")
    .select(["r.id", "r.status", "r.consent_deadline", "c.amount_kobo", "c.choice", "fp.id as from_pot_id", "fp.name as from_pot_name", "tp.id as to_pot_id", "tp.name as to_pot_name", "tp.share_kobo as to_pot_share_kobo"])
    .where("c.rollover_id", "=", rolloverId)
    .where("c.user_id", "=", user.id)
    .executeTakeFirst();
  if (!row) throw notFound("Offer not found");
  return row;
}

/** The organiser's view: how the group is deciding. */
export async function potRollovers(db: Db, user: Actor["user"], potId: string) {
  await authorizePot(db, user, potId, "pot.view");
  const rollovers = await db.selectFrom("rollovers as r").innerJoin("pots as tp", "tp.id", "r.to_pot_id").selectAll("r").select("tp.name as to_pot_name").where("r.from_pot_id", "=", potId).orderBy("r.created_at", "desc").execute();
  const choices = rollovers.length
    ? await db
        .selectFrom("rollover_choices as c")
        .innerJoin("users as u", "u.id", "c.user_id")
        .select(["c.rollover_id", "c.user_id", "u.full_name", "c.amount_kobo", "c.choice", "c.decided_by"])
        .where("c.rollover_id", "in", rollovers.map((r) => r.id))
        .execute()
    : [];
  return rollovers.map((r) => ({ ...r, choices: choices.filter((c) => c.rollover_id === r.id) }));
}
