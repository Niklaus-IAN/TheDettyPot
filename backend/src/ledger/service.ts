import type { Transaction } from "kysely";
import type { Database, Db } from "../db/index.js";

export type AccountKind =
  | "pot_available"
  | "pot_reserved"
  | "processor_clearing"
  | "platform_revenue"
  | "platform_expense"
  | "external";

const POT_KINDS: readonly AccountKind[] = ["pot_available", "pot_reserved"];

/** Finds an account, creating it on first use. Pot accounts can never go negative. */
export async function ensureAccount(db: Db, kind: AccountKind, potId: string | null = null): Promise<string> {
  const scoped = POT_KINDS.includes(kind);
  if (scoped !== (potId !== null)) throw new Error(`account ${kind} ${scoped ? "needs" : "can't have"} a pot`);
  await db
    .insertInto("ledger_accounts")
    .values({ kind, pot_id: potId, allow_negative: !scoped })
    .onConflict((oc) => oc.constraint("ledger_accounts_one_per_kind").doNothing())
    .execute();
  let query = db.selectFrom("ledger_accounts").select("id").where("kind", "=", kind);
  query = potId === null ? query.where("pot_id", "is", null) : query.where("pot_id", "=", potId);
  return (await query.executeTakeFirstOrThrow()).id;
}

export interface Posting {
  kind: "contribution" | "fee" | "payout" | "refund" | "reversal" | "adjustment";
  potId: string | null;
  memberUserId?: string | null;
  /** The same event always produces the same key, so it can only be posted once. */
  idempotencyKey: string;
  /** Plain language, shown to every member of the pot. */
  description: string;
  createdBy?: string | null;
  reversesId?: string;
  metadata?: Record<string, unknown>;
  entries: { accountId: string; amountKobo: number }[];
}

/**
 * Writes one balanced ledger transaction. Takes a database transaction so the
 * header and its entries always commit together. Zero amounts are dropped;
 * entries are written in account order so concurrent postings lock accounts in
 * the same order and can't deadlock.
 */
export async function post(trx: Transaction<Database>, p: Posting): Promise<string> {
  const entries = p.entries.filter((e) => e.amountKobo !== 0).sort((a, b) => a.accountId.localeCompare(b.accountId));
  const { id } = await trx
    .insertInto("ledger_transactions")
    .values({
      kind: p.kind,
      pot_id: p.potId,
      member_user_id: p.memberUserId ?? null,
      idempotency_key: p.idempotencyKey,
      description: p.description,
      created_by: p.createdBy ?? null,
      reverses_id: p.reversesId ?? null,
      metadata: JSON.stringify(p.metadata ?? {}),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await trx
    .insertInto("ledger_entries")
    .values(entries.map((e) => ({ transaction_id: id, account_id: e.accountId, amount_kobo: e.amountKobo })))
    .execute();
  return id;
}
