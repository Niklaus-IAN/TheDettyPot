import type { Selectable } from "kysely";
import { recordAudit } from "../audit.js";
import { authorizePot } from "../auth/pot-access.js";
import type { Database, Db } from "../db/index.js";
import { conflict, forbidden, notFound } from "../errors.js";
import { notifyPotMembers, notifyUser } from "../notifications/service.js";
import { CLOSED, lockPot, type Actor, type Stage } from "../pots/service.js";
import type { User } from "../users/service.js";

export type ApprovalRow = Selectable<Database["pot_approval_requests"]>;

/** How long members have to vote on a nomination. */
export const APPROVAL_TTL_HOURS = 72;

/** More than half of the people who get a vote. */
export const majorityOf = (eligibleVoters: number) => Math.floor(eligibleVoters / 2) + 1;

const approvalClosed = (status: string) =>
  conflict("APPROVAL_CLOSED", status === "expired" ? "Voting on this has closed" : `This decision is already ${status}`);

/**
 * Marks open requests whose voting window has passed as expired. Runs on its
 * own (outside any request transaction) so the expiry sticks even when the
 * caller then fails; the background worker also calls it on a schedule.
 */
export async function expireDueApprovals(db: Db, filter: { potId?: string } = {}): Promise<number> {
  let query = db
    .updateTable("pot_approval_requests")
    .set({ status: "expired" })
    .where("status", "=", "open")
    .where("expires_at", "<=", new Date());
  if (filter.potId) query = query.where("pot_id", "=", filter.potId);
  const result = await query.executeTakeFirst();
  return Number(result.numUpdatedRows);
}

async function tally(db: Db, requestId: string) {
  const votes = await db.selectFrom("pot_approval_votes").select("decision").where("request_id", "=", requestId).execute();
  return {
    approvals: votes.filter((v) => v.decision === "approve").length,
    rejections: votes.filter((v) => v.decision === "reject").length,
  };
}

/** Applies the outcome once the votes decide it. Call with the request row locked. */
async function resolveIfDecided(db: Db, request: ApprovalRow, actor: Actor): Promise<string> {
  const { approvals, rejections } = await tally(db, request.id);
  const canStillPass = request.eligible_voters - rejections >= request.required_approvals;

  let outcome: "approved" | "rejected" | "cancelled" | null = null;
  if (approvals >= request.required_approvals) outcome = "approved";
  else if (!canStillPass) outcome = "rejected";
  if (!outcome) return "open";

  const nomineeId = request.subject_user_id!;
  if (outcome === "approved") {
    // The nominee may have left or been removed since the vote opened.
    const promoted = await db
      .updateTable("pot_members")
      .set({ role: "co_organiser" })
      .where("pot_id", "=", request.pot_id)
      .where("user_id", "=", nomineeId)
      .where("status", "=", "active")
      .where("role", "=", "member")
      .executeTakeFirst();
    if (Number(promoted.numUpdatedRows) === 0) outcome = "cancelled";
  }

  await db.updateTable("pot_approval_requests").set({ status: outcome }).where("id", "=", request.id).execute();

  if (outcome === "approved") {
    await notifyUser(db, nomineeId, request.pot_id, "co_organiser_approved", { requestId: request.id });
    await notifyPotMembers(db, request.pot_id, "co_organiser_added", { userId: nomineeId }, { exceptUserId: nomineeId });
  } else if (outcome === "rejected") {
    await notifyUser(db, nomineeId, request.pot_id, "co_organiser_rejected", { requestId: request.id });
    await notifyUser(db, request.requested_by, request.pot_id, "co_organiser_rejected", { requestId: request.id });
  }
  await recordAudit(db, {
    actorUserId: actor.user.id,
    action: `approval.${outcome}`,
    potId: request.pot_id,
    subjectType: "approval",
    subjectId: request.id,
    requestId: actor.requestId,
    metadata: { kind: request.kind, approvals, rejections, required: request.required_approvals },
  });
  return outcome;
}

// ─────────────────────────────────────────────
// Co-organisers
// ─────────────────────────────────────────────

/**
 * The organiser nominates a member to be co-organiser. A majority of the
 * other active members must approve; the organiser's nomination counts as
 * their own approval, so in a two-person pot it passes straight away.
 */
