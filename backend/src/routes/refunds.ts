import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import type { Actor } from "../pots/service.js";
import { myRefunds, provideRefundAccount, settleLeftover, startRefunds } from "../refunds/service.js";
import { chooseRollover, getMyRollover, offerRollover, potRollovers } from "../rollovers/service.js";

const actorOf = (req: FastifyRequest): Actor => ({ user: requireUser(req), requestId: req.id });
const doc = (summary: string) => ({ tags: ["refunds"], summary, security: [{ bearerAuth: [] }] });

export const refundRoutes: FastifyPluginAsyncZod = async (app) => {
  const auth = { preHandler: app.authenticate };

  app.post(
    "/pots/:potId/settle",
    {
      ...auth,
      schema: {
        ...doc("Settle what's left after the outing (organiser only): refund it in proportion, or offer to roll it into a new pot you organise"),
        params: z.object({ potId: z.string().max(64) }),
        body: z
          .discriminatedUnion("mode", [
            z.strictObject({ mode: z.literal("refund") }),
            z.strictObject({ mode: z.literal("rollover"), targetPotId: z.uuid() }),
          ])
          .optional(),
        response: {
          200: z.object({
            mode: z.enum(["refund", "rollover"]),
            leftoverKobo: z.number().int(),
            settlementId: z.uuid().optional(),
            refunds: z.number().int().optional(),
            rolloverId: z.uuid().optional(),
            consentDeadline: z.iso.datetime().optional(),
          }),
        },
      },
    },
    async (req) => {
      if (req.body?.mode === "rollover") {
        const r = await offerRollover(app.db, actorOf(req), req.params.potId, req.body.targetPotId);
        return { mode: "rollover" as const, leftoverKobo: r.leftover_kobo, rolloverId: r.id, consentDeadline: r.consent_deadline.toISOString() };
      }
      const result = await settleLeftover(app.db, actorOf(req), req.params.potId);
      await startRefunds(app.db, app.paystack, result.refundIds);
      return { mode: "refund" as const, settlementId: result.settlementId, leftoverKobo: result.leftoverKobo, refunds: result.refundIds.length };
    },
  );

  app.get(
    "/pots/:potId/rollovers",
    { ...auth, schema: { ...doc("Roll-over offers from this pot and how each contributor chose"), params: z.object({ potId: z.string().max(64) }) } },
    async (req) => potRollovers(app.db, requireUser(req), req.params.potId),
  );

  app.get(
    "/rollovers/:rolloverId",
    {
      ...auth,
      schema: {
        ...doc("Your part of a roll-over offer"),
        params: z.object({ rolloverId: z.uuid() }),
        response: {
          200: z.object({
            id: z.uuid(),
            status: z.string(),
            consentDeadline: z.iso.datetime(),
            amountKobo: z.number().int(),
            choice: z.enum(["pending", "move", "refund"]),
            fromPot: z.object({ id: z.uuid(), name: z.string() }),
            toPot: z.object({ id: z.uuid(), name: z.string(), shareKobo: z.number().int() }),
          }),
        },
      },
    },
    async (req) => {
      const r = await getMyRollover(app.db, requireUser(req), req.params.rolloverId);
      return {
        id: r.id,
        status: r.status,
        consentDeadline: r.consent_deadline.toISOString(),
        amountKobo: r.amount_kobo,
        choice: r.choice as "pending" | "move" | "refund",
        fromPot: { id: r.from_pot_id, name: r.from_pot_name },
        toPot: { id: r.to_pot_id, name: r.to_pot_name, shareKobo: r.to_pot_share_kobo },
      };
    },
  );

  app.post(
    "/rollovers/:rolloverId/choice",
    {
      ...auth,
      schema: {
        ...doc("Move your part into the new outing, or have it refunded"),
        params: z.object({ rolloverId: z.uuid() }),
        body: z.strictObject({ choice: z.enum(["move", "refund"]) }),
        response: { 200: z.object({ ok: z.literal(true) }) },
      },
    },
    async (req) => {
      const refundIds = await chooseRollover(app.db, actorOf(req), req.params.rolloverId, req.body.choice);
      await startRefunds(app.db, app.paystack, refundIds);
      return { ok: true as const };
    },
  );

  app.get(
    "/refunds/mine",
    {
      ...auth,
      schema: {
        ...doc("Your refunds, from every pot"),
        response: {
          200: z.array(
            z.object({
              id: z.uuid(),
              potId: z.uuid(),
              potName: z.string(),
              amountKobo: z.number().int(),
              reason: z.string(),
              status: z.string(),
              createdAt: z.iso.datetime(),
              completedAt: z.iso.datetime().nullable(),
            }),
          ),
        },
      },
    },
    async (req) =>
      (await myRefunds(app.db, requireUser(req))).map((r) => ({
        id: r.id,
        potId: r.pot_id,
        potName: r.pot_name,
        amountKobo: r.amount_kobo,
        reason: r.reason,
        status: r.status,
        createdAt: r.created_at.toISOString(),
        completedAt: r.completed_at?.toISOString() ?? null,
      })),
  );

  app.post(
    "/refunds/:refundId/account",
    {
      ...auth,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        ...doc("Tell us where to send a refund your bank couldn't receive automatically"),
        params: z.object({ refundId: z.uuid() }),
        body: z.strictObject({
          bankCode: z.string().regex(/^[0-9A-Za-z]{2,20}$/),
          accountNumber: z.string().regex(/^[0-9]{10}$/, "A Nigerian account number has 10 digits"),
        }),
        response: { 200: z.object({ status: z.string(), accountName: z.string() }) },
      },
    },
    async (req) => provideRefundAccount(app.db, app.paystack, actorOf(req), req.params.refundId, req.body),
  );
};
