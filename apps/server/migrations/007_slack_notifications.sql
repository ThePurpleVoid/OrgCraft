-- Slack notifications (PRD 6.8 O1 and O4, CPO story "Slack notifications", D55 to D60). A Slack sink is a team's
-- connection to one Slack workspace: it names the vault entries with the bot token and the sign-in client secret,
-- never the values, so with nothing stored nothing is posted. DMs go only to people who linked their own Slack
-- account and switched kinds on; channel posts only to channels an owner or admin picked. Agents have no route here.
-- (006 is the meetings migration.)
--
-- Rollback: drop table slack_deliveries, slack_channels, slack_links, slack_sinks;
-- delete from schema_migrations where name = '007_slack_notifications.sql'.

create table slack_sinks (
  id text primary key,
  tenant text not null references tenants(id),
  team text not null references teams(id) unique,
  -- The vault entry with the bot token (PUT /secrets/{name}). SLACK_ prefixed, so a sink can never be pointed at
  -- another integration's key.
  secret text not null check (secret ~ '^SLACK_[A-Z0-9_]{1,58}$'),
  -- "Connect Slack" (Sign in with Slack, identity only): the app's client id and the vault entry with its secret.
  client_id text check (client_id ~ '^[0-9]{1,20}\.[0-9]{1,20}$'),
  client_secret text check (client_secret ~ '^SLACK_[A-Z0-9_]{1,58}$'),
  cursor bigint not null default 0,
  failures int not null default 0,
  next_at timestamptz not null default now(),
  last_error text,
  -- The health line (O1): set when a post fails, cleared when posts work again.
  failing_since timestamptz,
  created_at timestamptz not null default now()
);

-- A person's own Slack account for one team (D55, D56): proven by signing in to Slack, never typed.
create table slack_links (
  id text primary key,
  tenant text not null references tenants(id),
  team text not null references teams(id),
  principal text not null,
  slack_user text not null check (slack_user ~ '^[UW][A-Z0-9]{2,20}$'),
  slack_workspace text not null check (slack_workspace ~ '^[TE][A-Z0-9]{2,20}$'),
  slack_name text,
  kinds text[] not null default '{}',
  welcomed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (team, principal)
);

-- Channels an owner or admin picked, per kind (D55). Approval and BLOCKED start off.
create table slack_channels (
  id text primary key,
  tenant text not null references tenants(id),
  team text not null references teams(id),
  channel text not null check (channel ~ '^[CG][A-Z0-9]{2,20}$'),
  name text not null,
  kinds text[] not null default '{}',
  added_by text not null,
  added_by_name text not null,
  created_at timestamptz not null default now(),
  unique (team, channel)
);

-- The delivery log: one row per message tried. A sent (or sent-by-email) row makes a retry skip that target.
create table slack_deliveries (
  id bigserial primary key,
  tenant text not null references tenants(id),
  team text not null references teams(id),
  -- A slack_links or slack_channels id.
  target text not null,
  event text not null,
  kind text not null,
  status text not null check (status in ('sent', 'failed', 'skipped', 'emailed')),
  error text,
  at timestamptz not null default now()
);
create unique index slack_deliveries_once on slack_deliveries(target, event) where status in ('sent', 'emailed');
create index slack_deliveries_team on slack_deliveries(team, at);

do $$ declare t text; begin
  foreach t in array array['slack_sinks', 'slack_links', 'slack_channels', 'slack_deliveries'] loop
    execute format('alter table %I enable row level security', t);
    execute format($p$create policy tenant_only on %I using (tenant = current_setting('app.tenant', true)) with check (tenant = current_setting('app.tenant', true))$p$, t);
  end loop;
end $$;

grant select, insert, update, delete on slack_sinks, slack_links, slack_channels to agent_team_app;
grant select, insert on slack_deliveries to agent_team_app;
grant usage on sequence slack_deliveries_id_seq to agent_team_app;
