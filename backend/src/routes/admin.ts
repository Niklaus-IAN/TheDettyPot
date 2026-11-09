import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  assertAdmin,
  auditLog,
  feeSchedules,
  paymentsByStatus,
  potRecord,
  searchPots,
  searchUsers,
  setFeeSchedule,
  setFrozen,
  webhooksByStatus,
} from "../admin/service.js";
import { requireUser } from "../auth/plugin.js";

/** Internal support tools. Hidden (404) from anyone who isn't an admin. */
export const adminRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", async (req) => assertAdmin(requireUser(req)));
  const doc = (summary: string) => ({ tags: ["admin"], summary, security: [{ bearerAuth: [] }] });
  const potParams = z.object({ potId: z.string().max(64) });
  const ok = z.object({ ok: z.literal(true) });

  app.get(
    "/admin/pots",
    { schema: { ...doc("Search pots by name, id or organiser email"), querystring: z.object({ q: z.string().max(200).default("") }) } },
    async (req) => searchPots(app.db, req.query.q),
  );

  app.get(
    "/admin/pots/:potId",
    { schema: { ...doc("A pot's full record: members, ledger, invites, audit trail"), params: potParams } },
    async (req) => potRecord(app.db, req.params.potId),
  );

  app.post(
    "/admin/pots/:potId/freeze",
    {
      schema: {
        ...doc("Freeze a pot: read-only for its members until unfrozen"),
        params: potParams,
        body: z.strictObject({ reason: z.string().trim().min(3).max(500) }),
        response: { 200: ok },
      },
    },
    async (req) => {
      await setFrozen(app.db, requireUser(req), req.params.potId, { reason: req.body.reason }, req.id);
      return { ok: true as const };
    },
  );

  app.post(
    "/admin/pots/:potId/unfreeze",
    { schema: { ...doc("Lift a freeze"), params: potParams, response: { 200: ok } } },
    async (req) => {
      await setFrozen(app.db, requireUser(req), req.params.potId, null, req.id);
      return { ok: true as const };
    },
  );

  app.get(
    "/admin/users",
    { schema: { ...doc("Search users by email, name or id"), querystring: z.object({ q: z.string().max(200).default("") }) } },
    async (req) => searchUsers(app.db, req.query.q),
  );

  app.get("/admin/fees", { schema: { ...doc("Fee schedules: the ones in force, and the history") } }, async () => feeSchedules(app.db));

  app.post(
    "/admin/fees",
    {
      schema: {
        ...doc("Set a new fee schedule for a payment method (applies to payments started from now)"),
        body: z.strictObject({
          method: z.enum(["card", "bank_transfer"]),
          percentBps: z.number().int().min(0).max(5000),
          flatKobo: z.number().int().min(0).max(1_000_000),
          capKobo: z.number().int().positive().nullable(),
          marginBps: z.number().int().min(0).max(5000),
          marginFlatKobo: z.number().int().min(0).max(1_000_000),
          note: z.string().trim().max(500).optional(),
        }),
      },
    },
    async (req, reply) => reply.status(201).send(await setFeeSchedule(app.db, requireUser(req), req.body, req.id)),
  );

  app.get(
    "/admin/payments",
    {
      schema: {
        ...doc("Payments by status; 'review' lists those a person must check"),
        querystring: z.object({ status: z.enum(["review", "pending", "failed", "expired", "succeeded"]).default("review") }),
      },
    },
    async (req) => paymentsByStatus(app.db, req.query.status),
  );

  app.get(
    "/admin/webhooks",
    {
      schema: {
        ...doc("Incoming webhooks by status; 'failed' lists those that ran out of retries"),
        querystring: z.object({ status: z.enum(["failed", "pending", "processed", "ignored"]).default("failed") }),
      },
    },
    async (req) => webhooksByStatus(app.db, req.query.status),
  );

  app.get(
    "/admin/audit",
    {
      schema: {
        ...doc("The audit log, newest first"),
        querystring: z.object({
          potId: z.uuid().optional(),
          actorUserId: z.uuid().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
      },
    },
    async (req) => auditLog(app.db, req.query),
  );
};