export async function nominateCoOrganiser(db: Db, actor: Actor, potId: string, nomineeId: string): Promise<ApprovalRow> {
  return db.transaction().execute(async (trx) => {
    await authorizePot(trx, actor.user, potId, "co_organiser.nominate");
    const pot = await lockPot(trx, potId);
    if (CLOSED.includes(pot.stage as Stage)) throw conflict("POT_CLOSED", `This pot is ${pot.stage}`);

    const nominee = await trx
      .selectFrom("pot_members")
      .select("role")
      .where("pot_id", "=", potId)
      .where("user_id", "=", nomineeId)
      .where("status", "=", "active")
      .executeTakeFirst();
    if (!nominee) throw notFound("Member not found");
    if (nominee.role !== "member") throw conflict("ALREADY_CO_ORGANISER", "This person already helps run the pot");

    const voters = await trx
      .selectFrom("pot_members")
      .select("user_id")
      .where("pot_id", "=", potId)
      .where("status", "=", "active")
      .where("user_id", "<>", nomineeId)
      .execute();

    const open = await trx
      .selectFrom("pot_approval_requests")
      .select("id")
      .where("pot_id", "=", potId)
      .where("kind", "=", "co_organiser_promotion")
      .where("subject_user_id", "=", nomineeId)
      .where("status", "=", "open")
      .executeTakeFirst();
    if (open) throw conflict("NOMINATION_OPEN", "There is already an open vote for this person");

    const request = await trx
      .insertInto("pot_approval_requests")
      .values({
        pot_id: potId,
        kind: "co_organiser_promotion",
        requested_by: actor.user.id,
        subject_user_id: nomineeId,
        eligible_voters: voters.length,
        required_approvals: majorityOf(voters.length),
        expires_at: new Date(Date.now() + APPROVAL_TTL_HOURS * 3600 * 1000),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await trx
      .insertInto("pot_approval_votes")
      .values({ request_id: request.id, user_id: actor.user.id, decision: "approve" })
      .execute();
    await recordAudit(trx, {
      actorUserId: actor.user.id,
      action: "approval.opened",
      potId,
      subjectType: "approval",
      subjectId: request.id,
      requestId: actor.requestId,
      metadata: { kind: request.kind, nomineeId, eligible: voters.length, required: request.required_approvals },
    });

    const outcome = await resolveIfDecided(trx, request, actor);
    if (outcome === "open") {
      await notifyPotMembers(
        trx,
        potId,
        "approval_requested",
        { requestId: request.id, kind: request.kind, subjectUserId: nomineeId },
        { exceptUserId: actor.user.id },
      );
    }
    return trx.selectFrom("pot_approval_requests").selectAll().where("id", "=", request.id).executeTakeFirstOrThrow();
  });
}

export async function voteOnApproval(
  db: Db,
  actor: Actor,
  potId: string,
  requestId: string,
  decision: "approve" | "reject",
): Promise<ApprovalRow> {
  await authorizePot(db, actor.user, potId, "approval.vote");
  await expireDueApprovals(db, { potId });

  return db.transaction().execute(async (trx) => {
    const request = await trx
      .selectFrom("pot_approval_requests")
      .selectAll()
      .where("id", "=", requestId)
      .where("pot_id", "=", potId)
      .forUpdate()
      .executeTakeFirst();
    if (!request) throw notFound("Approval not found");
    if (request.status !== "open") throw approvalClosed(request.status);
    if (request.subject_user_id === actor.user.id) {
      throw forbidden("You can't vote on a decision about yourself");
    }
    // Only people who were members when the vote opened count towards it.
    const voter = await trx
      .selectFrom("pot_members")
      .select("joined_at")
      .where("pot_id", "=", potId)
      .where("user_id", "=", actor.user.id)
      .where("status", "=", "active")
      .executeTakeFirst();
    if (!voter?.joined_at || voter.joined_at > request.created_at) {
      throw forbidden("Only people who were in the pot when this vote opened can vote on it");
    }
    const already = await trx
      .selectFrom("pot_approval_votes")
      .select("decision")
      .where("request_id", "=", requestId)
      .where("user_id", "=", actor.user.id)
      .executeTakeFirst();
    if (already) throw conflict("ALREADY_VOTED", "You've already voted on this");

    await trx.insertInto("pot_approval_votes").values({ request_id: requestId, user_id: actor.user.id, decision }).execute();
    await resolveIfDecided(trx, request, actor);
    return trx.selectFrom("pot_approval_requests").selectAll().where("id", "=", requestId).executeTakeFirstOrThrow();
  });
}

export async function cancelApproval(db: Db, actor: Actor, potId: string, requestId: string): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await authorizePot(trx, actor.user, potId, "co_organiser.nominate");
    const request = await trx
      .selectFrom("pot_approval_requests")
      .selectAll()
      .where("id", "=", requestId)
      .where("pot_id", "=", potId)
      .forUpdate()
      .executeTakeFirst();
    if (!request) throw notFound("Approval not found");
    if (request.status !== "open") throw approvalClosed(request.status);
    await trx.updateTable("pot_approval_requests").set({ status: "cancelled" }).where("id", "=", requestId).execute();
    if (request.subject_user_id) {
      await notifyUser(trx, request.subject_user_id, potId, "co_organiser_nomination_cancelled", { requestId });
    }
    await recordAudit(trx, {
      actorUserId: actor.user.id,
      action: "approval.cancelled",
      potId,
      subjectType: "approval",
      subjectId: requestId,
      requestId: actor.requestId,
    });
  });
}

