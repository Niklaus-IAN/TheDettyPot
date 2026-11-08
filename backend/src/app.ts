import { randomUUID } from "node:crypto";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
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
import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import { AppError, type ErrorBody } from "./errors.js";
import { healthRoutes } from "./routes/health.js";
import { meRoutes } from "./routes/me.js";

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    db: Db;
  }
}

export interface AppDeps {
  config: Config;
  db: Db;
  /** Defaults to one built from config; tests pass their own. */
  tokenVerifier?: TokenVerifier;
}

// Accept a caller-supplied request id (e.g. from a load balancer) only if it
// is a harmless token; otherwise generate one.
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

function loggerOptions(config: Config) {
  const base = {
    level: config.LOG_LEVEL,
    redact: ["req.headers.authorization", "req.headers.cookie", "req.headers['x-paystack-signature']"],
  };
  if (config.APP_ENV === "local") {
    return { ...base, transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } };
  }
  return base;
}

export async function buildApp({ config, db, tokenVerifier }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.APP_ENV === "test" ? false : loggerOptions(config),
    genReqId: (req) => {
      const incoming = req.headers["x-request-id"];
      return typeof incoming === "string" && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    },
  });

  app.decorate("config", config);
  app.decorate("db", db);

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

  installAuth(app, tokenVerifier ?? tokenVerifierFromConfig(config));

  await app.register(healthRoutes);
  await app.register(meRoutes);

  return app;
}
