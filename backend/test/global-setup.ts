import { sql } from "kysely";
import { createDb } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrate.js";
import { TEST_DATABASE_URL } from "./helpers.js";

/**
 * Runs once before the whole suite: wipe the test database and migrate it from
 * scratch, so every run starts clean and also proves the migrations apply to an
 * empty database. Append-only tables cannot be emptied any other way.
 */
export default async function setup() {
  const dbName = new URL(TEST_DATABASE_URL).pathname.slice(1);
  if (!dbName.endsWith("_test")) {
    throw new Error(
      `Refusing to reset "${dbName}": the test database name must end with "_test" so a dev or prod database is never wiped.`,
    );
  }

  const db = createDb(TEST_DATABASE_URL);
  try {
    await sql`drop schema if exists public cascade`.execute(db);
    await sql`create schema public`.execute(db);
    await runMigrations(db);
  } catch (err) {
    throw new Error(
      `Could not prepare the test database at ${TEST_DATABASE_URL.replace(/:[^:@/]*@/, ":***@")}.\n` +
        `Is Postgres running? Start it with: npm run db:up\n\nCause: ${(err as Error).message}`,
      { cause: err },
    );
  } finally {
    await db.destroy();
  }
}
