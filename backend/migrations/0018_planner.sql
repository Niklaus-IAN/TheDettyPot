-- ─────────────────────────────────────────────
-- The AI planner (AI-01 to AI-11): a conversation inside each pot. Members ask,
-- the planner answers with real places from Google. Questions are answered in
-- the background by the worker, one at a time per pot.
-- ─────────────────────────────────────────────
create table planner_messages (
  id           uuid primary key default gen_random_uuid(),
  pot_id       uuid not null references pots(id),
  role         text not null check (role in ('user','assistant')),
  -- The member who asked. Replies come from the planner, so they have none.
  author_id    uuid references users(id),
  -- A reply points at the question it answers.
  reply_to     uuid references planner_messages(id),
  content      text not null check (char_length(content) between 1 and 4000),
  -- Questions only: where answering has got to.
  status       text check (status in ('pending','answered','failed')),
  attempts     int not null default 0 check (attempts >= 0),
  lease_until  timestamptz,
  created_at   timestamptz not null default now(),

  constraint planner_question_has_author check ((role = 'user') = (author_id is not null)),
  constraint planner_question_has_status check ((role = 'user') = (status is not null)),
  constraint planner_reply_answers check ((role = 'assistant') = (reply_to is not null))
);

create index planner_messages_pot_idx on planner_messages (pot_id, created_at);
-- One reply per question: regenerating replaces it, it doesn't add another (AI-07).
create unique index planner_one_reply on planner_messages (reply_to) where reply_to is not null;
-- One question in progress per pot, so answers arrive in order.
create unique index planner_one_pending on planner_messages (pot_id) where status = 'pending';
create index planner_pending_idx on planner_messages (created_at) where status = 'pending';

-- What the planner suggested in a reply. Only the Google place ID is kept (AI-10);
-- the rest is the planner's own words.
create table planner_suggestions (
  id                 uuid primary key default gen_random_uuid(),
  message_id         uuid not null references planner_messages(id) on delete cascade,
  pot_id             uuid not null references pots(id),
  position           smallint not null check (position between 1 and 5),
  place_id           text not null check (char_length(place_id) between 1 and 300),
  why                text not null check (char_length(why) between 1 and 600),
  -- Always shown as an estimate (AI-03).
  cost_estimate_kobo bigint check (cost_estimate_kobo >= 0 and cost_estimate_kobo % 100 = 0),
  -- Always shown as AI guidance, never as a score (AI-04).
  safety_note        text check (char_length(safety_note) between 1 and 600),
  created_at         timestamptz not null default now(),
  unique (message_id, position),
  unique (message_id, place_id)
);

create index planner_suggestions_pot_idx on planner_suggestions (pot_id);

-- Every question and every regenerate, for the daily limits (AI-06).
create table planner_requests (
  id          uuid primary key default gen_random_uuid(),
  pot_id      uuid not null references pots(id),
  user_id     uuid not null references users(id),
  kind        text not null check (kind in ('ask','regenerate')),
  created_at  timestamptz not null default now()
);

create index planner_requests_pot_idx on planner_requests (pot_id, created_at);
create index planner_requests_user_idx on planner_requests (user_id, created_at);

-- A short summary of older messages, written by the smaller model (AI-09), so
-- long conversations stay cheap to continue.
create table planner_threads (
  pot_id              uuid primary key references pots(id),
  summary             text not null check (char_length(summary) between 1 and 4000),
  -- Messages created up to this moment are covered by the summary.
  summarised_through  timestamptz not null,
  updated_at          timestamptz not null default now()
);

create trigger planner_threads_updated_at before update on planner_threads
  for each row execute function set_updated_at();

-- Every call to Claude: prompt, model, tokens and cost, per pot (AI-11).
-- Payment data is never put in prompts, so it never lands here.
create table ai_calls (
  id                  uuid primary key default gen_random_uuid(),
  pot_id              uuid references pots(id),
  -- Whose question caused the call.
  user_id             uuid references users(id),
  message_id          uuid references planner_messages(id) on delete set null,
  purpose             text not null check (purpose in ('plan','summary')),
  requested_model     text not null,
  -- The model that answered; a fallback model can step in.
  model               text,
  prompt_version      text not null,
  -- Cleared if the person deletes their account; the numbers stay.
  request             jsonb,
  response            jsonb,
  stop_reason         text,
  input_tokens        int check (input_tokens >= 0),
  output_tokens       int check (output_tokens >= 0),
  cache_read_tokens   int check (cache_read_tokens >= 0),
  cache_write_tokens  int check (cache_write_tokens >= 0),
  -- In billionths of a US dollar. Null when the model's price isn't known.
  cost_nano_usd       bigint check (cost_nano_usd >= 0),
  duration_ms         int not null check (duration_ms >= 0),
  error               text,
  created_at          timestamptz not null default now()
);

create index ai_calls_pot_idx on ai_calls (pot_id, created_at);
create index ai_calls_created_idx on ai_calls (created_at);
