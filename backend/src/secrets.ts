/**
 * In AWS, keys and database credentials live in Secrets Manager, not in the
 * environment. Before the config is read, this copies them into the
 * environment:
 *
 *   APP_SECRET_ID       a secret holding a JSON object of settings, e.g.
 *                       {"PAYSTACK_SECRET_KEY": "sk_test_…"}. Each one is set
 *                       unless the environment already has it.
 *   DATABASE_SECRET_ID  the database's own secret (as RDS writes it); becomes
 *                       DATABASE_URL, with TLS verified against the RDS
 *                       certificates, unless DATABASE_URL is already set.
 *
 * Locally neither is set and nothing happens.
 */
export type GetSecret = (id: string) => Promise<string>;

/** Settings an app secret may provide. Anything else in it is ignored. */
const SECRET_SETTINGS = ["PAYSTACK_SECRET_KEY", "GOOGLE_MAPS_API_KEY", "ANTHROPIC_API_KEY"];

export async function loadAwsSecrets(env: NodeJS.ProcessEnv = process.env, getSecret?: GetSecret): Promise<void> {
  const { APP_SECRET_ID, DATABASE_SECRET_ID } = env;
  if (!APP_SECRET_ID && !DATABASE_SECRET_ID) return;
  const get = getSecret ?? (await secretsManager());

  if (APP_SECRET_ID) {
    const settings = parseObject(await get(APP_SECRET_ID), "APP_SECRET_ID");
    for (const name of SECRET_SETTINGS) {
      const value = settings[name];
      // An empty value means "not set yet": the feature stays off rather than failing validation.
      if (typeof value === "string" && value.trim() !== "" && !env[name]) env[name] = value.trim();
    }
  }

  if (DATABASE_SECRET_ID && !env.DATABASE_URL) {
    const s = parseObject(await get(DATABASE_SECRET_ID), "DATABASE_SECRET_ID");
    for (const field of ["username", "password", "host", "port", "dbname"]) {
      if (s[field] === undefined || s[field] === "") throw new Error(`The database secret has no ${field}`);
    }
    const user = encodeURIComponent(String(s.username));
    const password = encodeURIComponent(String(s.password));
    const db = encodeURIComponent(String(s.dbname));
    env.DATABASE_URL = `postgres://${user}:${password}@${s.host}:${s.port}/${db}?sslmode=verify-full`;
  }
}

function parseObject(raw: string, from: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // Never include the secret itself in the message.
    throw new Error(`The secret named by ${from} isn't JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`The secret named by ${from} isn't a JSON object`);
  return value as Record<string, unknown>;
}

async function secretsManager(): Promise<GetSecret> {
  const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
  const client = new SecretsManagerClient({});
  return async (id) => {
    const res = await client.send(new GetSecretValueCommand({ SecretId: id }));
    if (res.SecretString === undefined) throw new Error("The secret has no text value");
    return res.SecretString;
  };
}
