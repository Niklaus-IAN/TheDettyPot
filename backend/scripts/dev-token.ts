/**
 * Local development only: mints a sign-in token so you can call the API
 * without a real identity provider.
 *
 *   npm run dev:token -- ada@example.com
 *   npm run dev:token -- ada@example.com --name "Ada Obi" --unverified
 *
 * The first run creates a signing key in .dev-auth/ (git-ignored); restart
 * `npm run dev` after that so the API picks the key up. The API only trusts
 * this key when AUTH_DEV_JWKS_FILE is set, which config refuses outside local.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { exportJWK, generateKeyPair, importJWK, SignJWT, type JWK } from "jose";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { name: { type: "string" }, unverified: { type: "boolean", default: false } },
});

const email = positionals[0];
const { APP_ENV = "local", AUTH_ISSUER, AUTH_AUDIENCE, AUTH_DEV_JWKS_FILE } = process.env;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!email || !email.includes("@")) fail('Usage: npm run dev:token -- you@example.com [--name "Your Name"] [--unverified]');
if (APP_ENV !== "local") fail(`dev:token only runs with APP_ENV=local (current: ${APP_ENV})`);
if (!AUTH_ISSUER || !AUTH_AUDIENCE || !AUTH_DEV_JWKS_FILE) {
  fail("Set AUTH_ISSUER, AUTH_AUDIENCE and AUTH_DEV_JWKS_FILE in .env (see .env.example)");
}

const jwksFile = AUTH_DEV_JWKS_FILE;
const privateKeyFile = path.join(path.dirname(jwksFile), "private-key.json");

let privateJwk: JWK;
if (existsSync(privateKeyFile)) {
  privateJwk = JSON.parse(readFileSync(privateKeyFile, "utf8")) as JWK;
} else {
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const kid = randomUUID();
  privateJwk = { ...(await exportJWK(privateKey)), kid, alg: "ES256" };
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" };
  mkdirSync(path.dirname(jwksFile), { recursive: true });
  writeFileSync(privateKeyFile, JSON.stringify(privateJwk, null, 2), { mode: 0o600 });
  writeFileSync(jwksFile, JSON.stringify({ keys: [publicJwk] }, null, 2));
  console.error(`Created a local signing key in ${path.dirname(jwksFile)}/. Restart \`npm run dev\` to use it.\n`);
}

const token = await new SignJWT({
  email,
  email_verified: !values.unverified,
  ...(values.name && { name: values.name }),
})
  .setProtectedHeader({ alg: "ES256", kid: privateJwk.kid })
  .setSubject(`local|${email.toLowerCase()}`)
  .setIssuer(AUTH_ISSUER)
  .setAudience(AUTH_AUDIENCE)
  .setIssuedAt()
  .setExpirationTime("12h")
  .sign(await importJWK(privateJwk, "ES256"));

console.log(token);
