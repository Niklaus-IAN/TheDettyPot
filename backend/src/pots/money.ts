import type { Db } from "../db/index.js";

/**
 * Read-only views of pot money, always computed from the ledger (MON-07).
 *
 * What a member has paid is their contributions minus their refunds, counted
 * on the pot's own account. Fees are separate ledger transactions and never
 * count towards a share. Only confirmed money is in the ledger, so these
 * figures never include payments still in progress (FR-PAY-03).
 */
export async function paidByMember(db: Db, potIds: string[]): Promise<Map<string, Map<string, number>>> {
  const result = new Map<string, Map<string, number>>();
  if (potIds.length === 0) return result;

  const rows = await db
    .selectFrom("ledger_transactions as t")
    .innerJoin("ledger_entries as e", "e.transaction_id", "t.id")
    .innerJoin("ledger_accounts as a", "a.id", "e.account_id")
    .select((eb) => ["t.pot_id", "t.member_user_id", eb.fn.sum<number>("e.amount_kobo").as("paid")])
    .where("t.pot_id", "in", potIds)
    .where("t.kind", "in", ["contribution", "refund"])
    .where("t.member_user_id", "is not", null)
    .where("a.kind", "=", "pot_available")
    .groupBy(["t.pot_id", "t.member_user_id"])
    .execute();

  for (const row of rows) {
    const potId = row.pot_id as string;
    if (!result.has(potId)) result.set(potId, new Map());
    // sum() of bigint comes back as numeric, which pg returns as a string.
    result.get(potId)!.set(row.member_user_id as string, Number(row.paid));
  }
  return result;
}

export const totalRaised = (paid: Map<string, number> | undefined) =>
  [...(paid?.values() ?? [])].reduce((sum, amount) => sum + amount, 0);

/** Money the pot currently holds, including any reserved for a payout in flight. */
export async function heldBalance(db: Db, potId: string): Promise<number> {
  const row = await db
    .selectFrom("ledger_account_balances")
    .select((eb) => eb.fn.sum<number>("balance_kobo").as("held"))
    .where("pot_id", "=", potId)
    .executeTakeFirst();
  return Number(row?.held ?? 0);
}

/** Payments started but not confirmed yet, per pot. Shown apart from raised money (FR-PAY-03). */
export async function inProgressByPot(db: Db, potIds: string[]): Promise<Map<string, number>> {
  if (potIds.length === 0) return new Map();
  const rows = await db
    .selectFrom("payments")
    .select((eb) => ["pot_id", eb.fn.sum<number>("share_kobo").as("kobo")])
    .where("pot_id", "in", potIds)
    .where("status", "=", "pending")
    .where("expires_at", ">", new Date())
    .groupBy("pot_id")
    .execute();
  return new Map(rows.map((r) => [r.pot_id, Number(r.kobo)]));
}
