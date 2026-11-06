-- The control plane's first schema: tenants, teams, report tokens, the event log, sinks and the secret vault.
-- Every tenant-owned table has row-level security keyed on the transaction setting app.tenant. The server does all
-- tenant work as agent_team_app, which the policies bind; only the owner (migrations, token lookup, the sink
-- worker's scan) sees across tenants. The owner needs CREATEROLE (or a superuser to create agent_team_app first).
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'agent_team_app') then create role agent_team_app nologin; end if;
  begin execute format('grant agent_team_app to %I', current_user); exception when others then null; end;
  execute format('grant usage on schema %I to agent_team_app', current_schema());
end $$;

create table tenants (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name text not null,
  created_at timestamptz not null default now()
);

-- Team ids are unique across tenants so that a report URL (/v1/teams/{team}/reports) names exactly one team.
create table teams (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  tenant text not null references tenants(id),
  name text not null,
  created_at timestamptz not null default now()
);
create index teams_tenant on teams(tenant);

-- Append-only tokens for teams that report from outside (the kit's scripts and hooks). Only a hash is kept.
create table report_tokens (
  id text primary key,
  tenant text not null references tenants(id),
  team text not null references teams(id),
  hash text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- The event log (docs/contracts/events.md). seq orders it and is the stream cursor; (team, id) makes retries safe.
create table events (
  seq bigserial primary key,
  tenant text not null references tenants(id),
  team text not null references teams(id),
  id text not null,
  type text not null,
  version int not null,
  time timestamptz not null,
  actor_kind text not null,
  actor_id text not null,
  envelope jsonb not null,
  received_at timestamptz not null default now(),
  unique (team, id)
);
create index events_team_seq on events(team, seq);
create index events_team_type_time on events(team, type, time);

-- Where events are forwarded. kit-report sends report and message events in the kit's report shape, so a board a
-- team already runs keeps working. The header value is a vault secret, named here, never stored in this table.
create table sinks (
  id text primary key,
  tenant text not null references tenants(id),
  team text not null references teams(id),
  url text not null,
  format text not null default 'kit-report' check (format in ('kit-report', 'event')),
  header text,
  secret text,
  cursor bigint not null default 0,
  failures int not null default 0,
  next_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now()
);

-- Secrets, sealed with AES-256-GCM under the server's master key.
create table secrets (
  tenant text not null references tenants(id),
  name text not null check (name ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  sealed text not null,
  updated_at timestamptz not null default now(),
  primary key (tenant, name)
);

do $$ declare t text; begin
  foreach t in array array['teams', 'report_tokens', 'events', 'sinks', 'secrets'] loop
    execute format('alter table %I enable row level security', t);
    execute format($p$create policy tenant_only on %I using (tenant = current_setting('app.tenant', true)) with check (tenant = current_setting('app.tenant', true))$p$, t);
  end loop;
end $$;
alter table tenants enable row level security;
create policy tenant_only on tenants using (id = current_setting('app.tenant', true));

grant select on tenants to agent_team_app;
grant select, insert, update on teams, report_tokens, sinks, secrets to agent_team_app;
grant select, insert on events to agent_team_app;
grant delete on sinks, secrets to agent_team_app;
grant usage on sequence events_seq_seq to agent_team_app;
