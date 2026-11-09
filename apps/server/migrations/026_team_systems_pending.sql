-- L40b: a team's systems change waiting on its pull request. In PR mode the Studio's publish does not change main, so
-- the admin's confirmation (PUT /v1/teams/{team}/systems with pending { sha }, step-up scoped systems:<team>) is stored
-- here, bound to the commit and to the systems version it was confirmed against. It becomes the team's systems only
-- when team.published for exactly that commit arrives, and only if the base has not moved. A newer pending set
-- replaces it; closing the PR (DELETE …/systems/pending) or 30 days drop it. One per team.
--
-- Rollback: drop table team_systems_pending; delete from schema_migrations where name = '026_team_systems_pending.sql'.

create table team_systems_pending (
  tenant text not null references tenants(id),
  team text not null references teams(id),
  sha text not null check (sha ~ '^[0-9a-f]{40}$'),
  pr integer check (pr is null or pr > 0),
  resources jsonb not null default '[]'::jsonb,
  bindings jsonb not null default '[]'::jsonb,
  -- The team_systems version the person saw the capability diff against (0 when there were none).
  expect integer not null check (expect >= 0),
  created_by text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (tenant, team)
);
alter table team_systems_pending enable row level security;
create policy tenant_only on team_systems_pending using (tenant = current_setting('app.tenant', true)) with check (tenant = current_setting('app.tenant', true));
grant select, insert, update, delete on team_systems_pending to agent_team_app;
