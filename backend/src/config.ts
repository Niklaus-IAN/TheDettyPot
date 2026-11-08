import { z } from "zod";

/**
 * Where this process is running.
 *   local    a developer's machine
 *   test     the automated test suite
 *   dev      shared AWS environment, deployed from main on every merge
 *   staging  production-like AWS environment, final checks before release
 *   prod     real users and real money
 */
export const APP_ENVS = ["local", "test", "dev", "staging", "prod"] as const;
export type AppEnv = (typeof APP_ENVS)[number];

const configSchema = z
  .object({
    APP_ENV: z.enum(APP_ENVS).default("local"),
    HOST: z.string().min(1).default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "must be a postgres:// connection string"),
    ENABLE_DOCS: z.stringbool().default(false),
    // Sign-in tokens are issued by an OpenID Connect provider (Cognito or similar).
    AUTH_ISSUER: z.url(),
    AUTH_AUDIENCE: z.string().min(1),
    // Where the provider publishes its signing keys. Defaults to the standard
    // location under the issuer, which is where Cognito publishes them.
    AUTH_JWKS_URL: z.url().optional(),
    // Local development only: trust keys from a file written by `npm run dev:token`.
    AUTH_DEV_JWKS_FILE: z.string().min(1).optional(),
  })
  .superRefine((config, ctx) => {
    if (config.APP_ENV === "prod" && config.ENABLE_DOCS) {
      ctx.addIssue({ code: "custom", path: ["ENABLE_DOCS"], message: "must be false in prod" });
    }
    if (config.AUTH_DEV_JWKS_FILE && !["local", "test"].includes(config.APP_ENV)) {
      ctx.addIssue({ code: "custom", path: ["AUTH_DEV_JWKS_FILE"], message: "is only allowed in local and test" });
    }
  });

export type Config = z.infer<typeof configSchema>;

/**
 * Validates the environment once at startup so a missing or malformed setting
 * fails fast. Error messages name the variables but never echo their values,
 * because values can be secrets.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  return result.data;
}
