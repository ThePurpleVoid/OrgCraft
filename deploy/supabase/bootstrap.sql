-- Run once per Supabase project, as the project's `postgres` user, in the dashboard's SQL editor.
-- It gives the control plane its own login and its own schema, so nothing it stores sits in `public`, which
-- Supabase's Data API (PostgREST) exposes to the anon and authenticated roles.
--
-- Before running: replace REPLACE_WITH_A_GENERATED_PASSWORD with a long random password from your password manager
-- (letters and digits only, so it needs no escaping in a URL). Do not save the edited file or paste it anywhere else;
-- the password goes only into the two connection strings described in docs/deploy/vercel-supabase.md.
--
-- Safe to run again: it changes nothing that already exists except the password.

-- Supabase logs DDL statements by default (log_statement = ddl), which would write the password below into the
-- project's Postgres logs. Turn that off for this connection only; Supabase lets the postgres role do this. (On a
-- plain Postgres where this login may not, it carries on: check your own log settings there.)
do $$ begin
  perform set_config('log_statement', 'none', false);
exception when insufficient_privilege then
  raise notice 'could not turn off statement logging for this connection; check log_statement before setting a password';
end $$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'agent_team_owner') then
    create role agent_team_owner login createrole;
  end if;
end $$;
alter role agent_team_owner with login createrole password 'REPLACE_WITH_A_GENERATED_PASSWORD';
-- The migrator creates the schema itself (deploy/server/migrate.mjs), so it owns everything inside it.
grant create on database postgres to agent_team_owner;
alter role agent_team_owner set search_path = agent_team;
