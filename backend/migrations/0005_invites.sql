-- FR-INV-01/02/04: joining needs a valid invite token. Only a SHA-256 hash of
-- the token is stored; the token itself appears once, in the invite link.
create table pot_invites (
  id            uuid primary key default gen_random_uuid(),
  pot_id        uuid not null references pots(id),
  created_by    uuid not null references users(id),
  -- link: shareable, multi-use. email/phone: sent to one person.
  kind          text not null check (kind in ('link','email','phone')),
  token_hash    bytea not null unique check (octet_length(token_hash) = 32),
  invitee_email citext,
  invitee_phone text check (invitee_phone ~ '^\+[1-9][0-9]{7,14}$'),
  max_uses      integer check (max_uses > 0),
  use_count     integer not null default 0 check (use_count >= 0),
  expires_at    timestamptz,
  revoked_at    timestamptz,
  revoked_by    uuid references users(id),
  created_at    timestamptz not null default now(),

  constraint pot_invites_within_max_uses check (max_uses is null or use_count <= max_uses),
  constraint pot_invites_email_has_address check (kind <> 'email' or invitee_email is not null),
  constraint pot_invites_phone_has_number check (kind <> 'phone' or invitee_phone is not null),
  constraint pot_invites_revoked_by_someone check ((revoked_at is null) = (revoked_by is null))
);

create index pot_invites_pot_idx on pot_invites (pot_id);

-- Invites are revoked, never deleted, so a member's invite_id stays valid.
create trigger pot_invites_no_delete before delete on pot_invites
  for each row execute function forbid_change();

-- Which invite a member joined with (null for the organiser).
alter table pot_members add column invite_id uuid references pot_invites(id);
