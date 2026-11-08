import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { unauthorized } from "../errors.js";
import { syncUserFromIdentity, type User } from "../users/service.js";
import type { TokenVerifier } from "./tokens.js";

declare module "fastify" {
  interface FastifyRequest {
    user: User | null;
  }
  interface FastifyInstance {
    /** Route preHandler: verifies the bearer token and loads req.user. */
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

export function installAuth(app: FastifyInstance, verifier: TokenVerifier) {
  app.decorateRequest("user", null);
  app.decorate("authenticate", async (req: FastifyRequest) => {
    const match = req.headers.authorization?.match(BEARER);
    if (!match?.[1]) throw unauthorized();
    const identity = await verifier.verify(match[1]);
    req.user = await syncUserFromIdentity(app.db, identity);
  });
}

/** The signed-in user, for routes that ran `app.authenticate`. */
export function requireUser(req: FastifyRequest): User {
  if (!req.user) throw unauthorized();
  return req.user;
}
