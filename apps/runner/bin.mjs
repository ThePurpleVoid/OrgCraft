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
//   AGENT_TEAM_PREVIEW_CREATORS, AGENT_TEAM_PREVIEW_HOSTS  comma lists: whose deployment statuses give the Ready to
//                    try link (default vercel[bot],netlify[bot]; github-actions[bot] never) and, if set, which domains
//   AGENT_TEAM_MERGER_APP_ID  the merger GitHub App; its key is AGENT_TEAM_MERGER_APP_KEY (the PEM), or the file
//                    --data/merger-app.pem (or AGENT_TEAM_MERGER_APP_KEY_FILE).
//                    With both, the runner opens each session's pull request and merges it after approval.
//   AGENT_TEAM_PROPOSALS=local  the dry run: pull requests on a stand-in bare repository instead
//   AGENT_TEAM_RUNNER_ADAPTER=dryrun with AGENT_TEAM_DRYRUN_CONTROL=<folder>  the dry run's scripted fake model
//                    (adapters/dryrun.mjs; refused with a model key set)
//   AGENT_TEAM_RUNNER_GITCONFIG  a git config with the runner's push credential (a helper for a token that can push
//                            branches but not the default branch); sessions never see it
//
//   AGENT_TEAM_SANDBOX_UID, AGENT_TEAM_SANDBOX_GID, AGENT_TEAM_SANDBOX_EXEC
//                            run every session as this user and group, switched with this setpriv (the Dockerfile
//                            sets all three). The data folder is then closed to sessions; their clones, homes and
//                            memory files live in AGENT_TEAM_RUNNER_WORK
//   AGENT_TEAM_RUNNER_WORK   the folder sessions may reach (default: the data folder, when there is no sandbox)
//   AGENT_TEAM_RUNNER_UNSANDBOXED=1  start without a sandbox even with a model key set (development only; without it
//                            the runner refuses)
//
// Run it in the container (Dockerfile): the runner as one user, sessions as another. Without the sandbox settings,
// sessions share the runner's OS user and could read its environment; that is for development only.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { agentSdkAdapter } from './adapters/agent-sdk.mjs';
import { dryrunAdapter } from './adapters/dryrun.mjs';
import { startRunner } from './runner.mjs';
import { checkServer } from './link.mjs';
import { githubProposals, localProposals } from './proposals.mjs';
import { useGitConfig } from './worktree.mjs';
import { crossCheck, hardlinksProtected, parseSlots, privateDir, sandboxPool, selfCheck } from './sandbox.mjs';

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
  let base;
  try { base = checkServer(o.server); } catch (e) { fail(e.message); }
  const res = await fetch(`${base}/v1/runners`, {
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
try { checkServer(server); } catch (e) { fail(e.message); }
mkdirSync(data, { recursive: true, mode: 0o700 });
const id = (v) => (v === undefined || v === '' ? undefined : Number(v));
// The agent users: a pool (AGENT_TEAM_SANDBOX_UIDS, each uid with a group of the same number; the image's default),
// one per live session (#28), with AGENT_TEAM_SANDBOX_GID as the shared work group; or one shared user
// (AGENT_TEAM_SANDBOX_UID), which serves one team only.
const exec = process.env.AGENT_TEAM_SANDBOX_EXEC || 'setpriv';
let sandbox = null;
try {
  if (process.env.AGENT_TEAM_SANDBOX_UIDS) sandbox = sandboxPool({ slots: parseSlots(process.env.AGENT_TEAM_SANDBOX_UIDS), sharedGid: id(process.env.AGENT_TEAM_SANDBOX_GID), exec });
  else if (process.env.AGENT_TEAM_SANDBOX_UID) sandbox = { uid: id(process.env.AGENT_TEAM_SANDBOX_UID), gid: id(process.env.AGENT_TEAM_SANDBOX_GID), exec };
} catch (e) { fail(`the sandbox settings are wrong: ${e.message}`); }
let work = data;
if (sandbox) {
  if (!process.env.AGENT_TEAM_RUNNER_WORK) fail('a sandbox needs AGENT_TEAM_RUNNER_WORK, a folder outside the data folder');
  work = resolve(process.env.AGENT_TEAM_RUNNER_WORK);
  if (work === data || work.startsWith(`${data}/`)) fail('AGENT_TEAM_RUNNER_WORK must be outside the data folder, which sessions cannot reach');
  process.umask(0o007); // what the runner makes for a session is shared with it through the group, and no one else
  privateDir(data);
  // Check the sandbox this platform actually gives before taking any session: every agent user, and, for a pool,
  // that one cannot reach another's folder and that hard links are protected (review of #28, C).
  const slots = sandbox.slots ?? [sandbox];
  if (sandbox.slots && !hardlinksProtected()) fail('refusing to start: fs.protected_hardlinks is not 1 here, so one agent user could hard-link another\'s files; a pool of agent users needs it');
  const problems = slots.flatMap((s) => selfCheck(s, { data }).problems);
  if (sandbox.slots) problems.push(...crossCheck(sandbox, work).problems);
  if (problems.length) fail(`refusing to start: the sandbox does not hold here: ${problems.join('; ')}`);
  console.error(`[runner] sandbox checked: sessions run as ${sandbox.slots ? `their own uid (${slots.length} agent users, one per live session)` : `uid ${sandbox.uid}, one team only`}, cannot read this process's environment or ${data}, and have no capabilities`);
} else if (process.env.ANTHROPIC_API_KEY && process.env.AGENT_TEAM_RUNNER_UNSANDBOXED !== '1') {
  // A real model key in a runner whose sessions share its user would be readable by every session (F3).
  fail('refusing to start: ANTHROPIC_API_KEY is set but there is no sandbox. Run the runner in its container (apps/runner/Dockerfile); for development only, AGENT_TEAM_RUNNER_UNSANDBOXED=1 overrides this');
} else {
  console.error('[runner] warning: no sandbox (AGENT_TEAM_SANDBOX_UID); sessions run as this user and could read its environment. Development only.');
}
try { useGitConfig(process.env.AGENT_TEAM_RUNNER_GITCONFIG ?? join(data, 'gitconfig')); } catch (e) { console.error(`agent-team-runner: ${e.message}`); process.exit(2); }

// Who opens and merges the session's pull request (runner-protocol, Proposals). The merger GitHub App when its id
// and key are there (M3 on a Mac installs the key into the data folder), or the stand-in remote of the dry run.
let proposals = null;
const appKey = process.env.AGENT_TEAM_MERGER_APP_KEY_FILE ?? join(data, 'merger-app.pem');
const control = process.env.AGENT_TEAM_DRYRUN_CONTROL;
// The dry run's hold: while <control>/hold-merge exists, an approved merge waits (so a test can move the head first).
const hold = async () => { while (control && existsSync(join(control, 'hold-merge'))) await new Promise((r) => setTimeout(r, 200)); };
if (process.env.AGENT_TEAM_PROPOSALS === 'local') proposals = localProposals({ before: hold });
else if (process.env.AGENT_TEAM_MERGER_APP_ID && (process.env.AGENT_TEAM_MERGER_APP_KEY || existsSync(appKey))) {
  // A hosted runner gets the key as a secret in its environment (sessions cannot read that, F3); on a Mac, a file.
  // Preview links (G-12) only from these hosts' apps (default vercel[bot], netlify[bot]) and, if set, these domains.
  const list = (v) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined);
  proposals = githubProposals({ appId: process.env.AGENT_TEAM_MERGER_APP_ID, privateKey: process.env.AGENT_TEAM_MERGER_APP_KEY || readFileSync(appKey, 'utf8'),
    previewCreators: list(process.env.AGENT_TEAM_PREVIEW_CREATORS), previewHosts: list(process.env.AGENT_TEAM_PREVIEW_HOSTS) });
}
else if (process.env.AGENT_TEAM_MERGER_APP_ID) fail(`AGENT_TEAM_MERGER_APP_ID is set but there is no key at ${appKey}`);
console.error(`[runner] pull requests: ${proposals ? `opened and merged by the runner (${proposals.connector})` : 'not opened by the runner (no merger app configured)'}`);

// The model: the Agent SDK, or the dry run's scripted fake (no model, no key, no cost; the M3 exit test's Pass A).
let adapter;
if (process.env.AGENT_TEAM_RUNNER_ADAPTER === 'dryrun') {
  if (process.env.ANTHROPIC_API_KEY) fail('refusing to start: the dry-run model is for runs with no model key; unset ANTHROPIC_API_KEY');
  adapter = dryrunAdapter({ control });
  console.error(`[runner] model: the dry run's scripted fake (control folder ${control})`);
} else adapter = agentSdkAdapter({ effort: o.effort });

// The dry run looks for a merge's preview every second for ten minutes, so the harness need not wait (G-12).
const previewDelays = process.env.AGENT_TEAM_RUNNER_ADAPTER === 'dryrun' ? Array(600).fill(1000) : undefined;
const runner = startRunner({
  server, key, root: data, work, sandbox, proposals, previewDelays, id: saved.id ?? o.name, maxSessions: Number(o['max-sessions']) || 8,
  adapter,
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
