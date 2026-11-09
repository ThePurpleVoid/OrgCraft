-- The run inspector's storage (N1, ADR 0009, local PR L19s-a; plans/n8n/n1-run-inspector-architecture.md §5).
--
-- A task is one chain of work from a root wake (a person's chat, a meeting opening, later a trigger) through every
-- wake it causes. The server mints `task` and `cause` and stamps them on the envelope and on these columns; a
-- sender's own values are replaced. `tasks` is a projection of the log and can be rebuilt from it.
--
-- `step_io` holds tool inputs and outputs and a turn's own text, outside the append-only log, because they can hold
-- customer data that has to go after a while. It is the only copy: the tick deletes rows past their expiry (io_days,
-- 7 to 90, default 30), in batches, as the owner. The app role can't delete or read across tenants, and no session
-- token reaches it. `step_io_days` counts each session's bytes per UTC day for the 50 MB cap.
--
-- Additive: nullable columns and new tables. Older servers keep working against it.
--
-- Rollback: drop table step_io_days; drop table step_io; drop table tasks; alter table budgets drop column io_days;
-- alter table deliveries drop column task; alter table sessions drop column task, drop column cause;
-- drop index events_team_task; alter table events drop column task, drop column cause;
-- delete from schema_migrations where name = '016_run_inspector.sql'.

alter table events add column task text, add column cause text;
create index events_team_task on events(team, task, seq) where task is not null;
alter table sessions add column task text, add column cause text;
alter table deliveries add column task text;
alter table budgets add column io_days int not null default 30 check (io_days between 7 and 90);

create table tasks (
  id text primary key,
  tenant text not null references tenants(id),
  team text not null references teams(id),
  run text,
  root_event text not null,
  started_by jsonb not null,
  title text not null,
  work_item text,
  state text not null default 'running',
  focus text,
  roles text[] not null default '{}',
  cost bigint not null default 0,
  currency text,
  started_at timestamptz not null,
  last_at timestamptz not null,
  ended_at timestamptz
);
create index tasks_team_last on tasks(team, last_at desc);
create index tasks_team_state on tasks(team, state, last_at desc);

create table step_io (
  id text primary key,
  tenant text not null references tenants(id),
  team text not null references teams(id),
  session text not null,
  task text,
  part text not null check (part in ('input', 'output')),
  mime text not null default 'text/plain',
  body text not null,
  bytes int not null,
  truncated boolean not null default false,
  redactions text[] not null default '{}',
  outside boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index step_io_expiry on step_io(expires_at);
create index step_io_session on step_io(session);

create table step_io_days (
  tenant text not null references tenants(id),
  session text not null,
  day date not null,
  bytes bigint not null default 0,
  primary key (session, day)
);

do $$ declare t text; begin
  foreach t in array array['tasks', 'step_io', 'step_io_days'] loop
    execute format('alter table %I enable row level security', t);
    execute format($p$create policy tenant_only on %I using (tenant = current_setting('app.tenant', true)) with check (tenant = current_setting('app.tenant', true))$p$, t);
  end loop;
end $$;

grant select, insert, update on tasks, step_io_days to agent_team_app;
-- Insert, and update for `outside` only (set from the session.result that names the row); never delete.
grant select, insert on step_io to agent_team_app;
grant update (outside) on step_io to agent_team_app;
