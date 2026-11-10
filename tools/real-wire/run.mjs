#!/usr/bin/env node
// The real-wire test (CTO, after the F-B5 live test): proves the whole wire on a throwaway repository before anything
// runs on OrgCraft again. One command, on the owner's Mac (scripts/real-wire.sh):
//
//   1. a control plane in local mode (in this process, its own data folder, the owner's step-up passphrase hash),
//      with the merger app's installation pinned to ThePurpleVoid/orgcraft-sandbox and nothing else
//   2. a team with one teammate (the chief of staff, model tier light) and a daily cap of $0.50
//   3. the runner image, registered with the sandbox's write deploy key and the merger app's key
//   4. one tiny task: write wire/<stamp>.md and ask to merge it (request_approval, action accept)
//   5. checks: SSH clone with the runner's key, the push, the pull request opened by the merger app, an accept card
//      bound to the pushed head, no merge without the owner's passphrase, the merge after it
//   6. the runner restarted with the read-only deploy key, a second task, and a loud BLOCKED: proposal.failed (push),
//      a message.blocked for the owner in the control plane's voice, no card, nothing pushed
//   7. a pass/fail table in evidence/real-wire/<time>.md, and everything stopped and removed
//
// It refuses any repository but ThePurpleVoid/orgcraft-sandbox. `--fake` runs the same harness here, with the model
// stubbed (a scripted chief of staff), a faithful fake of GitHub's REST API backed by a bare repository (the app's
// JWT, installation lookup and tokens, pull requests, a squash merge pinned to the head) and the runner in this
// process; the owner's run is then only the real wire. tests/e2e/real-wire.e2e.mjs runs --fake in CI.
//
//   node tools/real-wire/run.mjs --installation <id> [--app-id 5687048] [--secrets ~/.agent-team/sandbox-secrets]
//        [--step-up-hash ~/.agent-team/step-up.hash] [--image agent-team-runner] [--port 4859] [--evidence evidence/real-wire]
//   node tools/real-wire/run.mjs --fake
import { execFileSync, spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const KIT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const SANDBOX = 'ThePurpleVoid/orgcraft-sandbox';
export const SANDBOX_URL = `git@github.com:${SANDBOX}.git`;
const TENANT = 'local';
const TEAM = 'real-wire';
const FRONT = 'chief-of-staff';
const CAP_CENTS = 50;
const CONTAINER = 'orgcraft-real-wire';

/** The one repository this test may touch. Anything else, in any spelling, is refused before anything starts. */
export function onlySandbox(url) {
  const m = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(String(url ?? ''));
  if (!m || `${m[1]}/${m[2]}`.toLowerCase() !== SANDBOX.toLowerCase()) throw new Error(`refusing ${JSON.stringify(String(url).slice(0, 100))}: the real-wire test runs only on ${SANDBOX}`);
  return SANDBOX;
}

const BRIEF = `# Chief of staff (real-wire test)

**Model:** light

You are the only teammate in a test of OrgCraft's wiring. Each request from the owner asks you to add one small file.
Do exactly this, and nothing else:

1. Write the file the owner names, with the line the owner gives, in your working copy (only under wire/).
2. Call the team tool request_approval with action "accept", call "merge the pull request", and why "the owner's test file".
3. If a tool answers with text that starts with BLOCKED, call the team tool blocked with that text as detail, need
   "a deploy key with write access", needFrom "owner", recommendation "turn on write access for the deploy key",
   meanwhile "waiting", and task "real-wire test". Then stop.

Do not run git yourself, do not open pull requests, do not merge any other way, and do not change any other file.
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what, fn, ms, every = 500) {
  const until = Date.now() + ms;
  let last;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}${last ? ` (${last.message})` : ''}`);
    await sleep(every);
  }
}

/** A hidden prompt on the terminal (the passphrase never echoes and is never written anywhere). */
export function askHidden(question) {
  return new Promise((ok) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) process.stderr.write(s); };
    rl.question(question, (a) => { rl.close(); process.stderr.write('\n'); ok(a); });
  });
}

