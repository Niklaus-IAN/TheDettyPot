-- ─────────────────────────────────────────────
-- Bank accounts that receive payouts. The name always comes from the bank's
-- own lookup (MON-11); a typed name is never stored.
-- ─────────────────────────────────────────────
create table bank_accounts (
  id                      uuid primary key default gen_random_uuid(),
  created_by              uuid not null references users(id),
  bank_code               text not null check (bank_code ~ '^[0-9A-Za-z]{2,20}$'),
  bank_name               text not null,
  account_number          text not null check (account_number ~ '^[0-9]{10}$'),
  account_name            text not null check (char_length(account_name) between 1 and 200),
  provider_recipient_code text,
  created_at              timestamptz not null default now(),
  unique (created_by, bank_code, account_number)
);

create trigger bank_accounts_no_delete before delete on bank_accounts
  for each row execute function forbid_change();

-- ─────────────────────────────────────────────
-- Payouts (MON-09 to MON-14).
--   waiting          reserved; waiting for member approval and/or a hold to pass
--   flagged          a member raised a concern during the hold; support decides
--   ready            cleared to send
--   sending          handed to Paystack, result not known yet
--   needs_attention  Paystack wants something a person must do (e.g. an OTP)
--   succeeded / failed / reversed   Paystack's final answer
--   rejected         members didn't approve in time
--   cancelled        withdrawn by the organiser or support before sending
-- ─────────────────────────────────────────────
create table payouts (
  id                  uuid primary key default gen_random_uuid(),
  pot_id              uuid not null references pots(id),
  requested_by        uuid not null references users(id),
  bank_account_id     uuid not null references bank_accounts(id),
  amount_kobo         bigint not null check (amount_kobo > 0 and amount_kobo % 100 = 0),
  narration           text check (char_length(narration) <= 100),
  -- Paystack transfer references: lowercase letters, digits, - and _, 16+ characters.
  reference           text not null unique check (reference ~ '^[a-z0-9_-]{16,100}$'),
  status              text not null
                      check (status in ('waiting','flagged','ready','sending','needs_attention','succeeded','failed','reversed','rejected','cancelled')),
  hold_until          timestamptz,
  hold_reasons        text[] not null default '{}',
  approval_request_id uuid references pot_approval_requests(id),
  flagged_by          uuid references users(id),
  flag_reason         text check (char_length(flag_reason) <= 500),
  transfer_code       text,
  provider_fee_kobo   bigint check (provider_fee_kobo >= 0),
  failure_reason      text check (char_length(failure_reason) <= 500),
  reserve_txn_id      uuid not null references ledger_transactions(id),
  settle_txn_id       uuid references ledger_transactions(id),
  release_txn_id      uuid references ledger_transactions(id),
  sent_at             timestamptz,
  completed_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint payouts_flag_has_reason check ((flagged_by is null) = (flag_reason is null)),
  -- Reserved money ends up exactly one way: paid out, or released back to the pot.
  constraint payouts_settled check ((status = 'succeeded') = (settle_txn_id is not null)),
  constraint payouts_released check (
    (status in ('failed','rejected','cancelled')) = (release_txn_id is not null) or status = 'reversed'
  )
);

create index payouts_pot_idx on payouts (pot_id, created_at);
create index payouts_open_idx on payouts (status) where status in ('waiting','ready','sending','needs_attention','flagged');

create function payouts_guard() returns trigger
language plpgsql as $$
begin
  if (new.pot_id, new.requested_by, new.bank_account_id, new.amount_kobo, new.reference, new.reserve_txn_id)
     is distinct from (old.pot_id, old.requested_by, old.bank_account_id, old.amount_kobo, old.reference, old.reserve_txn_id) then
    raise exception 'the amount, account and parties of a payout cannot change' using errcode = 'check_violation';
  end if;
  -- Final states are final, except that a completed transfer can later be reversed by the bank.
  if old.status in ('failed','rejected','cancelled','reversed') and new.status <> old.status then
    raise exception 'payout % is already %', old.id, old.status using errcode = 'check_violation';
  end if;
  if old.status = 'succeeded' and new.status not in ('succeeded','reversed') then
    raise exception 'a succeeded payout can only be reversed' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger payouts_guard before update on payouts for each row execute function payouts_guard();
create trigger payouts_set_updated_at before update on payouts for each row execute function set_updated_at();
create trigger payouts_no_delete before delete on payouts for each row execute function forbid_change();

-- ─────────────────────────────────────────────
-- Member approval of payouts (MON-13) reuses approval requests.
-- ─────────────────────────────────────────────
alter table pot_approval_requests drop constraint pot_approval_requests_kind_check;
alter table pot_approval_requests add constraint pot_approval_requests_kind_check
  check (kind in ('co_organiser_promotion','payout'));
alter table pot_approval_requests add column payout_id uuid references payouts(id);
alter table pot_approval_requests add constraint pot_approval_requests_payout_has_payout
  check ((kind = 'payout') = (payout_id is not null));

-- Who may vote, fixed when the request opens. Used for payouts: the people who
-- had paid in at that moment.
create table pot_approval_voters (
  request_id uuid not null references pot_approval_requests(id),
  user_id    uuid not null references users(id),
  primary key (request_id, user_id)
);

create trigger pot_approval_voters_immutable before update or delete on pot_approval_voters
  for each row execute function forbid_change();

-- Votes on a request with a fixed voter list must come from that list.
create or replace function pot_approval_votes_guard() returns trigger
language plpgsql as $$
declare
  req pot_approval_requests%rowtype;
begin
  select * into req from pot_approval_requests where id = new.request_id;
  if req.status <> 'open' or req.expires_at <= now() then
    raise exception 'approval request % is closed', new.request_id using errcode = 'check_violation';
  end if;
  if new.user_id = req.subject_user_id then
    raise exception 'members cannot vote on a decision about themselves' using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from pot_members where pot_id = req.pot_id and user_id = new.user_id and status = 'active'
  ) then
    raise exception 'only active members of the pot can vote' using errcode = 'check_violation';
  end if;
  if exists (select 1 from pot_approval_voters where request_id = new.request_id)
     and not exists (select 1 from pot_approval_voters where request_id = new.request_id and user_id = new.user_id) then
    raise exception 'only the people who could vote when this opened can vote on it' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
