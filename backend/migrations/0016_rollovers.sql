-- ─────────────────────────────────────────────
-- Rolling leftover money into a new outing (MON-17: "unless the group agrees
-- otherwise"). The organiser offers it; each contributor decides for their own
-- part: move it into the new pot, or have it refunded. Silence means refund.
-- ─────────────────────────────────────────────

-- Money moving between two pots passes through this account in one transaction.
alter table ledger_accounts drop constraint ledger_accounts_kind_check;
alter table ledger_accounts add constraint ledger_accounts_kind_check check (kind in (
  'pot_available','pot_reserved','processor_clearing','platform_revenue','platform_expense','external','internal_transfer'
));

create table rollovers (
  id               uuid primary key default gen_random_uuid(),
  from_pot_id      uuid not null references pots(id),
  to_pot_id        uuid not null references pots(id),
  created_by       uuid not null references users(id),
  leftover_kobo    bigint not null check (leftover_kobo > 0),
  consent_deadline timestamptz not null,
  status           text not null default 'open' check (status in ('open','closed')),
  created_at       timestamptz not null default now(),
  closed_at        timestamptz,
  constraint rollovers_different_pots check (from_pot_id <> to_pot_id),
  constraint rollovers_closed check ((status = 'closed') = (closed_at is not null))
);

-- One open offer per pot at a time.
create unique index rollovers_one_open on rollovers (from_pot_id) where status = 'open';

create table rollover_choices (
  rollover_id  uuid not null references rollovers(id),
  user_id      uuid not null references users(id),
  amount_kobo  bigint not null check (amount_kobo > 0),
  choice       text not null default 'pending' check (choice in ('pending','move','refund')),
  decided_by   text check (decided_by in ('member','deadline')),
  decided_at   timestamptz,
  hold_txn_id  uuid not null references ledger_transactions(id),
  primary key (rollover_id, user_id),
  constraint rollover_choices_decided check ((choice = 'pending') = (decided_at is null) and (decided_at is null) = (decided_by is null))
);

create function rollover_choices_guard() returns trigger
language plpgsql as $$
begin
  if (new.rollover_id, new.user_id, new.amount_kobo, new.hold_txn_id) is distinct from (old.rollover_id, old.user_id, old.amount_kobo, old.hold_txn_id) then
    raise exception 'a roll-over choice''s amount and owner cannot change' using errcode = 'check_violation';
  end if;
  if old.choice <> 'pending' and new.choice <> old.choice then
    raise exception 'this roll-over choice has already been made' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger rollover_choices_guard before update on rollover_choices for each row execute function rollover_choices_guard();
create trigger rollover_choices_no_delete before delete on rollover_choices for each row execute function forbid_change();
create trigger rollovers_no_delete before delete on rollovers for each row execute function forbid_change();
