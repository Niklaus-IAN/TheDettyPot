import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  balanceOf,
  createPot,
  createUser,
  ledgerAccount,
  naira,
  postLedger,
  sleep,
  testDb,
  type LedgerAccount,
  type Pot,
} from "./fixtures.js";

const db = testDb();
afterAll(() => db.destroy());

let pot: Pot;
let available: LedgerAccount;
let external: LedgerAccount;

beforeEach(async () => {
  pot = await createPot(db, await createUser(db));
  available = await ledgerAccount(db, "pot_available", pot.id);
  external = await ledgerAccount(db, "external");
});

/** Money arriving in the pot from outside. */
const fund = (amount: number, key?: string) =>
  postLedger(db, {
    kind: "contribution",
    potId: pot.id,
    key,
    entries: [
      { account: external, amount: -amount },
      { account: available, amount },
    ],
  });

describe("ledger transactions", () => {
  it("record balanced movements, and balances are computed from entries", async () => {
    await fund(naira(25_000));
    await fund(naira(5_000));
    expect(await balanceOf(db, available)).toBe(naira(30_000));
  });

  it("are rejected at commit when entries do not sum to zero", async () => {
    await expect(
      postLedger(db, {
        potId: pot.id,
        entries: [
          { account: external, amount: -naira(100) },
          { account: available, amount: naira(150) },
        ],
      }),
    ).rejects.toThrow(/is unbalanced/);
    expect(await balanceOf(db, available)).toBe(0);
  });

  it("need at least two entries", async () => {
    await expect(postLedger(db, { entries: [] })).rejects.toThrow(/is unbalanced \(0 entries/);
    await expect(postLedger(db, { entries: [{ account: external, amount: naira(1) }] })).rejects.toThrow(
      /is unbalanced \(1 entries/,
    );
  });

  it("reject zero-value entries", async () => {
    await expect(
      postLedger(db, {
        entries: [
          { account: external, amount: 0 },
          { account: available, amount: 0 },
        ],
      }),
    ).rejects.toThrow(/ledger_entries_amount_kobo_check/);
  });

  it("are idempotent: the same event can only be posted once", async () => {
    const key = `paystack:charge:${randomUUID()}`;
    await fund(naira(10_000), key);
    await expect(fund(naira(10_000), key)).rejects.toThrow(/ledger_transactions_idempotency_key_key/);
    expect(await balanceOf(db, available)).toBe(naira(10_000));
  });

  it("cannot be extended after they are committed", async () => {
    const txnId = await fund(naira(10_000));
    await expect(
      db
        .insertInto("ledger_entries")
        .values([
          { transaction_id: txnId, account_id: external.id, amount_kobo: -naira(1_000) },
          { transaction_id: txnId, account_id: available.id, amount_kobo: naira(1_000) },
        ])
        .execute(),
    ).rejects.toThrow(/same database transaction/);
  });

  it("must say what they reverse, and only reversals may", async () => {
    await expect(postLedger(db, { kind: "reversal", entries: [] })).rejects.toThrow(
      /ledger_transactions_reversal_target/,
    );
  });
});

describe("ledger immutability", () => {
  it.each(["ledger_accounts", "ledger_transactions", "ledger_entries"] as const)(
    "%s rows can never be updated, deleted or truncated",
    async (table) => {
      await fund(naira(1_000));
      await expect(sql`update ${sql.table(table)} set created_at = now()`.execute(db)).rejects.toThrow(
        new RegExp(`UPDATE is not allowed on ${table}`),
      );
      await expect(sql`delete from ${sql.table(table)}`.execute(db)).rejects.toThrow(
        new RegExp(`DELETE is not allowed on ${table}`),
      );
      await expect(sql`truncate ${sql.table(table)} cascade`.execute(db)).rejects.toThrow(
        /TRUNCATE is not allowed/,
      );
    },
  );
});

describe("pot balances", () => {
  /** Money leaving the pot to the outside. */
  const withdraw = (amount: number) =>
    postLedger(db, {
      kind: "payout",
      potId: pot.id,
      entries: [
        { account: available, amount: -amount },
        { account: external, amount },
      ],
    });

  it("can be spent down to zero", async () => {
    await fund(naira(10_000));
    await withdraw(naira(10_000));
    expect(await balanceOf(db, available)).toBe(0);
  });

  it("can never go below zero", async () => {
    await fund(naira(10_000));
    await expect(withdraw(naira(10_001))).rejects.toThrow(/cannot go below zero/);
    expect(await balanceOf(db, available)).toBe(naira(10_000));
  });

  it("cannot be overdrawn by two withdrawals racing each other", async () => {
    await fund(naira(1_000));

    // Two withdrawals of ₦600 start at the same time against a ₦1,000 balance.
    // Each would pass on its own; together they would overdraw the pot.
    //
    // The dangerous interleaving is both balance checks running before either
    // transaction commits, so each sees the untouched ₦1,000. Normally the
    // checks run at commit and that window is tiny; SET CONSTRAINTS ALL
    // IMMEDIATE runs each check right away while the transaction stays open,
    // which forces that interleaving every time. Without the account lock in
    // ledger_entries_guard both withdrawals would succeed.
    let firstHasWritten!: () => void;
    const firstWrote = new Promise<void>((resolve) => (firstHasWritten = resolve));

    const attempt = (holdOpen: () => Promise<void>) =>
      db.transaction().execute(async (trx) => {
        const txn = await trx
          .insertInto("ledger_transactions")
          .values({ kind: "payout", pot_id: pot.id, idempotency_key: randomUUID(), description: "race" })
          .returning("id")
          .executeTakeFirstOrThrow();
        await trx
          .insertInto("ledger_entries")
          .values([
            { transaction_id: txn.id, account_id: available.id, amount_kobo: -naira(600) },
            { transaction_id: txn.id, account_id: external.id, amount_kobo: naira(600) },
          ])
          .execute();
        await sql`set constraints all immediate`.execute(trx);
        await holdOpen();
      });

    const first = attempt(async () => {
      firstHasWritten();
      await sleep(300); // keep the first transaction open while the second tries
    });
    await firstWrote;
    const second = attempt(async () => {});

    const results = await Promise.allSettled([first, second]);
    const failed = results.filter((r) => r.status === "rejected");
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(String((failed[0] as PromiseRejectedResult).reason)).toMatch(/cannot go below zero/);
    expect(await balanceOf(db, available)).toBe(naira(400));
  });
});

describe("ledger accounts", () => {
  it("are scoped to a pot exactly when they hold a pot's money", async () => {
    await expect(
      db.insertInto("ledger_accounts").values({ kind: "pot_available", pot_id: null, allow_negative: false }).execute(),
    ).rejects.toThrow(/ledger_accounts_pot_scope/);
    await expect(
      db.insertInto("ledger_accounts").values({ kind: "platform_revenue", pot_id: pot.id, allow_negative: false }).execute(),
    ).rejects.toThrow(/ledger_accounts_pot_scope/);
  });

  it("for a pot can never be allowed to go negative", async () => {
    await expect(
      db.insertInto("ledger_accounts").values({ kind: "pot_reserved", pot_id: pot.id, allow_negative: true }).execute(),
    ).rejects.toThrow(/ledger_accounts_pots_never_negative/);
  });

  it("exist once per kind, per pot and globally", async () => {
    await expect(
      db.insertInto("ledger_accounts").values({ kind: "pot_available", pot_id: pot.id, allow_negative: false }).execute(),
    ).rejects.toThrow(/ledger_accounts_one_per_kind/);
    await expect(
      db.insertInto("ledger_accounts").values({ kind: "external", pot_id: null, allow_negative: true }).execute(),
    ).rejects.toThrow(/ledger_accounts_one_per_kind/);
  });
});
