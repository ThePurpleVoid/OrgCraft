#!/usr/bin/env node
// agent-team-runner: the data plane. It connects out to a control plane and runs the role sessions it is given.
//
//   agent-team-runner register --server <url> --code <one-time code> [--name <name>]
//   agent-team-runner start [--server <url>] [--max-sessions 8] [--effort <level>]
//
// register trades a one-time code (made in the Studio) for a runner key, kept in --data/runner.json, readable only
// by you. start connects with that key. Clones and worktrees live in --data (default ~/.agent-team/runner).
//
// Environment:
//   AGENT_TEAM_RUNNER_KEY    the runner key (instead of runner.json; for deployments)
//   AGENT_TEAM_SERVER        the control plane's URL (instead of --server)
//   ANTHROPIC_API_KEY        the model key. It stays in this process: sessions reach the model through a loopback
//                            proxy with a token of their own
//   AGENT_TEAM_RUNNER_GITCONFIG  a git config with the runner's push credential (a helper for a token that can push
//                            branches but not the default branch); sessions never see it
//
// Run it in a container as its own user (Dockerfile). On a bare machine, sessions share the OS user with the runner,
// which this process cannot fully wall off; that is not a supported deployment.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { agentSdkAdapter } from './adapters/agent-sdk.mjs';
import { startRunner } from './runner.mjs';
import { useGitConfig } from './worktree.mjs';

const { values: o, positionals: [cmd] } = parseArgs({ allowPositionals: true, options: {
  server: { type: 'string', default: process.env.AGENT_TEAM_SERVER },
  code: { type: 'string' },
  name: { type: 'string', default: hostname() },
  data: { type: 'string', default: process.env.AGENT_TEAM_RUNNER_DATA ?? join(homedir(), '.agent-team', 'runner') },
  'max-sessions': { type: 'string', default: '8' },
  effort: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} });
const usage = () => { const l = readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1); return l.slice(0, l.findIndex((x) => !x.startsWith('//'))).map((x) => x.replace(/^\/\/ ?/, '')).join('\n'); };
if (o.help || !['register', 'start'].includes(cmd)) { console.log(usage()); process.exit(o.help ? 0 : 64); }

const data = resolve(o.data);
const file = join(data, 'runner.json');
const fail = (m) => { console.error(`agent-team-runner: ${m}`); process.exit(2); };

if (cmd === 'register') {
  if (!o.server || !o.code) fail('register needs --server and --code');
  const res = await fetch(`${o.server.replace(/\/+$/, '')}/v1/runners`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: o.code, name: o.name, capabilities: { sandboxes: ['process'], runtimes: ['agent-sdk'] } }),
  }).catch((e) => fail(`could not reach ${o.server}: ${e.message}`));
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.key) fail(`registration refused (${res.status}): ${body.error ?? 'no key in the answer'}`);
  mkdirSync(data, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ server: o.server, id: body.id, key: body.key }, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
  console.log(`Registered runner ${body.id}. Start it with: agent-team-runner start`);
  process.exit(0);
}

const saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
const server = o.server ?? saved.server;
const key = process.env.AGENT_TEAM_RUNNER_KEY ?? saved.key;
if (!server || !key) fail('not registered: run agent-team-runner register --server <url> --code <code> first');
mkdirSync(data, { recursive: true, mode: 0o700 });
useGitConfig(process.env.AGENT_TEAM_RUNNER_GITCONFIG ?? join(data, 'gitconfig'));

const runner = startRunner({
  server, key, root: data, id: saved.id ?? o.name, maxSessions: Number(o['max-sessions']) || 8,
  adapter: agentSdkAdapter({ effort: o.effort }),
  log: (m) => console.error(`[runner] ${m}`),
});
runner.link.on('open', () => console.error(`[runner] connected to ${server}`));
runner.ready.then((w) => console.error(`[runner] ready (${w.protocol ?? 'runner/1'}), tenant ${w.tenant ?? '?'}`));
let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => {
  if (stopping) process.exit(1);
  stopping = true;
  console.error('[runner] stopping: finishing the current step of each session and saving its work (again to force)');
  await runner.close({ mode: 'finish-step' });
  process.exit(0);
});
