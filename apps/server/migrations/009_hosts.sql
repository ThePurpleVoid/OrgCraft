-- One Studio inside your own app, step 2 (docs/specs/studio-embed.md section 6; issue #123). A host is a customer's
-- own site that mounts the Studio and talks to this deployment for chat, runs and the live board. It signs its users
-- in as a confidential OIDC client of this issuer, and its page opens the live stream with a single-use ticket.
--
-- Both tables are read before a request knows its tenant (the issuer looks a client up by id; a ticket is its own
-- proof), so like the identity tables in 004 they are owner-only (db.system) and agent_team_app has no grant.
--
-- Rollback: drop table stream_tickets, host_links, host_clients; delete from schema_migrations where name = '009_hosts.sql'.

create table host_clients (
  id text primary key check (id ~ '^host_[A-Za-z0-9_-]{8,64}$'),
  tenant text not null references tenants(id),
  name text not null check (length(name) between 1 and 100),
  -- The client secret, sealed with the master key (vault.mjs): the issuer compares it in plain, so it is not hashed.
  secret_sealed text not null,
  redirect_uris text[] not null,
  -- The host's page origins: the only origins the live stream answers for this client's tickets (S8).
  origins text[] not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index host_clients_tenant on host_clients(tenant);

-- A person's yes on the host's consent page (security review H2): until then the host gets no grant for them.
-- Unlinking sets revoked_at and revokes that person's tokens for the host.
create table host_links (
  host text not null references host_clients(id),
  person text not null references people(id),
  linked_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (host, person)
);

-- A stream ticket (S8): single use, 60 seconds, read-only, one team, one person. Only its sha256 is kept.
create table stream_tickets (
  hash text primary key,
  tenant text not null references tenants(id),
  team text not null,
  person text not null,
  client text,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index stream_tickets_expires on stream_tickets(expires_at);

revoke all on host_clients, host_links, stream_tickets from agent_team_app;
revoke all on host_clients, host_links, stream_tickets from public;
