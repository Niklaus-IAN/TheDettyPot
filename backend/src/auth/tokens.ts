import { existsSync, readFileSync } from "node:fs";
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from "jose";
import type { Config } from "../config.js";
import { AppError } from "../errors.js";

/** Who the identity provider says the caller is. */
export interface Identity {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

export interface TokenVerifier {
  verify(token: string): Promise<Identity>;
}

// Asymmetric algorithms only: the API never holds a secret that could mint tokens.
const ALGORITHMS = ["RS256", "ES256"];
const CLOCK_TOLERANCE_SECONDS = 30;

export function createTokenVerifier(opts: { issuer: string; audience: string; keys: JWTVerifyGetKey }): TokenVerifier {
  return {
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, opts.keys, {
          issuer: opts.issuer,
          audience: opts.audience,
          algorithms: ALGORITHMS,
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
          requiredClaims: ["sub", "exp"],
        });
        return {
          subject: payload.sub as string,
          email: typeof payload.email === "string" ? payload.email : null,
          // Some providers send the flag as the string "true".
          emailVerified: payload.email_verified === true || payload.email_verified === "true",
          name: typeof payload.name === "string" ? payload.name : null,
        };
      } catch (err) {
        if (err instanceof joseErrors.JWTExpired) {
          throw new AppError(401, "TOKEN_EXPIRED", "Your session has expired. Sign in again.");
        }
        throw new AppError(401, "INVALID_TOKEN", "Invalid sign-in token");
      }
    },
  };
}

/** Builds the verifier the running app uses, from configuration. */
export function tokenVerifierFromConfig(config: Config): TokenVerifier {
  let keys: JWTVerifyGetKey;
  if (config.AUTH_DEV_JWKS_FILE) {
    if (!existsSync(config.AUTH_DEV_JWKS_FILE)) {
      throw new Error(`No local sign-in keys at ${config.AUTH_DEV_JWKS_FILE}. Create them with: npm run dev:token -- you@example.com`);
    }
    const jwks = JSON.parse(readFileSync(config.AUTH_DEV_JWKS_FILE, "utf8")) as JSONWebKeySet;
    keys = createLocalJWKSet(jwks);
  } else {
    const url = config.AUTH_JWKS_URL ?? `${config.AUTH_ISSUER.replace(/\/$/, "")}/.well-known/jwks.json`;
    keys = createRemoteJWKSet(new URL(url));
  }
  return createTokenVerifier({ issuer: config.AUTH_ISSUER, audience: config.AUTH_AUDIENCE, keys });
}