export async function demoteCoOrganiser(db: Db, actor: Actor, potId: string, userId: string): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await authorizePot(trx, actor.user, potId, "co_organiser.demote");
    const result = await trx
      .updateTable("pot_members")
      .set({ role: "member" })
      .where("pot_id", "=", potId)
      .where("user_id", "=", userId)
      .where("status", "=", "active")
      .where("role", "=", "co_organiser")
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) throw notFound("Co-organiser not found");
    await notifyUser(trx, userId, potId, "co_organiser_removed", {});
    await recordAudit(trx, {
      actorUserId: actor.user.id,
      action: "member.demoted",
      potId,
      subjectType: "user",
      subjectId: userId,
      requestId: actor.requestId,
    });
  });
}

// ─────────────────────────────────────────────
// Reading
// ─────────────────────────────────────────────

export interface ApprovalView {
  request: ApprovalRow;
  subjectName: string | null;
  approvals: number;
  rejections: number;
  myVote: "approve" | "reject" | null;
  canVote: boolean;
}

/** Open decisions first, then the 20 most recent closed ones. */
export async function listApprovals(db: Db, user: User, potId: string): Promise<ApprovalView[]> {
  const access = await authorizePot(db, user, potId, "pot.view");
  await expireDueApprovals(db, { potId });
  const me = await db.selectFrom("pot_members").select("joined_at").where("id", "=", access.membershipId).executeTakeFirstOrThrow();

  const base = db
    .selectFrom("pot_approval_requests as r")
    .leftJoin("users as u", "u.id", "r.subject_user_id")
    .selectAll("r")
    .select("u.full_name as subject_name")
    .where("r.pot_id", "=", potId);
  const open = await base.where("r.status", "=", "open").orderBy("r.created_at").execute();
  const closed = await base.where("r.status", "<>", "open").orderBy("r.updated_at", "desc").limit(20).execute();
  const rows = [...open, ...closed];
  if (rows.length === 0) return [];

  const votes = await db
    .selectFrom("pot_approval_votes")
    .select(["request_id", "user_id", "decision"])
    .where(
      "request_id",
      "in",
      rows.map((r) => r.id),
    )
    .execute();

  return rows.map(({ subject_name, ...request }) => {
    const cast = votes.filter((v) => v.request_id === request.id);
    const myVote = (cast.find((v) => v.user_id === user.id)?.decision ?? null) as ApprovalView["myVote"];
    return {
      request,
      subjectName: subject_name,
      approvals: cast.filter((v) => v.decision === "approve").length,
      rejections: cast.filter((v) => v.decision === "reject").length,
      myVote,
      canVote:
        request.status === "open" &&
        myVote === null &&
        request.subject_user_id !== user.id &&
        me.joined_at !== null &&
        me.joined_at <= request.created_at,
    };
  });
}
