-- Meetings in the written-round format (plans/m3-meetings-seams.md and its architect review). A meeting is an
-- instance (mtg_…) of a definition the run was started with (runs.roster.meetings); the control plane drives it
-- through the ordinary deliveries: one meeting.turn per attendee in order, then a closing turn to the facilitator.
-- Every change here is also an event (meeting.opened, .turn, .replied, .skipped, .closed). Money is in the budget's
-- minor units, like usage.recorded.cost. Row-level security as in 001 (no FORCE).
--
-- Rollback: drop table meetings; delete from schema_migrations where name = '006_meetings.sql'. The events stay.

create table meetings (
  id text primary key,
  tenant text not null references tenants(id),
  team text not null references teams(id),
  run text not null references runs(id),
  definition text not null,
  title text not null,
  agenda text not null default '',
  facilitator text not null,
  attendees jsonb not null default '[]',
  if_busy text not null default 'next-pause' check (if_busy in ('next-pause', 'proxy', 'skip')),
  minutes_to_chat boolean not null default true,
  -- open: the round is going; closing: the facilitator has its closing turn; closed: done (see outcome).
  state text not null default 'open' check (state in ('open', 'closing', 'closed')),
  outcome text check (outcome in ('completed', 'capped', 'abandoned')),
  capped boolean not null default false,
  turn int not null default 0,
  turn_event text,
  turn_due timestamptz,
  replies jsonb not null default '[]',
  skipped jsonb not null default '[]',
  minutes text,
  cap bigint not null check (cap > 0),
  currency text not null default 'USD',
  spent bigint not null default 0,
  closed_by_session text,
  close_billed boolean not null default false,
  opened_by text not null,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  version int not null default 1
);
-- One open instance per definition: two starts at once cannot both win.
create unique index meetings_one_open on meetings(team, definition) where state <> 'closed';
create index meetings_run_state on meetings(run, state);
create index meetings_team_opened on meetings(team, opened_at desc);

alter table meetings enable row level security;
create policy tenant_only on meetings using (tenant = current_setting('app.tenant', true)) with check (tenant = current_setting('app.tenant', true));

grant select, insert, update on meetings to agent_team_app;
