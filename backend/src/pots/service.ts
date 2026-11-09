import type { Selectable } from "kysely";
import { recordAudit } from "../audit.js";
import { authorizePot, type PotAccess } from "../auth/pot-access.js";
import type { PotRole } from "../auth/permissions.js";
import type { Database, Db } from "../db/index.js";
import { badRequest, conflict } from "../errors.js";
import { notifyPotMembers } from "../notifications/service.js";
import type { User } from "../users/service.js";
import { payoutsInFlight, refundAllProRata } from "../refunds/service.js";
import { inProgressByPot, paidByMember, totalRaised } from "./money.js";

export type PotRow = Selectable<Database["pots"]>;

export const VIBES = ["beach", "club", "dinner", "travel", "staycay", "adventure", "concert", "other"] as const;
export const STAGES = ["planning", "collecting", "funded", "confirmed", "completed", "cancelled"] as const;
export type Stage = (typeof STAGES)[number];
export type AdvanceTo = "collecting" | "funded" | "confirmed" | "completed";

/** Sanity cap on a pot's budget: ₦100,000,000. */
export const MAX_BUDGET_KOBO = 100_000_000 * 100;

const EDITABLE: readonly Stage[] = ["planning", "collecting"];
export const CLOSED: readonly Stage[] = ["completed", "cancelled"];
/** People can join while the plan and the money are still open. */
export const JOINABLE: readonly Stage[] = ["planning", "collecting"];
const NEXT: Record<AdvanceTo, Stage> = {
  collecting: "planning",
  funded: "collecting",
  confirmed: "funded",
  completed: "confirmed",
};

/** The person acting, and the request to tie audit entries to. */
export interface Actor {
  user: User;
  requestId?: string;
}

export interface PotDetails {
  name?: string;
  description?: string | null;
  vibe?: (typeof VIBES)[number];
  area?: string | null;
  outingDate?: string | null;
  outingTime?: string | null;
  fundingDeadline?: string | null;
  budgetKobo?: number;
  headcount?: number;
}

export interface CreatePotInput extends PotDetails {
  name: string;
  budgetKobo: number;
  headcount: number;
  joinApprovalRequired?: boolean;
  payoutApprovalRequired?: boolean;
}

export interface MemberSummary {
  userId: string;
  fullName: string | null;
  avatarEmoji: string | null;
  role: PotRole;
  joinedAt: Date | null;
  paidKobo: number;
}

export interface PotView {
  pot: PotRow;
  myRole: PotRole;
  memberCount: number;
  raisedKobo: number;
  /** Payments started but not yet confirmed; never part of raisedKobo. */
  inProgressKobo: number;
  myPaidKobo: number;
  myOwedKobo: number;
}

export interface PotDetailView extends PotView {
  members: MemberSummary[];
  myReminderFrequency: ReminderFrequency;
}

export const REMINDER_FREQUENCIES = ["daily", "every_3_days", "weekly", "off"] as const;
export type ReminderFrequency = (typeof REMINDER_FREQUENCIES)[number];

/** Today's date (YYYY-MM-DD) in the pot's timezone. */
const todayIn = (timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());

/** The calendar date (YYYY-MM-DD) an instant falls on in a timezone. */
const dateIn = (instant: Date, timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone }).format(instant);

function checkDates(
  next: { outingDate: string | null; fundingDeadline: string | null; timezone: string },
  changed: { outingDate: boolean; fundingDeadline: boolean },
) {
  if (changed.outingDate && next.outingDate && next.outingDate < todayIn(next.timezone)) {
    throw badRequest("OUTING_IN_PAST", "The outing date can't be in the past");
  }
  if (changed.fundingDeadline && next.fundingDeadline && new Date(next.fundingDeadline) <= new Date()) {
    throw badRequest("DEADLINE_IN_PAST", "The funding deadline must be in the future");
  }
  if (next.outingDate && next.fundingDeadline && dateIn(new Date(next.fundingDeadline), next.timezone) > next.outingDate) {
    throw badRequest("DEADLINE_AFTER_OUTING", "The funding deadline must be on or before the outing date");
  }
}

const owed = (pot: PotRow, paid: number) =>
  CLOSED.includes(pot.stage as Stage) ? 0 : Math.max(0, pot.share_kobo - paid);

export async function lockPot(db: Db, potId: string): Promise<PotRow> {
  return db.selectFrom("pots").selectAll().where("id", "=", potId).forUpdate().executeTakeFirstOrThrow();
}

// ─────────────────────────────────────────────
// Creating and reading
// ─────────────────────────────────────────────

