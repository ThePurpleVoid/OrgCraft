-- A step-up token can be bound to the one change it was asked for (ADR 0013; local PR L7). `scope` names that change,
-- for example `resume:<run id>`: such a token is spent only on that change. A route that requires a scope refuses a
-- token without one, so a step-up made for team A's run can never resume team B's. Null keeps today's meaning (any
-- one step-up action).
--
-- Rollback: alter table step_up_tokens drop column scope; delete from schema_migrations where name = '014_step_up_scope.sql'.

alter table step_up_tokens add column scope text check (scope is null or length(scope) <= 200);
