import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { buildApp } from "../src/app.js";
import { createTokenVerifier } from "../src/auth/tokens.js";
import type { PaystackClient } from "../src/payments/paystack.js";
import type { PlacesClient } from "../src/places/client.js";
import type { ClaudeClient } from "../src/planner/claude.js";
import { loadConfig, type Config } from "../src/config.js";
import { createDb, type Db } from "../src/db/index.js";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://dettypot:dettypot@localhost:5433/dettypot_test";

export const TEST_ISSUER = "https://auth.test.dettypot";
export const TEST_AUDIENCE = "dettypot-api-test";

// One signing key per test run, standing in for the identity provider's.
const issuerKeys = await generateKeyPair("ES256");
const ISSUER_KID = "test-key";
const testJwks = { keys: [{ ...(await exportJWK(issuerKeys.publicKey)), kid: ISSUER_KID, alg: "ES256" }] };

export interface TokenOptions {
  subject?: string;
  email?: string | null;
  emailVerified?: boolean;
  name?: string;
  issuer?: string;
  audience?: string;
  expiresIn?: string;
  /** Sign with a different key, as an attacker would. */
  key?: CryptoKey;
}

/** A sign-in token as the identity provider would issue it. */
export async function signToken(opts: TokenOptions = {}): Promise<string> {
  const subject = opts.subject ?? `test|${randomUUID()}`;
  const claims: Record<string, unknown> = { email_verified: opts.emailVerified ?? true };
  const email = opts.email === undefined ? `${subject.replace(/\W/g, "")}@example.com` : opts.email;
  if (email !== null) claims.email = email;
  if (opts.name) claims.name = opts.name;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", kid: ISSUER_KID })
    .setSubject(subject)
    .setIssuer(opts.issuer ?? TEST_ISSUER)
    .setAudience(opts.audience ?? TEST_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? "1h")
    .sign(opts.key ?? issuerKeys.privateKey);
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export interface TestApp {
  app: FastifyInstance;
  db: Db;
  config: Config;
  close: () => Promise<void>;
}

/** Builds the real app against the test database. Call close() in afterAll. */
export async function makeTestApp(
  overrides: Partial<NodeJS.ProcessEnv> = {},
  deps: { paystack?: PaystackClient | null; places?: PlacesClient | null; claude?: ClaudeClient | null } = {},
): Promise<TestApp> {
  const config = loadConfig({
    APP_ENV: "test",
    DATABASE_URL: TEST_DATABASE_URL,
    LOG_LEVEL: "silent",
    AUTH_ISSUER: TEST_ISSUER,
    AUTH_AUDIENCE: TEST_AUDIENCE,
    // Tests send many requests from one address; the limiter has its own tests.
    RATE_LIMIT_ENABLED: "false",
    ...overrides,
  });
  const db = createDb(config.DATABASE_URL);
  const tokenVerifier = createTokenVerifier({
    issuer: config.AUTH_ISSUER,
    audience: config.AUTH_AUDIENCE,
    keys: createLocalJWKSet(testJwks),
  });
  const app = await buildApp({ config, db, tokenVerifier, paystack: deps.paystack ?? null, places: deps.places ?? null, claude: deps.claude ?? null });
  await app.ready();
  return {
    app,
    db,
    config,
    close: async () => {
      await app.close();
      await db.destroy();
    },
  };
}
