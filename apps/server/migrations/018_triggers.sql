-- Triggers (N2, local PR L21; plans/n8n/n2-triggers-architecture.md section 7). A trigger is a wake-up (ADR 0010):
-- a webhook, a schedule or an event inside the team wakes one teammate with trusted text the owner wrote. Only
-- verified, unique, in-ceiling signals reach the event log; rejections, duplicates and floods are rows here, never
-- events. Unsigned floods are counted in memory and written as one row per hook per minute (CTO R6).
--
-- The body of a signal is outside data: it stays in `inbound.body`, deleted with the row at keep_until, and never in
-- the append-only log. (It moves to step_io with `outside: true` once the run inspector's storage is merged.)
--
-- Rollback: drop table trigger_state; drop table inbound_outcomes; drop table inbound; drop table hooks;
-- alter table runs drop column triggers; delete from schema_migrations where name = '018_triggers.sql'.

create table hooks (
  id text primary key,
  tenant text not null references tenants(id),
  team text not null references teams(id),
  name text not null check (name ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  scheme text not null check (scheme in ('hmac', 'bearer')),
  secret_name text not null,
  prev_secret_name text,
  prev_expires timestamptz,
  state text not null default 'active' check (state in ('active', 'revoked')),
  created_by text not null,
  created_at timestamptz not null default now(),
  last_at timestamptz
);
create unique index hooks_team_name on hooks (team, name) where state = 'active';

create table inbound (
  id text primary key,
  tenant text not null references tenants(id),
  team text not null references teams(id),
  hook text not null references hooks(id),
  kind text,
  dedupe_key text,
  state text not null check (state in ('rejected', 'duplicate', 'over-ceiling', 'accepted', 'queued', 'expired')),
  reason text,
  summary text,
  fields jsonb,
  body text check (body is null or length(body) <= 262144),
  dupes int not null default 0,
  received_at timestamptz not null default now(),
  keep_until timestamptz not null
);
create unique index inbound_dedupe on inbound (team, hook, dedupe_key) where dedupe_key is not null and state <> 'rejected';
create index inbound_hook_time on inbound (team, hook, received_at desc);
create index inbound_queued on inbound (team, received_at) where state = 'queued';

create table inbound_outcomes (
  inbound text not null references inbound(id) on delete cascade,
  trigger text not null,
  tenant text not null references tenants(id),
  team text not null references teams(id),
  outcome text not null check (outcome in ('fired', 'filtered', 'held')),
  detail text,
  event text,
  at timestamptz not null default now(),
  primary key (inbound, trigger)
);

create table trigger_state (
  tenant text not null references tenants(id),
  team text not null references teams(id),
  trigger text not null,
  last_slot timestamptz,
  window_start timestamptz,
  window_count int not null default 0,
  held_count int not null default 0,
  held_noted timestamptz,
  last_fired timestamptz,
  primary key (team, trigger)
);

alter table runs add column triggers jsonb;

do $$ declare t text; begin
  foreach t in array array['hooks', 'inbound', 'inbound_outcomes', 'trigger_state'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy tenant_only on %I using (tenant = current_setting(''app.tenant'', true)) with check (tenant = current_setting(''app.tenant'', true))', t);
  end loop;
end $$;
grant select, insert, update on hooks, inbound_outcomes, trigger_state to agent_team_app;
grant select, insert, update, delete on inbound to agent_team_app;
