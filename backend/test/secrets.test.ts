import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { loadAwsSecrets, type GetSecret } from "../src/secrets.js";

const store =
  (secrets: Record<string, unknown>): GetSecret & { asked: string[] } => {
    const asked: string[] = [];
    const get = async (id: string) => {
      asked.push(id);
      if (!(id in secrets)) throw new Error(`no secret ${id}`);
      const v = secrets[id];
      return typeof v === "string" ? v : JSON.stringify(v);
    };
    return Object.assign(get, { asked });
  };

const rds = { username: "dettypot", password: "p@ss:w/rd?#", host: "db.abc.eu-west-1.rds.amazonaws.com", port: 5432, dbname: "dettypot", engine: "postgres" };

describe("loading secrets in AWS", () => {
  it("does nothing locally, without asking AWS", async () => {
    const env = { DATABASE_URL: "postgres://localhost/dettypot" };
    const get = store({});
    await loadAwsSecrets(env, get);
    expect(env).toEqual({ DATABASE_URL: "postgres://localhost/dettypot" });
    expect(get.asked).toEqual([]);
  });

  it("builds the database address from the RDS secret, escaping the password and verifying TLS", async () => {
    const env: NodeJS.ProcessEnv = { DATABASE_SECRET_ID: "dettypot/dev/db" };
    await loadAwsSecrets(env, store({ "dettypot/dev/db": rds }));
    expect(env.DATABASE_URL).toBe("postgres://dettypot:p%40ss%3Aw%2Frd%3F%23@db.abc.eu-west-1.rds.amazonaws.com:5432/dettypot?sslmode=verify-full");
    const url = new URL(env.DATABASE_URL!);
    expect(decodeURIComponent(url.password)).toBe(rds.password);
  });

  it("sets the app's keys, ignores anything else in the secret, and leaves empty ones unset", async () => {
    const env: NodeJS.ProcessEnv = { APP_SECRET_ID: "dettypot/dev/app" };
    await loadAwsSecrets(
      env,
      store({ "dettypot/dev/app": { PAYSTACK_SECRET_KEY: " sk_test_abc ", GOOGLE_MAPS_API_KEY: "", ANTHROPIC_API_KEY: "sk-ant-xyz", APP_ENV: "prod", AUTH_DEV_JWKS_FILE: "/tmp/x" } }),
    );
    expect(env).toEqual({ APP_SECRET_ID: "dettypot/dev/app", PAYSTACK_SECRET_KEY: "sk_test_abc", ANTHROPIC_API_KEY: "sk-ant-xyz" });
  });

  it("never overrides what the environment already says", async () => {
    const env: NodeJS.ProcessEnv = { APP_SECRET_ID: "a", DATABASE_SECRET_ID: "d", PAYSTACK_SECRET_KEY: "sk_test_mine", DATABASE_URL: "postgres://mine/db" };
    const get = store({ a: { PAYSTACK_SECRET_KEY: "sk_test_theirs" }, d: rds });
    await loadAwsSecrets(env, get);
    expect(env.PAYSTACK_SECRET_KEY).toBe("sk_test_mine");
    expect(env.DATABASE_URL).toBe("postgres://mine/db");
    expect(get.asked).toEqual(["a"]);
  });

  it("fails clearly, without revealing the secret, when it's malformed or missing", async () => {
    await expect(loadAwsSecrets({ APP_SECRET_ID: "a" }, store({ a: "sk_test_plaintext" }))).rejects.toThrow("isn't JSON");
    await expect(loadAwsSecrets({ APP_SECRET_ID: "a" }, store({ a: "sk_test_plaintext" }))).rejects.not.toThrow("sk_test_plaintext");
    await expect(loadAwsSecrets({ APP_SECRET_ID: "a" }, store({ a: ["x"] }))).rejects.toThrow("isn't a JSON object");
    await expect(loadAwsSecrets({ DATABASE_SECRET_ID: "d" }, store({ d: { ...rds, host: "" } }))).rejects.toThrow("no host");
    await expect(loadAwsSecrets({ DATABASE_SECRET_ID: "d" }, store({}))).rejects.toThrow("no secret d");
  });

  it("produces settings the config accepts", async () => {
    const env: NodeJS.ProcessEnv = { APP_ENV: "dev", APP_SECRET_ID: "a", DATABASE_SECRET_ID: "d", AUTH_ISSUER: "https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_abc", AUTH_AUDIENCE: "client" };
    await loadAwsSecrets(env, store({ a: { PAYSTACK_SECRET_KEY: "sk_test_abc123" }, d: rds }));
    expect(loadConfig(env)).toMatchObject({ APP_ENV: "dev", PAYSTACK_SECRET_KEY: "sk_test_abc123", DATABASE_URL: expect.stringContaining("sslmode=verify-full") });
  });
});
