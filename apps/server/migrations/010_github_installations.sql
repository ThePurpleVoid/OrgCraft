-- GitHub App installations each workspace has proven it owns (docs/specs/studio-embed.md S9; issue #123, #139).
--
-- The deployment's GitHub App key can mint a token for every installation, that is for every customer. A token is
-- only ever minted, by the hosted Studio or by a runner, for an installation bound here to the tenant. A binding is
-- made by the install callback only: an admin starts it (step-up), GitHub sends the same person back with a user code
-- and the installation id, and the server checks with GitHub, as that person, that they administer the account the app
-- was installed on. See apps/server/github.mjs.
--
-- The install callback runs before a request knows its tenant (the signed state names it), so like 004 and 009 these
-- tables are owner-only (db.system) and agent_team_app has no grant.
--
-- Rollback: drop table github_install_states, github_installations; alter table teams drop column repo;
-- delete from schema_migrations where name = '010_github_installations.sql'.

create table github_installations (
  -- One tenant per installation, ever at once: the hosted Studio caches tokens by installation on that basis.
  installation_id bigint primary key check (installation_id > 0),
  tenant text not null references tenants(id),
  account_login text not null,
  account_id bigint not null,
  account_type text not null check (account_type in ('User', 'Organization')),
  proven_by text not null references people(id),
  -- The GitHub login of the person who proved it, at the time (people.login may change later).
  github_login text not null,
  proven_at timestamptz not null default now(),
  method text not null check (method in ('install-callback'))
);
create index github_installations_tenant on github_installations(tenant);

-- The install callback's state: single use, ten minutes. Only a sha256 of its random part is kept; the rest is an
-- HMAC over the tenant, the person and that random part under the master key.
create table github_install_states (
  hash text primary key,
  tenant text not null references tenants(id),
  person text not null references people(id),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index github_install_states_expires on github_install_states(expires_at);

-- The team's GitHub repository, owner/name: what the hosted Studio edits. Set with PUT /v1/teams/{team}.
alter table teams add column repo text check (repo is null or repo ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$');

revoke all on github_installations, github_install_states from agent_team_app;
revoke all on github_installations, github_install_states from public;