export async function createPot(db: Db, actor: Actor, input: CreatePotInput): Promise<PotView> {
  checkDates(
    { outingDate: input.outingDate ?? null, fundingDeadline: input.fundingDeadline ?? null, timezone: "Africa/Lagos" },
    { outingDate: true, fundingDeadline: true },
  );

  const pot = await db.transaction().execute(async (trx) => {
    const pot = await trx
      .insertInto("pots")
      .values({
        created_by: actor.user.id,
        name: input.name,
        description: input.description ?? null,
        vibe: input.vibe ?? "other",
        area: input.area ?? null,
        outing_date: input.outingDate ?? null,
        outing_time: input.outingTime ?? null,
        funding_deadline: input.fundingDeadline ?? null,
        budget_kobo: input.budgetKobo,
        headcount: input.headcount,
        join_approval_required: input.joinApprovalRequired ?? false,
        payout_approval_required: input.payoutApprovalRequired ?? false,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await trx.insertInto("pot_members").values({ pot_id: pot.id, user_id: actor.user.id, role: "organiser" }).execute();
    await recordAudit(trx, { actorUserId: actor.user.id, action: "pot.created", potId: pot.id, requestId: actor.requestId });
    return pot;
  });

  return { pot, myRole: "organiser", memberCount: 1, raisedKobo: 0, inProgressKobo: 0, myPaidKobo: 0, myOwedKobo: pot.share_kobo };
}

const STAGE_ORDER: Record<Stage, number> = {
  collecting: 0,
  funded: 1,
  confirmed: 2,
  planning: 3,
  completed: 4,
  cancelled: 5,
};

/** The dashboard: every pot I'm an active member of (FR-DSH-01). */
export async function listMyPots(db: Db, user: User): Promise<PotView[]> {
  const rows = await db
    .selectFrom("pot_members as m")
    .innerJoin("pots as p", "p.id", "m.pot_id")
    .selectAll("p")
    .select((eb) => [
      "m.role as my_role",
      eb
        .selectFrom("pot_members as c")
        .select(eb.fn.countAll<number>().as("n"))
        .whereRef("c.pot_id", "=", "p.id")
        .where("c.status", "=", "active")
        .as("member_count"),
    ])
    .where("m.user_id", "=", user.id)
    .where("m.status", "=", "active")
    .execute();

  const paid = await paidByMember(
    db,
    rows.map((r) => r.id),
  );
  const inProgress = await inProgressByPot(
    db,
    rows.map((r) => r.id),
  );

  return rows
    .map(({ my_role, member_count, ...pot }) => {
      const potPaid = paid.get(pot.id);
      const myPaid = potPaid?.get(user.id) ?? 0;
      return {
        pot,
        myRole: my_role as PotRole,
        memberCount: Number(member_count ?? 0),
        raisedKobo: totalRaised(potPaid),
        inProgressKobo: inProgress.get(pot.id) ?? 0,
        myPaidKobo: myPaid,
        myOwedKobo: owed(pot, myPaid),
      };
    })
    .sort(
      (a, b) =>
        STAGE_ORDER[a.pot.stage as Stage] - STAGE_ORDER[b.pot.stage as Stage] ||
        (a.pot.outing_date ?? "9999").localeCompare(b.pot.outing_date ?? "9999") ||
        b.pot.created_at.getTime() - a.pot.created_at.getTime(),
    );
}

/** The pot page: details, who is in it and who has paid what (FR-PAY-04). */
export async function getPot(db: Db, user: User, potId: string): Promise<PotDetailView> {
  const access = await authorizePot(db, user, potId, "pot.view");
  const pot = await db.selectFrom("pots").selectAll().where("id", "=", potId).executeTakeFirstOrThrow();
  const memberRows = await db
    .selectFrom("pot_members as m")
    .innerJoin("users as u", "u.id", "m.user_id")
    .select(["m.user_id", "m.role", "m.joined_at", "u.full_name", "u.avatar_emoji"])
    .where("m.pot_id", "=", potId)
    .where("m.status", "=", "active")
    .orderBy("m.joined_at")
    .execute();

  const potPaid = (await paidByMember(db, [potId])).get(potId);
  const myPaid = potPaid?.get(user.id) ?? 0;
  return {
    pot,
    myRole: access.role,
    memberCount: memberRows.length,
    raisedKobo: totalRaised(potPaid),
    inProgressKobo: (await inProgressByPot(db, [potId])).get(potId) ?? 0,
    myPaidKobo: myPaid,
    myOwedKobo: owed(pot, myPaid),
    myReminderFrequency: (
      await db.selectFrom("pot_members").select("reminder_frequency").where("id", "=", access.membershipId).executeTakeFirstOrThrow()
    ).reminder_frequency as ReminderFrequency,
    members: memberRows.map((m) => ({
      userId: m.user_id,
      fullName: m.full_name,
      avatarEmoji: m.avatar_emoji,
      role: m.role as PotRole,
      joinedAt: m.joined_at,
      paidKobo: potPaid?.get(m.user_id) ?? 0,
    })),
  };
}

// ─────────────────────────────────────────────
// Changing
// ─────────────────────────────────────────────

/** Edit details (FR-POT-03). Only before the pot is funded; budget changes notify everyone. */
export async function updatePot(db: Db, actor: Actor, potId: string, changes: PotDetails): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await authorizePot(trx, actor.user, potId, "pot.edit");
    const pot = await lockPot(trx, potId);
    if (!EDITABLE.includes(pot.stage as Stage)) {
      throw conflict("POT_LOCKED", `This pot can't be edited once it is ${pot.stage}`);
    }

    const has = (key: keyof PotDetails) => changes[key] !== undefined;
    checkDates(
      {
        outingDate: has("outingDate") ? (changes.outingDate ?? null) : pot.outing_date,
        fundingDeadline: has("fundingDeadline") ? (changes.fundingDeadline ?? null) : pot.funding_deadline?.toISOString() ?? null,
        timezone: pot.timezone,
      },
      { outingDate: has("outingDate"), fundingDeadline: has("fundingDeadline") },
    );

    if (has("headcount")) {
      const { n } = await trx
        .selectFrom("pot_members")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("pot_id", "=", potId)
        .where("status", "=", "active")
        .executeTakeFirstOrThrow();
      if (changes.headcount! < Number(n)) {
        throw conflict("HEADCOUNT_TOO_LOW", `The pot already has ${n} members, so the headcount can't be lower than that`);
      }
    }

    const updated = await trx
      .updateTable("pots")
      .set({
        ...(has("name") && { name: changes.name }),
        ...(has("description") && { description: changes.description }),
        ...(has("vibe") && { vibe: changes.vibe }),
        ...(has("area") && { area: changes.area }),
        ...(has("outingDate") && { outing_date: changes.outingDate }),
        ...(has("outingTime") && { outing_time: changes.outingTime }),
        // A new deadline gets its own warning and missed-deadline alert.
        ...(has("fundingDeadline") && {
          funding_deadline: changes.fundingDeadline,
          deadline_warning_sent_at: null,
          deadline_passed_sent_at: null,
        }),
        ...(has("budgetKobo") && { budget_kobo: changes.budgetKobo }),
        ...(has("headcount") && { headcount: changes.headcount }),
      })
      .where("id", "=", potId)
      .returningAll()
      .executeTakeFirstOrThrow();

    if (updated.share_kobo !== pot.share_kobo || updated.budget_kobo !== pot.budget_kobo) {
      await notifyPotMembers(
        trx,
        potId,
        "budget_changed",
        {
          budgetKobo: updated.budget_kobo,
          headcount: updated.headcount,
          shareKobo: updated.share_kobo,
          previousShareKobo: pot.share_kobo,
        },
        { exceptUserId: actor.user.id },
      );
    }
    await recordAudit(trx, {
      actorUserId: actor.user.id,
      action: "pot.updated",
      potId,
      requestId: actor.requestId,
      metadata: { fields: Object.keys(changes).filter((k) => has(k as keyof PotDetails)) },
    });
  });
}

