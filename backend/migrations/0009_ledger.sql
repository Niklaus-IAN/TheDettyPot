-- Double-entry ledger (MON-06/07). Every movement of money is a ledger
-- transaction made of entries that sum to zero. Balances are always computed
-- from entries; nothing stores or sets a balance directly. Rows are
-- append-only: mistakes are corrected with a reversing transaction.
--
-- Sign convention: an entry's amount is money moving into (+) or out of (-)
-- its account. The account kinds below are the generic core; the money stage
-- may add more (for example per-member holds) in a new migration.

create table ledger_accounts (
  id             uuid primary key default gen_random_uuid(),
  kind           text not null check (kind in (
                   'pot_available',      -- a pot's money, free to pay out
                   'pot_reserved',       -- a pot's money held for a payout in flight
                   'processor_clearing', -- money sitting with Paystack
                   'platform_revenue',   -- DettyPot's fee income
                   'platform_expense',   -- costs DettyPot pays (processor and payout fees)
                   'external'            -- the outside world: payers and payees
                 )),
  pot_id         uuid references pots(id),
  -- Pot accounts may never go below zero, which is what stops a pot paying
  -- out more than it holds.
  allow_negative boolean not null,
  created_at     timestamptz not null default now(),

  constraint ledger_accounts_pot_scope
    check ((kind in ('pot_available','pot_reserved')) = (pot_id is not null)),
  constraint ledger_accounts_pots_never_negative check (pot_id is null or not allow_negative),
  constraint ledger_accounts_one_per_kind unique nulls not distinct (kind, pot_id)
);

create table ledger_transactions (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null check (kind in ('contribution','fee','payout','refund','reversal','adjustment')),
  pot_id          uuid references pots(id),
  -- The member this movement concerns, e.g. who contributed or was refunded.
  member_user_id  uuid references users(id),
  -- Makes posting idempotent: the same event (e.g. a webhook delivered twice)
  -- can only ever create one transaction (MON-04).
  idempotency_key text not null unique check (char_length(idempotency_key) between 1 and 200),
  -- Plain-language line every member can read (MON-08).
  description     text not null check (char_length(description) between 1 and 500),
  reverses_id     uuid references ledger_transactions(id),
  metadata        jsonb not null default '{}',
  created_by      uuid references users(id),
  -- The database transaction that created this row; entries must come from
  -- the same one (see ledger_entries_guard). Set by trigger, cannot be forged.
  db_xact_id      xid8 not null default pg_current_xact_id(),
  created_at      timestamptz not null default now(),

  constraint ledger_transactions_reversal_target check ((kind = 'reversal') = (reverses_id is not null))
);

create index ledger_transactions_pot_idx on ledger_transactions (pot_id, created_at);
create index ledger_transactions_member_idx on ledger_transactions (member_user_id, created_at);

create table ledger_entries (
  id             bigint generated always as identity primary key,
  transaction_id uuid not null references ledger_transactions(id),
  account_id     uuid not null references ledger_accounts(id),
  amount_kobo    bigint not null check (amount_kobo <> 0),
  created_at     timestamptz not null default now()
);

create index ledger_entries_transaction_idx on ledger_entries (transaction_id);
create index ledger_entries_account_idx on ledger_entries (account_id);

-- ─────────────────────────────────────────────
-- Integrity rules
-- ─────────────────────────────────────────────

create function ledger_transactions_stamp() returns trigger
language plpgsql as $$
begin
  new.db_xact_id := pg_current_xact_id();
  return new;
end;
$$;

create trigger ledger_transactions_stamp before insert on ledger_transactions
  for each row execute function ledger_transactions_stamp();

-- Entries can only be added in the same database transaction that created
-- their ledger transaction, so a committed transaction can never be extended.
-- Writes to never-negative accounts take a row lock on the account, which
-- queues concurrent writers so the balance check below sees each one in turn.
-- Callers touching several such accounts should insert entries in account-id
-- order to avoid deadlocks.
create function ledger_entries_guard() returns trigger
language plpgsql as $$
declare
  txn_xact xid8;
  acct_allow_negative boolean;
begin
  select db_xact_id into txn_xact from ledger_transactions where id = new.transaction_id;
  if txn_xact is distinct from pg_current_xact_id() then
    raise exception 'ledger entries must be written in the same database transaction as their ledger transaction'
      using errcode = 'check_violation';
  end if;

  select allow_negative into acct_allow_negative from ledger_accounts where id = new.account_id;
  if not acct_allow_negative then
    perform 1 from ledger_accounts where id = new.account_id for no key update;
  end if;
  return new;
end;
$$;

create trigger ledger_entries_guard before insert on ledger_entries
  for each row execute function ledger_entries_guard();

-- Checked at commit: the transaction has at least two entries that sum to zero.
create function assert_ledger_transaction_balanced(p_transaction_id uuid) returns void
language plpgsql as $$
declare
  entry_count integer;
  total numeric;
begin
  select count(*), coalesce(sum(amount_kobo), 0) into entry_count, total
  from ledger_entries where transaction_id = p_transaction_id;
  if entry_count < 2 or total <> 0 then
    raise exception 'ledger transaction % is unbalanced (% entries summing to %)', p_transaction_id, entry_count, total
      using errcode = 'check_violation';
  end if;
end;
$$;

create function ledger_transactions_check() returns trigger
language plpgsql as $$
begin
  perform assert_ledger_transaction_balanced(new.id);
  return null;
end;
$$;

create constraint trigger ledger_transactions_balanced after insert on ledger_transactions
  deferrable initially deferred
  for each row execute function ledger_transactions_check();

-- Checked at commit: never-negative accounts are still at or above zero.
create function ledger_entries_check() returns trigger
language plpgsql as $$
declare
  acct_allow_negative boolean;
  balance numeric;
begin
  select allow_negative into acct_allow_negative from ledger_accounts where id = new.account_id;
  if not acct_allow_negative then
    select coalesce(sum(amount_kobo), 0) into balance from ledger_entries where account_id = new.account_id;
    if balance < 0 then
      raise exception 'ledger account % cannot go below zero (would be % kobo)', new.account_id, balance
        using errcode = 'check_violation';
    end if;
  end if;
  return null;
end;
$$;

create constraint trigger ledger_entries_not_negative after insert on ledger_entries
  deferrable initially deferred
  for each row execute function ledger_entries_check();

-- Append-only: no updates, deletes or truncates, ever.
create trigger ledger_accounts_immutable before update or delete on ledger_accounts
  for each row execute function forbid_change();
create trigger ledger_accounts_no_truncate before truncate on ledger_accounts
  for each statement execute function forbid_change();
create trigger ledger_transactions_immutable before update or delete on ledger_transactions
  for each row execute function forbid_change();
create trigger ledger_transactions_no_truncate before truncate on ledger_transactions
  for each statement execute function forbid_change();
create trigger ledger_entries_immutable before update or delete on ledger_entries
  for each row execute function forbid_change();
create trigger ledger_entries_no_truncate before truncate on ledger_entries
  for each statement execute function forbid_change();

-- ─────────────────────────────────────────────
-- Balances, computed from entries
-- ─────────────────────────────────────────────
create view ledger_account_balances as
select
  a.id                                  as account_id,
  a.kind,
  a.pot_id,
  coalesce(sum(e.amount_kobo), 0)::bigint as balance_kobo
from ledger_accounts a
left join ledger_entries e on e.account_id = a.id
group by a.id;
