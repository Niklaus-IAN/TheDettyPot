/**
 * Gives (or takes away) access to the internal admin tools. There is
 * deliberately no API for this: it needs direct access to the database.
 *
 *   npm run admin:grant -- support@example.com
 *   npm run admin:grant -- support@example.com --revoke
 */
import { parseArgs } from "node:util";
import { recordAudit } from "../src/audit.js";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/index.js";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { revoke: { type: "boolean", default: false } } });
const email = positionals[0];
if (!email) {
  console.error("Usage: npm run admin:grant -- someone@example.com [--revoke]");
  process.exit(1);
}

const db = createDb(loadConfig().DATABASE_URL);
try {
  const user = await db
    .updateTable("users")
    .set({ is_admin: !values.revoke })
    .where("email", "=", email)
    .where("deleted_at", "is", null)
    .returning(["id", "email"])
    .executeTakeFirst();
  if (!user) {
    console.error(`No account for ${email}. They need to sign in once first.`);
    process.exitCode = 1;
  } else {
    await recordAudit(db, {
      actorUserId: null,
      action: values.revoke ? "admin.access_revoked" : "admin.access_granted",
      subjectType: "user",
      subjectId: user.id,
      metadata: { via: "script" },
    });
    console.log(`${user.email} ${values.revoke ? "is no longer" : "is now"} an admin.`);
  }
} finally {
  await db.destroy();
}
