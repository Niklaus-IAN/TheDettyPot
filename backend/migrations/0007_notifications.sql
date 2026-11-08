-- FR-NOT-01/02: one notification per event per recipient. The row itself is the
-- in-app notification; each outside channel (email now, WhatsApp later) gets a
-- delivery row that a worker sends and retries.
create table notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id),
  pot_id     uuid references pots(id),
  -- e.g. invited, joined, payment_received, reminder, deadline_near, funded,
  -- venue_selected, payout, refund, approval_requested. Validated by the API.
  type       text not null check (type ~ '^[a-z][a-z_]{1,62}$'),
  payload    jsonb not null default '{}',
  read_at    timestamptz,
  created_at timestamptz not null default now()
);

create index notifications_user_created_idx on notifications (user_id, created_at desc);

create table notification_deliveries (
  id                  uuid primary key default gen_random_uuid(),
  notification_id     uuid not null references notifications(id),
  channel             text not null check (channel in ('email','whatsapp')),
  status              text not null default 'pending' check (status in ('pending','sent','failed','skipped')),
  attempts            integer not null default 0 check (attempts >= 0),
  last_error          text,
  provider_message_id text,
  sent_at             timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  unique (notification_id, channel),
  constraint notification_deliveries_sent_has_time check ((status = 'sent') = (sent_at is not null))
);

create index notification_deliveries_pending_idx on notification_deliveries (created_at) where status = 'pending';

create trigger notification_deliveries_set_updated_at before update on notification_deliveries
  for each row execute function set_updated_at();
