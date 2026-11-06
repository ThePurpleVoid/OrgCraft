#!/usr/bin/env node
// Registers the hosted runner, once, by the owner: adding a runner needs a fresh step-up, which only a person can
// give. It asks for the admin token and the step-up secret without echoing them, mints a one-time code, redeems it,
// and prints the runner key once. Paste it into GitHub → Settings → Environments → production as the secret
// AGENT_TEAM_RUNNER_KEY; the Deploy workflow's runner job stages it on the runner app.
//
//   node deploy/fly/register-runner.mjs --server https://<FLY_APP>.fly.dev [--name <runner name>]
//
// The name defaults to <FLY_APP>-runner for a fly.dev server.
//
// Revoke a runner with DELETE /v1/runners/{id} (its id is printed here and listed by GET /v1/runners).
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { ask } from '../server/step-up-hash.mjs';

const { values: o } = parseArgs({ options: { server: { type: 'string' }, name: { type: 'string' } } });
const fail = (m) => { console.error(`register-runner: ${m}`); process.exit(1); };
if (!o.server) fail('pass --server https://<control plane>');
let url;
try { url = new URL(o.server); } catch { fail(`not a URL: ${o.server}`); }
// The admin token and the step-up secret go over this connection: https only, except to this machine.
const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) fail('--server must be https (http only for localhost)');
const base = url.origin;
// <FLY_APP>-runner for https://<FLY_APP>.fly.dev, the app the Deploy workflow's runner job creates.
const name = o.name ?? (url.hostname.endsWith('.fly.dev') ? `${url.hostname.split('.')[0]}-runner` : 'hosted-runner');

async function post(path, body, headers = {}) {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID(), ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  }).catch((e) => fail(`could not reach ${base}: ${e.message}`));
  const b = await r.json().catch(() => ({}));
  if (!r.ok) fail(`${path} answered ${r.status}: ${b.error ?? b.title ?? b.detail ?? 'no detail'}`);
  return b;
}

const token = (await ask('Admin token (not shown): ')).trim();
const secret = await ask('Step-up secret (not shown): ');
if (!token || !secret) fail('both are needed');
const auth = { authorization: `Bearer ${token}` };
const { token: stepUp } = await post('/v1/auth/step-up', { secret }, auth);
if (!stepUp) fail('no step-up token in the answer');
const { code } = await post('/v1/runners/codes', { name }, { ...auth, 'x-step-up': stepUp });
if (!code) fail('no code in the answer');
const reg = await post('/v1/runners', { code, name, capabilities: { sandboxes: ['process'], runtimes: ['agent-sdk'] } });
if (!reg.key) fail('no key in the answer');
console.error(`register-runner: registered ${reg.id} as ${name}. Paste the line below into GitHub as AGENT_TEAM_RUNNER_KEY, then clear your terminal.`);
process.stdout.write(`${reg.key}\n`);
