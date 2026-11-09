-- ─────────────────────────────────────────────
-- Refunds (MON-15 to MON-17). Money goes back through Paystack against the
-- payment it came from. The service fee is not refunded. Like payouts, the
-- money is reserved first, then settled when Paystack confirms, or released
-- back to the pot if the refund fails.
--   reserved       money set aside; Paystack not asked yet
--   requested      Paystack has the refund
--   needs_details  Paystack needs the member's bank account to send it
--   processed      done: the money reached the member
--   failed         Paystack couldn't refund it; the money is back in the pot
-- ─────────────────────────────────────────────
create table refunds (
  id                      uuid primary key default gen_random_uuid(),
  pot_id                  uuid not null references pots(id),
  user_id                 uuid not null references users(id),
  payment_id              uuid not null references payments(id),
  amount_kobo             bigint not null check (amount_kobo > 0),
  reason                  text not null check (reason in ('pot_cancelled','member_left','member_removed','leftover')),
  settlement_id           uuid,
  status                  text not null default 'reserved'
                          check (status in ('reserved','requested','needs_details','processed','failed')),
  provider_refund_id      bigint,
  provider_status         text,
  provider_deducted_kobo  bigint check (provider_deducted_kobo >= 0),
  failure_reason          text check (char_length(failure_reason) <= 500),
  refund_bank_code        text,
  refund_account_last4    text check (refund_account_last4 ~ '^[0-9]{4}$'),
  reserve_txn_id          uuid not null references ledger_transactions(id),
  settle_txn_id           uuid references ledger_transactions(id),
  release_txn_id          uuid references ledger_transactions(id),
  requested_at            timestamptz,
  completed_at            timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint refunds_processed_settled check ((status = 'processed') = (settle_txn_id is not null)),
  constraint refunds_failed_released check ((status = 'failed') = (release_txn_id is not null))
);

create index refunds_pot_idx on refunds (pot_id, created_at);
create index refunds_payment_idx on refunds (payment_id);
create index refunds_open_idx on refunds (status) where status in ('reserved','requested','needs_details');

create function refunds_guard() returns trigger
language plpgsql as $$
begin
  if (new.pot_id, new.user_id, new.payment_id, new.amount_kobo, new.reason, new.reserve_txn_id)
     is distinct from (old.pot_id, old.user_id, old.payment_id, old.amount_kobo, old.reason, old.reserve_txn_id) then
    raise exception 'the amount and parties of a refund cannot change' using errcode = 'check_violation';
  end if;
  if old.status in ('processed','failed') and new.status <> old.status then
    raise exception 'refund % is already %', old.id, old.status using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger refunds_guard before update on refunds for each row execute function refunds_guard();
create trigger refunds_set_updated_at before update on refunds for each row execute function set_updated_at();
create trigger refunds_no_delete before delete on refunds for each row execute function forbid_change();

-- Never refund more than the share of a payment (the fee is non-refundable).
-- Checked at commit, across every refund of that payment that hasn't failed.
create function refunds_within_payment() returns trigger
language plpgsql as $$
declare
  refunded bigint;
  share bigint;
begin
  select coalesce(sum(amount_kobo), 0) into refunded from refunds where payment_id = new.payment_id and status <> 'failed';
  select share_kobo into share from payments where id = new.payment_id;
  if refunded > share then
    raise exception 'refunds of payment % (% kobo) would exceed its share (% kobo)', new.payment_id, refunded, share
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

create constraint trigger refunds_within_payment after insert or update on refunds
  deferrable initially deferred
  for each row execute function refunds_within_payment();

-- ─────────────────────────────────────────────
-- Settling up leftover money after the outing (MON-17).
-- ─────────────────────────────────────────────
create table settlements (
  id            uuid primary key default gen_random_uuid(),
  pot_id        uuid not null references pots(id),
  mode          text not null check (mode in ('refund')),
  leftover_kobo bigint not null check (leftover_kobo > 0),
  created_by    uuid not null references users(id),
  created_at    timestamptz not null default now()
);

alter table refunds add constraint refunds_settlement_fk foreign key (settlement_id) references settlements(id);

create trigger settlements_immutable before update or delete on settlements
  for each row execute function forbid_change();
