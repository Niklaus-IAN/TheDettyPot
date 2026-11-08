import { sql } from "kysely";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

const DB_CHECK_TIMEOUT_MS = 2000;

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  // Liveness: the process is up. Used by the platform to decide whether to restart it.
  app.get(
    "/health",
    {
      schema: {
        tags: ["system"],
        summary: "Liveness check",
        response: { 200: z.object({ status: z.literal("ok") }) },
      },
    },
    async () => ({ status: "ok" as const }),
  );

  // Readiness: the process can do useful work. Used to decide whether to send it traffic.
  app.get(
    "/health/ready",
    {
      schema: {
        tags: ["system"],
        summary: "Readiness check (includes the database)",
        response: {
          200: z.object({ status: z.literal("ok"), database: z.literal("up") }),
          503: z.object({ status: z.literal("unavailable"), database: z.literal("down") }),
        },
      },
    },
    async (req, reply) => {
      try {
        await Promise.race([
          sql`select 1`.execute(app.db),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("database check timed out")), DB_CHECK_TIMEOUT_MS).unref(),
          ),
        ]);
        return { status: "ok" as const, database: "up" as const };
      } catch (err) {
        req.log.error({ err }, "readiness check failed");
        return reply.status(503).send({ status: "unavailable" as const, database: "down" as const });
      }
    },
  );
};