/** Join approval and payout approval switches (organiser only). */
export async function updateSettings(
  db: Db,
  actor: Actor,
  potId: string,
  settings: { joinApprovalRequired?: boolean; payoutApprovalRequired?: boolean },
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await authorizePot(trx, actor.user, potId, "pot.change_settings");
    const pot = await lockPot(trx, potId);
    if (CLOSED.includes(pot.stage as Stage)) {
      throw conflict("POT_CLOSED", `This pot is ${pot.stage}`);
    }
    // Once money is being collected, members may be relying on approving
    // payouts, so the organiser can't quietly switch that off.
    if (settings.payoutApprovalRequired === false && pot.payout_approval_required && pot.stage !== "planning") {
      throw conflict(
        "PAYOUT_APPROVAL_LOCKED",
        "Member approval for payouts can't be switched off once collection has started",
      );
    }

    await trx
      .updateTable("pots")
      .set({
        ...(settings.joinApprovalRequired !== undefined && { join_approval_required: settings.joinApprovalRequired }),
        ...(settings.payoutApprovalRequired !== undefined && { payout_approval_required: settings.payoutApprovalRequired }),
      })
      .where("id", "=", potId)
      .execute();

    if (settings.payoutApprovalRequired !== undefined && settings.payoutApprovalRequired !== pot.payout_approval_required) {
      await notifyPotMembers(
        trx,
        potId,
        "payout_approval_changed",
        { payoutApprovalRequired: settings.payoutApprovalRequired },
        { exceptUserId: actor.user.id },
      );
    }
    await recordAudit(trx, {
      actorUserId: actor.user.id,
      action: "pot.settings_changed",
      potId,
      requestId: actor.requestId,
      metadata: settings,
    });
  });
}

