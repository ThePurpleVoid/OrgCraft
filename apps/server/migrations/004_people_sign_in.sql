-- Signing in (M4, docs/specs/m4-sign-in.md section 4): who a person is, their sessions and tokens, and the
-- workspaces they belong to.
--
-- Identity is looked up before a request knows its tenant, so people, person_sessions, oauth_tokens, passkeys and
-- the issuer's own storage are tenant-less and read and written only by the owner role (db.system, like the report
-- token lookup in 001). agent_team_app gets no grant on them. members and invitations are tenant-scoped under RLS on
-- app.tenant like every table in 001; the one cross-tenant read (a person's tenants, open invitations at sign-in) is
-- done by the owner role.
--
-- Rollback: drop table identity_audit, issuer_keys, oidc_store, oauth_tokens, person_sessions, passkeys,
-- invitations, members, people; delete from schema_migrations where name = '004_people_sign_in.sql'.

create table people (
  id text primary key check (id ~ '^per_[A-Za-z0-9_-]{8,64}$'),
  provider text not null check (provider in ('github')),
  -- The upstream's stable user id (GitHub's numeric id), never the login, which can be renamed and reused.
  subject text not null check (subject ~ '^[0-9]{1,20}$'),
  login text not null,
  name text,
  -- Only the upstream's verified primary email, or null.
  email text,
  created_at timestamptz not null default now(),
  unique (provider, subject)
);

-- A web sign-in: the __Host-agent-team cookie holds a random 32-byte id, and only its sha256 is kept here.
create table person_sessions (
  id_hash text primary key,
  person text not null references people(id),
  client text not null,
  device text,
  auth_time timestamptz not null,
  -- For audit only: no gate ever reads these (ADR 0007, K2).
  last_step_up timestamptz,
  amr text[] not null default '{}',
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index person_sessions_person on person_sessions(person);

-- The issuer's access and refresh tokens (apps and the CLI), by sha256 of the opaque value. family is the grant:
-- reusing a rotated refresh token revokes every token of the family. device is the key a refresh token is bound to.
create table oauth_tokens (
  hash text primary key,
  kind text not null check (kind in ('access', 'refresh')),
  person text,
  client text not null,
  session text,
  family text,
  device text,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz
);
create index oauth_tokens_family on oauth_tokens(family);
create index oauth_tokens_person on oauth_tokens(person);

-- The issuer library's other short-lived records (interactions, codes, grants, its own sessions, replay ids), and
-- the upstream sign-in's state. Keyed by sha256 of their id, so a stolen table does not hand out live codes.
create table oidc_store (
  model text not null,
  id_hash text not null,
  payload jsonb not null,
  grant_id text,
  uid text,
  expires_at timestamptz,
  consumed_at timestamptz,
  primary key (model, id_hash)
);
create index oidc_store_grant on oidc_store(grant_id) where grant_id is not null;
create index oidc_store_uid on oidc_store(model, uid) where uid is not null;
create index oidc_store_expires on oidc_store(expires_at);

-- The issuer's signing keys (ES256), sealed under the master key. Made on first start, rotated every 90 days, the
-- previous one kept for a day so tokens it signed still verify.
create table issuer_keys (
  kid text primary key,
  sealed text not null,
  created_at timestamptz not null default now(),
  retired_at timestamptz
);

-- Sign-in events that belong to a person rather than a tenant: a refresh token reused, a sign-in refused.
create table identity_audit (
  id bigserial primary key,
  at timestamptz not null default now(),
  person text,
  action text not null,
  detail jsonb not null default '{}'
);

-- Passkeys (order 2 fills these): tenant-less, like people.
create table passkeys (
  id text primary key,
  person text not null references people(id),
  credential_id text not null unique,
  public_key text not null,
  sign_count bigint not null default 0,
  name text not null,
  created_at timestamptz not null default now(),
  last_used timestamptz
);
create index passkeys_person on passkeys(person);

create table members (
  id text primary key,
  tenant text not null references tenants(id),
  person text not null references people(id),
  role text not null check (role in ('owner', 'admin', 'editor', 'viewer', 'approver')),
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  unique (tenant, person)
);
create index members_person on members(person) where removed_at is null;

create table invitations (
  id text primary key,
  tenant text not null references tenants(id),
  provider text not null default 'github' check (provider in ('github')),
  -- The numeric upstream user id, resolved when the invitation is made (S2), or a verified primary email.
  subject text check (subject ~ '^[0-9]{1,20}$'),
  email text,
  role text not null check (role in ('owner', 'admin', 'editor', 'viewer', 'approver')),
  invited_by text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by text references people(id),
  check (subject is not null or email is not null)
);
create index invitations_subject on invitations(provider, subject) where accepted_at is null;
create index invitations_email on invitations(lower(email)) where accepted_at is null;

do $$ declare t text; begin
  foreach t in array array['members', 'invitations'] loop
    execute format('alter table %I enable row level security', t);
    execute format($p$create policy tenant_only on %I using (tenant = current_setting('app.tenant', true)) with check (tenant = current_setting('app.tenant', true))$p$, t);
  end loop;
end $$;
grant select, insert, update on members, invitations to agent_team_app;
-- Belt and braces: whatever a host's defaults grant, the app role cannot touch identity.
revoke all on people, person_sessions, oauth_tokens, oidc_store, issuer_keys, identity_audit, passkeys from agent_team_app;
revoke all on people, person_sessions, oauth_tokens, oidc_store, issuer_keys, identity_audit, passkeys from public;
