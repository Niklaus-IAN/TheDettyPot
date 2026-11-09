import type { FastifyPluginAsync } from "fastify";
import { AppError } from "../errors.js";
import { isValidPaystackSignature } from "../payments/paystack.js";
import { processWebhookEvent, storeWebhook, type PaystackEvent } from "../payments/webhooks.js";

/** How long Paystack waits on us while we try to process the event straight away. */
const INLINE_BUDGET_MS = 5_000;

/**
 * Paystack's signed notifications. The raw body is kept so the signature can
 * be checked over exactly the bytes Paystack signed. Registered as its own
 * plugin so this body handling applies to this route only.
 */
export const webhookRoutes: FastifyPluginAsync = async (app) => {
  app.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 1024 * 1024 }, (_req, body, done) => done(null, body));

  app.post(
    "/webhooks/paystack",
    { config: { rateLimit: false }, schema: { hide: true } },
    async (req, reply) => {
      const secret = app.config.PAYSTACK_SECRET_KEY;
      if (!secret || !app.paystack) throw new AppError(503, "PAYMENTS_UNAVAILABLE", "Payments are not configured");

      const raw = req.body as Buffer;
      if (!Buffer.isBuffer(raw) || !isValidPaystackSignature(raw, req.headers["x-paystack-signature"], secret)) {
        throw new AppError(401, "INVALID_SIGNATURE", "Invalid signature");
      }
      let event: PaystackEvent;
      try {
        event = JSON.parse(raw.toString("utf8")) as PaystackEvent;
      } catch {
        throw new AppError(400, "BAD_REQUEST", "Body is not JSON");
      }
      if (typeof event?.event !== "string") throw new AppError(400, "BAD_REQUEST", "Missing event type");

      const id = await storeWebhook(app.db, event, raw);
      if (id) {
        // Try straight away so the member sees their payment quickly. If it
        // fails or takes too long, the stored event is picked up by the worker.
        const attempt = processWebhookEvent(app.db, app.paystack, id).catch((err) => {
          req.log.error({ err, eventId: id }, "webhook processing failed; the worker will retry");
        });
        await Promise.race([attempt, new Promise((resolve) => setTimeout(resolve, INLINE_BUDGET_MS).unref())]);
      }
      return reply.status(200).send({ received: true });
    },
  );
};
