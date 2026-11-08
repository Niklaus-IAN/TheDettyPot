import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { POT_ROLES } from "../auth/permissions.js";
import {
  advanceStage,
  cancelPot,
  createPot,
  getPot,
  listMyPots,
  MAX_BUDGET_KOBO,
  STAGES,
  updatePot,
  updateSettings,
  VIBES,
  type Actor,
  type PotView,
  type PotDetailView,
} from "../pots/service.js";

// ─────────────────────────────────────────────
// Request shapes. Money is always in kobo (₦1 = 100 kobo).
// ─────────────────────────────────────────────
const budgetKobo = z
  .number()
  .int()
  .positive()
  .multipleOf(100, "Budgets are set in whole naira")
  .max(MAX_BUDGET_KOBO, "Budget is above the ₦100,000,000 limit");
const headcount = z.number().int().min(2).max(1000);
const name = z.string().trim().min(2).max(80);
const description = z.string().trim().max(1000);
const area = z.string().trim().max(120);
const outingDate = z.iso.date();
const outingTime = z.iso.time({ precision: -1 }); // HH:MM
const fundingDeadline = z.iso.datetime({ offset: true });

const createBody = z.strictObject({
  name,
  description: description.optional(),
  vibe: z.enum(VIBES).optional(),
  area: area.optional(),
  outingDate: outingDate.optional(),
  outingTime: outingTime.optional(),
  fundingDeadline: fundingDeadline.optional(),
  budgetKobo,
  headcount,
  joinApprovalRequired: z.boolean().optional(),
  payoutApprovalRequired: z.boolean().optional(),
});

// null clears an optional field.
const updateBody = z
  .strictObject({
    name: name.optional(),
    description: description.nullable().optional(),
    vibe: z.enum(VIBES).optional(),
    area: area.nullable().optional(),
    outingDate: outingDate.nullable().optional(),
    outingTime: outingTime.nullable().optional(),
    fundingDeadline: fundingDeadline.nullable().optional(),
    budgetKobo: budgetKobo.optional(),
    headcount: headcount.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "Nothing to update" });

const settingsBody = z
  .strictObject({
    joinApprovalRequired: z.boolean().optional(),
    payoutApprovalRequired: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "Nothing to update" });

const stageBody = z.strictObject({ to: z.enum(["collecting", "funded", "confirmed", "completed"]) });
const cancelBody = z.strictObject({ reason: z.string().trim().min(1).max(500).optional() }).optional();
const potParams = z.object({ potId: z.string().max(64) });

// ─────────────────────────────────────────────
// Response shapes
// ─────────────────────────────────────────────
const potSummary = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  vibe: z.enum(VIBES),
  stage: z.enum(STAGES),
  stageChangedAt: z.iso.datetime(),
  area: z.string().nullable(),
  outingDate: z.string().nullable(),
  outingTime: z.string().nullable(),
  timezone: z.string(),
  fundingDeadline: z.iso.datetime().nullable(),
  currency: z.literal("NGN"),
  budgetKobo: z.number().int(),
  headcount: z.number().int(),
  shareKobo: z.number().int(),
  joinApprovalRequired: z.boolean(),
  payoutApprovalRequired: z.boolean(),
  createdAt: z.iso.datetime(),
  myRole: z.enum(POT_ROLES),
  memberCount: z.number().int(),
  /** Confirmed money only; payments in progress are not counted. */
  raisedKobo: z.number().int(),
  /** Payments started but not confirmed yet, shown separately. */
  inProgressKobo: z.number().int(),
  myPaidKobo: z.number().int(),
  myOwedKobo: z.number().int(),
});

const potDetail = potSummary.extend({
  members: z.array(
    z.object({
      userId: z.uuid(),
      fullName: z.string().nullable(),
      avatarEmoji: z.string().nullable(),
      role: z.enum(POT_ROLES),
      joinedAt: z.iso.datetime().nullable(),
      paidKobo: z.number().int(),
    }),
  ),
});

type PotSummary = z.infer<typeof potSummary>;

