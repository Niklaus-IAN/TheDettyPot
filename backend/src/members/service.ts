import { createHash, randomBytes } from "node:crypto";
import type { Selectable } from "kysely";
import { recordAudit } from "../audit.js";
import { authorizePot } from "../auth/pot-access.js";
import { canRemoveMember, type PotRole } from "../auth/permissions.js";
import type { Database, Db } from "../db/index.js";
import { AppError, conflict, forbidden, notFound } from "../errors.js";
import { notifyEmailAddress, notifyPotMembers, notifyUser } from "../notifications/service.js";
import { paidByMember } from "../pots/money.js";
import { CLOSED, JOINABLE, lockPot, type Actor, type PotRow, type Stage } from "../pots/service.js";
import type { User } from "../users/service.js";

export type InviteRow = Selectable<Database["pot_invites"]>;

export const INVITE_DEFAULT_TTL_DAYS = 30;
export const EMAIL_INVITE_TTL_DAYS = 14;
/** Guards against a pot being used to spam people. */
export const EMAIL_INVITES_PER_POT_PER_DAY = 50;
const ORGANISER_ROLES = ["organiser", "co_organiser"] as const;

/** 16 URL-safe characters, 96 bits of randomness: short enough to share, impossible to guess. */
export const newInviteToken = () => randomBytes(12).toString("base64url");
export const hashToken = (token: string) => createHash("sha256").update(token).digest();

const inviteInvalid = () => new AppError(404, "INVITE_INVALID", "This invite link is invalid or has expired");

const isUsable = (invite: InviteRow, now = new Date()) =>
  !invite.revoked_at &&
  (!invite.expires_at || invite.expires_at > now) &&
  (invite.max_uses === null || invite.use_count < invite.max_uses);

async function activeMemberCount(db: Db, potId: string): Promise<number> {
  const { n } = await db
    .selectFrom("pot_members")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("pot_id", "=", potId)
    .where("status", "=", "active")
    .executeTakeFirstOrThrow();
  return Number(n);
}

function assertJoinable(pot: PotRow) {
  if (pot.frozen_at) {
    throw new AppError(423, "POT_FROZEN", "This pot is paused while DettyPot support takes a look");
  }
  if (!JOINABLE.includes(pot.stage as Stage)) {
    throw conflict("POT_NOT_JOINABLE", `New members can't join a pot that is ${pot.stage}`);
  }
}

async function assertRoomFor(db: Db, pot: PotRow) {
  if ((await activeMemberCount(db, pot.id)) >= pot.headcount) {
    throw conflict("POT_FULL", "This pot is full. The organiser can raise the headcount to make room.");
  }
}

/** Money can't leave a member's hands without refunds, which arrive with payments (MON-16). */
async function assertNothingPaid(db: Db, potId: string, userId: string) {
  const paid = (await paidByMember(db, [potId])).get(potId)?.get(userId) ?? 0;
  if (paid > 0) {
    throw conflict(
      "MEMBER_HAS_PAID",
      "This member has paid into the pot. Leaving or removal will refund them, which isn't available yet.",
    );
  }
}

/** Closes any open vote about someone who is no longer in the pot. */
async function cancelOpenRequestsAbout(db: Db, potId: string, userId: string) {
  await db
    .updateTable("pot_approval_requests")
    .set({ status: "cancelled" })
    .where("pot_id", "=", potId)
    .where("subject_user_id", "=", userId)
    .where("status", "=", "open")
    .execute();
}

// ─────────────────────────────────────────────
// Invites
// ─────────────────────────────────────────────

export interface CreatedInvite {
  invite: InviteRow;
  /** Shown once. Only its hash is stored. */
  token: string;
}

