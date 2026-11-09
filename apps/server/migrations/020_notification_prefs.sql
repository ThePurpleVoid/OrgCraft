-- L25 notifications: each person's quiet hours and daily digest, per tenant.
-- Quiet hours hold non-urgent email (logged 'held'); the digest gathers what was held plus the kinds the person
-- picked, once a day at their own time. Breakthrough kinds (approvals and budget stops: approval, budget100) are never held. Held
-- mail goes in the digest, or, for an address without one, out on its own when quiet hours end.
-- Rollback: drop table notification_prefs; alter table email_deliveries drop column held; delete from schema_migrations where name = '020_notification_prefs.sql'.

create table notification_prefs (
  tenant text not null references tenants(id),
  principal text not null,
  -- IANA zone, checked by the server (Intl) before it is stored.
  timezone text not null default 'UTC' check (length(timezone) between 1 and 64),
  -- Minutes after local midnight; both null means no quiet hours. start > end wraps past midnight.
  quiet_start smallint check (quiet_start between 0 and 1439),
  quiet_end smallint check (quiet_end between 0 and 1439),
  -- Local minute the digest goes out; null turns the digest off.
  digest_at smallint check (digest_at between 0 and 1439),
  digest_kinds text[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (tenant, principal),
  check ((quiet_start is null) = (quiet_end is null))
);

-- Additive: a held email is a skipped row with held = true (the log shows it as "held"), so the status check stays.
-- A digest is logged against the subscription with event digest-<local date>.
alter table email_deliveries add column held boolean not null default false;
create index email_deliveries_held on email_deliveries(subscription, event) where held;

alter table notification_prefs enable row level security;
create policy tenant_only on notification_prefs using (tenant = current_setting('app.tenant', true)) with check (tenant = current_setting('app.tenant', true));
grant select, insert, update on notification_prefs to agent_team_app;
