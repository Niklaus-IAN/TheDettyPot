-- Notifications can go to an email address that has no account yet (email invites).
alter table notifications alter column user_id drop not null;
alter table notifications add column recipient_email citext;
alter table notifications add constraint notifications_has_recipient
  check (user_id is not null or recipient_email is not null);

-- Retries with backoff: a failed delivery waits until next_attempt_at.
alter table notification_deliveries add column next_attempt_at timestamptz not null default now();
drop index notification_deliveries_pending_idx;
create index notification_deliveries_due_idx on notification_deliveries (next_attempt_at) where status = 'pending';

-- Payment reminders (FR-NOT-01/03).
alter table pot_members add column last_reminded_at timestamptz;

-- One-off pot alerts, and admin freezes (FR-ADM-01).
alter table pots add column deadline_warning_sent_at timestamptz;
alter table pots add column deadline_passed_sent_at timestamptz;
alter table pots add column frozen_at timestamptz;
alter table pots add column frozen_reason text check (char_length(frozen_reason) <= 500);
alter table pots add column frozen_by uuid references users(id);
alter table pots add constraint pots_frozen_by_someone
  check ((frozen_at is null) = (frozen_by is null) and (frozen_at is null) = (frozen_reason is null));

-- FR-MKT-01: the waitlist keeps an email or phone and where the person came from.
create table waitlist_signups (
  id         uuid primary key default gen_random_uuid(),
  email      citext unique,
  phone      text unique check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  source     text check (char_length(source) <= 100),
  referrer   text check (char_length(referrer) <= 500),
  created_at timestamptz not null default now(),
  constraint waitlist_signups_has_contact check (email is not null or phone is not null)
);
