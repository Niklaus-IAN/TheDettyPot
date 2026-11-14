import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { installAuth } from "./auth/plugin.js";
import { tokenVerifierFromConfig, type TokenVerifier } from "./auth/tokens.js";
import { HttpPaystackClient, type PaystackClient } from "./payments/paystack.js";
import { HttpPlacesClient, type PlacesClient } from "./places/client.js";
import { AnthropicClaudeClient, type ClaudeClient } from "./planner/claude.js";
import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import { AppError, type ErrorBody } from "./errors.js";
import { healthRoutes } from "./routes/health.js";
import { meRoutes } from "./routes/me.js";
import { adminRoutes } from "./routes/admin.js";
import { memberRoutes } from "./routes/members.js";
import { notificationRoutes } from "./routes/notifications.js";
import { paymentRoutes } from "./routes/payments.js";
import { payoutRoutes } from "./routes/payouts.js";
import { potRoutes } from "./routes/pots.js";
import { refundRoutes } from "./routes/refunds.js";
import { plannerRoutes } from "./routes/planner.js";
import { venueRoutes } from "./routes/venues.js";
import { waitlistRoutes } from "./routes/waitlist.js";
import { webhookRoutes } from "./routes/webhooks.js";

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    db: Db;
    /** null when Paystack isn't configured; payment endpoints then answer 503. */
    paystack: PaystackClient | null;
    /** null when Google Maps isn't configured; venue search then answers 503. */
    places: PlacesClient | null;
    /** null when no Anthropic key is configured; the planner then answers 503. */
    claude: ClaudeClient | null;
  }
}

export interface AppDeps {
  config: Config;
  db: Db;
  /** Defaults to one built from config; tests pass their own. */
  tokenVerifier?: TokenVerifier;
  /** Defaults to the real Paystack API when a secret key is configured; tests pass a fake. */
  paystack?: PaystackClient | null;
  places?: PlacesClient | null;
  claude?: ClaudeClient | null;
}

// Accept a caller-supplied request id (e.g. from a load balancer) only if it
// is a harmless token; otherwise generate one.
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * The caller's address. Behind API Gateway, from the header it sets
 * (CLIENT_IP_HEADER), since the connection itself comes from API Gateway;
 * otherwise from the connection, or X-Forwarded-For if a proxy is trusted.
 */
export function clientIp(req: FastifyRequest, header: string | undefined): string {
  if (header) {
    const value = req.headers[header];
    if (typeof value === "string" && isIP(value.trim())) return value.trim();
  }
  return req.ip;
}

function loggerOptions(config: Config) {
  const base = {
    level: config.LOG_LEVEL,
    redact: ["req.headers.authorization", "req.headers.cookie", "req.headers['x-paystack-signature']"],
    serializers: {
      req: (req: FastifyRequest) => ({
        method: req.method,
        url: req.url,
        host: req.host,
        remoteAddress: clientIp(req, config.CLIENT_IP_HEADER),
      }),
    },
  };
  if (config.APP_ENV === "local") {
    return { ...base, transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } };
  }
  return base;
}

export async function buildApp({ config, db, tokenVerifier, paystack, places, claude }: AppDeps): Promise<FastifyInstance> {
  const hops = config.TRUST_PROXY_HOPS;
  const app = Fastify({
    logger: config.APP_ENV === "test" ? false : loggerOptions(config),
    // With hops set, only the last `hops` forwarders are trusted (hop 0 is the one that connected to us).
    trustProxy: hops === undefined ? config.TRUST_PROXY : (_address: string, hop: number) => hop < hops,
    genReqId: (req) => {
      const incoming = req.headers["x-request-id"];
      return typeof incoming === "string" && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    },
  });

  app.decorate("config", config);
  app.decorate("db", db);
  app.decorate(
    "paystack",
    paystack !== undefined
      ? paystack
      : config.PAYSTACK_SECRET_KEY
        ? new HttpPaystackClient(config.PAYSTACK_SECRET_KEY, config.PAYSTACK_BASE_URL)
        : null,
  );
  app.decorate(
    "places",
    places !== undefined ? places : config.GOOGLE_MAPS_API_KEY ? new HttpPlacesClient(config.GOOGLE_MAPS_API_KEY) : null,
  );
  app.decorate("claude", claude !== undefined ? claude : config.ANTHROPIC_API_KEY ? new AnthropicClaudeClient(config.ANTHROPIC_API_KEY) : null);

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });

  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    const send = (status: number, code: string, message: string, details?: unknown) => {
      const body: ErrorBody = { error: { code, message, requestId: req.id, ...(details === undefined ? {} : { details }) } };
      return reply.status(status).send(body);
    };

    if (hasZodFastifySchemaValidationErrors(err)) {
      return send(400, "VALIDATION_ERROR", "The request is invalid", err.validation);
    }
    if (err instanceof AppError) {
      if (err.statusCode === 401) reply.header("www-authenticate", "Bearer");
      return send(err.statusCode, err.code, err.message, err.details);
    }
    // Errors Fastify raises itself for bad input (malformed JSON, body too large, ...).
    const status = (err as FastifyError).statusCode;
    if (status && status >= 400 && status < 500) {
      return send(status, "BAD_REQUEST", err.message);
    }

    req.log.error({ err }, "unhandled error");
    return send(500, "INTERNAL_ERROR", "Something went wrong");
  });

  app.setNotFoundHandler((req, reply) => {
    const body: ErrorBody = { error: { code: "NOT_FOUND", message: "Route not found", requestId: req.id } };
    return reply.status(404).send(body);
  });

  if (config.ENABLE_DOCS) {
    await app.register(swagger, {
      openapi: {
        info: { title: "DettyPot API", version: "0.1.0" },
        components: {
          securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
        },
      },
      transform: jsonSchemaTransform,
    });
    await app.register(swaggerUi, { routePrefix: "/docs" });
  }

  // Per-IP limits (NFR-03): a generous default, tighter on public and
  // sensitive routes. The store is per process; in AWS, API Gateway also caps
  // total traffic in front of this.
  if (config.RATE_LIMIT_ENABLED) {
    await app.register(rateLimit, {
      max: 300,
      timeWindow: "1 minute",
      keyGenerator: (req) => clientIp(req, config.CLIENT_IP_HEADER),
      errorResponseBuilder: (_req, ctx) =>
        new AppError(429, "RATE_LIMITED", `Too many requests. Try again in ${ctx.after}.`),
    });
  }

  installAuth(app, tokenVerifier ?? tokenVerifierFromConfig(config));

  // CORS preflights. API Gateway adds the CORS headers (only for the website's
  // origins) but passes the OPTIONS request on; browsers need a 2xx answer.
  app.options("/*", { schema: { hide: true } }, async (_req, reply) => reply.code(204).send());

  await app.register(healthRoutes);
  await app.register(meRoutes);
  await app.register(potRoutes);
  await app.register(memberRoutes);
  await app.register(paymentRoutes);
  await app.register(payoutRoutes);
  await app.register(refundRoutes);
  await app.register(venueRoutes);
  await app.register(plannerRoutes);
  await app.register(notificationRoutes);
  await app.register(waitlistRoutes);
  await app.register(adminRoutes);
  await app.register(webhookRoutes);

  return app;
}
