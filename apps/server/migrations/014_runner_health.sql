-- What a runner last said about its own health (L29, vision O19.2 and O37.8): today only whether its model proxy can
-- reach the model provider, plus upgradeBy, the date set once when the runner falls behind the supported version
-- window (CTO R13: N-2). The server reads it for the runner card and the outage banner from any instance.
-- Additive: a new column with a default, so older servers keep working against it.
--
-- Rollback: alter table runners drop column health; delete from schema_migrations where name = '014_runner_health.sql'.

alter table runners add column health jsonb not null default '{}';
