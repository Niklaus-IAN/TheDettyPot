-- ─────────────────────────────────────────────
-- Venues (FR-PLN-01/03/05). Google's terms let us keep only the place ID long
-- term (AI-10); a Google venue's name, address, rating and so on are fetched
-- fresh whenever they're shown. A custom venue (someone's house, a beach with
-- no listing) keeps the name and address members typed, which are ours.
-- ─────────────────────────────────────────────
create table pot_venues (
  id                uuid primary key default gen_random_uuid(),
  pot_id            uuid not null references pots(id),
  added_by          uuid not null references users(id),
  kind              text not null check (kind in ('google','custom')),
  place_id          text check (char_length(place_id) between 1 and 300),
  custom_name       text check (char_length(custom_name) between 1 and 120),
  custom_address    text check (char_length(custom_address) <= 300),
  -- Why it suits the group: written by the member, or by the planner.
  note              text check (char_length(note) <= 500),
  -- Per-person cost. Always labelled: an estimate unless the organiser set it (AI-03).
  cost_kobo         bigint check (cost_kobo >= 0 and cost_kobo % 100 = 0),
  cost_source       text check (cost_source in ('estimate','organiser')),
  source            text not null default 'member' check (source in ('member','planner')),
  removed_at        timestamptz,
  removed_by        uuid references users(id),
  created_at        timestamptz not null default now(),

  constraint pot_venues_google_has_place check ((kind = 'google') = (place_id is not null)),
  constraint pot_venues_custom_has_name check ((kind = 'custom') = (custom_name is not null)),
  constraint pot_venues_cost_labelled check ((cost_kobo is null) = (cost_source is null)),
  constraint pot_venues_removed_by_someone check ((removed_at is null) = (removed_by is null))
);

create index pot_venues_pot_idx on pot_venues (pot_id) where removed_at is null;
-- The same Google place can't be on a pot's list twice.
create unique index pot_venues_one_place on pot_venues (pot_id, place_id) where removed_at is null and place_id is not null;

create trigger pot_venues_no_delete before delete on pot_venues for each row execute function forbid_change();

-- One vote per member per venue (FR-PLN-03). Members may back several venues.
create table venue_votes (
  venue_id   uuid not null references pot_venues(id),
  user_id    uuid not null references users(id),
  created_at timestamptz not null default now(),
  primary key (venue_id, user_id)
);

alter table pots add column venue_voting_deadline timestamptz;
alter table pots add column selected_venue_id uuid references pot_venues(id);

-- The chosen venue locks once the booking is confirmed (FR-PLN-05).
create or replace function pots_guard() returns trigger
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

  if old.stage not in ('planning','collecting')
     and (new.budget_kobo <> old.budget_kobo or new.headcount <> old.headcount) then
    raise exception 'budget and headcount are locked once a pot is %', old.stage using errcode = 'check_violation';
  end if;

  if old.stage in ('confirmed','completed','cancelled') and new.selected_venue_id is distinct from old.selected_venue_id then
    raise exception 'the venue is locked once a pot is %', old.stage using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- ─────────────────────────────────────────────
-- Date poll (FR-PLN-04): members mark the dates they can make.
-- ─────────────────────────────────────────────
create table pot_date_options (
  id         uuid primary key default gen_random_uuid(),
  pot_id     uuid not null references pots(id),
  date       date not null,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  unique (pot_id, date)
);

create table pot_date_answers (
  option_id  uuid not null references pot_date_options(id) on delete cascade,
  user_id    uuid not null references users(id),
  available  boolean not null,
  updated_at timestamptz not null default now(),
  primary key (option_id, user_id)
);
