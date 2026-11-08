import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { DB } from "./types.js";

/** Table types, generated from the live schema by `npm run db:types`. */
export type Database = DB;
export type Db = Kysely<Database>;

// Money is stored as bigint kobo. Read it as a JS number, which is exact up to
// Number.MAX_SAFE_INTEGER kobo (about ₦90 trillion). Fail loudly beyond that
// rather than silently losing precision.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`bigint ${value} is too large to read safely`);
  return n;
});

// Calendar dates (e.g. an outing date) stay as "YYYY-MM-DD" strings. Turning
// them into JS Dates would shift them by the server's timezone.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

export function createDb(connectionString: string): Db {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: 10 }),
    }),
  });
}
