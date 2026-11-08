-- Group decisions that need members' approval. Today: promoting a member to
-- co-organiser (always needs approval). Payout approval (optional per pot) is
-- added as another kind in the money stage.
create table pot_approval_requests (
  id                 uuid primary key default gen_random_uuid(),
  pot_id             uuid not null references pots(id),
  kind               text not null check (kind in ('co_organiser_promotion')),
  requested_by       uuid not null references users(id),
  -- The member the decision is about, e.g. the nominee for co-organiser.
  subject_user_id    uuid references users(id),
  status             text not null default 'open'
                     check (status in ('open','approved','rejected','expired','cancelled')),
  -- Snapshot of the rule when the request opened, so members joining or
  -- leaving later cannot change the outcome.
  eligible_voters    integer not null check (eligible_voters > 0),
  required_approvals integer not null,
  expires_at         timestamptz not null,
  resolved_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint pot_approval_requests_threshold check (required_approvals between 1 and eligible_voters),
  constraint pot_approval_requests_resolved check ((status = 'open') = (resolved_at is null)),
  constraint pot_approval_requests_promotion_has_subject
    check (kind <> 'co_organiser_promotion' or subject_user_id is not null)
);

create index pot_approval_requests_pot_idx on pot_approval_requests (pot_id);

-- One open request per decision at a time.
create unique index pot_approval_requests_one_open
  on pot_approval_requests (pot_id, kind, subject_user_id) nulls not distinct
  where status = 'open';

create function pot_approval_requests_guard() returns trigger
language plpgsql as $$
begin
  if old.status <> 'open' then
    raise exception 'approval request % is already %', old.id, old.status using errcode = 'check_violation';
  end if;
  if (new.pot_id, new.kind, new.requested_by, new.subject_user_id, new.eligible_voters, new.required_approvals, new.expires_at)
     is distinct from
     (old.pot_id, old.kind, old.requested_by, old.subject_user_id, old.eligible_voters, old.required_approvals, old.expires_at) then
    raise exception 'only the status of an approval request can change' using errcode = 'check_violation';
  end if;
  if new.status <> 'open' then
    new.resolved_at := now();
  end if;
  return new;
end;
$$;

create trigger pot_approval_requests_guard before update on pot_approval_requests
  for each row execute function pot_approval_requests_guard();

create trigger pot_approval_requests_set_updated_at before update on pot_approval_requests
  for each row execute function set_updated_at();

create trigger pot_approval_requests_no_delete before delete on pot_approval_requests
  for each row execute function forbid_change();

-- One vote per member per request. Votes are final.
create table pot_approval_votes (
  request_id uuid not null references pot_approval_requests(id),
  user_id    uuid not null references users(id),
  decision   text not null check (decision in ('approve','reject')),
  created_at timestamptz not null default now(),
  primary key (request_id, user_id)
);

create function pot_approval_votes_guard() returns trigger
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
  return new;
end;
$$;

create trigger pot_approval_votes_guard before insert on pot_approval_votes
  for each row execute function pot_approval_votes_guard();

create trigger pot_approval_votes_immutable before update or delete on pot_approval_votes
  for each row execute function forbid_change();
create trigger pot_approval_votes_no_truncate before truncate on pot_approval_votes
  for each statement execute function forbid_change();
