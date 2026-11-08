import { authorizePot } from "../auth/pot-access.js";
import type { Db } from "../db/index.js";
import type { User } from "../users/service.js";

export interface LedgerLine {
  id: string;
  kind: string;
  description: string;
  memberUserId: string | null;
  memberName: string | null;
  /** Money into (+) or out of (−) the pot's own accounts. */
  potAmountKobo: number;
  /** For contributions: what Paystack kept and what DettyPot kept from the fee. */
  processorFeeKobo: number;
  platformFeeKobo: number;
  createdAt: Date;
}

export interface PotLedger {
  availableKobo: number;
  reservedKobo: number;
  raisedKobo: number;
  refundedKobo: number;
  paidOutKobo: number;
  /** Payments started but not confirmed yet. Never counted in the figures above (FR-PAY-03). */
  inProgressKobo: number;
  lines: LedgerLine[];
}

/** The pot's full money story in plain language, open to every member (MON-08). */
export async function potLedger(db: Db, user: User, potId: string): Promise<PotLedger> {
  await authorizePot(db, user, potId, "ledger.view");

  const rows = await db
    .selectFrom("ledger_transactions as t")
    .innerJoin("ledger_entries as e", "e.transaction_id", "t.id")
    .innerJoin("ledger_accounts as a", "a.id", "e.account_id")
    .leftJoin("users as u", "u.id", "t.member_user_id")
    .select(["t.id", "t.kind", "t.reverses_id", "t.description", "t.member_user_id", "u.full_name", "t.created_at", "a.kind as account_kind", "a.pot_id as account_pot", "e.amount_kobo"])
    .where("t.pot_id", "=", potId)
    .orderBy("t.created_at")
    .orderBy("e.id")
    .execute();

  const lines = new Map<string, LedgerLine>();
  const reverses = new Map<string, string>();
  let available = 0;
  let reserved = 0;
  for (const r of rows) {
    if (r.reverses_id) reverses.set(r.id, r.reverses_id);
    let line = lines.get(r.id);
    if (!line) {
      line = {
        id: r.id,
        kind: r.kind,
        description: r.description,
        memberUserId: r.member_user_id,
        memberName: r.full_name,
        potAmountKobo: 0,
        processorFeeKobo: 0,
        platformFeeKobo: 0,
        createdAt: r.created_at,
      };
      lines.set(r.id, line);
    }
    if (r.account_pot === potId) {
      if (r.account_kind === "pot_available") available += r.amount_kobo;
      if (r.account_kind === "pot_reserved") reserved += r.amount_kobo;
      // Moving money between the pot's own accounts (reserving it) isn't money in or out.
      if (r.account_kind === "pot_available" || r.account_kind === "pot_reserved") line.potAmountKobo += r.amount_kobo;
    }
    if (r.kind === "contribution" && r.account_kind === "platform_expense") line.processorFeeKobo += r.amount_kobo;
    if (r.kind === "contribution" && r.account_kind === "platform_revenue") line.platformFeeKobo += r.amount_kobo;
  }

  const all = [...lines.values()];
  // A reversal counts against whatever it reverses: a reversed payout is no longer paid out.
  const effectiveKind = (l: LedgerLine) => (l.kind === "reversal" ? (lines.get(reverses.get(l.id) ?? "")?.kind ?? "reversal") : l.kind);
  const sum = (kind: string) => all.filter((l) => effectiveKind(l) === kind).reduce((s, l) => s + l.potAmountKobo, 0);
  const inProgress = await db
    .selectFrom("payments")
    .select((eb) => eb.fn.coalesce(eb.fn.sum<number>("share_kobo"), eb.lit(0)).as("kobo"))
    .where("pot_id", "=", potId)
    .where("status", "=", "pending")
    .where("expires_at", ">", new Date())
    .executeTakeFirstOrThrow();

  return {
    availableKobo: available,
    reservedKobo: reserved,
    raisedKobo: sum("contribution") + sum("refund"),
    refundedKobo: -sum("refund"),
    paidOutKobo: -sum("payout"),
    inProgressKobo: Number(inProgress.kobo),
    lines: all.reverse(),
  };
}