/** Moves a pot one stage forward, after checking that stage's conditions. */
export async function advanceStage(db: Db, actor: Actor, potId: string, to: AdvanceTo): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const access: PotAccess = await authorizePot(trx, actor.user, potId, "pot.view");
    const pot = await lockPot(trx, potId);

    if (pot.stage !== NEXT[to]) {
      throw conflict("INVALID_STAGE_CHANGE", `A pot can't move from ${pot.stage} to ${to}`);
    }

    if (to === "collecting") {
      await authorizePot(trx, actor.user, potId, "pot.advance_stage");
      if (!pot.funding_deadline || pot.funding_deadline <= new Date()) {
        throw conflict("DEADLINE_REQUIRED", "Set a funding deadline in the future before collecting money");
      }
    }

    if (to === "funded") {
      const raised = totalRaised((await paidByMember(trx, [potId])).get(potId));
      if (raised >= pot.budget_kobo) {
        await authorizePot(trx, actor.user, potId, "pot.advance_stage");
      } else {
        // MON-15: the target was missed, so only the organiser can decide to
        // go ahead with what was raised, and only once the deadline has passed.
        await authorizePot(trx, actor.user, potId, "pot.proceed_with_less");
        if (pot.funding_deadline && pot.funding_deadline > new Date()) {
          throw conflict(
            "TARGET_NOT_MET",
            "The pot hasn't reached its target. Once the deadline passes, the organiser can go ahead with what was raised.",
          );
        }
        if (raised === 0) {
          throw conflict("NOTHING_RAISED", "Nothing has been raised yet. Extend the deadline or cancel the pot.");
        }
      }
    }

    if (to === "confirmed") {
      await authorizePot(trx, actor.user, potId, "pot.advance_stage");
    }

    if (to === "completed") {
      await authorizePot(trx, actor.user, potId, "pot.advance_stage");
      if (!pot.outing_date || pot.outing_date > todayIn(pot.timezone)) {
        throw conflict("OUTING_NOT_PASSED", "A pot can be completed on or after the outing date");
      }
    }

    await trx.updateTable("pots").set({ stage: to }).where("id", "=", potId).execute();
    await notifyPotMembers(trx, potId, `pot_${to}`, { stage: to }, { exceptUserId: actor.user.id });
    await recordAudit(trx, {
      actorUserId: actor.user.id,
      action: "pot.stage_changed",
      potId,
      requestId: actor.requestId,
      metadata: { from: pot.stage, to, role: access.role },
    });
  });
}

/** Cancels the pot and refunds everyone what's left, in proportion to what they paid (MON-15). */
export async function cancelPot(db: Db, actor: Actor, potId: string, reason?: string): Promise<string[]> {
  return db.transaction().execute(async (trx) => {
    await authorizePot(trx, actor.user, potId, "pot.cancel");
    const pot = await lockPot(trx, potId);
    if (CLOSED.includes(pot.stage as Stage)) {
      throw conflict("POT_CLOSED", `This pot is already ${pot.stage}`);
    }
    // Money already on its way out has to land first, so the refunds are right.
    if (await payoutsInFlight(trx, potId)) {
      throw conflict("PAYOUTS_IN_PROGRESS", "Finish or cancel the payouts in progress before cancelling the pot");
    }

    await trx.updateTable("pots").set({ stage: "cancelled" }).where("id", "=", potId).execute();
    const { refundIds } = await refundAllProRata(trx, potId, "pot_cancelled");
    await notifyPotMembers(trx, potId, "pot_cancelled", { reason: reason ?? null }, { exceptUserId: actor.user.id });
    await recordAudit(trx, {
      actorUserId: actor.user.id,
      action: "pot.cancelled",
      potId,
      requestId: actor.requestId,
      metadata: { from: pot.stage, reason: reason ?? null, refunds: refundIds.length },
    });
    return refundIds;
  });
}

/** FR-NOT-03: each member chooses how often they're reminded to pay, per pot. */
export async function setReminderFrequency(db: Db, user: User, potId: string, frequency: ReminderFrequency): Promise<void> {
  // A personal setting, so it's allowed even while support has the pot paused.
  const access = await authorizePot(db, user, potId, "pot.view");
  await db.updateTable("pot_members").set({ reminder_frequency: frequency }).where("id", "=", access.membershipId).execute();
}
