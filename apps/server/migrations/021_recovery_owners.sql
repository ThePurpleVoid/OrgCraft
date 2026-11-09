-- L27 (B15, rule 11 Now minimum): a workspace names its recovery owners, people who can still get in and put things
-- right when another owner loses their way in (a GitHub account gone, a passkey lost). A recovery owner is an owner
-- of the workspace with a passkey, so they never depend on GitHub alone. Adding one widens access, so it takes
-- effect after 24 hours (security review 2, rule 2) and every owner is told; removing one is at once.
--
-- Rollback: drop table recovery_owners; delete from schema_migrations where name = '021_recovery_owners.sql'.

create table recovery_owners (
  id text primary key,
  tenant text not null references tenants(id),
  person text not null references people(id),
  added_by text not null,
  added_at timestamptz not null default now(),
  -- When it counts: added_at plus 24 hours, or at once for the first one an owner names themselves as.
  effective_at timestamptz not null,
  removed_at timestamptz,
  removed_by text
);
create unique index recovery_owners_live on recovery_owners(tenant, person) where removed_at is null;

alter table recovery_owners enable row level security;
create policy tenant_only on recovery_owners using (tenant = current_setting('app.tenant', true)) with check (tenant = current_setting('app.tenant', true));
grant select, insert, update on recovery_owners to agent_team_app;
