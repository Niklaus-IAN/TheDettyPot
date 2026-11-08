-- Shared trigger functions used by later migrations.

-- Keeps updated_at current on tables whose rows can change.
create function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Rejects the operation outright. Attached as BEFORE UPDATE/DELETE (row) and
-- BEFORE TRUNCATE (statement) triggers on tables whose history must never be
-- rewritten: the ledger, the audit log and approval votes. Also used to block
-- deletes on tables that are closed or anonymised instead of deleted.
create function forbid_change() returns trigger
language plpgsql as $$
begin
  raise exception '% is not allowed on %', tg_op, tg_table_name
    using errcode = 'restrict_violation';
end;
$$;
