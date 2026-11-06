#!/usr/bin/env node
// Brings a Postgres up to the control plane's schema, the same migrations apps/server runs on start, but first:
//   - creates the schema named by the login's search_path (agent_team on Supabase, see deploy/supabase/bootstrap.sql) if missing
//   - lists pending migrations and refuses any that look destructive unless ALLOW_DESTRUCTIVE=1
//   - after migrating, fails if the anon or authenticated roles (Supabase's Data API) can reach any of our tables
//
//   DATABASE_URL=postgres://… node deploy/server/migrate.mjs [--check]
//
// --check only reports what would run. Needs a session connection (direct, or Supabase's session pooler), not a
// transaction pooler. DATABASE_DIRECT_URL wins over DATABASE_URL when both are set.
// Works on any Postgres 15+: the Supabase checks are skipped where those roles do not exist.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER = join(ROOT, 'apps', 'server');
const require = createRequire(join(SERVER, 'package.json'));
const pg = require('pg');
const { openDb } = await import(join(SERVER, 'db.mjs'));
const { destructiveStatements } = await import('./guard.mjs');

const url = process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL;
const checkOnly = process.argv.includes('--check');
if (!url) { console.error('migrate: set DATABASE_URL (a session connection string)'); process.exit(2); }

const c = new pg.Client({ connectionString: url });
await c.connect();
const fail = async (msg) => { console.error(`migrate: ${msg}`); await c.end(); process.exit(1); };
const [{ schema, me, path }] = (await c.query("select current_schema() as schema, current_user as me, current_setting('search_path') as path")).rows;
let target = schema;
if (!target) {
  target = path.split(',')[0].trim().replace(/^"|"$/g, '');
  if (!target || target.startsWith('$')) await fail(`no usable schema on the search_path (${path}) for ${me}`);
  if (checkOnly) console.log(`migrate: would create schema ${target}`);
  else { await c.query(`create schema if not exists ${pg.escapeIdentifier(target)}`); console.log(`migrate: created schema ${target}`); }
}
const exists = target && (await c.query("select to_regclass('schema_migrations') as t")).rows[0].t;
const done = new Set(exists ? (await c.query('select name from schema_migrations')).rows.map((r) => r.name) : []);
const dir = join(SERVER, 'migrations');
const pending = readdirSync(dir).filter((f) => f.endsWith('.sql') && !done.has(f)).sort();
const risky = pending.flatMap((f) => destructiveStatements(readFileSync(join(dir, f), 'utf8')).map((s) => `${f}: ${s.split('\n')[0].slice(0, 120)}`));
console.log(`migrate: ${me} on schema ${target}, ${done.size} applied, ${pending.length} pending${pending.length ? `: ${pending.join(', ')}` : ''}`);
if (risky.length) {
  console.log(`migrate: destructive statements pending:\n  ${risky.join('\n  ')}`);
  if (process.env.ALLOW_DESTRUCTIVE !== '1') await fail('refusing destructive migrations; the owner approves them by re-running with ALLOW_DESTRUCTIVE=1');
}
// Refuse before creating anything in a schema Supabase's Data API roles can already use (public, on Supabase).
const exposed = (await c.query("select r from unnest(array['anon', 'authenticated']) r where exists (select 1 from pg_roles where rolname = r) and has_schema_privilege(r, $1, 'usage')", [target])).rows.map((x) => x.r);
if (exposed.length) await fail(`${exposed.join(' and ')} can use schema ${target}; connect as the agent_team_owner login from deploy/supabase/bootstrap.sql`);
await c.end();
if (checkOnly) process.exit(0);

// The server's own migrator: one at a time (advisory lock), each migration in its own transaction.
if (pending.length) await (await openDb({ url })).close();

// Supabase exposes schemas through its Data API to anon and authenticated. Our tables must not be reachable by them.
const v = new pg.Client({ connectionString: url });
await v.connect();
const roles = (await v.query("select rolname from pg_roles where rolname in ('anon', 'authenticated')")).rows.map((r) => r.rolname);
if (roles.length) {
  const leaks = (await v.query(
    `select r.rolname as role, c.relname as rel from pg_class c join pg_namespace n on n.oid = c.relnamespace
       cross join unnest($1::text[]) as r(rolname)
      where n.nspname = current_schema() and c.relkind in ('r', 'v', 'm', 'S')
        and (has_table_privilege(r.rolname, c.oid, 'select') or has_table_privilege(r.rolname, c.oid, 'insert')
             or has_table_privilege(r.rolname, c.oid, 'update') or has_table_privilege(r.rolname, c.oid, 'delete'))`, [roles])).rows;
  const schemaUse = (await v.query('select r as role from unnest($1::text[]) r where has_schema_privilege(r, current_schema(), \'usage\')', [roles])).rows;
  await v.end();
  if (leaks.length || schemaUse.length) {
    console.error(`migrate: the Data API roles can reach the control plane's schema: ${[...schemaUse.map((x) => `${x.role} has usage on the schema`), ...leaks.map((l) => `${l.role} on ${l.rel}`)].join('; ')}`);
    console.error('migrate: use the agent_team_owner login from deploy/supabase/bootstrap.sql, whose schema is not in public');
    process.exit(1);
  }
  console.log(`migrate: checked ${roles.join(' and ')} cannot reach the schema`);
} else await v.end();
console.log('migrate: up to date');
