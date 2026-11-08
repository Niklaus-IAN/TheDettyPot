import { pino } from "pino";
import { expireDueApprovals } from "./approvals/service.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/index.js";
import { LogEmailSender } from "./notifications/email.js";
import { deliverEmails, sendDeadlinePassedAlerts, sendDeadlineWarnings, sendPaymentReminders } from "./worker/tasks.js";

/**
 * The background worker: runs alongside the API (a separate process in AWS).
 * Every job is safe to run on several workers at once.
 */
const config = loadConfig();
const log = pino({
  level: config.LOG_LEVEL,
  ...(config.APP_ENV === "local" && { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } }),
});
const db = createDb(config.DATABASE_URL);
const sender = new LogEmailSender(log, config.EMAIL_FROM);

const TICK_MS = 15_000;

const jobs: [string, () => Promise<unknown>][] = [
  ["expire approvals", () => expireDueApprovals(db)],
  ["deadline passed", () => sendDeadlinePassedAlerts(db)],
  ["deadline warnings", () => sendDeadlineWarnings(db)],
  ["payment reminders", () => sendPaymentReminders(db)],
  ["email delivery", () => deliverEmails(db, sender, { webBaseUrl: config.WEB_BASE_URL })],
];

let stopping = false;
let timer: NodeJS.Timeout | undefined;
let running: Promise<void> = Promise.resolve();

async function runJobs() {
  for (const [name, job] of jobs) {
    if (stopping) return;
    try {
      const result = await job();
      log.debug({ job: name, result }, "job done");
    } catch (err) {
      // One failing job must not stop the others.
      log.error({ err, job: name }, "job failed");
    }
  }
}

function tick() {
  running = runJobs().finally(() => {
    if (!stopping) timer = setTimeout(tick, TICK_MS);
  });
}

/** Lets the current cycle finish, so no job is cut off halfway, then exits. */
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  log.info({ signal }, "worker shutting down");
  await running;
  await db.destroy();
  log.info("worker stopped");
  log.flush();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

log.info({ tickMs: TICK_MS }, "worker started");
tick();
