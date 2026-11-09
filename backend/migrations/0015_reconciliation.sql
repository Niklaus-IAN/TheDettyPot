-- NFR-05: a daily comparison of DettyPot's records with Paystack's.
create table reconciliation_runs (
  id          uuid primary key default gen_random_uuid(),
  window_from timestamptz not null,
  window_to   timestamptz not null,
  status      text not null default 'running' check (status in ('running','ok','discrepancies','error')),
  summary     jsonb not null default '{}',
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  constraint reconciliation_runs_window check (window_from < window_to)
);

create index reconciliation_runs_started_idx on reconciliation_runs (started_at desc);

-- Something that didn't match and couldn't be fixed automatically.
create table reconciliation_findings (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null references reconciliation_runs(id),
  kind          text not null check (kind in (
                  'payment_unknown_here',      -- Paystack has a DettyPot payment we have no record of
                  'payment_not_confirmed',     -- Paystack says paid; we still don't count it
                  'payment_missing_at_paystack', -- we count it; Paystack has no successful charge
                  'payment_amount_mismatch',
                  'payout_unknown_here',
                  'payout_status_mismatch',
                  'ledger_mismatch'
                )),
  subject_type  text,
  subject_id    text,
  details       jsonb not null default '{}',
  resolved_at   timestamptz,
  resolved_by   uuid references users(id),
  resolution    text check (char_length(resolution) <= 1000),
  created_at    timestamptz not null default now(),
  constraint reconciliation_findings_resolved check ((resolved_at is null) = (resolved_by is null))
);

create index reconciliation_findings_open_idx on reconciliation_findings (created_at) where resolved_at is null;