export async function createInviteLink(
  db: Db,
  actor: Actor,
  potId: string,
  opts: { maxUses?: number; expiresInDays?: number },
): Promise<CreatedInvite> {
  return db.transaction().execute(async (trx) => {
    await authorizePot(trx, actor.user, potId, "invite.manage");
    assertJoinable(await lockPot(trx, potId));

    const token = newInviteToken();
    const days = opts.expiresInDays ?? INVITE_DEFAULT_TTL_DAYS;
    const invite = await trx
      .insertInto("pot_invites")
      .values({
        pot_id: potId,
        created_by: actor.user.id,
        kind: "link",
        token_hash: hashToken(token),
        max_uses: opts.maxUses ?? null,
        expires_at: new Date(Date.now() + days * 24 * 3600 * 1000),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await recordAudit(trx, {
      actorUserId: actor.user.id,
      action: "invite.created",
      potId,
      subjectType: "invite",
      subjectId: invite.id,
      requestId: actor.requestId,
    });
    return { invite, token };
  });
}

/**
 * Invites one person by email, whether or not they have an account (FR-INV-04).
 * The link is single-use and only works for someone signed in with that
 * verified address, so a forwarded email can't be used by anyone else.
 */
export async function createEmailInvite(
  db: Db,
  actor: Actor,
  potId: string,
  email: string,
  webBaseUrl: string,
): Promise<InviteRow> {
  return db.transaction().execute(async (trx) => {
    await authorizePot(trx, actor.user, potId, "invite.manage");
    const pot = await lockPot(trx, potId);
    assertJoinable(pot);

    const alreadyIn = await trx
      .selectFrom("pot_members as m")
      .innerJoin("users as u", "u.id", "m.user_id")
      .select("m.status")
      .where("m.pot_id", "=", potId)
      .where("u.email", "=", email)
      .where("m.status", "in", ["active", "pending"])
      .executeTakeFirst();
    if (alreadyIn) throw conflict("ALREADY_MEMBER", "This person is already in the pot or waiting to join");

    const { n } = await trx
      .selectFrom("pot_invites")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("pot_id", "=", potId)
      .where("kind", "=", "email")
      .where("created_at", ">", new Date(Date.now() - 24 * 3600 * 1000))
      .executeTakeFirstOrThrow();
    if (Number(n) >= EMAIL_INVITES_PER_POT_PER_DAY) {
      throw new AppError(429, "TOO_MANY_INVITES", "This pot has sent the most email invites allowed today. Try again tomorrow.");
    }

    const token = newInviteToken();
    const invite = await trx
      .insertInto("pot_invites")
      .values({
        pot_id: potId,
        created_by: actor.user.id,
        kind: "email",
        token_hash: hashToken(token),
        invitee_email: email,
        max_uses: 1,
        expires_at: new Date(Date.now() + EMAIL_INVITE_TTL_DAYS * 24 * 3600 * 1000),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    // The token travels in the email. It is useless without signing in as the
    // invited, verified address, so keeping it in the notification is safe.
    await notifyEmailAddress(trx, email, potId, "pot_invite", {
      inviterName: actor.user.full_name,
      potName: pot.name,
      shareKobo: pot.share_kobo,
      url: new URL(`/join/${token}`, webBaseUrl).toString(),
    });
    await recordAudit(trx, {
      actorUserId: actor.user.id,
      action: "invite.emailed",
      potId,
      subjectType: "invite",
      subjectId: invite.id,
      requestId: actor.requestId,
    });
    return invite;
  });
}

export interface InviteSummary {
  invite: InviteRow;
  createdByName: string | null;
}

export async function listInvites(db: Db, user: User, potId: string): Promise<InviteSummary[]> {
  await authorizePot(db, user, potId, "invite.manage");
  const rows = await db
    .selectFrom("pot_invites as i")
    .innerJoin("users as u", "u.id", "i.created_by")
    .selectAll("i")
    .select("u.full_name as created_by_name")
    .where("i.pot_id", "=", potId)
    .orderBy("i.created_at", "desc")
    .execute();
  return rows.map(({ created_by_name, ...invite }) => ({ invite, createdByName: created_by_name }));
}

export const inviteIsActive = (invite: InviteRow) => isUsable(invite);

export async function revokeInvite(db: Db, actor: Actor, potId: string, inviteId: string): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await authorizePot(trx, actor.user, potId, "invite.manage");
    const invite = await trx
      .selectFrom("pot_invites")
      .selectAll()
      .where("id", "=", inviteId)
      .where("pot_id", "=", potId)
      .forUpdate()
      .executeTakeFirst();
    if (!invite) throw notFound("Invite not found");
    if (invite.revoked_at) return;
    await trx
      .updateTable("pot_invites")
      .set({ revoked_at: new Date(), revoked_by: actor.user.id })
      .where("id", "=", inviteId)
      .execute();
    await recordAudit(trx, {
      actorUserId: actor.user.id,
      action: "invite.revoked",
      potId,
      subjectType: "invite",
      subjectId: inviteId,
      requestId: actor.requestId,
    });
  });
}

export interface InvitePreview {
  pot: PotRow;
  organiserName: string | null;
  memberCount: number;
  joinable: boolean;
}

/**
 * What someone sees before joining, without signing in (FR-INV-01): enough to
 * decide, nothing about the members themselves.
 */
export async function previewInvite(db: Db, token: string): Promise<InvitePreview> {
  const invite = await db.selectFrom("pot_invites").selectAll().where("token_hash", "=", hashToken(token)).executeTakeFirst();
  if (!invite || !isUsable(invite)) throw inviteInvalid();

  const pot = await db.selectFrom("pots").selectAll().where("id", "=", invite.pot_id).executeTakeFirstOrThrow();
  const organiser = await db
    .selectFrom("pot_members as m")
    .innerJoin("users as u", "u.id", "m.user_id")
    .select("u.full_name")
    .where("m.pot_id", "=", pot.id)
    .where("m.role", "=", "organiser")
    .executeTakeFirst();
  const memberCount = await activeMemberCount(db, pot.id);
  return {
    pot,
    organiserName: organiser?.full_name ?? null,
    memberCount,
    joinable: !pot.frozen_at && JOINABLE.includes(pot.stage as Stage) && memberCount < pot.headcount,
  };
}

export interface JoinResult {
  potId: string;
  status: "active" | "pending";
  alreadyMember: boolean;
}

/** Joins a pot with an invite token (FR-INV-02). The server decides the role. */
export async function joinWithInvite(db: Db, actor: Actor, token: string): Promise<JoinResult> {
  return db.transaction().execute(async (trx) => {
    const invite = await trx
      .selectFrom("pot_invites")
      .selectAll()
      .where("token_hash", "=", hashToken(token))
      .forUpdate()
      .executeTakeFirst();
    if (!invite) throw inviteInvalid();

    // People already in the pot are sent to it, even if the link has since
    // been used up or expired: they often tap an old invite again.
    const existing = await trx
      .selectFrom("pot_members")
      .selectAll()
      .where("pot_id", "=", invite.pot_id)
      .where("user_id", "=", actor.user.id)
      .forUpdate()
      .executeTakeFirst();
    if (existing?.status === "active" || existing?.status === "pending") {
      return { potId: invite.pot_id, status: existing.status, alreadyMember: true };
    }

    if (!isUsable(invite)) throw inviteInvalid();
    const pot = await lockPot(trx, invite.pot_id);
    assertJoinable(pot);

    if (invite.kind !== "link") {
      const matches = actor.user.email?.toLowerCase() === invite.invitee_email?.toLowerCase();
      if (!matches || !actor.user.email_verified_at) {
        throw forbidden("This invite was sent to someone else");
      }
    }

    if (existing?.status === "removed" && invite.kind === "link") {
      throw new AppError(
        403,
        "REMOVED_FROM_POT",
        "The organiser removed you from this pot. Ask them for a personal invite to rejoin.",
      );
    }

    const status = pot.join_approval_required ? "pending" : "active";
    if (status === "active") await assertRoomFor(trx, pot);

    // Counts the use only if the invite still has one left, so two people
    // racing for the last use can't both get in.
    const used = await trx
      .updateTable("pot_invites")
      .set((eb) => ({ use_count: eb("use_count", "+", 1) }))
      .where("id", "=", invite.id)
      .where((eb) => eb.or([eb("max_uses", "is", null), eb("use_count", "<", eb.ref("max_uses"))]))
      .executeTakeFirst();
    if (Number(used.numUpdatedRows) === 0) throw inviteInvalid();

    const membership = {
      role: "member",
      status,
      invite_id: invite.id,
      joined_at: status === "active" ? new Date() : null,
      status_changed_by: actor.user.id,
    };
    if (existing) {
      await trx.updateTable("pot_members").set(membership).where("id", "=", existing.id).execute();
    } else {
      await trx.insertInto("pot_members").values({ pot_id: pot.id, user_id: actor.user.id, ...membership }).execute();
    }

    const who = { userId: actor.user.id, name: actor.user.full_name };
    if (status === "pending") {
      await notifyPotMembers(trx, pot.id, "join_requested", who, { roles: ORGANISER_ROLES });
    } else {
      await notifyPotMembers(trx, pot.id, "member_joined", who, { exceptUserId: actor.user.id });
    }
    await recordAudit(trx, {
      actorUserId: actor.user.id,
      action: status === "pending" ? "member.join_requested" : "member.joined",
      potId: pot.id,
      subjectType: "invite",
      subjectId: invite.id,
      requestId: actor.requestId,
    });
    return { potId: pot.id, status, alreadyMember: false };
  });
}

// ─────────────────────────────────────────────
// Join requests
// ─────────────────────────────────────────────

export interface JoinRequest {
  userId: string;
  fullName: string | null;
  avatarEmoji: string | null;
  requestedAt: Date;
}

export async function listJoinRequests(db: Db, user: User, potId: string): Promise<JoinRequest[]> {
  await authorizePot(db, user, potId, "member.approve_join");
  const rows = await db
    .selectFrom("pot_members as m")
    .innerJoin("users as u", "u.id", "m.user_id")
    .select(["m.user_id", "u.full_name", "u.avatar_emoji", "m.status_changed_at"])
    .where("m.pot_id", "=", potId)
    .where("m.status", "=", "pending")
    .orderBy("m.status_changed_at")
    .execute();
  return rows.map((r) => ({
    userId: r.user_id,
    fullName: r.full_name,
    avatarEmoji: r.avatar_emoji,
    requestedAt: r.status_changed_at,
  }));
}

export async function decideJoinRequest(
  db: Db,
  actor: Actor,
  potId: string,
  userId: string,
  decision: "approve" | "decline",
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await authorizePot(trx, actor.user, potId, "member.approve_join");
    const pot = await lockPot(trx, potId);
    const request = await trx
      .selectFrom("pot_members")
      .selectAll()
      .where("pot_id", "=", potId)
      .where("user_id", "=", userId)
      .where("status", "=", "pending")
      .forUpdate()
      .executeTakeFirst();
    if (!request) throw notFound("Join request not found");

    if (decision === "approve") {
      assertJoinable(pot);
      await assertRoomFor(trx, pot);
      await trx
        .updateTable("pot_members")
        .set({ status: "active", joined_at: new Date(), status_changed_by: actor.user.id })
        .where("id", "=", request.id)
        .execute();
      const joiner = await trx.selectFrom("users").select("full_name").where("id", "=", userId).executeTakeFirstOrThrow();
      await notifyUser(trx, userId, potId, "join_approved", { potName: pot.name });
      await notifyPotMembers(trx, potId, "member_joined", { userId, name: joiner.full_name }, { exceptUserId: userId });
    } else {
      await trx
        .updateTable("pot_members")
        .set({ status: "declined", status_changed_by: actor.user.id })
        .where("id", "=", request.id)
        .execute();
      await notifyUser(trx, userId, potId, "join_declined", { potName: pot.name });
    }
    await recordAudit(trx, {
      actorUserId: actor.user.id,
      action: decision === "approve" ? "member.join_approved" : "member.join_declined",
      potId,
      subjectType: "user",
      subjectId: userId,
      requestId: actor.requestId,
    });
  });
}

