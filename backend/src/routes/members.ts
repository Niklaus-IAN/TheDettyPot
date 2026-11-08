import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  cancelApproval,
  demoteCoOrganiser,
  listApprovals,
  nominateCoOrganiser,
  voteOnApproval,
  type ApprovalRow,
  type ApprovalView,
} from "../approvals/service.js";
import { requireUser } from "../auth/plugin.js";
import {
  createEmailInvite,
  createInviteLink,
  decideJoinRequest,
  inviteIsActive,
  joinWithInvite,
  leavePot,
  listInvites,
  listJoinRequests,
  previewInvite,
  removeMember,
  revokeInvite,
  type InviteRow,
} from "../members/service.js";
import { STAGES, VIBES, type Actor } from "../pots/service.js";

const actorOf = (req: FastifyRequest): Actor => ({ user: requireUser(req), requestId: req.id });
const doc = (tag: string, summary: string, signedIn = true) => ({
  tags: [tag],
  summary,
  ...(signedIn && { security: [{ bearerAuth: [] }] }),
});

const potParams = z.object({ potId: z.string().max(64) });
const memberParams = potParams.extend({ userId: z.uuid() });
const inviteParams = potParams.extend({ inviteId: z.uuid() });
const approvalParams = potParams.extend({ requestId: z.uuid() });
const tokenParams = z.object({ token: z.string().max(64) });

const ok = z.object({ ok: z.literal(true) });

// ─── Invites ───
const inviteSchema = z.object({
  id: z.uuid(),
  kind: z.string(),
  createdAt: z.iso.datetime(),
  createdByName: z.string().nullable(),
  maxUses: z.number().int().nullable(),
  useCount: z.number().int(),
  expiresAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  active: z.boolean(),
});

const toInvite = (invite: InviteRow, createdByName: string | null) => ({
  id: invite.id,
  kind: invite.kind,
  createdAt: invite.created_at.toISOString(),
  createdByName,
  maxUses: invite.max_uses,
  useCount: invite.use_count,
  expiresAt: invite.expires_at?.toISOString() ?? null,
  revokedAt: invite.revoked_at?.toISOString() ?? null,
  active: inviteIsActive(invite),
});

const previewSchema = z.object({
  joinable: z.boolean(),
  joinApprovalRequired: z.boolean(),
  pot: z.object({
    name: z.string(),
    vibe: z.enum(VIBES),
    stage: z.enum(STAGES),
    area: z.string().nullable(),
    outingDate: z.string().nullable(),
    outingTime: z.string().nullable(),
    budgetKobo: z.number().int(),
    headcount: z.number().int(),
    shareKobo: z.number().int(),
    memberCount: z.number().int(),
    organiserName: z.string().nullable(),
  }),
});