/**
 * Runs the test. `mode` is 'real' (the runner image, GitHub, the model) or 'fake' (all here, nothing leaves the
 * machine). Returns { ok, rows, evidence }. Never throws past setup: a failed step is a failed row, and teardown runs.
 */
export async function realWire(o = {}) {
  const mode = o.mode ?? 'fake';
  const log = o.log ?? ((l) => console.error(`[real-wire] ${l}`));
  const rows = [];
  const row = (check, pass, detail = '') => { rows.push({ check, pass: Boolean(pass), detail: String(detail).replace(/\s+/g, ' ').slice(0, 300) }); log(`${pass ? 'PASS' : 'FAIL'} ${check}${detail ? `: ${detail}` : ''}`); return pass; };
  const step = async (check, fn) => { try { const r = await fn(); row(check, r?.pass ?? true, r?.detail ?? ''); return r; } catch (e) { row(check, false, e.message); return null; } };
  const repoUrl = o.repo ?? SANDBOX_URL;
  onlySandbox(repoUrl);
  const installation = Number(o.installation ?? (mode === 'fake' ? 77 : NaN));
  if (!Number.isSafeInteger(installation) || installation <= 0) throw new Error('--installation is the merger app\'s installation id on orgcraft-sandbox (a number)');
  const appId = String(o.appId ?? '5687048');
  const work = mkdtempSync(join(o.tmp ?? tmpdir(), 'real-wire-'));
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const cleanups = [];
  let plane, db;

  try {
    // ---- the world: real secrets and GitHub, or the fake ----
    let secrets, api, appKey, fake = null, adapter = null, gitconfig = null, bare = null;
    if (mode === 'fake') {
      const { fakeGitHub } = await import(pathToFileURL(join(KIT, 'tests/fake-github.mjs')));
      bare = join(work, 'github', 'orgcraft-sandbox.git');
      const seed = join(work, 'seed');
      mkdirSync(seed, { recursive: true });
      const g = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=owner', '-c', 'user.email=owner@example.invalid', ...a], { cwd, stdio: 'pipe' });
      g(seed, 'init', '-q', '-b', 'main');
      writeFileSync(join(seed, 'README.md'), '# orgcraft-sandbox\n');
      g(seed, 'add', '-A'); g(seed, 'commit', '-qm', 'Initial commit');
      g(work, 'init', '-q', '--bare', '-b', 'main', bare);
      g(seed, 'push', '-q', bare, 'main');
      appKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
      fake = await fakeGitHub({ bare, repo: SANDBOX, installation, token: `ghs_${randomBytes(12).toString('hex')}`, appLogin: 'orgcraft-merger[bot]' });
      cleanups.push(() => { if (process.env.REAL_WIRE_DEBUG) log(JSON.stringify(fake.calls.map((c) => `${c.method} ${c.path}`))); return fake.close(); });
      api = fake.url;
      // The runner's git config, as the image writes it, but "GitHub" over ssh is the bare repository.
      gitconfig = join(work, 'runner-gitconfig');
      writeFileSync(gitconfig, `[url "${bare}"]\n\tinsteadOf = ${SANDBOX_URL}\n`, { mode: 0o600 });
      chmodSync(gitconfig, 0o600);
      adapter = o.adapter ?? (await scriptedFront());
    } else {
      secrets = resolve(o.secrets ?? join(homedir(), '.agent-team', 'sandbox-secrets'));
      for (const f of ['runner-deploy-key', 'readonly-deploy-key', 'merger-app.pem']) if (!existsSync(join(secrets, f))) throw new Error(`missing ${join(secrets, f)} (plans/setup-day/sandbox-repo.md, step 2 and 3)`);
      if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set in this shell; the runner needs it for the model');
      appKey = readFileSync(join(secrets, 'merger-app.pem'), 'utf8');
      api = 'https://api.github.com';
    }
    const { githubApp } = await import(pathToFileURL(join(KIT, 'packages/github-app/index.mjs')));
    const gh = githubApp({ appId, privateKey: appKey, api, userAgent: 'orgcraft-real-wire' });
    const read = async (path) => {
      const { token } = await gh.tokenFor(SANDBOX, [installation], { permissions: { contents: 'read', pull_requests: 'read' } });
      return gh.call(`/repos/${SANDBOX}${path}`, { token });
    };

    // ---- 1. the control plane, local mode ----
    const { openDb } = await import(pathToFileURL(join(KIT, 'apps/server/db.mjs')));
    const { masterKey } = await import(pathToFileURL(join(KIT, 'apps/server/vault.mjs')));
    const store = await import(pathToFileURL(join(KIT, 'apps/server/store.mjs')));
    const { createControlPlane } = await import(pathToFileURL(join(KIT, 'apps/server/server.mjs')));
    const { hashStepUpSecret, stepUpVerifier } = await import(pathToFileURL(join(KIT, 'apps/server/m3.mjs')));
    let fakeSecret = null;
    let hash;
    if (mode === 'fake') { fakeSecret = `real-wire ${randomBytes(9).toString('base64url')}`; hash = await hashStepUpSecret(fakeSecret); }
    else hash = readFileSync(resolve(o.stepUpHash ?? join(homedir(), '.agent-team', 'step-up.hash')), 'utf8').trim();
    const passphrase = async (why) => (mode === 'fake' ? fakeSecret : (o.askPassphrase ?? askHidden)(`${why}\nYour step-up passphrase: `));
    const adminToken = `adm_${randomBytes(18).toString('base64url')}`;
    db = await openDb({ dataDir: join(work, 'control-plane') });
    await store.ensureTenant(db, TENANT);
    // The pin, as AGENT_TEAM_GITHUB_INSTALLATION_ID with AGENT_TEAM_GITHUB_REPOS would set it: this installation, only
    // for the sandbox. Any other repository gets no installation, so the runner refuses to write to it.
    const installationsFor = async (t, url) => { try { return t === TENANT && onlySandbox(url) ? [installation] : []; } catch { return []; } };
    plane = createControlPlane({ db, key: masterKey(randomBytes(32).toString('base64')), tenant: TENANT, adminToken, stepUpVerifier: stepUpVerifier(hash), pollMs: 300, installationsFor });
    await new Promise((r, j) => { plane.once('error', j); plane.listen(o.port ?? 0, '127.0.0.1', () => { plane.off('error', j); r(); }); });
    const cp = `http://127.0.0.1:${plane.address().port}`;
    row('control plane in local mode, installation pinned to the sandbox only', true, `${cp}, installation ${installation}`);
    const auth = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' };
    const call = async (method, path, body, headers = {}) => {
      const res = await fetch(`${cp}/v1${path}`, { method, headers: { ...auth, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      const b = await res.json().catch(() => ({}));
      return { status: res.status, body: b };
    };
    const must = async (...a) => { const r = await call(...a); if (r.status >= 300) throw new Error(`${a[0]} ${a[1]}: ${r.status} ${r.body.error ?? r.body.title ?? JSON.stringify(r.body)}`); return r.body; };
    const stepUp = async (secret, scope) => (await must('POST', '/auth/step-up', { secret, ...(scope ? { scope } : {}) })).token;
    const events = async (type) => (await db.system('select envelope from events where team = $1 and type = $2 order by seq', [TEAM, type])).map((r) => r.envelope);

    // ---- 2. the team, its cap, the run ----
    await must('POST', '/teams', { id: TEAM });
    // One passphrase for the two setup steps (each step-up token is spent once); kept in memory only, never written.
    let setupSecret = await passphrase('Setting up: the $0.50 daily cap and the test runner need your step-up.');
    await must('PUT', `/teams/${TEAM}/budget`, { perDay: CAP_CENTS, perRun: CAP_CENTS }, { 'x-step-up': await stepUp(setupSecret) });
    const { code } = await must('POST', '/runners/codes', {}, { 'x-step-up': await stepUp(setupSecret) });
    setupSecret = null;
    row('team created with a daily cap of $0.50', true, `${CAP_CENTS} cents per day and per run`);

    // ---- 3. the runner ----
    let runner = null;
    const startFake = async (key) => {
      const { startRunner } = await import(pathToFileURL(join(KIT, 'apps/runner/runner.mjs')));
      const { githubProposals } = await import(pathToFileURL(join(KIT, 'apps/runner/proposals.mjs')));
      const { useGitConfig } = await import(pathToFileURL(join(KIT, 'apps/runner/worktree.mjs')));
      useGitConfig(gitconfig);
      const r = startRunner({ server: cp, key, root: join(work, 'runner'), adapter, proposals: githubProposals({ appId, privateKey: appKey, api }), id: 'real-wire', log: (m) => log(`runner: ${m}`) });
      await r.ready;
      return { close: () => r.close() };
    };
    let fakeKey = null;
    const docker = (args, opts = {}) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
    const vol = CONTAINER;
    const server = `http://host.docker.internal:${plane.address().port}`;
    const image = o.image ?? 'agent-team-runner';
    const keysInto = (key) => {
      // A folder of exactly the two keys the entrypoint copies: the deploy key given, as runner-deploy-key, and the
      // merger app's key. Never the whole secrets folder.
      const d = mkdtempSync(join(secrets, '..', '.real-wire-keys-'));
      chmodSync(d, 0o700);
      copyFileSync(join(secrets, key), join(d, 'runner-deploy-key')); chmodSync(join(d, 'runner-deploy-key'), 0o600);
      copyFileSync(join(secrets, 'merger-app.pem'), join(d, 'merger-app.pem')); chmodSync(join(d, 'merger-app.pem'), 0o600);
      cleanups.push(() => rmSync(d, { recursive: true, force: true }));
      return d;
    };
    const startReal = () => {
      try { docker(['rm', '-f', CONTAINER]); } catch { /* none */ }
      docker(['run', '-d', '--name', CONTAINER, '-e', 'ANTHROPIC_API_KEY', '-e', `AGENT_TEAM_MERGER_APP_ID=${appId}`, '-v', `${vol}:/data`, image]);
      return { close: async () => { try { docker(['stop', '-t', '20', CONTAINER]); } catch { /* gone */ } try { docker(['rm', '-f', CONTAINER]); } catch { /* gone */ } } };
    };
    const connected = () => waitFor('the runner to connect', () => plane.runners?.connected?.(TENANT)?.length, 90_000);
    if (mode === 'fake') {
      const res = await fetch(`${cp}/v1/runners`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'real-wire', capabilities: { sandboxes: ['process'], runtimes: ['agent-sdk'] } }) });
      fakeKey = (await res.json()).key;
      runner = await startFake(fakeKey);
    } else {
      try { docker(['rm', '-f', CONTAINER]); } catch { /* none */ }
      try { docker(['volume', 'rm', vol]); } catch { /* none */ }
      cleanups.push(() => { try { docker(['rm', '-f', CONTAINER]); } catch { /* gone */ } try { docker(['volume', 'rm', vol]); } catch { /* gone */ } });
      const keys = keysInto('runner-deploy-key');
      docker(['run', '--rm', '-v', `${keys}:/run/agent-team:ro`, '-v', `${vol}:/data`, image, 'node', 'apps/runner/bin.mjs', 'register', '--server', server, '--code', code, '--name', 'real-wire']);
      runner = startReal();
    }
    await step('runner connected', async () => { await connected(); return { detail: mode === 'fake' ? 'in this process, stubbed model' : `container ${CONTAINER}, image ${image}` }; });

    // ---- 4. SSH clone with the runner's own git config ----
    await step('SSH clone with the runner\'s deploy key (ls-remote)', async () => {
      let out;
      if (mode === 'fake') out = execFileSync('git', ['ls-remote', SANDBOX_URL, 'refs/heads/main'], { encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitconfig } });
      else {
        // As the runner user, through the runner's own check of its git config (mode 0600, its owner), the way the
        // image's CI step does it; no shell, so nothing here is quoted twice.
        const script = `import { useGitConfig, effectiveSshCommand } from '/app/apps/runner/worktree.mjs';
          import { execFileSync } from 'node:child_process';
          useGitConfig('/data/runner/gitconfig');
          if (!/deploy-key/.test(effectiveSshCommand())) throw new Error('the git config does not use the deploy key: ' + effectiveSshCommand());
          process.stdout.write(execFileSync('git', ['ls-remote', ${JSON.stringify(SANDBOX_URL)}, 'refs/heads/main'], { encoding: 'utf8',
            env: { PATH: process.env.PATH, HOME: '/home/runner', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/data/runner/gitconfig' } }));`;
        out = docker(['run', '--rm', '--user', 'runner', '-e', 'HOME=/home/runner', '--entrypoint', 'node', '-v', `${vol}:/data`, image, '--input-type=module', '-e', script]);
      }
      const sha = /^([0-9a-f]{40})\s+refs\/heads\/main$/m.exec(out)?.[1];
      return { pass: Boolean(sha), detail: sha ? `main is ${sha.slice(0, 12)}` : out.slice(0, 200) };
    });

    // ---- 5. the run and the first task ----
    const roster = { version: `real-wire-${stamp}`, repo: { url: repoUrl, ref: 'main' }, roles: [{ slug: FRONT, reportsTo: 'owner', areas: ['wire/**'], model: 'light', brief: BRIEF }] };
    const run = await must('POST', `/teams/${TEAM}/runs`, { team: roster });
    const runId = run.id ?? run.run?.id;
    const file1 = `wire/${stamp}.md`;
    await must('POST', `/teams/${TEAM}/chat`, { text: `Add the file ${file1} with the line "real wire ${stamp}", then ask to merge it.` });
    const T = mode === 'fake' ? 60_000 : 6 * 60_000;

    const opened = await step('push and pull request opened by the merger app', async () => {
      const e = await waitFor('proposal.opened', async () => (await events('proposal.opened'))[0], T);
      const pr = await read(`/pulls/${Number(e.data.ref)}`);
      const by = pr.body.user ?? {};
      const branchSha = (await read(`/git/ref/heads/${e.data.branch}`)).body?.object?.sha;
      const ok = pr.status === 200 && by.type === 'Bot' && /\[bot\]$/.test(by.login ?? '') && branchSha === e.data.headSha;
      return { pass: ok, detail: `PR #${e.data.ref} by ${by.login ?? '?'} (${by.type ?? '?'}), branch ${e.data.branch} at ${String(branchSha).slice(0, 12)}`, e };
    });

    const card = await step('accept card bound to the pushed head', async () => {
      const a = await waitFor('the accept card', async () => (await db.system("select id, card, call, calls_hash from approvals where team = $1 and state = 'pending' order by expires_at", [TEAM]))[0], T);
      const pr = await read(`/pulls/${Number(a.call?.pr)}`);
      const ok = a.call?.pr === opened?.e?.data?.ref && a.call?.headSha === opened?.e?.data?.headSha && pr.body.head?.sha === a.call?.headSha;
      return { pass: ok, detail: `approval for PR #${a.call?.pr} at ${String(a.call?.headSha).slice(0, 12)}; the PR's head is ${String(pr.body.head?.sha).slice(0, 12)}`, a };
    });

    await step('no merge without the owner\'s passphrase', async () => {
      if (!card?.a) return { pass: false, detail: 'no card' };
      const r = await call('POST', `/approvals/${card.a.id}`, { decision: 'approved' });
      const pr = await read(`/pulls/${Number(card.a.call.pr)}`);
      return { pass: r.status === 401 && r.body.type === 'step-up-required' && pr.body.state === 'open', detail: `approve without step-up: ${r.status} ${r.body.type ?? ''}; PR still ${pr.body.state}` };
    });

    await step('merge after the owner\'s passphrase, at the approved head', async () => {
      if (!card?.a) return { pass: false, detail: 'no card' };
      const scope = (await call('POST', `/approvals/${card.a.id}`, { decision: 'approved' })).body.scope;
      const su = await stepUp(await passphrase(`Approve the merge of pull request #${card.a.call.pr} at ${String(card.a.call.headSha).slice(0, 12)} on ${SANDBOX}.`), scope);
      await must('POST', `/approvals/${card.a.id}`, { decision: 'approved' }, { 'x-step-up': su });
      const acc = await waitFor('proposal.accepted', async () => (await events('proposal.accepted'))[0], T);
      const pr = await read(`/pulls/${Number(card.a.call.pr)}`);
      const main = (await read('/git/ref/heads/main')).body?.object?.sha;
      const ok = pr.body.merged === true || Boolean(pr.body.merged_at);
      return { pass: ok && acc.data.headSha === card.a.call.headSha && main === acc.data.result, detail: `PR #${card.a.call.pr} merged as ${String(acc.data.result).slice(0, 12)}; main is ${String(main).slice(0, 12)}` };
    });

    // ---- 6. the read-only key: a loud BLOCKED ----
    await runner.close();
    runner = null;
    if (mode === 'fake') {
      writeFileSync(join(bare, 'hooks', 'pre-receive'), '#!/bin/sh\necho "ERROR: The key you are authenticating with has been marked as read only." >&2\nexit 1\n');
      chmodSync(join(bare, 'hooks', 'pre-receive'), 0o755);
      runner = await startFake(fakeKey);
    } else {
      docker(['run', '--rm', '-v', `${keysInto('readonly-deploy-key')}:/run/agent-team:ro`, '-v', `${vol}:/data`, image, 'true']);
      runner = startReal();
    }
    await connected();
    const mainBefore = (await read('/git/ref/heads/main')).body?.object?.sha;
    // The session's branch as GitHub has it now (the runner's checkpoint after the merge may have pushed it again):
    // under the read-only key it must not move.
    const branchName = opened?.e?.data?.branch;
    const branchBefore = branchName ? (await read(`/git/ref/heads/${branchName}`)).body?.object?.sha ?? null : null;
    const pending = async () => Number((await db.system("select count(*)::int as n from approvals where team = $1 and state = 'pending'", [TEAM]))[0].n);
    const file2 = `wire/${stamp}-readonly.md`;
    await must('POST', `/teams/${TEAM}/chat`, { text: `Add the file ${file2} with the line "read only ${stamp}", then ask to merge it.` });
    await step('read-only key: a loud BLOCKED (push refused, owner told, no card, nothing pushed)', async () => {
      const failed = await waitFor('proposal.failed (push)', async () => (await events('proposal.failed')).find((e) => e.data.reason === 'push'), T);
      const blocked = await waitFor('message.blocked for the owner', async () => (await events('message.blocked')).find((e) => e.actor?.kind === 'system' && e.data?.needFrom === 'owner'), 30_000);
      await sleep(mode === 'fake' ? 500 : 5000);
      const mainAfter = (await read('/git/ref/heads/main')).body?.object?.sha;
      const branch = failed.data.branch ? (await read(`/git/ref/heads/${failed.data.branch}`)).body?.object?.sha ?? null : null;
      const waiting = await pending();
      const said = /read.only|denied|permission/i.test(failed.data.detail ?? '');
      const same = failed.data.branch === branchName && branch === branchBefore;
      const ok = said && waiting === 0 && mainAfter === mainBefore && same;
      return { pass: ok, detail: `cards waiting ${waiting}; main unchanged ${mainAfter === mainBefore}; branch unchanged ${same}; the owner sees: ${String(blocked.data.detail).slice(0, 160)}` };
    });

    // ---- spend ----
    await step('spend stayed under the $0.50 cap', async () => {
      const [b] = await db.system('select coalesce(sum(spent), 0)::int as spent from budget_days where team = $1', [TEAM]);
      return { pass: Number(b.spent) <= CAP_CENTS, detail: `${Number(b.spent)} cents spent` };
    });
    if (runId) await call('POST', `/runs/${runId}/stop`, {}).catch(() => {});
    await runner?.close();
    runner = null;
    if (mode === 'real') { try { writeFileSync(join(work, 'runner.log'), docker(['logs', CONTAINER], { stdio: ['ignore', 'pipe', 'pipe'] })); } catch { /* gone */ } }
  } catch (e) {
    row('the test ran to the end', false, e.message);
  } finally {
    try { plane?.runners?.closeAll?.(); plane?.closeAllConnections?.(); plane?.close(); } catch { /* closed */ }
    try { await db?.close?.(); } catch { /* closed */ }
    for (const c of cleanups.reverse()) { try { await c(); } catch { /* best effort */ } }
  }

  // ---- 7. the table ----
  const ok = rows.length > 0 && rows.every((r) => r.pass);
  const table = [
    `# Real-wire test, ${mode === 'fake' ? 'fake GitHub and stubbed model' : SANDBOX} (${new Date().toISOString()})`,
    '',
    `Result: **${ok ? 'PASS' : 'FAIL'}**${mode === 'real' ? `, installation ${installation}, app ${appId}` : ''}`,
    '',
    '| # | Check | Result | Detail |',
    '|---|---|---|---|',
    ...rows.map((r, i) => `| ${i + 1} | ${r.check} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.detail.replace(/\|/g, '\\|')} |`),
    '',
  ].join('\n');
  let evidence = null;
  if (o.evidence !== false) {
    const dir = resolve(o.evidence ?? join(KIT, 'evidence', 'real-wire'));
    mkdirSync(dir, { recursive: true });
    evidence = join(dir, `${stamp}${mode === 'fake' ? '-fake' : ''}.md`);
    writeFileSync(evidence, table);
  }
  rmSync(work, { recursive: true, force: true });
  return { ok, rows, table, evidence };
}