// ─────────────────────────────────────────────
// Leaving and removal
// ─────────────────────────────────────────────

export async function removeMember(db: Db, actor: Actor, potId: string, userId: string): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const access = await authorizePot(trx, actor.user, potId, "member.remove");
    const pot = await lockPot(trx, potId);
    if (CLOSED.includes(pot.stage as Stage)) throw conflict("POT_CLOSED", `This pot is ${pot.stage}`);

    const target = await trx
      .selectFrom("pot_members")
      .selectAll()
      .where("pot_id", "=", potId)
      .where("user_id", "=", userId)
      .where("status", "=", "active")
      .forUpdate()
      .executeTakeFirst();
    if (!target) throw notFound("Member not found");
    if (userId === actor.user.id) throw conflict("CANNOT_REMOVE_SELF", "To leave the pot, use leave instead");
    if (!canRemoveMember(access.role, target.role as PotRole)) {
      throw forbidden(target.role === "organiser" ? "The organiser can't be removed" : "Your role can't remove this member");
    }
    await assertNothingPaid(trx, potId, userId);

    await trx
      .updateTable("pot_members")
      .set({ status: "removed", role: "member", status_changed_by: actor.user.id })
      .where("id", "=", target.id)
      .execute();
    await cancelOpenRequestsAbout(trx, potId, userId);
    await notifyUser(trx, userId, potId, "removed_from_pot", { potName: pot.name });
    await recordAudit(trx, {
      actorUserId: actor.user.id,
      action: "member.removed",
      potId,
      subjectType: "user",
      subjectId: userId,
      requestId: actor.requestId,
      metadata: { role: target.role },
    });
  });
}

export async function leavePot(db: Db, actor: Actor, potId: string): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const access = await authorizePot(trx, actor.user, potId, "pot.view");
    const pot = await lockPot(trx, potId);
    if (access.role === "organiser") {
      throw conflict("ORGANISER_CANNOT_LEAVE", "Hand the pot over to someone else before leaving it");
    }
    if (!CLOSED.includes(pot.stage as Stage)) await assertNothingPaid(trx, potId, actor.user.id);

    await trx
      .updateTable("pot_members")
      .set({ status: "left", role: "member", status_changed_by: actor.user.id })
      .where("id", "=", access.membershipId)
      .execute();
    await cancelOpenRequestsAbout(trx, potId, actor.user.id);
    await notifyPotMembers(trx, potId, "member_left", { userId: actor.user.id, name: actor.user.full_name }, { roles: ORGANISER_ROLES });
    await recordAudit(trx, { actorUserId: actor.user.id, action: "member.left", potId, requestId: actor.requestId });
  });
}
