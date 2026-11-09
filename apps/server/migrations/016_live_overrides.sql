-- Live overrides (L18, CTO review-2 R2): emergency controls are control-plane state, never Git. Stop everything for a
-- team (kind 'halt') and pausing or switching off one teammate (kind 'member') take effect here, without the code host
-- or a publish. Each is an event and an audit row; an active one shows on the next publish diff as a "Live change", and
-- lifting one needs a passkey (ADR 0013 rule 4: stopping stays cheap, carrying on does not).
--
-- Rollback: drop table live_overrides; delete from schema_migrations where name = '016_live_overrides.sql'.

create table live_overrides (
  id text primary key,
  tenant text not null references tenants(id),
  team text not null references teams(id),
  kind text not null check (kind in ('halt', 'member')),
  role text check ((kind = 'member') = (role is not null)),
  instance text,
  state text not null check (state in ('paused', 'off')),
  runs jsonb not null default '[]'::jsonb,
  reason text check (reason is null or length(reason) <= 500),
  set_by text not null,
  set_at timestamptz not null default now(),
  cleared_at timestamptz,
  cleared_by text,
  cleared_how text check (cleared_how is null or cleared_how = 'lifted')
);
-- At most one active override per team and target; a second "pause" of the same teammate is the same override.
create unique index live_overrides_one_active on live_overrides (team, kind, coalesce(role, ''), coalesce(instance, '')) where cleared_at is null;
create index live_overrides_team on live_overrides (team) where cleared_at is null;

alter table live_overrides enable row level security;
create policy tenant_only on live_overrides using (tenant = current_setting('app.tenant', true)) with check (tenant = current_setting('app.tenant', true));
grant select, insert, update on live_overrides to agent_team_app;
