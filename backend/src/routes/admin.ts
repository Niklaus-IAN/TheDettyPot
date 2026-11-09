import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { assertAdmin, auditLog, potRecord, searchPots, searchUsers, setFrozen } from "../admin/service.js";
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
