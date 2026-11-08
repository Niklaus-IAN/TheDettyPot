import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const valid = { DATABASE_URL: "postgres://u:p@localhost:5432/db" };

describe("loadConfig", () => {
  it("applies defaults", () => {
    const config = loadConfig(valid);
    expect(config.PORT).toBe(3000);
    expect(config.APP_ENV).toBe("local");
    expect(config.ENABLE_DOCS).toBe(false);
  });

  it("accepts every deployment environment", () => {
    for (const APP_ENV of ["local", "test", "dev", "staging", "prod"]) {
      expect(loadConfig({ ...valid, APP_ENV }).APP_ENV).toBe(APP_ENV);
    }
  });

  it("rejects an unknown environment", () => {
    expect(() => loadConfig({ ...valid, APP_ENV: "production" })).toThrow(/APP_ENV/);
  });

  it("refuses to expose API docs in prod", () => {
    expect(() => loadConfig({ ...valid, APP_ENV: "prod", ENABLE_DOCS: "true" })).toThrow(/ENABLE_DOCS/);
    expect(loadConfig({ ...valid, APP_ENV: "staging", ENABLE_DOCS: "true" }).ENABLE_DOCS).toBe(true);
  });

  it("parses typed values from strings", () => {
    const config = loadConfig({ ...valid, PORT: "8080", ENABLE_DOCS: "true" });
    expect(config.PORT).toBe(8080);
    expect(config.ENABLE_DOCS).toBe(true);
  });

  it("rejects a missing database url", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it("never echoes secret values in the error", () => {
    const secret = "not-a-postgres-url-hunter2";
    expect(() => loadConfig({ DATABASE_URL: secret })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL: secret })).not.toThrow(new RegExp(secret));
  });

  it("rejects an out-of-range port", () => {
    expect(() => loadConfig({ ...valid, PORT: "70000" })).toThrow(/PORT/);
  });
});
