import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { deleteMyAccount, exportMyData } from "../users/account.js";
import { updateProfile, type User } from "../users/service.js";

const profile = z.object({
  id: z.uuid(),
  email: z.string(),
  emailVerified: z.boolean(),
  fullName: z.string().nullable(),
  avatarEmoji: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

const toProfile = (user: User): z.infer<typeof profile> => ({
  id: user.id,
  email: user.email ?? "",
  emailVerified: user.email_verified_at !== null,
  fullName: user.full_name,
  avatarEmoji: user.avatar_emoji,
  avatarUrl: user.avatar_url,
  createdAt: user.created_at.toISOString(),
});

const profileChanges = z
  .strictObject({
    fullName: z.string().trim().min(1).max(80).optional(),
    avatarEmoji: z.string().trim().min(1).max(16).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "Nothing to update" });

export const meRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/me",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["account"],
        summary: "The signed-in user's profile (created on first sign-in)",
        security: [{ bearerAuth: [] }],
        response: { 200: profile },
      },
    },
    async (req) => toProfile(requireUser(req)),
  );

  app.patch(
    "/me",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["account"],
        summary: "Update your name or avatar",
        security: [{ bearerAuth: [] }],
        body: profileChanges,
        response: { 200: profile },
      },
    },
    async (req) => toProfile(await updateProfile(app.db, requireUser(req).id, req.body)),
  );

  app.get(
    "/me/export",
    {
      preHandler: app.authenticate,
      config: { rateLimit: { max: 5, timeWindow: "1 hour" } },
      schema: { tags: ["account"], summary: "Everything DettyPot holds about you, as JSON", security: [{ bearerAuth: [] }] },
    },
    async (req, reply) => {
      reply.header("content-disposition", 'attachment; filename="dettypot-my-data.json"');
      return exportMyData(app.db, requireUser(req));
    },
  );

  app.post(
    "/me/delete",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["account"],
        summary: "Delete your account: your details are removed; money records the law requires are kept anonymously",
        security: [{ bearerAuth: [] }],
        body: z.strictObject({ confirm: z.literal("DELETE", { message: 'Send {"confirm": "DELETE"} to confirm' }) }),
        response: { 200: z.object({ ok: z.literal(true) }) },
      },
    },
    async (req) => {
      await deleteMyAccount(app.db, { user: requireUser(req), requestId: req.id });
      return { ok: true as const };
    },
  );
};