// ─── Approvals ───
const approvalSchema = z.object({
  id: z.uuid(),
  kind: z.string(),
  status: z.enum(["open", "approved", "rejected", "expired", "cancelled"]),
  subjectUserId: z.uuid().nullable(),
  subjectName: z.string().nullable(),
  eligibleVoters: z.number().int(),
  requiredApprovals: z.number().int(),
  approvals: z.number().int(),
  rejections: z.number().int(),
  myVote: z.enum(["approve", "reject"]).nullable(),
  canVote: z.boolean(),
  expiresAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

const toApproval = (v: ApprovalView): z.infer<typeof approvalSchema> => ({
  id: v.request.id,
  kind: v.request.kind,
  status: v.request.status as z.infer<typeof approvalSchema>["status"],
  subjectUserId: v.request.subject_user_id,
  subjectName: v.subjectName,
  eligibleVoters: v.request.eligible_voters,
  requiredApprovals: v.request.required_approvals,
  approvals: v.approvals,
  rejections: v.rejections,
  myVote: v.myVote,
  canVote: v.canVote,
  expiresAt: v.request.expires_at.toISOString(),
  resolvedAt: v.request.resolved_at?.toISOString() ?? null,
  createdAt: v.request.created_at.toISOString(),
});

export const memberRoutes: FastifyPluginAsyncZod = async (app) => {
  const auth = { preHandler: app.authenticate };

  /** Re-reads one approval through the list so the response shape is the same everywhere. */
  const approvalView = async (req: FastifyRequest, potId: string, row: ApprovalRow) => {
    const views = await listApprovals(app.db, requireUser(req), potId);
    return toApproval(views.find((v) => v.request.id === row.id)!);
  };

  // ─── Invite links ───
  app.post(
    "/pots/:potId/invites",
    {
      ...auth,
      schema: {
        ...doc("invites", "Create an invite link. The token is shown only in this response."),
        params: potParams,
        body: z.strictObject({
          maxUses: z.number().int().min(1).max(1000).optional(),
          expiresInDays: z.number().int().min(1).max(90).optional(),
        }),
        response: { 201: inviteSchema.extend({ token: z.string(), url: z.string() }) },
      },
    },
    async (req, reply) => {
      const { invite, token } = await createInviteLink(app.db, actorOf(req), req.params.potId, req.body);
      return reply.status(201).send({
        ...toInvite(invite, req.user!.full_name),
        token,
        url: new URL(`/join/${token}`, app.config.WEB_BASE_URL).toString(),
      });
    },
  );

  app.post(
    "/pots/:potId/invites/email",
    {
      ...auth,
      config: { rateLimit: { max: 30, timeWindow: "1 hour" } },
      schema: {
        ...doc("invites", "Invite someone by email, with or without an account"),
        params: potParams,
        body: z.strictObject({ email: z.email().max(254) }),
        response: { 201: inviteSchema },
      },
    },
    async (req, reply) => {
      const invite = await createEmailInvite(app.db, actorOf(req), req.params.potId, req.body.email.toLowerCase(), app.config.WEB_BASE_URL);
      return reply.status(201).send(toInvite(invite, req.user!.full_name));
    },
  );

  app.get(
    "/pots/:potId/invites",
    { ...auth, schema: { ...doc("invites", "A pot's invites (tokens are never shown again)"), params: potParams, response: { 200: z.array(inviteSchema) } } },
    async (req) => (await listInvites(app.db, requireUser(req), req.params.potId)).map((i) => toInvite(i.invite, i.createdByName)),
  );

  app.post(
    "/pots/:potId/invites/:inviteId/revoke",
    { ...auth, schema: { ...doc("invites", "Revoke an invite link"), params: inviteParams, response: { 200: ok } } },
    async (req) => {
      await revokeInvite(app.db, actorOf(req), req.params.potId, req.params.inviteId);
      return { ok: true as const };
    },
  );

  // ─── Joining ───
  app.get(
    "/invites/:token",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } }, schema: { ...doc("invites", "Preview a pot from its invite link (no sign-in needed)", false), params: tokenParams, response: { 200: previewSchema } } },
    async (req) => {
      const p = await previewInvite(app.db, req.params.token);
      return {
        joinable: p.joinable,
        joinApprovalRequired: p.pot.join_approval_required,
        pot: {
          name: p.pot.name,
          vibe: p.pot.vibe as z.infer<typeof previewSchema>["pot"]["vibe"],
          stage: p.pot.stage as z.infer<typeof previewSchema>["pot"]["stage"],
          area: p.pot.area,
          outingDate: p.pot.outing_date,
          outingTime: p.pot.outing_time?.slice(0, 5) ?? null,
          budgetKobo: p.pot.budget_kobo,
          headcount: p.pot.headcount,
          shareKobo: p.pot.share_kobo,
          memberCount: p.memberCount,
          organiserName: p.organiserName,
        },
      };
    },
  );

  app.post(
    "/invites/:token/join",
    {
      ...auth,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        ...doc("invites", "Join a pot with an invite link"),
        params: tokenParams,
        response: { 200: z.object({ potId: z.uuid(), status: z.enum(["active", "pending"]), alreadyMember: z.boolean() }) },
      },
    },
    async (req) => joinWithInvite(app.db, actorOf(req), req.params.token),
  );

  // ─── Join requests ───
  app.get(
    "/pots/:potId/join-requests",
    {
      ...auth,
      schema: {
        ...doc("members", "People waiting for approval to join"),
        params: potParams,
        response: {
          200: z.array(
            z.object({ userId: z.uuid(), fullName: z.string().nullable(), avatarEmoji: z.string().nullable(), requestedAt: z.iso.datetime() }),
          ),
        },
      },
    },
    async (req) =>
      (await listJoinRequests(app.db, requireUser(req), req.params.potId)).map((r) => ({ ...r, requestedAt: r.requestedAt.toISOString() })),
  );

  for (const decision of ["approve", "decline"] as const) {
    app.post(
      `/pots/:potId/join-requests/:userId/${decision}`,
      { ...auth, schema: { ...doc("members", `${decision === "approve" ? "Approve" : "Decline"} a join request`), params: memberParams, response: { 200: ok } } },
      async (req) => {
        await decideJoinRequest(app.db, actorOf(req), req.params.potId, req.params.userId, decision);
        return { ok: true as const };
      },
    );
  }

  // ─── Leaving, removal, roles ───
  app.post(
    "/pots/:potId/members/:userId/remove",
    { ...auth, schema: { ...doc("members", "Remove a member"), params: memberParams, response: { 200: ok } } },
    async (req) => {
      await removeMember(app.db, actorOf(req), req.params.potId, req.params.userId);
      return { ok: true as const };
    },
  );

  app.post(
    "/pots/:potId/members/:userId/demote",
    { ...auth, schema: { ...doc("members", "Take co-organiser rights back (organiser only)"), params: memberParams, response: { 200: ok } } },
    async (req) => {
      await demoteCoOrganiser(app.db, actorOf(req), req.params.potId, req.params.userId);
      return { ok: true as const };
    },
  );

  app.post(
    "/pots/:potId/leave",
    { ...auth, schema: { ...doc("members", "Leave a pot"), params: potParams, response: { 200: ok } } },
    async (req) => {
      await leavePot(app.db, actorOf(req), req.params.potId);
      return { ok: true as const };
    },
  );

  // ─── Co-organiser votes ───
  app.post(
    "/pots/:potId/co-organisers",
    {
      ...auth,
      schema: {
        ...doc("approvals", "Nominate a member as co-organiser; members vote on it"),
        params: potParams,
        body: z.strictObject({ userId: z.uuid() }),
        response: { 201: approvalSchema },
      },
    },
    async (req, reply) => {
      const row = await nominateCoOrganiser(app.db, actorOf(req), req.params.potId, req.body.userId);
      return reply.status(201).send(await approvalView(req, req.params.potId, row));
    },
  );

  app.get(
    "/pots/:potId/approvals",
    { ...auth, schema: { ...doc("approvals", "Open and recent decisions in a pot"), params: potParams, response: { 200: z.array(approvalSchema) } } },
    async (req) => (await listApprovals(app.db, requireUser(req), req.params.potId)).map(toApproval),
  );

  app.post(
    "/pots/:potId/approvals/:requestId/votes",
    {
      ...auth,
      schema: {
        ...doc("approvals", "Vote on a decision"),
        params: approvalParams,
        body: z.strictObject({ decision: z.enum(["approve", "reject"]) }),
        response: { 200: approvalSchema },
      },
    },
    async (req) => {
      const row = await voteOnApproval(app.db, actorOf(req), req.params.potId, req.params.requestId, req.body.decision);
      return approvalView(req, req.params.potId, row);
    },
  );

  app.post(
    "/pots/:potId/approvals/:requestId/cancel",
    { ...auth, schema: { ...doc("approvals", "Withdraw a nomination (organiser only)"), params: approvalParams, response: { 200: ok } } },
    async (req) => {
      await cancelApproval(app.db, actorOf(req), req.params.potId, req.params.requestId);
      return { ok: true as const };
    },
  );
};
