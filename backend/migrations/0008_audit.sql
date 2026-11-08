-- NFR-04: admin actions and all money actions are written here and can never
-- be edited or deleted.
create table audit_events (
  id            bigint generated always as identity primary key,
  occurred_at   timestamptz not null default now(),
  actor_type    text not null check (actor_type in ('user','admin','system')),
  actor_user_id uuid references users(id),
  action        text not null check (action ~ '^[a-z][a-z0-9_.]{1,99}$'),
  pot_id        uuid references pots(id),
  subject_type  text,
  subject_id    text,
  request_id    text,
  metadata      jsonb not null default '{}',

  constraint audit_events_actor check ((actor_type = 'system') = (actor_user_id is null))
);

create index audit_events_pot_idx on audit_events (pot_id, occurred_at);
create index audit_events_actor_idx on audit_events (actor_user_id, occurred_at);

create trigger audit_events_immutable before update or delete on audit_events
  for each row execute function forbid_change();
create trigger audit_events_no_truncate before truncate on audit_events
  for each statement execute function forbid_change();
