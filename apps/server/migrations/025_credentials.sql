-- L20 (F4, vision areas 6 and 7): credentials and the vault's release of them.
--
-- A credential is a named key the workspace keeps for a service (Slack, GitHub, a payments API). Its value is sealed in
-- its own row (`sealed`, AES-256-GCM bound to tenant and credential id), apart from the sinks' `secrets`, so a credential
-- can never replace or delete a sink's token. No route returns it.
-- It is released only to a session's sidecar or the gateway, and only when the run's frozen roster binds that
-- session's role to a resource that lists the name, and the credential is granted to the team. Every release is an
-- audit row (`secret.release`), never with the value.
--
-- Rollback: drop table team_systems; drop table credentials; delete from schema_migrations where name = '025_credentials.sql'.

create table credentials (
  id text primary key check (id ~ '^cred_[A-Za-z0-9_-]{8,40}$'),
  tenant text not null references tenants(id),
  -- The vault name (secrets.name) and the name resources.json lists in a resource's `secrets`.
  name text not null check (name ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  label text check (label is null or length(label) <= 80),
  service text not null check (service ~ '^[a-z0-9][a-z0-9.-]{0,39}$'),
  auth text not null default 'key' check (auth in ('key', 'oauth')),
  -- Where it may be used: "<team>/<resource>" pairs (security review sev2). Empty means nowhere yet: a credential is
  -- granted to one resource of one team, never ambient, and released only to a resource of its own service type.
  grants text[] not null default '{}' check (cardinality(grants) <= 200),
  created_by text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  -- Test connection: { ok, at, detail } (detail is the service's short answer, never the value).
  last_test jsonb,
  -- The value, sealed (vault.mjs seal, associated data "<tenant>/credential/<id>"); null once removed.
  sealed text,
  removed_at timestamptz,
  removed_by text
);
create unique index credentials_live_name on credentials(tenant, name) where removed_at is null;

alter table credentials enable row level security;
create policy tenant_only on credentials using (tenant = current_setting('app.tenant', true)) with check (tenant = current_setting('app.tenant', true));
grant select, insert, update on credentials to agent_team_app;

-- A team's systems (resources.json: resources and bindings), set only by an admin with a step-up scoped to the team
-- (PUT /v1/teams/{team}/systems), audited with the diff. A run freezes them at start; nothing a run request carries
-- can add a resource, a command or a binding (security review sev2).
create table team_systems (
  tenant text not null references tenants(id),
  team text not null,
  resources jsonb not null default '[]'::jsonb,
  bindings jsonb not null default '[]'::jsonb,
  version integer not null default 1,
  updated_by text not null,
  updated_at timestamptz not null default now(),
  primary key (tenant, team),
  foreign key (team) references teams(id)
);
alter table team_systems enable row level security;
create policy tenant_only on team_systems using (tenant = current_setting('app.tenant', true)) with check (tenant = current_setting('app.tenant', true));
grant select, insert, update on team_systems to agent_team_app;
