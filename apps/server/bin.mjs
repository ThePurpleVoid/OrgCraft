#!/usr/bin/env node
// agent-team-server: the control plane. Local mode keeps everything in one folder (PGlite); a deployment sets
// DATABASE_URL and passes the keys in the environment.
//
//   agent-team-server [--port 4849] [--host 127.0.0.1] [--data ~/.agent-team/server]
//
// Environment:
//   DATABASE_URL            postgres://… (omit for local mode, which stores the database in --data)
//   AGENT_TEAM_MASTER_KEY   32 bytes, base64: seals secrets. Local mode makes one in --data/master.key
//   AGENT_TEAM_ADMIN_TOKEN  bearer token for people until sign-in lands. Local mode makes one in --data/admin.token
//   AGENT_TEAM_TENANT       the tenant this server signs people in to (default: local)
//   AGENT_TEAM_PUBLIC_URL   how others reach this server, used in report URLs (default: the request's host)
//   AGENT_TEAM_STEP_UP_SECRET_HASH  scrypt hash of the step-up secret a person types before approving or raising a
//                           budget. `agent-team-server --hash-step-up` reads a secret on stdin and prints its hash.
//                           Local mode makes a secret in --data/step-up.secret
//   CRON_SECRET             lets a cron call POST /v1/internal/tick (the server also ticks itself every 15 s)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openDb } from './db.mjs';
import { masterKey } from './vault.mjs';
import { ensureTenant } from './store.mjs';
import { startSinks } from './sinks.mjs';
import { createControlPlane } from './server.mjs';
import { hashStepUpSecret, stepUpVerifier } from './m3.mjs';

const { values: o } = parseArgs({ options: {
  port: { type: 'string', default: process.env.PORT ?? '4849' },
  host: { type: 'string', default: process.env.HOST ?? '127.0.0.1' },
  data: { type: 'string', default: process.env.AGENT_TEAM_DATA ?? join(homedir(), '.agent-team', 'server') },
  help: { type: 'boolean', short: 'h' },
  'hash-step-up': { type: 'boolean' },
} });
if (o.help) { console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, readFileSync(new URL(import.meta.url), 'utf8').split('\n').findIndex((l) => l.startsWith('import'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(0); }

if (o['hash-step-up']) {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  console.log(await hashStepUpSecret(Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')));
  process.exit(0);
}

const env = process.env;
const local = !env.DATABASE_URL;
const data = resolve(o.data);
/** A value from the environment, or (local mode only) one kept in a private file in the data folder. */
function keep(name, file, make) {
  if (env[name]) return env[name];
  if (!local) { console.error(`agent-team-server: set ${name}`); process.exit(2); }
  const path = join(data, file);
  if (!existsSync(path)) writeFileSync(path, make(), { mode: 0o600 });
  return readFileSync(path, 'utf8').trim();
}
if (local) mkdirSync(join(data, 'db'), { recursive: true, mode: 0o700 });
const key = masterKey(keep('AGENT_TEAM_MASTER_KEY', 'master.key', () => randomBytes(32).toString('base64')));
const adminToken = keep('AGENT_TEAM_ADMIN_TOKEN', 'admin.token', () => `adm_${randomBytes(24).toString('base64url')}`);
const tenant = env.AGENT_TEAM_TENANT ?? 'local';
// The step-up secret is never kept in plain text by the server: only its scrypt hash (issue #28 D3).
let stepUpHash = env.AGENT_TEAM_STEP_UP_SECRET_HASH ?? null;
if (!stepUpHash && local) {
  const hashFile = join(data, 'step-up.hash');
  if (!existsSync(hashFile)) {
    const secret = randomBytes(15).toString('base64url');
    writeFileSync(join(data, 'step-up.secret'), `${secret}\n`, { mode: 0o600 });
    writeFileSync(hashFile, await hashStepUpSecret(secret), { mode: 0o600 });
  }
  stepUpHash = readFileSync(hashFile, 'utf8').trim();
}
const verifier = stepUpHash ? stepUpVerifier(stepUpHash) : null;
if (!verifier) console.error('agent-team-server: no AGENT_TEAM_STEP_UP_SECRET_HASH, so approvals and raising budgets are refused');

const db = await openDb(local ? { dataDir: join(data, 'db') } : { url: env.DATABASE_URL });
await ensureTenant(db, tenant);
const sinks = startSinks(db, key);
const server = createControlPlane({ db, key, tenant, adminToken, publicUrl: env.AGENT_TEAM_PUBLIC_URL ?? '', sinks, stepUpVerifier: verifier });
server.listen(Number(o.port), o.host, () => {
  console.log(`Agent Team control plane on http://${o.host}:${server.address().port}/v1 (${db.kind}${local ? `, data in ${data}` : ''})`);
  if (local) console.log(`Admin token: ${join(data, 'admin.token')}\nStep-up secret (typed before approving): ${join(data, 'step-up.secret')}`);
});
const stop = async () => { sinks.stop(); server.runners.closeAll(); server.close(); await db.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
