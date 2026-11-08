import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

// Let TEST_DATABASE_URL come from .env so each developer can point the tests at
// their own Postgres (Docker or a local install). Falls back to the Docker default.
const fileEnv = loadEnv("test", process.cwd(), "");
process.env.TEST_DATABASE_URL ??= fileEnv.TEST_DATABASE_URL;

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    // Tests share one Postgres database, so run files one at a time.
    fileParallelism: false,
    env: { APP_ENV: "test" },
  },
});
