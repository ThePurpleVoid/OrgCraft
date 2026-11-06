-- Safe retries and runner registration (M3, issue #28).
--
-- idempotency_keys: every write a person or client makes may carry an Idempotency-Key header (api-v1.yaml,
-- clients.md section 7). The first answer is kept for 24 hours and a retry with the same key gets it back, so a
-- request sent twice from a bad connection acts once.
--
-- runner_codes and runners: a runner is registered once with a one-time code a person mints in the Studio
-- (runner-protocol.md, Authentication). The code and the runner key are kept only as hashes. Lookups by code or key
-- are made as the owner, because the tenant is not known until the hash matches, exactly as for report tokens.
--
-- Rollback: drop table runners, runner_codes, idempotency_keys; delete from schema_migrations where name =
-- '002_idempotency_runners.sql'. Nothing else refers to these tables yet.

create table idempotency_keys (
  tenant text not null references tenants(id),
  principal text not null,
  key text not null check (length(key) between 1 and 255),
  method text not null,
  path text not null,
  request_hash text not null,
  status int,
  response jsonb,
  created_at timestamptz not null default now(),
  primary key (tenant, principal, key)
);
create index idempotency_keys_created on idempotency_keys(created_at);

create table runner_codes (
  hash text primary key,
  tenant text not null references tenants(id),
  name text,
  created_by text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  runner text,
  created_at timestamptz not null default now()
);

create table runners (
  id text primary key,
  tenant text not null references tenants(id),
  name text not null,
  hash text not null,
  capabilities jsonb not null default '{}',
  version text,
  created_at timestamptz not null default now(),
  last_seen timestamptz,
  revoked_at timestamptz
);
create index runners_tenant on runners(tenant);

do $$ declare t text; begin
  foreach t in array array['idempotency_keys', 'runner_codes', 'runners'] loop
    execute format('alter table %I enable row level security', t);
    execute format($p$create policy tenant_only on %I using (tenant = current_setting('app.tenant', true)) with check (tenant = current_setting('app.tenant', true))$p$, t);
  end loop;
end $$;

grant select, insert, update, delete on idempotency_keys to agent_team_app;
grant select, insert, update on runner_codes, runners to agent_team_app;
