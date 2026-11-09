import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { potLedger } from "../ledger/view.js";
import { PAYMENT_METHODS } from "../payments/fees.js";
import { getPayment, myPayments, paymentOptions, startPayment, type PaymentRow } from "../payments/service.js";
import type { Actor } from "../pots/service.js";

const actorOf = (req: FastifyRequest): Actor => ({ user: requireUser(req), requestId: req.id });
const doc = (summary: string) => ({ tags: ["payments"], summary, security: [{ bearerAuth: [] }] });
const potParams = z.object({ potId: z.string().max(64) });
const method = z.enum(PAYMENT_METHODS as [string, ...string[]]);

const quoteSchema = z.object({
  method,
  shareKobo: z.number().int(),
  feeKobo: z.number().int(),
  totalKobo: z.number().int(),
  feeRefundable: z.boolean(),
});

const paymentSchema = z.object({
  id: z.uuid(),
  reference: z.string(),
  method,
  status: z.enum(["pending", "succeeded", "failed", "expired", "review"]),
  shareKobo: z.number().int(),
  feeKobo: z.number().int(),
  totalKobo: z.number().int(),
  feeRefundable: z.boolean(),
  paidAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});

const toPayment = (p: PaymentRow): z.infer<typeof paymentSchema> => ({
  id: p.id,
  reference: p.reference,
  method: p.method,
  status: p.status as z.infer<typeof paymentSchema>["status"],
  shareKobo: p.share_kobo,
  feeKobo: p.fee_kobo,
  totalKobo: p.total_kobo,
  feeRefundable: p.fee_refundable,
  paidAt: p.paid_at?.toISOString() ?? null,
  expiresAt: p.expires_at.toISOString(),
  createdAt: p.created_at.toISOString(),
});

export const paymentRoutes: FastifyPluginAsyncZod = async (app) => {
  const auth = { preHandler: app.authenticate };

  app.get(
    "/pots/:potId/payments/options",
    {
      ...auth,
      schema: {
        ...doc("What you owe, the minimum you can pay, and share + fee = total for each method"),
        params: potParams,
        querystring: z.object({ amountKobo: z.coerce.number().int().positive().max(10_000_000_000).optional() }),
        response: {
          200: z.object({
            owedKobo: z.number().int(),
            paidKobo: z.number().int(),
            minimumKobo: z.number().int(),
            quotes: z.array(quoteSchema),
          }),
        },
      },
    },
    async (req) => {
      const o = await paymentOptions(app.db, requireUser(req), req.params.potId, req.query.amountKobo);
      return { ...o, quotes: o.quotes.map((q) => ({ method: q.method, shareKobo: q.shareKobo, feeKobo: q.feeKobo, totalKobo: q.totalKobo, feeRefundable: q.feeRefundable })) };
    },
  );

  app.post(
    "/pots/:potId/payments",
    {
      ...auth,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        ...doc("Start a payment. Send the member to checkoutUrl (or open Paystack with accessCode)."),
        params: potParams,
        body: z.strictObject({ amountKobo: z.number().int().positive(), method }),
        response: { 201: paymentSchema.extend({ checkoutUrl: z.string(), accessCode: z.string() }) },
      },
    },
    async (req, reply) => {
      const started = await startPayment(
        app.db,
        app.paystack,
        actorOf(req),
        req.params.potId,
        { amountKobo: req.body.amountKobo, method: req.body.method as "card" | "bank_transfer" },
        app.config.WEB_BASE_URL,
      );
      return reply.status(201).send({ ...toPayment(started.payment), checkoutUrl: started.checkoutUrl, accessCode: started.accessCode });
    },
  );

  app.get(
    "/pots/:potId/payments/mine",
    { ...auth, schema: { ...doc("Your payments into this pot"), params: potParams, response: { 200: z.array(paymentSchema) } } },
    async (req) => (await myPayments(app.db, requireUser(req), req.params.potId)).map(toPayment),
  );

  app.get(
    "/pots/:potId/payments/:paymentId",
    {
      ...auth,
      schema: { ...doc("One payment's status (yours, or anyone's if you organise)"), params: potParams.extend({ paymentId: z.uuid() }), response: { 200: paymentSchema } },
    },
    async (req) => toPayment(await getPayment(app.db, requireUser(req), req.params.potId, req.params.paymentId)),
  );

  app.get(
    "/pots/:potId/ledger",
    {
      ...auth,
      schema: {
        ...doc("Every movement of the pot's money, in plain language"),
        params: potParams,
        response: {
          200: z.object({
            availableKobo: z.number().int(),
            reservedKobo: z.number().int(),
            raisedKobo: z.number().int(),
            refundedKobo: z.number().int(),
            paidOutKobo: z.number().int(),
            inProgressKobo: z.number().int(),
            lines: z.array(
              z.object({
                id: z.uuid(),
                kind: z.string(),
                description: z.string(),
                memberUserId: z.uuid().nullable(),
                memberName: z.string().nullable(),
                potAmountKobo: z.number().int(),
                processorFeeKobo: z.number().int(),
                platformFeeKobo: z.number().int(),
                createdAt: z.iso.datetime(),
              }),
            ),
          }),
        },
      },
    },
    async (req) => {
      const l = await potLedger(app.db, requireUser(req), req.params.potId);
      return { ...l, lines: l.lines.map((line) => ({ ...line, createdAt: line.createdAt.toISOString() })) };
    },
  );
};
