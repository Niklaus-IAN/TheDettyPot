import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import type { Actor } from "../pots/service.js";
import { myRefunds, provideRefundAccount, settleLeftover, startRefunds } from "../refunds/service.js";

const actorOf = (req: FastifyRequest): Actor => ({ user: requireUser(req), requestId: req.id });
const doc = (summary: string) => ({ tags: ["refunds"], summary, security: [{ bearerAuth: [] }] });

export const refundRoutes: FastifyPluginAsyncZod = async (app) => {
  const auth = { preHandler: app.authenticate };

  app.post(
    "/pots/:potId/settle",
    {
      ...auth,
      schema: {
        ...doc("Refund what's left after the outing, in proportion to what each person paid (organiser only)"),
        params: z.object({ potId: z.string().max(64) }),
        response: { 200: z.object({ settlementId: z.uuid(), leftoverKobo: z.number().int(), refunds: z.number().int() }) },
      },
    },
    async (req) => {
      const result = await settleLeftover(app.db, actorOf(req), req.params.potId);
      await startRefunds(app.db, app.paystack, result.refundIds);
      return { settlementId: result.settlementId, leftoverKobo: result.leftoverKobo, refunds: result.refundIds.length };
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
