import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Insertable, Selectable } from "kysely";
import { createDb, type Database, type Db } from "../src/db/index.js";
import { TEST_DATABASE_URL } from "./helpers.js";

export type User = Selectable<Database["users"]>;
export type Pot = Selectable<Database["pots"]>;
export type LedgerAccount = Selectable<Database["ledger_accounts"]>;

export const testDb = (): Db => createDb(TEST_DATABASE_URL);

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** ₦ → kobo, so tests read in naira. */
export const naira = (amount: number) => amount * 100;

export function createUser(db: Db, overrides: Partial<Insertable<Database["users"]>> = {}): Promise<User> {
  const tag = randomUUID().slice(0, 8);
  return db
    .insertInto("users")
    .values({ auth_subject: `test|${tag}`, email: `user-${tag}@example.com`, full_name: `User ${tag}`, ...overrides })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** A pot and its organiser membership, inserted together as the API will. */
export function createPot(
  db: Db,
  organiser: User,
  overrides: Partial<Insertable<Database["pots"]>> = {},
): Promise<Pot> {
  return db.transaction().execute(async (trx) => {
    const pot = await trx
      .insertInto("pots")
      .values({ created_by: organiser.id, name: "Beach day", budget_kobo: naira(100_000), headcount: 4, ...overrides })
      .returningAll()
      .executeTakeFirstOrThrow();
    await trx.insertInto("pot_members").values({ pot_id: pot.id, user_id: organiser.id, role: "organiser" }).execute();
    return pot;
  });
}

export function addMember(
  db: Db,
  pot: Pot,
  user: User,
  overrides: Partial<Insertable<Database["pot_members"]>> = {},
) {
  return db
    .insertInto("pot_members")
    .values({ pot_id: pot.id, user_id: user.id, ...overrides })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function setStage(db: Db, potId: string, ...stages: string[]) {
  for (const stage of stages) {
    await db.updateTable("pots").set({ stage }).where("id", "=", potId).execute();
  }
}

export const tokenHash = () => createHash("sha256").update(randomBytes(16)).digest();

/** Finds or creates the ledger account of a kind (pot-scoped when potId is given). */
export async function ledgerAccount(db: Db, kind: string, potId: string | null = null): Promise<LedgerAccount> {
  let query = db.selectFrom("ledger_accounts").selectAll().where("kind", "=", kind);
  query = potId === null ? query.where("pot_id", "is", null) : query.where("pot_id", "=", potId);
  const existing = await query.executeTakeFirst();
  if (existing) return existing;
  return db
    .insertInto("ledger_accounts")
    .values({ kind, pot_id: potId, allow_negative: potId === null })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export interface PostInput {
  kind?: string;
  potId?: string | null;
  key?: string;
  entries: { account: LedgerAccount; amount: number }[];
}

/** Writes one ledger transaction and its entries in a single DB transaction. */
export function postLedger(db: Db, { kind = "adjustment", potId = null, key = randomUUID(), entries }: PostInput) {
  return db.transaction().execute(async (trx) => {
    const txn = await trx
      .insertInto("ledger_transactions")
      .values({ kind, pot_id: potId, idempotency_key: key, description: "test movement" })
      .returning("id")
      .executeTakeFirstOrThrow();
    if (entries.length > 0) {
      await trx
        .insertInto("ledger_entries")
        .values(entries.map((e) => ({ transaction_id: txn.id, account_id: e.account.id, amount_kobo: e.amount })))
        .execute();
    }
    return txn.id;
  });
}

export async function balanceOf(db: Db, account: LedgerAccount): Promise<number> {
  const row = await db
    .selectFrom("ledger_account_balances")
    .select("balance_kobo")
    .where("account_id", "=", account.id)
    .executeTakeFirstOrThrow();
  return row.balance_kobo ?? 0;
}
