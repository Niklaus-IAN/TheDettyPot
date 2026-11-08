create table users (
  id                uuid primary key default gen_random_uuid(),
  -- Subject id from the identity provider (Cognito or similar).
  auth_subject      text unique,
  email             citext unique,
  email_verified_at timestamptz,
  full_name         text check (char_length(full_name) between 1 and 80),
  avatar_emoji      text check (char_length(avatar_emoji) <= 16),
  avatar_url        text,
  -- Phone verification is deferred until the WhatsApp assistant; the columns
  -- exist now so adding it later needs no data migration. E.164 format.
  phone             text unique check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  phone_verified_at timestamptz,
  is_admin          boolean not null default false,
  -- Deleting an account anonymises the row instead of removing it, because the
  -- ledger and audit log must keep pointing at it.
  deleted_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint users_active_have_identity
    check (deleted_at is not null or (auth_subject is not null and email is not null)),
  constraint users_deleted_have_no_personal_data
    check (deleted_at is null or (
      auth_subject is null and email is null and email_verified_at is null and full_name is null
      and avatar_url is null and phone is null and phone_verified_at is null
    )),
  constraint users_verified_needs_value
    check ((email_verified_at is null or email is not null) and (phone_verified_at is null or phone is not null))
);

create trigger users_set_updated_at before update on users
  for each row execute function set_updated_at();

create trigger users_no_delete before delete on users
  for each row execute function forbid_change();
