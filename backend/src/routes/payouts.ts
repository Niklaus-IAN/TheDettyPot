import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import {
  cancelPayout,
  flagPayout,
  listBanks,
  listPayouts,
  requestPayout,
  resolvePayoutAccount,
  sendPayout,
  type PayoutView,
} from "../payouts/service.js";
import type { Actor } from "../pots/service.js";

const actorOf = (req: FastifyRequest): Actor => ({ user: requireUser(req), requestId: req.id });
const doc = (summary: string) => ({ tags: ["payouts"], summary, security: [{ bearerAuth: [] }] });
const potParams = z.object({ potId: z.string().max(64) });
const payoutParams = potParams.extend({ payoutId: z.uuid() });
const bankCode = z.string().regex(/^[0-9A-Za-z]{2,20}$/);
const accountNumber = z.string().regex(/^[0-9]{10}$/, "A Nigerian account number has 10 digits");
const ok = z.object({ ok: z.literal(true) });

const payoutSchema = z.object({
  id: z.uuid(),
  amountKobo: z.number().int(),
  narration: z.string().nullable(),
  status: z.string(),
  accountName: z.string(),
  bankName: z.string(),
  accountNumberLast4: z.string(),
  requestedByName: z.string().nullable(),
  holdUntil: z.iso.datetime().nullable(),
  holdReasons: z.array(z.string()),
  approvalRequestId: z.uuid().nullable(),
  flagReason: z.string().nullable(),
  failureReason: z.string().nullable(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
});

export const toPayout = (v: PayoutView): z.infer<typeof payoutSchema> => ({
  id: v.payout.id,
  amountKobo: v.payout.amount_kobo,
  narration: v.payout.narration,
  status: v.payout.status,
  accountName: v.accountName,
  bankName: v.bankName,
  accountNumberLast4: v.accountNumberLast4,
  requestedByName: v.requestedByName,
  holdUntil: v.payout.hold_until?.toISOString() ?? null,
  holdReasons: v.payout.hold_reasons,
  approvalRequestId: v.payout.approval_request_id,
  flagReason: v.payout.flag_reason,
  failureReason: v.payout.failure_reason,
  createdAt: v.payout.created_at.toISOString(),
  completedAt: v.payout.completed_at?.toISOString() ?? null,
});

export const payoutRoutes: FastifyPluginAsyncZod = async (app) => {
  const auth = { preHandler: app.authenticate };

  app.get(
    "/banks",
    { ...auth, schema: { ...doc("Nigerian banks that can receive payouts"), response: { 200: z.array(z.object({ name: z.string(), code: z.string() })) } } },
    async () => listBanks(app.paystack),
  );

  app.post(
    "/pots/:potId/payouts/resolve-account",
    {
      ...auth,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        ...doc("Look up the name on a bank account before paying it (organiser only)"),
        params: potParams,
        body: z.strictObject({ bankCode, accountNumber }),
        response: { 200: z.object({ bankCode: z.string(), bankName: z.string(), accountNumber: z.string(), accountName: z.string() }) },
      },
    },
    async (req) => resolvePayoutAccount(app.db, app.paystack, actorOf(req), req.params.potId, req.body),
  );

  app.post(
    "/pots/:potId/payouts",
    {
      ...auth,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        ...doc("Pay money out of the pot (organiser only). Reserved at once; sent after any approval or hold."),
        params: potParams,
        body: z.strictObject({
          bankCode,
          accountNumber,
          amountKobo: z.number().int().positive(),
          narration: z.string().trim().min(1).max(100).optional(),
        }),
        response: { 201: payoutSchema },
      },
    },
    async (req, reply) => {
      const payout = await requestPayout(app.db, app.paystack, actorOf(req), req.params.potId, req.body);
      // Nothing to wait for: send it straight away. If this fails the worker picks it up.
      if (payout.status === "ready" && app.paystack) {
        await sendPayout(app.db, app.paystack, payout.id).catch((err) => req.log.error({ err }, "payout send failed; the worker will retry"));
      }
      const view = (await listPayouts(app.db, requireUser(req), req.params.potId)).find((v) => v.payout.id === payout.id)!;
      return reply.status(201).send(toPayout(view));
    },
  );

  app.get(
    "/pots/:potId/payouts",
    { ...auth, schema: { ...doc("Every payout from the pot, open to all members"), params: potParams, response: { 200: z.array(payoutSchema) } } },
    async (req) => (await listPayouts(app.db, requireUser(req), req.params.potId)).map(toPayout),
  );

  app.post(
    "/pots/:potId/payouts/:payoutId/flag",
    {
      ...auth,
      schema: {
        ...doc("Raise a concern about a payout on hold: it pauses and support looks at it"),
        params: payoutParams,
        body: z.strictObject({ reason: z.string().trim().min(3).max(500) }),
        response: { 200: ok },
      },
    },
    async (req) => {
      await flagPayout(app.db, actorOf(req), req.params.potId, req.params.payoutId, req.body.reason);
      return { ok: true as const };
    },
  );

  app.post(
    "/pots/:potId/payouts/:payoutId/cancel",
    { ...auth, schema: { ...doc("Withdraw a payout that hasn't been sent (organiser only)"), params: payoutParams, response: { 200: ok } } },
    async (req) => {
      await cancelPayout(app.db, actorOf(req), req.params.potId, req.params.payoutId);
      return { ok: true as const };
    },
  );
};
