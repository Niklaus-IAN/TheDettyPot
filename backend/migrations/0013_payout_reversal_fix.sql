-- A payout the bank reverses after it succeeded keeps its settlement record
-- (history is never rewritten), so a settlement belongs to a succeeded or a
-- reversed payout. 0012 only allowed succeeded, which blocked recording reversals.
alter table payouts drop constraint payouts_settled;
alter table payouts add constraint payouts_settled check (
  (status <> 'succeeded' or settle_txn_id is not null)
  and (settle_txn_id is null or status in ('succeeded','reversed'))
);
