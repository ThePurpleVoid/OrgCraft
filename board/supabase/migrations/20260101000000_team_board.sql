-- Agent Team Kit: hosted team board.
-- Threads report through the team-report Edge Function (scripts/agent-team/team-status.sh with a write-only token);
-- dashboards read through the same function with a separate read token. Nothing here is reachable with the anon
-- or authenticated keys: RLS is on and only the service role has grants.

-- Append-only. One row per report: a status change, a message between roles (HANDOFF, BUG, SIGNOFF, BLOCKED),
-- a note or a heartbeat. `role` is the brief's file name (backend-dev, qa-web, cto); `instance` tells pool threads
-- apart (a code reviewer per PR, a style thread per direction) and is null for standing roles.
create table if not exists public.team_events (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  role text not null check (role ~ '^[a-z0-9][a-z0-9_-]{0,59}$'),
  instance text check (instance is null or length(instance) between 1 and 60),
  kind text not null check (kind in ('status', 'handoff', 'bug', 'signoff', 'blocked', 'note', 'heartbeat')),
  status text check (status is null or status in ('idle', 'working', 'waiting', 'blocked', 'review', 'done')),
  task text check (task is null or length(task) <= 300),
  issue int,
  pr int,
  branch text check (branch is null or length(branch) <= 200),
  commit text check (commit is null or length(commit) <= 40),
  platform text check (platform is null or length(platform) <= 20),
  to_role text check (to_role is null or length(to_role) <= 60),
  severity int check (severity is null or severity between 1 and 4),
  evidence text[] not null default '{}',
  detail text check (detail is null or length(detail) <= 2000),
  source text check (source is null or length(source) <= 60),
  session text check (session is null or length(session) <= 120)
);
create index if not exists team_events_role_at on public.team_events (role, instance, at desc);
create index if not exists team_events_at on public.team_events (at desc);
alter table public.team_events enable row level security;
revoke all on public.team_events from public, anon, authenticated;
grant all on public.team_events to service_role;

-- Where every agent stands now: its latest status, when it last reported anything, whether it has gone quiet
-- (working or waiting with no report for 30 minutes), and whom it is waiting on.
create or replace view public.team_current with (security_invoker = true) as
with keyed as (
  select e.*, coalesce(e.instance, '') as inst from public.team_events e
), last_any as (
  select distinct on (role, inst) role, inst, at as last_at from keyed order by role, inst, at desc
), last_status as (
  select distinct on (role, inst) * from keyed where status is not null order by role, inst, at desc
), last_msg as (
  select distinct on (role, inst) role, inst, kind, to_role, at as msg_at from keyed
  where kind in ('handoff', 'blocked') and to_role is not null order by role, inst, at desc
)
select s.role, s.instance, s.status, s.task, s.issue, s.pr, s.branch, s.commit, s.platform, s.detail, s.session,
       s.at as status_at, a.last_at,
       extract(epoch from (now() - a.last_at))::int as age_s,
       (s.status in ('working', 'waiting') and a.last_at < now() - interval '30 minutes') as stale,
       case when s.status in ('waiting', 'blocked') and m.msg_at >= s.at - interval '5 seconds' then m.to_role end as waiting_on
from last_status s
join last_any a on a.role = s.role and a.inst = s.inst
left join last_msg m on m.role = s.role and m.inst = s.inst;
revoke all on public.team_current from public, anon, authenticated;
grant select on public.team_current to service_role;

-- The hand-off edges between roles in a window, for flow diagrams.
create or replace view public.team_flow_7d with (security_invoker = true) as
select e.role, e.to_role, count(*) as n, max(e.at) as last_at,
       (array_agg(e.kind order by e.at desc))[1] as last_kind
from public.team_events e
where e.kind in ('handoff', 'bug', 'signoff', 'blocked') and e.to_role is not null and e.at >= now() - interval '7 days'
group by e.role, e.to_role;
revoke all on public.team_flow_7d from public, anon, authenticated;
grant select on public.team_flow_7d to service_role;

-- Keep 90 days. Schedule it with pg_cron if you like: select cron.schedule('team-events-purge', '0 3 * * *',
-- 'select public.team_events_purge()');
create or replace function public.team_events_purge() returns void
language sql security definer set search_path = '' as $$
  delete from public.team_events where at < now() - interval '90 days';
$$;
revoke all on function public.team_events_purge() from public, anon, authenticated;