/** The stubbed model: the chief of staff does what the brief says, through the same tools a real session uses. */
async function scriptedFront() {
  const { stubAdapter } = await import(pathToFileURL(join(KIT, 'apps/runner/adapters/stub.mjs')));
  return stubAdapter({
    [FRONT]: async (t) => {
      const text = JSON.stringify(t.prompt ?? '');
      const file = /wire\/[A-Za-z0-9_.-]+\.md/.exec(text)?.[0];
      const line = /with the line \\?"([^"\\]+)\\?"/.exec(text)?.[1] ?? 'real wire';
      if (!file) return { result: 'Nothing to do.' };
      mkdirSync(join(t.cwd, 'wire'), { recursive: true });
      writeFileSync(join(t.cwd, file), `${line}\n`);
      const r = await t.call('request_approval', { action: 'accept', call: 'merge the pull request', why: 'the owner\'s test file' });
      if (r.isError && /^BLOCKED/.test(r.text)) {
        await t.call('blocked', { to: 'owner', task: 'real-wire test', detail: r.text.slice(0, 1000), need: 'a deploy key with write access', needFrom: 'owner', recommendation: 'turn on write access for the deploy key', meanwhile: 'waiting' });
      }
      return { result: r.text?.slice(0, 200) ?? '' };
    },
  }, { costUsd: 0.002 });
}

async function main() {
  const { values: o } = parseArgs({ options: {
    fake: { type: 'boolean' }, installation: { type: 'string' }, 'app-id': { type: 'string', default: '5687048' },
    secrets: { type: 'string' }, 'step-up-hash': { type: 'string' }, image: { type: 'string', default: 'agent-team-runner' },
    port: { type: 'string' }, evidence: { type: 'string' }, repo: { type: 'string' },
  } });
  const r = await realWire({ mode: o.fake ? 'fake' : 'real', installation: o.installation, appId: o['app-id'], secrets: o.secrets, stepUpHash: o['step-up-hash'], image: o.image, port: o.port ? Number(o.port) : (o.fake ? 0 : 4859), evidence: o.evidence, repo: o.repo });
  console.log(`\n${r.table}`);
  if (r.evidence) console.log(`Written to ${r.evidence}`);
  process.exit(r.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((e) => { console.error(`real-wire: ${e.message}`); process.exit(2); });
