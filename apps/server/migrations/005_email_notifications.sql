-- Email notifications (PRD 6.8, CPO story "Email notifications", D49 to D54). An email sink belongs to one team and
-- names a provider, a sender and the vault secret that holds the provider's key; with no key stored, nothing is sent.
-- Recipients are only addresses a person added for themselves and verified with a code, and only for the kinds
-- they switched on. Agents have no route here.
--
-- Rollback: drop table email_deliveries, email_code_events, email_subscriptions, email_sinks;
-- delete from schema_migrations where name = '005_email_notifications.sql'.

-- An email sink is its own table rather than a new format of sinks: it has no URL, and widening sinks' checks would
-- need dropping them. The sink worker drains both the same way: a cursor per sink, in order, at least once.
create table email_sinks (
  id text primary key,
  tenant text not null references tenants(id),
  team text not null references teams(id),
  provider text not null,
  sender text not null,
  -- The vault entry with the provider's API key (PUT /secrets/{name}), never the key itself.
  -- EMAIL_ prefixed, so a sink can never be pointed at another integration's key (security review).
  secret text not null check (secret ~ '^EMAIL_[A-Z0-9_]{1,58}$'),
  cursor bigint not null default 0,
  failures int not null default 0,
  next_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now()
);

create table email_subscriptions (
  id text primary key,
  tenant text not null references tenants(id),
  team text not null references teams(id),
  -- Who added it: a person's id, or "admin" for the local admin token. Only they see and change it.
  principal text not null,
  email text not null,
  -- The kinds switched on (approval, budget80, budget100, blocked, minutes). Empty until the person chooses.
  kinds text[] not null default '{}',
  code_hash text,
  code_expires timestamptz,
  code_tries int not null default 0,
  code_sent_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  unique (team, principal, email)
);
create index email_subscriptions_team on email_subscriptions(team) where verified_at is not null;

-- Codes sent and wrong codes typed, per person, for the daily caps (security review).
create table email_code_events (
  id bigserial primary key,
  tenant text not null references tenants(id),
  principal text not null,
  what text not null check (what in ('sent', 'wrong')),
  at timestamptz not null default now()
);
create index email_code_events_principal on email_code_events(principal, at);

-- The delivery log (O6): one row per message tried. A sent row makes a retry skip that recipient.
create table email_deliveries (
  id bigserial primary key,
  tenant text not null references tenants(id),
  team text not null references teams(id),
  subscription text not null references email_subscriptions(id) on delete cascade,
  event text not null,
  kind text not null,
  status text not null check (status in ('sent', 'failed', 'skipped')),
  provider_id text,
  error text,
  at timestamptz not null default now()
);
create unique index email_deliveries_once on email_deliveries(subscription, event) where status = 'sent';
create index email_deliveries_team on email_deliveries(team, at);

do $$ declare t text; begin
  foreach t in array array['email_sinks', 'email_subscriptions', 'email_deliveries', 'email_code_events'] loop
    execute format('alter table %I enable row level security', t);
    execute format($p$create policy tenant_only on %I using (tenant = current_setting('app.tenant', true)) with check (tenant = current_setting('app.tenant', true))$p$, t);
  end loop;
end $$;

grant select, insert, update, delete on email_sinks, email_subscriptions to agent_team_app;
grant select, insert on email_deliveries, email_code_events to agent_team_app;
grant usage on sequence email_deliveries_id_seq, email_code_events_id_seq to agent_team_app;