const toSummary = (v: PotView): PotSummary => ({
  id: v.pot.id,
  name: v.pot.name,
  description: v.pot.description,
  vibe: v.pot.vibe as PotSummary["vibe"],
  stage: v.pot.stage as PotSummary["stage"],
  stageChangedAt: v.pot.stage_changed_at.toISOString(),
  area: v.pot.area,
  outingDate: v.pot.outing_date,
  outingTime: v.pot.outing_time?.slice(0, 5) ?? null,
  timezone: v.pot.timezone,
  fundingDeadline: v.pot.funding_deadline?.toISOString() ?? null,
  currency: "NGN",
  budgetKobo: v.pot.budget_kobo,
  headcount: v.pot.headcount,
  shareKobo: v.pot.share_kobo,
  joinApprovalRequired: v.pot.join_approval_required,
  payoutApprovalRequired: v.pot.payout_approval_required,
  createdAt: v.pot.created_at.toISOString(),
  myRole: v.myRole,
  memberCount: v.memberCount,
  raisedKobo: v.raisedKobo,
  inProgressKobo: v.inProgressKobo,
  myPaidKobo: v.myPaidKobo,
  myOwedKobo: v.myOwedKobo,
});

const toDetail = (v: PotDetailView): z.infer<typeof potDetail> => ({
  ...toSummary(v),
  members: v.members.map((m) => ({ ...m, joinedAt: m.joinedAt?.toISOString() ?? null })),
});

const actorOf = (req: FastifyRequest): Actor => ({ user: requireUser(req), requestId: req.id });

export const potRoutes: FastifyPluginAsyncZod = async (app) => {
  const common = { preHandler: app.authenticate };
  const doc = (summary: string) => ({ tags: ["pots"], summary, security: [{ bearerAuth: [] }] });

  app.post(
    "/pots",
    { ...common, schema: { ...doc("Create a pot; you become its organiser"), body: createBody, response: { 201: potSummary } } },
    async (req, reply) => reply.status(201).send(toSummary(await createPot(app.db, actorOf(req), req.body))),
  );

  app.get(
    "/pots",
    { ...common, schema: { ...doc("Your pots, with what you've paid and still owe"), response: { 200: z.array(potSummary) } } },
    async (req) => (await listMyPots(app.db, requireUser(req))).map(toSummary),
  );

  app.get(
    "/pots/:potId",
    { ...common, schema: { ...doc("A pot, its members and who has paid"), params: potParams, response: { 200: potDetail } } },
    async (req) => toDetail(await getPot(app.db, requireUser(req), req.params.potId)),
  );

  app.patch(
    "/pots/:potId",
    {
      ...common,
      schema: { ...doc("Edit a pot's details (until it is funded)"), params: potParams, body: updateBody, response: { 200: potDetail } },
    },
    async (req) => {
      await updatePot(app.db, actorOf(req), req.params.potId, req.body);
      return toDetail(await getPot(app.db, requireUser(req), req.params.potId));
    },
  );

  app.patch(
    "/pots/:potId/settings",
    {
      ...common,
      schema: { ...doc("Switch join approval or payout approval"), params: potParams, body: settingsBody, response: { 200: potDetail } },
    },
    async (req) => {
      await updateSettings(app.db, actorOf(req), req.params.potId, req.body);
      return toDetail(await getPot(app.db, requireUser(req), req.params.potId));
    },
  );

  app.post(
    "/pots/:potId/stage",
    {
      ...common,
      schema: { ...doc("Move a pot to its next stage"), params: potParams, body: stageBody, response: { 200: potDetail } },
    },
    async (req) => {
      await advanceStage(app.db, actorOf(req), req.params.potId, req.body.to);
      return toDetail(await getPot(app.db, requireUser(req), req.params.potId));
    },
  );

  app.post(
    "/pots/:potId/cancel",
    { ...common, schema: { ...doc("Cancel a pot (organiser only)"), params: potParams, body: cancelBody, response: { 200: potDetail } } },
    async (req) => {
      await cancelPot(app.db, actorOf(req), req.params.potId, req.body?.reason);
      return toDetail(await getPot(app.db, requireUser(req), req.params.potId));
    },
  );
};
