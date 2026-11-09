-- The budget day in the team's time zone, and spend leases (local PR L24s; CTO review 2 R14 and R4).
--
-- `budgets.time_zone` is an IANA zone: the team's budget day (budget_days.day) runs from local midnight to local
-- midnight, 23 or 25 hours on a daylight-saving day. Default UTC, which is what every team had before.
--
-- `spend_leases`: before a session spends, it takes a lease, an amount from what is left today (and on its run) with an
-- expiry. Outstanding leases count as spent when the next one is granted, so two sessions can't both be given the last
-- dollar, and a runner cut off from the control plane can overshoot by one lease at most. Usage the session reports is
-- added to `used`; a lease ends when it expires, is replaced or is released.
--
-- Additive: one column with a default and a new table. Older servers ignore both.
--
-- Rollback: drop table spend_leases; alter table budgets drop column time_zone;
-- delete from schema_migrations where name = '019_budget_leases.sql'.

alter table budgets add column time_zone text not null default 'UTC' check (length(time_zone) between 1 and 64);

create table spend_leases (
  id text primary key,
  tenant text not null references tenants(id),
  team text not null references teams(id),
  run text,
  session text not null,
  day date not null,
  currency text not null,
  amount bigint not null check (amount > 0),
  used bigint not null default 0 check (used >= 0),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz
);
create index spend_leases_open on spend_leases(team, day) where ended_at is null;
create index spend_leases_session on spend_leases(session) where ended_at is null;

alter table spend_leases enable row level security;
create policy tenant_only on spend_leases using (tenant = current_setting('app.tenant', true)) with check (tenant = current_setting('app.tenant', true));
grant select, insert, update on spend_leases to agent_team_app;
