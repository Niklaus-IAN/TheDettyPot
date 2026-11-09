import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const valid = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  AUTH_ISSUER: "https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_abc",
  AUTH_AUDIENCE: "client-id",
};

describe("loadConfig: sign-in", () => {
  it("requires an issuer and audience", () => {
    expect(() => loadConfig({ DATABASE_URL: valid.DATABASE_URL })).toThrow(/AUTH_ISSUER[\s\S]*AUTH_AUDIENCE/);
  });

  it("requires the issuer to be a URL", () => {
    expect(() => loadConfig({ ...valid, AUTH_ISSUER: "not a url" })).toThrow(/AUTH_ISSUER/);
  });

  it("allows local signing keys only on a laptop or in tests", () => {
    for (const APP_ENV of ["local", "test"]) {
      expect(loadConfig({ ...valid, APP_ENV, AUTH_DEV_JWKS_FILE: "keys.json" }).AUTH_DEV_JWKS_FILE).toBe("keys.json");
    }
    for (const APP_ENV of ["dev", "staging", "prod"]) {
      expect(() => loadConfig({ ...valid, APP_ENV, AUTH_DEV_JWKS_FILE: "keys.json" })).toThrow(/AUTH_DEV_JWKS_FILE/);
    }
  });
});

describe("loadConfig: Paystack keys", () => {
  it("moves real money only in prod", () => {
    for (const APP_ENV of ["local", "test", "dev", "staging"]) {
      expect(() => loadConfig({ ...valid, APP_ENV, PAYSTACK_SECRET_KEY: "sk_live_abc123" })).toThrow(/live key is only allowed in prod/);
      expect(loadConfig({ ...valid, APP_ENV, PAYSTACK_SECRET_KEY: "sk_test_abc123" }).PAYSTACK_SECRET_KEY).toBe("sk_test_abc123");
    }
  });

  it("never runs prod on test money, or without payments", () => {
    expect(() => loadConfig({ ...valid, APP_ENV: "prod", PAYSTACK_SECRET_KEY: "sk_test_abc123" })).toThrow(/prod needs a live key/);
    expect(() => loadConfig({ ...valid, APP_ENV: "prod" })).toThrow(/prod needs a live key/);
  });

  it("rejects something that isn't a secret key, such as a public key", () => {
    expect(() => loadConfig({ ...valid, PAYSTACK_SECRET_KEY: "pk_test_abc123" })).toThrow(/PAYSTACK_SECRET_KEY/);
  });

  it("never echoes the key in errors", () => {
    expect(() => loadConfig({ ...valid, APP_ENV: "dev", PAYSTACK_SECRET_KEY: "sk_live_supersecret" })).not.toThrow(/supersecret/);
  });
});

describe("loadConfig", () => {
  it("applies defaults", () => {
    const config = loadConfig(valid);
    expect(config.PORT).toBe(3000);
    expect(config.APP_ENV).toBe("local");
    expect(config.ENABLE_DOCS).toBe(false);
  });

  it("accepts every deployment environment", () => {
    for (const APP_ENV of ["local", "test", "dev", "staging"]) {
      expect(loadConfig({ ...valid, APP_ENV }).APP_ENV).toBe(APP_ENV);
    }
    expect(loadConfig({ ...valid, APP_ENV: "prod", PAYSTACK_SECRET_KEY: "sk_live_abc123" }).APP_ENV).toBe("prod");
  });

  it("rejects an unknown environment", () => {
    expect(() => loadConfig({ ...valid, APP_ENV: "production" })).toThrow(/APP_ENV/);
  });

  it("refuses to expose API docs in prod", () => {
    expect(() => loadConfig({ ...valid, APP_ENV: "prod", PAYSTACK_SECRET_KEY: "sk_live_abc123", ENABLE_DOCS: "true" })).toThrow(/ENABLE_DOCS/);
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
