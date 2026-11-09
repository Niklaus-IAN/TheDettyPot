import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { listInbox, markRead } from "../notifications/service.js";

const item = z.object({
  id: z.uuid(),
  type: z.string(),
  potId: z.uuid().nullable(),
  title: z.string(),
  body: z.string(),
  link: z.string().nullable(),
  read: z.boolean(),
  createdAt: z.iso.datetime(),
});

export const notificationRoutes: FastifyPluginAsyncZod = async (app) => {
  const doc = (summary: string) => ({ tags: ["notifications"], summary, security: [{ bearerAuth: [] }] });

  app.get(
    "/notifications",
    {
      preHandler: app.authenticate,
      schema: {
        ...doc("Your notifications, newest first"),
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(50).default(20),
          before: z.iso.datetime({ offset: true }).optional(),
        }),
        response: { 200: z.object({ items: z.array(item), unreadCount: z.number().int() }) },
      },
    },
    async (req) => {
      const { items, unreadCount } = await listInbox(app.db, requireUser(req).id, {
        limit: req.query.limit,
        before: req.query.before ? new Date(req.query.before) : undefined,
        webBaseUrl: app.config.WEB_BASE_URL,
      });
      return {
        unreadCount,
        items: items.map(({ row, rendered }) => ({
          id: row.id,
          type: row.type,
          potId: row.pot_id,
          ...rendered,
          read: row.read_at !== null,
          createdAt: row.created_at.toISOString(),
        })),
      };
    },
  );

  app.post(
    "/notifications/read",
    {
      preHandler: app.authenticate,
      schema: {
        ...doc("Mark notifications as read (all of them when no ids are given)"),
        body: z.strictObject({ ids: z.array(z.uuid()).max(100).optional() }).optional(),
        response: { 200: z.object({ unreadCount: z.number().int() }) },
      },
    },
    async (req) => ({ unreadCount: await markRead(app.db, requireUser(req).id, req.body?.ids) }),
  );
};
