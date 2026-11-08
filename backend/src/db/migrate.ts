import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "kysely";
import { Migrator, type Migration, type MigrationProvider } from "kysely/migration";
import { loadConfig } from "../config.js";
import { createDb, type Db } from "./index.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

/**
 * Migrations are plain, forward-only .sql files named like 0001_description.sql.
 * They run in filename order inside a transaction and are recorded in the
 * kysely_migration table. Fix mistakes with a new migration, never by
 * editing one that has already run.
 */
class SqlFileProvider implements MigrationProvider {
  constructor(private readonly dir: string) {}

  async getMigrations(): Promise<Record<string, Migration>> {
    const files = (await readdir(this.dir)).filter((f) => f.endsWith(".sql")).sort();
    const migrations: Record<string, Migration> = {};
    for (const file of files) {
      const contents = await readFile(path.join(this.dir, file), "utf8");
      migrations[file.replace(/\.sql$/, "")] = {
        async up(db) {
          await sql.raw(contents).execute(db);
        },
      };
    }
    return migrations;
  }
}

export async function runMigrations(db: Db, dir: string = MIGRATIONS_DIR) {
  const migrator = new Migrator({ db, provider: new SqlFileProvider(dir) });
  const { error, results } = await migrator.migrateToLatest();
  if (error) throw error;
  return results ?? [];
}

// Run directly: `npm run db:migrate`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = createDb(loadConfig().DATABASE_URL);
  try {
    const results = await runMigrations(db);
    if (results.length === 0) console.log("Database is up to date.");
    for (const r of results) console.log(`${r.status.toLowerCase()}: ${r.migrationName}`);
  } catch (err) {
    console.error("Migration failed:", err);
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}
