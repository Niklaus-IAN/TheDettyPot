import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import { createDb, type Db } from "../src/db/index.js";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://dettypot:dettypot@localhost:5433/dettypot_test";

export interface TestApp {
  app: FastifyInstance;
  db: Db;
  config: Config;
  close: () => Promise<void>;
}

/** Builds the real app against the test database. Call close() in afterAll. */
export async function makeTestApp(overrides: Partial<NodeJS.ProcessEnv> = {}): Promise<TestApp> {
  const config = loadConfig({
    APP_ENV: "test",
    DATABASE_URL: TEST_DATABASE_URL,
    LOG_LEVEL: "silent",
    ...overrides,
  });
  const db = createDb(config.DATABASE_URL);
  const app = await buildApp({ config, db });
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
