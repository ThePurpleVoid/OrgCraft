// The database adapter. PGlite (Postgres compiled to WASM) for local mode and tests; node-postgres for a real
// deployment (DATABASE_URL). Same SQL, same migrations, same row-level security either way.
//
// Two ways in:
//   db.system(sql, params)    as the owner, for migrations, auth lookups and the sink worker's scan.
//   db.tenant(id, fn)         a transaction as agent_team_app with app.tenant set; RLS limits it to that tenant.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

async function pglite(dataDir) {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  await pg.waitReady;
  // PGlite is one connection, so transactions queue up behind each other.
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
  return {
    kind: 'pglite',
    query: (sql, params) => serial(() => pg.query(sql, params)),
    exec: (sql) => serial(() => pg.exec(sql)),
    transaction: (fn) => serial(() => pg.transaction((tx) => fn({ query: (s, p) => tx.query(s, p) }))),
    close: () => pg.close(),
  };
}

async function postgres(url) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url, max: Number(process.env.DATABASE_POOL ?? 10) });
  return {
    kind: 'postgres',
    query: (sql, params) => pool.query(sql, params),
    exec: (sql) => pool.query(sql),
    async transaction(fn) {
      const c = await pool.connect();
      try {
        await c.query('begin');
        const out = await fn({ query: (s, p) => c.query(s, p) });
        await c.query('commit');
        return out;
      } catch (e) {
        await c.query('rollback').catch(() => {});
        throw e;
      } finally { c.release(); }
    },
    close: () => pool.end(),
  };
}

/** Opens the database and brings its schema up to date. `url`: a postgres:// URL, or omit for PGlite (`dataDir`, or in memory). */
export async function openDb({ url, dataDir } = {}) {
  const raw = url ? await postgres(url) : await pglite(dataDir);
  await migrate(raw);
  return {
    kind: raw.kind,
    system: async (sql, params) => (await raw.query(sql, params)).rows,
    tenant: (id, fn) => raw.transaction(async (tx) => {
      await tx.query("select set_config('app.tenant', $1, true)", [id]);
      await tx.query('set local role agent_team_app');
      return fn({ q: async (sql, params) => (await tx.query(sql, params)).rows });
    }),
    close: raw.close,
  };
}

async function migrate(raw) {
  await raw.exec('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  // One migrator at a time across server instances.
  const done = new Set((await raw.query('select name from schema_migrations')).rows.map((r) => r.name));
  for (const name of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(name)) continue;
    const sql = readFileSync(join(MIGRATIONS, name), 'utf8');
    await raw.transaction(async (tx) => {
      await tx.query('select pg_advisory_xact_lock(4848)');
      if ((await tx.query('select 1 from schema_migrations where name = $1', [name])).rows.length) return;
      for (const stmt of split(sql)) await tx.query(stmt);
      await tx.query('insert into schema_migrations(name) values ($1)', [name]);
    });
  }
}

/** Splits a migration into statements, keeping dollar-quoted bodies whole. */
export function split(sql) {
  const out = [];
  let cur = '', tag = null;
  for (const line of sql.split('\n')) {
    if (!tag && /^\s*--/.test(line)) continue;
    cur += `${line}\n`;
    for (const m of line.matchAll(/\$[a-z]*\$/g)) tag = tag === m[0] ? null : tag ?? m[0];
    if (!tag && /;\s*$/.test(line)) { out.push(cur.trim()); cur = ''; }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
