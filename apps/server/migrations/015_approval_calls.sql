-- What you see is what you sign (ADR 0013 rule 1; local PR L6). An approval may be bound to the exact calls it covers:
-- `calls` holds them in canonical form (packages/calls) and `calls_hash` their sha256, which approval.result echoes so
-- the runner runs only those calls. The card's facts are rendered from `calls`, never from the role's text. Old
-- approvals have neither and keep working as before, at normal risk.
--
-- Rollback: alter table approvals drop column calls, drop column calls_hash; delete from schema_migrations where name = '015_approval_calls.sql'.

alter table approvals add column calls jsonb, add column calls_hash text check (calls_hash is null or calls_hash ~ '^[0-9a-f]{64}$');
