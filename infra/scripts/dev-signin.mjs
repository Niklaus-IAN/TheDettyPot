#!/usr/bin/env node
/**
 * Signs you in to the dev environment and prints a token for the API docs page
 * (<ApiUrl>/docs → Authorize). Creates your account first if you need one:
 * Cognito emails you a code. Needs the AWS CLI, but not an AWS login: these
 * are the same public sign-in calls the app makes.
 *
 *   node infra/scripts/dev-signin.mjs
 *
 * Tokens last an hour; run it again for a new one.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";

// From the DettyPot-dev stack's outputs (WebClientId, ApiUrl). Not secrets.
const CLIENT_ID = process.env.DEV_CLIENT_ID ?? "2q5ne8pfmlmh16nnb65eiagui";
const API_URL = process.env.DEV_API_URL ?? "https://li5qj4kuaa.execute-api.eu-west-1.amazonaws.com";
const REGION = "eu-west-1";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
const lines = rl[Symbol.asyncIterator]();
// While a password is typed, keypresses aren't echoed.
let muted = false;
const echo = rl._writeToOutput.bind(rl);
rl._writeToOutput = (s) => {
  if (!muted) echo(s);
};
async function ask(question, { hidden = false } = {}) {
  process.stdout.write(question);
  muted = hidden;
  const { value } = await lines.next();
  muted = false;
  if (hidden) process.stdout.write("\n");
  return (value ?? "").trim();
}
const askHidden = (question) => ask(question, { hidden: true });

/** Calls Cognito through the AWS CLI. Input goes through a private temp file, so the password never appears in a process list. */
function cognito(command, input) {
  const dir = mkdtempSync(path.join(tmpdir(), "dettypot-signin-"));
  const file = path.join(dir, "input.json");
  try {
    writeFileSync(file, JSON.stringify(input), { mode: 0o600 });
    const out = execFileSync("aws", ["cognito-idp", command, "--cli-input-json", `file://${file}`, "--region", REGION, "--no-sign-request", "--output", "json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out ? JSON.parse(out) : {};
  } catch (err) {
    const message = String(err.stderr || err.message);
    const code = message.match(/\((\w+Exception)\)/)?.[1] ?? "Error";
    const e = new Error(message.replace(/^[\s\S]*?when calling the \w+ operation: /, "").trim());
    e.code = code;
    throw e;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const signIn = (email, password) =>
  cognito("initiate-auth", { ClientId: CLIENT_ID, AuthFlow: "USER_PASSWORD_AUTH", AuthParameters: { USERNAME: email, PASSWORD: password } }).AuthenticationResult.IdToken;

async function confirm(email) {
  const code = await ask("Code from the email: ");
  cognito("confirm-sign-up", { ClientId: CLIENT_ID, Username: email, ConfirmationCode: code });
}

try {
  const isNew = /^n/i.test(await ask("Do you already have a DettyPot dev account? (y/n): "));
  const email = await ask("Email: ");
  let password;
  if (isNew) {
    const name = await ask("Your name: ");
    password = await askHidden("Choose a password (at least 10 characters): ");
    cognito("sign-up", { ClientId: CLIENT_ID, Username: email, Password: password, UserAttributes: [{ Name: "email", Value: email }, { Name: "name", Value: name }] });
    console.log(`We've emailed a code to ${email} (check spam too).`);
    await confirm(email);
  } else {
    password = await askHidden("Password: ");
  }

  let token;
  try {
    token = signIn(email, password);
  } catch (err) {
    if (err.code !== "UserNotConfirmedException") throw err;
    cognito("resend-confirmation-code", { ClientId: CLIENT_ID, Username: email });
    console.log(`Your email isn't confirmed yet. We've sent a new code to ${email}.`);
    await confirm(email);
    token = signIn(email, password);
  }

  console.log(`\nSigned in. Your token (valid for an hour):\n\n${token}\n`);
  console.log(`Open ${API_URL}/docs, click Authorize, paste the token, then try GET /me.`);
} catch (err) {
  console.error(`\nCouldn't sign in: ${err.message}`);
  process.exitCode = 1;
} finally {
  rl.close();
}
