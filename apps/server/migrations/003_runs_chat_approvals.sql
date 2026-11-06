-- Runs, sessions, the bus, cards, approvals, chat, budgets and the audit log (M3, docs/product/m3-design.md
-- section 1). Every table here is a projection of the event log except audit; each state change is appended as an
-- event in the same transaction as the row it changes. Row-level security as in 001 (no FORCE).
--
-- Rollback: drop table audit, budget_days, budgets, chat_messages, approvals, cards, deliveries, sessions, runs,
-- step_up_tokens, step_up_failures; delete from schema_migrations where name = '003_runs_chat_approvals.sql'.
-- The events they projected stay in the log.

create table runs (
  id text primary key,
  tenant text not null references tenants(id),
  team text not null references teams(id),
  mode text not null default 'runner' check (mode in ('runner', 'subagents', 'agent-teams')),
  state text not null check (state in ('running', 'paused', 'stopped')),
  reason text,
  caps jsonb not null default '{}',
  roster jsonb not null default '{}',
  team_version text,
  started_by text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  resume_on date,
  version int not null default 1
);
create index runs_team_state on runs(team, state);

create table sessions (
  id text primary key,
  tenant text not null references tenants(id),
  team text not null references teams(id),
  run text not null references runs(id),
  role text not null,
  instance text,
  state text not null check (state in ('queued', 'starting', 'running', 'idle', 'waiting', 'stopped', 'ended', 'unknown')),
  runner text,
  team_version text,
  branch text,
  worktree text,
  checkpoint jsonb,
  token_hash text,
  token_expires timestamptz,
  last_seen timestamptz,
  created_at timestamptz not null default now()
);
create unique index sessions_one_per_role on sessions(run, role, coalesce(instance, ''));
create index sessions_team_run_state on sessions(team, run, state);
create index sessions_runner on sessions(runner) where runner is not null;

create table deliveries (
  id text primary key,
  tenant text not null references tenants(id),
  team text not null references teams(id),
  event text not null,
  run text not null references runs(id),
  role text not null,
  instance text,
  session text,
  state text not null default 'pending' check (state in ('pending', 'sent', 'acked', 'held', 'dead')),
  attempts int not null default 0,
  next_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create unique index deliveries_once on deliveries(event, role, coalesce(instance, ''));
create index deliveries_due on deliveries(state, next_at);

create table cards (
  id text primary key,
  tenant text not null references tenants(id),
  team text not null references teams(id),
  kind text not null,
  subject text,
  session text,
  run text,
  card jsonb not null,
  version int not null default 1,
  state text not null default 'open' check (state in ('open', 'answered', 'expired', 'superseded')),
  answer jsonb,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
create index cards_team_state on cards(team, state);

create table approvals (
  id text primary key,
  tenant text not null references tenants(id),
  team text not null references teams(id),
  run text,
  session text,
  role text,
  action text not null,
  call jsonb not null,
  why text,
  risk text,
  card text not null,
  state text not null default 'pending' check (state in ('pending', 'approved', 'denied', 'expired')),
  decided_by text,
  decided_at timestamptz,
  expires_at timestamptz not null
);
create index approvals_team_state on approvals(team, state);

create table chat_messages (
  tenant text not null references tenants(id),
  team text not null references teams(id),
  event text not null,
  client_id text,
  from_kind text not null check (from_kind in ('person', 'role')),
  from_id text not null,
  text text not null,
  reply_to text,
  at timestamptz not null,
  primary key (team, event)
);
create unique index chat_messages_client on chat_messages(team, client_id) where client_id is not null;
create index chat_messages_team_at on chat_messages(team, at desc);

create table budgets (
  tenant text not null references tenants(id),
  team text primary key references teams(id),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  per_day bigint check (per_day is null or per_day >= 0),
  per_run bigint check (per_run is null or per_run >= 0),
  sessions int not null default 3 check (sessions between 1 and 100),
  updated_by text not null,
  updated_at timestamptz not null default now()
);

create table budget_days (
  tenant text not null references tenants(id),
  team text not null references teams(id),
  day date not null,
  spent bigint not null default 0,
  warned_at timestamptz,
  exhausted_at timestamptz,
  raised bigint not null default 0,
  primary key (team, day)
);

-- Append-only: agent_team_app may insert and read, never change or delete.
create table audit (
  seq bigserial primary key,
  tenant text not null references tenants(id),
  team text references teams(id),
  at timestamptz not null default now(),
  actor_kind text not null,
  actor_id text not null,
  session text,
  action text not null,
  target text,
  decision text,
  rule text,
  event text,
  detail jsonb
);
create index audit_team_seq on audit(team, seq);

-- The step-up stub (m3-design section 4, issue #28 D3 and D5): tokens kept as hashes, bound to the principal, used
-- once; failed attempts counted per tenant for the lockout.
create table step_up_tokens (
  id text primary key,
  tenant text not null references tenants(id),
  principal text not null,
  hash text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table step_up_failures (
  tenant text not null references tenants(id),
  at timestamptz not null default now()
);
create index step_up_failures_tenant_at on step_up_failures(tenant, at);

do $$ declare t text; begin
  foreach t in array array['runs', 'sessions', 'deliveries', 'cards', 'approvals', 'chat_messages', 'budgets', 'budget_days', 'audit', 'step_up_tokens', 'step_up_failures'] loop
    execute format('alter table %I enable row level security', t);
    execute format($p$create policy tenant_only on %I using (tenant = current_setting('app.tenant', true)) with check (tenant = current_setting('app.tenant', true))$p$, t);
  end loop;
end $$;

grant select, insert, update on runs, sessions, deliveries, cards, approvals, budgets, budget_days, step_up_tokens to agent_team_app;
grant select, insert on chat_messages, audit, step_up_failures to agent_team_app;
grant usage on sequence audit_seq_seq to agent_team_app;
