-- The managed team store (ADR 0012, spec L9 section 4.1): a team with no code host keeps its Git objects, refs and
-- change requests here. Expand-only: teams.backend defaults to 'github', so every existing team is unchanged.
--
-- managed_refs and managed_objects hold the team's whole history. They are excluded from every retention job and go only
-- with the tenant, after the 30-day export window (ADR 0012, "Retention"); the erasure registry lists all four tables as
-- tenant-lifetime stores. Objects are content-addressed and never updated or deleted by the app role.
--
-- Rollback: drop table standing_exports, managed_objects, change_requests, managed_refs; alter table teams drop column
-- backend; delete from schema_migrations where name = '014_managed_store.sql'.

alter table teams add column backend text not null default 'github' check (backend in ('github', 'managed', 'local'));

create table managed_refs (
  tenant text not null references tenants(id),
  team text not null references teams(id),
  name text not null check (name ~ '^(main|cr/[1-9][0-9]{0,8})$'),
  sha text not null check (sha ~ '^[0-9a-f]{40}$'),
  version bigint not null default 1 check (version >= 1),
  updated_at timestamptz not null default now(),
  primary key (tenant, team, name)
);

create table change_requests (
  id text primary key check (id ~ '^cr_[A-Za-z0-9_-]{6,40}$'),
  tenant text not null references tenants(id),
  team text not null references teams(id),
  number int not null check (number >= 1),
  base text check (base is null or base ~ '^[0-9a-f]{40}$'),   -- null: the team's first version
  head text not null check (head ~ '^[0-9a-f]{40}$'),
  title text not null check (length(title) <= 200),
  body text not null default '' check (length(body) <= 65536),
  state text not null default 'open' check (state in ('open', 'accepted', 'closed')),
  checks jsonb,
  capability_diff jsonb not null default '[]'::jsonb,
  needs_code boolean not null default false,
  -- The person who opened it. A change a teammate drafted (a team tool, a lesson-to-brief edit) has the person it acts
  -- for here, and the teammate in author_member: the self-widening check (ADR 0013 rule 2) reads author_member.
  created_by text references people(id),
  author_member text check (author_member is null or author_member ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  accepted_by text references people(id),
  accepted_sha text check (accepted_sha is null or accepted_sha ~ '^[0-9a-f]{40}$'),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  unique (tenant, team, number)
);

create table managed_objects (
  tenant text not null references tenants(id),
  team text not null references teams(id),
  sha text not null check (sha ~ '^[0-9a-f]{40}$'),
  body bytea not null,
  primary key (tenant, team, sha)
);

create table standing_exports (
  tenant text not null references tenants(id),
  team text not null references teams(id),
  connection text not null,
  target text not null,
  cadence text not null check (cadence in ('daily', 'on-publish')),
  last_sha text check (last_sha is null or last_sha ~ '^[0-9a-f]{40}$'),
  last_at timestamptz,
  last_error text,
  primary key (tenant, team)
);

do $$ declare t text; begin
  foreach t in array array['managed_refs', 'change_requests', 'managed_objects', 'standing_exports'] loop
    execute format('alter table %I enable row level security', t);
    execute format($p$create policy tenant_only on %I using (tenant = current_setting('app.tenant', true)) with check (tenant = current_setting('app.tenant', true))$p$, t);
  end loop;
end $$;

grant select, insert, update on managed_refs, change_requests, standing_exports to agent_team_app;
grant select, insert on managed_objects to agent_team_app;
grant delete on standing_exports to agent_team_app;
