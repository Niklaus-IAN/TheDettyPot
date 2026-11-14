#!/usr/bin/env node
/**
 * Copies the API keys from backend/.env into an environment's Secrets Manager
 * secret (dettypot/<env>/app), creating it the first time. Values are never
 * printed, and they reach AWS through a private temporary file rather than the
 * command line.
 *
 *   node scripts/put-keys.mjs dev --profile dettypot
 *
 * The running services pick new values up when they next start.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEYS = ["PAYSTACK_SECRET_KEY", "GOOGLE_MAPS_API_KEY", "ANTHROPIC_API_KEY"];
const REGION = "eu-west-1";

const [envName, ...rest] = process.argv.slice(2);
const profileAt = rest.indexOf("--profile");
const profile = profileAt >= 0 ? rest[profileAt + 1] : undefined;
if (!["dev", "staging", "prod"].includes(envName ?? "")) {
  console.error("Usage: node scripts/put-keys.mjs <dev|staging|prod> [--profile <aws profile>]");
  process.exit(1);
}

const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../backend/.env");
const values = {};
for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && KEYS.includes(m[1])) values[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
}
for (const key of KEYS) {
  if (!values[key]) console.warn(`${key} isn't in backend/.env: that feature stays off in ${envName}`);
}
if (values.PAYSTACK_SECRET_KEY?.startsWith("sk_live_") && envName !== "prod") {
  console.error(`Refusing: a live Paystack key only belongs in prod, not ${envName}`);
  process.exit(1);
}

const name = `dettypot/${envName}/app`;
const aws = (args) => execFileSync("aws", [...args, "--region", REGION, ...(profile ? ["--profile", profile] : [])], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const dir = mkdtempSync(path.join(tmpdir(), "dettypot-keys-"));
const file = path.join(dir, "secret.json");
try {
  writeFileSync(file, JSON.stringify(values), { mode: 0o600 });
  let exists = true;
  try {
    aws(["secretsmanager", "describe-secret", "--secret-id", name]);
  } catch (err) {
    if (!String(err.stderr).includes("ResourceNotFoundException")) throw err;
    exists = false;
  }
  if (exists) aws(["secretsmanager", "put-secret-value", "--secret-id", name, "--secret-string", `file://${file}`]);
  else aws(["secretsmanager", "create-secret", "--name", name, "--description", `DettyPot ${envName}: Paystack, Google and Anthropic keys`, "--secret-string", `file://${file}`]);
  console.log(`${exists ? "Updated" : "Created"} ${name} with: ${Object.keys(values).join(", ") || "nothing"}`);
} catch (err) {
  // The AWS CLI's message names the problem; it never contains the values.
  console.error(String(err.stderr || err.message).trim());
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
