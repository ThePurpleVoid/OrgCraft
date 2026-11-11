-- L9d (spec L9 section 5.2; ADR 0013 rule 3): a standing export's new target waits 24 hours. Turning the export on, or
-- pointing it at another connection or folder, is a way to copy the team out, so the change is stored as pending with
-- the time it takes effect, announced, and only then becomes the target the job writes to. Turning it off, or changing
-- only the cadence, takes effect at once. A row with no active target yet (connection null) is a pending turn-on.
--
-- Rollback: alter table standing_exports drop column pending_connection, drop column pending_target,
-- drop column pending_cadence, drop column pending_at, drop column pending_by, drop column changed_by,
-- drop column changed_at, drop column last_try_at, alter column connection set not null, alter column target set not null,
-- alter column cadence set not null; delete from schema_migrations where name = '029_standing_export_pending.sql'.

alter table standing_exports
  alter column connection drop not null,
  alter column target drop not null,
  alter column cadence drop not null,
  add column pending_connection text check (pending_connection is null or pending_connection ~ '^cred_[A-Za-z0-9_-]{8,40}$'),
  add column pending_target text check (pending_target is null or length(pending_target) between 1 and 300),
  add column pending_cadence text check (pending_cadence is null or pending_cadence in ('daily', 'on-publish')),
  add column pending_at timestamptz,
  add column pending_by text,
  add column changed_by text,
  add column changed_at timestamptz,
  add column last_try_at timestamptz,
  add constraint standing_exports_pending_whole check ((pending_connection is null) = (pending_target is null) and (pending_connection is null) = (pending_at is null)),
  add constraint standing_exports_active_whole check ((connection is null) = (target is null) and (connection is null) = (cadence is null));
