-- ─────────────────────────────────────────────
-- Pots
-- ─────────────────────────────────────────────
create table pots (
  id                       uuid primary key default gen_random_uuid(),
  created_by               uuid not null references users(id),
  name                     text not null check (char_length(name) between 2 and 80),
  description              text check (char_length(description) <= 1000),
  vibe                     text not null default 'other'
                           check (vibe in ('beach','club','dinner','travel','staycay','adventure','concert','other')),
  -- planning → collecting → funded → confirmed → completed, or cancelled.
  -- Allowed moves are enforced by pots_guard below.
  stage                    text not null default 'planning'
                           check (stage in ('planning','collecting','funded','confirmed','completed','cancelled')),
  stage_changed_at         timestamptz not null default now(),
  area                     text check (char_length(area) <= 120),
  outing_date              date,
  outing_time              time,
  timezone                 text not null default 'Africa/Lagos',
  funding_deadline         timestamptz,
  currency                 text not null default 'NGN' check (currency = 'NGN'),
  -- Budgets are set in whole naira.
  budget_kobo              bigint not null check (budget_kobo > 0 and budget_kobo % 100 = 0),
  headcount                integer not null check (headcount between 2 and 1000),
  -- Budget ÷ headcount, rounded up to the whole naira. This is the only place
  -- the rounding rule lives.
  share_kobo               bigint generated always as
                           (((budget_kobo + headcount * 100 - 1) / (headcount * 100)) * 100) stored,
  join_approval_required   boolean not null default false,
  payout_approval_required boolean not null default false,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index pots_created_by_idx on pots (created_by);
create index pots_stage_idx on pots (stage);

create function pots_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.stage <> 'planning' then
      raise exception 'new pots start in the planning stage' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if new.created_by <> old.created_by then
    raise exception 'pots.created_by cannot change' using errcode = 'check_violation';
  end if;

  if new.stage <> old.stage then
    if (old.stage || '>' || new.stage) <> all (array[
      'planning>collecting', 'planning>cancelled',
      'collecting>funded',   'collecting>cancelled',
      'funded>confirmed',    'funded>cancelled',
      'confirmed>completed', 'confirmed>cancelled'
    ]) then
      raise exception 'invalid pot stage change: % -> %', old.stage, new.stage using errcode = 'check_violation';
    end if;
    new.stage_changed_at := now();
  end if;

  -- FR-POT-03: the money target is fixed once the pot is funded.
  if old.stage not in ('planning','collecting')
     and (new.budget_kobo <> old.budget_kobo or new.headcount <> old.headcount) then
    raise exception 'budget and headcount are locked once a pot is %', old.stage using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger pots_guard before insert or update on pots
  for each row execute function pots_guard();

create trigger pots_set_updated_at before update on pots
  for each row execute function set_updated_at();

-- Pots are cancelled, never deleted.
create trigger pots_no_delete before delete on pots
  for each row execute function forbid_change();

-- ─────────────────────────────────────────────
-- Members
-- ─────────────────────────────────────────────
create table pot_members (
  id                 uuid primary key default gen_random_uuid(),
  pot_id             uuid not null references pots(id),
  user_id            uuid not null references users(id),
  -- Roles are always set by the server, never by the member.
  role               text not null default 'member' check (role in ('organiser','co_organiser','member')),
  -- pending: waiting for the organiser to approve a join request.
  status             text not null default 'active'
                     check (status in ('pending','active','declined','removed','left')),
  reminder_frequency text not null default 'every_3_days'
                     check (reminder_frequency in ('daily','every_3_days','weekly','off')),
  joined_at          timestamptz,
  status_changed_at  timestamptz not null default now(),
  status_changed_by  uuid references users(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  unique (pot_id, user_id),
  constraint pot_members_elevated_roles_are_active check (role = 'member' or status = 'active'),
  constraint pot_members_active_have_joined check (status <> 'active' or joined_at is not null)
);

create index pot_members_user_idx on pot_members (user_id);

-- At most one organiser per pot (pot_members_keep_organiser below ensures at least one).
create unique index pot_members_one_organiser on pot_members (pot_id) where role = 'organiser';

create function pot_members_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if new.pot_id <> old.pot_id or new.user_id <> old.user_id then
      raise exception 'pot_members.pot_id and user_id cannot change' using errcode = 'check_violation';
    end if;
    if new.status <> old.status then
      new.status_changed_at := now();
    end if;
  end if;
  if new.status = 'active' and new.joined_at is null then
    new.joined_at := now();
  end if;
  return new;
end;
$$;

create trigger pot_members_guard before insert or update on pot_members
  for each row execute function pot_members_guard();

create trigger pot_members_set_updated_at before update on pot_members
  for each row execute function set_updated_at();

-- Members leave or are removed (status), never deleted: who paid must stay visible.
create trigger pot_members_no_delete before delete on pot_members
  for each row execute function forbid_change();

-- Every pot has exactly one organiser, checked at commit so a pot and its
-- organiser can be inserted together, and the organiser can be handed over
-- within one transaction.
create function assert_pot_has_organiser(p_pot_id uuid) returns void
language plpgsql as $$
begin
  if not exists (select 1 from pot_members where pot_id = p_pot_id and role = 'organiser') then
    raise exception 'pot % must have exactly one organiser', p_pot_id using errcode = 'check_violation';
  end if;
end;
$$;

create function pots_check_organiser() returns trigger
language plpgsql as $$
begin
  perform assert_pot_has_organiser(new.id);
  return null;
end;
$$;

create constraint trigger pots_must_have_organiser after insert on pots
  deferrable initially deferred
  for each row execute function pots_check_organiser();

create function pot_members_check_organiser() returns trigger
language plpgsql as $$
begin
  perform assert_pot_has_organiser(new.pot_id);
  return null;
end;
$$;

create constraint trigger pot_members_keep_organiser after update on pot_members
  deferrable initially deferred
  for each row execute function pot_members_check_organiser();
