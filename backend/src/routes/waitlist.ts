import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

const body = z
  .strictObject({
    email: z.email().max(254).optional(),
    phone: z.string().regex(/^\+[1-9][0-9]{7,14}$/, "Use international format, e.g. +2348031234567").optional(),
    source: z.string().trim().max(100).optional(),
    referrer: z.string().trim().max(500).optional(),
  })
  .refine((b) => b.email || b.phone, { message: "Give an email address or phone number" });

/** FR-MKT-01: the website's waitlist form. */
export const waitlistRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    "/waitlist",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: { tags: ["waitlist"], summary: "Join the waitlist (no sign-in needed)", body, response: { 202: z.object({ ok: z.literal(true) }) } },
    },
    async (req, reply) => {
      // Signing up twice is fine and looks the same, so the form can't be used
      // to find out who is already on the list.
      await app.db
        .insertInto("waitlist_signups")
        .values({
          email: req.body.email?.toLowerCase() ?? null,
          phone: req.body.phone ?? null,
          source: req.body.source ?? null,
          referrer: req.body.referrer ?? null,
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
      return reply.status(202).send({ ok: true as const });
    },
  );
};
