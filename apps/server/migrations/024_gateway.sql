-- The gateway's outbound governor and effect idempotency (local PR L20g; CTO review 2 R1a, R5; decision C1).
--
-- `governor_buckets`: one row per pacing key (a provider account, an installation, a tenant's share of a provider).
-- `tat` is the key's theoretical arrival time (GCRA): a call may go at tat minus the burst allowance, and moves tat on
-- by one interval. Calls are delayed, never dropped. `blocked_until` holds a key back after the provider answered with
-- a rate limit or an abuse response (the server's own observation; see `reports` for what runners say). Keys span tenants (a shared App or model key), so the table is the control
-- plane's own: no tenant column, row level security on with no policy, read and written as the owner only.
--
-- `effects`: every outward effect's idempotency key (task, step and call hash, or the sidecar's key), per tenant. The
-- first call records `started`, then `done` with its result or `failed`; a repeat of a done key is answered with the
-- first result and never sent again, and a repeat while it is started is refused. One still started 15 minutes after
-- `started_at` was cut off: it becomes `unknown` and is sent again only with a person's approval.
--
-- Additive: two new tables. Older servers ignore both.
--
-- Rollback: drop table effects; drop table governor_buckets;
-- delete from schema_migrations where name = '024_gateway.sql'.

create table governor_buckets (
  key text primary key check (length(key) between 1 and 200),
  tat timestamptz not null default now(),
  blocked_until timestamptz,
  blocked_reason text,
  slowed_at timestamptz,
  -- A shared account key only: the tenants whose runners said the provider slowed them, and when (kept 5 minutes).
  -- A runner's word alone never holds the shared key; two tenants' do, at most once every 30 minutes.
  reports jsonb not null default '{}',
  report_held_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table governor_buckets enable row level security;

create table effects (
  tenant text not null references tenants(id),
  key text not null check (length(key) between 1 and 200),
  team text,
  session text,
  tool text not null check (length(tool) between 1 and 200),
  call_hash text,
  state text not null default 'started' check (state in ('started', 'done', 'failed', 'unknown')),
  result jsonb,
  attempts int not null default 1,
  -- The effect-resend approval its latest attempt was sent under; an approval counts once.
  approval text,
  created_at timestamptz not null default now(),
  started_at timestamptz not null default now(),
  done_at timestamptz,
  primary key (tenant, key)
);
create index effects_session on effects(session);

alter table effects enable row level security;
create policy tenant_only on effects using (tenant = current_setting('app.tenant', true)) with check (tenant = current_setting('app.tenant', true));
grant select, insert, update on effects to agent_team_app;
