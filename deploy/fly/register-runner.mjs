#!/usr/bin/env node
// Registers the hosted runner, once, by the owner: adding a runner needs a fresh step-up, which only a person can
// give. It asks for the admin token and the step-up secret without echoing them, mints a one-time code, redeems it,
// and prints the runner key once. Paste it into GitHub → Settings → Environments → production as the secret
// AGENT_TEAM_RUNNER_KEY; the Deploy workflow's runner job stages it on the runner app.
//
//   node deploy/fly/register-runner.mjs --server https://<FLY_APP>.fly.dev [--name <FLY_APP>-runner]
//
// Revoke a runner with DELETE /v1/runners/{id} (its id is printed here and listed by GET /v1/runners).
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { ask } from '../server/step-up-hash.mjs';

const { values: o } = parseArgs({ options: { server: { type: 'string' }, name: { type: 'string', default: 'hosted-runner' } } });
const fail = (m) => { console.error(`register-runner: ${m}`); process.exit(1); };
if (!o.server) fail('pass --server https://<control plane>');
const base = o.server.replace(/\/+$/, '');

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
const { code } = await post('/v1/runners/codes', { name: o.name }, { ...auth, 'x-step-up': stepUp });
if (!code) fail('no code in the answer');
const reg = await post('/v1/runners', { code, name: o.name, capabilities: { sandboxes: ['process'], runtimes: ['agent-sdk'] } });
if (!reg.key) fail('no key in the answer');
console.error(`register-runner: registered ${reg.id} as ${o.name}. Paste the line below into GitHub as AGENT_TEAM_RUNNER_KEY, then clear your terminal.`);
process.stdout.write(`${reg.key}\n`);
