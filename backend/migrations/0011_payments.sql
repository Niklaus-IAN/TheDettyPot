-- ─────────────────────────────────────────────
-- Fee schedules (MON-18). The contributor pays one service fee on top of their
-- share: the processor's cost plus DettyPot's margin. Rows are never edited;
-- a change is a new row, so every payment can point at the exact schedule it
-- was quoted under.
-- ─────────────────────────────────────────────
create table fee_schedules (
  id               uuid primary key default gen_random_uuid(),
  method           text not null check (method in ('card','bank_transfer')),
  -- What the processor charges: percent (basis points) + flat, optionally capped.
  percent_bps      integer not null check (percent_bps between 0 and 5000),
  flat_kobo        bigint not null default 0 check (flat_kobo >= 0),
  cap_kobo         bigint check (cap_kobo > 0),
  -- DettyPot's own margin on top.
  margin_bps       integer not null default 0 check (margin_bps between 0 and 5000),
  margin_flat_kobo bigint not null default 0 check (margin_flat_kobo >= 0),
  effective_from   timestamptz not null default now(),
  created_by       uuid references users(id),
  note             text check (char_length(note) <= 500),
  created_at       timestamptz not null default now()
);

create index fee_schedules_current_idx on fee_schedules (method, effective_from desc);

create trigger fee_schedules_immutable before update or delete on fee_schedules
  for each row execute function forbid_change();

-- Launch defaults. Cards are quoted at the international rate so every card is
-- covered; bank transfers at 1% capped at ₦300. No DettyPot margin during the
-- beta: contributors pay the processor's cost only.
insert into fee_schedules (method, percent_bps, flat_kobo, cap_kobo, note) values
  ('card',          390, 10000, null,  'Launch default: international card rate, no margin'),
  ('bank_transfer', 100, 0,     30000, 'Launch default: 1% capped at ₦300, no margin');

-- ─────────────────────────────────────────────
-- Payments (MON-01). Created by the server before the member pays, recording
-- who pays, for which pot, the exact amounts and a unique reference. Money only
-- counts once a verified webhook confirms it (MON-02).
-- ─────────────────────────────────────────────
create table payments (
  id                      uuid primary key default gen_random_uuid(),
  pot_id                  uuid not null references pots(id),
  user_id                 uuid not null references users(id),
  reference               text not null unique check (reference ~ '^[A-Za-z0-9.=-]{10,100}$'),
  method                  text not null check (method in ('card','bank_transfer')),
  currency                text not null default 'NGN' check (currency = 'NGN'),
  -- share goes into the pot; fee is the service fee; total is what is charged.
  share_kobo              bigint not null check (share_kobo > 0 and share_kobo % 100 = 0),
  fee_kobo                bigint not null check (fee_kobo >= 0),
  total_kobo              bigint not null,
  fee_schedule_id         uuid not null references fee_schedules(id),
  fee_refundable          boolean not null,
  -- pending: waiting for the member to pay. review: Paystack reported something
  -- that doesn't match this record, so a person must look before it counts.
  status                  text not null default 'pending'
                          check (status in ('pending','succeeded','failed','expired','review')),
  provider_access_code    text,
  provider_checkout_url   text,
  provider_transaction_id bigint,
  provider_fee_kobo       bigint check (provider_fee_kobo >= 0),
  channel                 text,
  paid_at                 timestamptz,
  expires_at              timestamptz not null,
  failure_reason          text check (char_length(failure_reason) <= 500),
  ledger_transaction_id   uuid references ledger_transactions(id),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint payments_total check (total_kobo = share_kobo + fee_kobo),
  constraint payments_succeeded_recorded
    check ((status = 'succeeded') = (ledger_transaction_id is not null and paid_at is not null))
);

create index payments_pot_idx on payments (pot_id, created_at);
create index payments_user_idx on payments (user_id, created_at);
create index payments_pending_idx on payments (expires_at) where status = 'pending';

create function payments_guard() returns trigger
language plpgsql as $$
begin
  if (new.pot_id, new.user_id, new.reference, new.method, new.share_kobo, new.fee_kobo, new.total_kobo, new.fee_schedule_id, new.fee_refundable)
     is distinct from
     (old.pot_id, old.user_id, old.reference, old.method, old.share_kobo, old.fee_kobo, old.total_kobo, old.fee_schedule_id, old.fee_refundable) then
    raise exception 'the amounts and parties of a payment cannot change' using errcode = 'check_violation';
  end if;
  -- Money that arrived is never un-arrived: corrections are ledger reversals.
  if old.status = 'succeeded' and new.status <> 'succeeded' then
    raise exception 'a succeeded payment cannot change status' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger payments_guard before update on payments
  for each row execute function payments_guard();
create trigger payments_set_updated_at before update on payments
  for each row execute function set_updated_at();
create trigger payments_no_delete before delete on payments
  for each row execute function forbid_change();

-- ─────────────────────────────────────────────
-- Incoming webhooks (NFR-05). Every signed event is stored before anything is
-- done with it, then processed from this table with retries, so none is lost
-- if processing fails. The same event delivered twice is stored once (MON-04).
-- ─────────────────────────────────────────────
create table webhook_events (
  id              uuid primary key default gen_random_uuid(),
  provider        text not null check (provider in ('paystack')),
  event_type      text not null,
  dedupe_key      text not null,
  payload         jsonb not null,
  status          text not null default 'pending' check (status in ('pending','processed','ignored','failed')),
  attempts        integer not null default 0,
  last_error      text,
  next_attempt_at timestamptz not null default now(),
  processed_at    timestamptz,
  received_at     timestamptz not null default now(),
  unique (provider, dedupe_key)
);

create index webhook_events_due_idx on webhook_events (next_attempt_at) where status = 'pending';

create trigger webhook_events_no_delete before delete on webhook_events
  for each row execute function forbid_change();
