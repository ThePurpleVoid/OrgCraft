#!/usr/bin/env node
// The M3 dry run (exit test, Pass A): the control plane, the Studio and a runner with a scripted fake model, against
// a fresh team repository whose "GitHub" is a bare repository on disk. No model, no key, no GitHub, no cost.
//
//   node tools/dry-run/m3.mjs up [--dir <folder>] [--port 4849] [--studio-port 4848] [--runner process|docker]
//       starts everything and prints the Studio link and the step-up secret; Ctrl-C stops it
//   node tools/dry-run/m3.mjs signoff  --dir <folder> [--evidence path,...] [--result pass|fail]   QA's SIGNOFF (step 6)
//   node tools/dry-run/m3.mjs hold     --dir <folder>      an approved merge waits (before step 9b)
//   node tools/dry-run/m3.mjs move-head --dir <folder>     push a commit to the open pull request (step 9b)
//   node tools/dry-run/m3.mjs release  --dir <folder>      the held merge goes ahead (and fails head-moved if moved)
//   node tools/dry-run/m3.mjs deploy [pr] --dir <folder>   the stand-in host deploys the latest merge (or that PR's):
//       the runner finds the preview link and the Ready to try card gains it (G-12)
//   node tools/dry-run/m3.mjs spend <usd> --dir <folder>   the next turn reports that cost (step 11)
//   node tools/dry-run/m3.mjs meeting [id] --dir <folder>  start a meeting now (standup by default): each attendee
//       answers its turn and the chief of staff posts the minutes in the chat
//   node tools/dry-run/m3.mjs meeting-spend <usd> --dir <folder>   the next attendee's turn costs that (the cap path)
//   node tools/dry-run/m3.mjs status   --dir <folder>      the pull requests (head, state, merge result) and the log
//
// Needs `npm ci --prefix apps/server` and `npm ci --prefix apps/runner` first. `up` writes <folder>/state.json; the
// other commands read it, so they work from another terminal while `up` runs.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const KIT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TENANT = 'acme';
const TEAM = 'dry-run';
const BUILDER = { role: 'web-dev', file: 'app/request.md' };
// The control plane runs in this process, so a child that talks to it must not block the event loop.
const runChild = (cmd, args, opts) => new Promise((ok, fail) => {
  const c = spawn(cmd, args, { ...opts, stdio: ['ignore', 'inherit', 'inherit'] });
  c.once('error', fail);
  c.once('exit', (code) => (code === 0 ? ok() : fail(new Error(`${cmd} ${args.slice(0, 3).join(' ')} exited ${code}`))));
});
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=dry-run', '-c', 'user.email=dry-run@agent-team.invalid', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A team repository from the minimal preset, published and pushed to a bare "remote", with owned areas for the demo. */
export function teamRepo(dir) {
  const root = join(dir, 'team'), bare = join(dir, 'origin.git');
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  execFileSync(process.execPath, [join(KIT, 'bin/agent-team.mjs'), 'init', '--preset', 'minimal', '--project', 'Dry run', '--dir', root], { stdio: 'ignore' });
  // Who may write what: the builder its app, QA its evidence, the front door its notes.
  writeFileSync(join(root, '.agent-team/ownership.json'), JSON.stringify({ rows: [
    { writer: BUILDER.role, path: 'app/**' }, { writer: 'qa-web', path: 'qa/**' }, { writer: 'chief-of-staff', path: 'notes/**' },
  ] }, null, 2));
  // One meeting: a written round of the builder and QA, run by the front door, with a small cap.
  writeFileSync(join(root, '.agent-team/meetings.json'), JSON.stringify({ meetings: [
    { id: 'standup', title: 'Daily standup', when: { days: ['mon', 'tue', 'wed', 'thu', 'fri'], at: '09:00' }, attendees: { roles: [BUILDER.role, 'qa-web'] }, facilitator: 'chief-of-staff',
      format: 'round', agenda: 'What you did, what is next, what blocks you.', ifBusy: 'next-pause', owner: { minutes: true, speaks: false }, capUsd: 0.5 },
  ] }, null, 2));
  for (const d of ['app', 'qa', 'notes']) { mkdirSync(join(root, d), { recursive: true }); writeFileSync(join(root, d, 'README.md'), `# ${d}\n`); }
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'The dry run\'s team');
  git(dir, 'init', '-q', '--bare', '-b', 'main', bare);
  git(root, 'remote', 'add', 'origin', bare);
  git(root, 'push', '-q', '-u', 'origin', 'main');
  return { root, bare };
}

async function json(res) { const b = await res.json().catch(() => ({})); if (!res.ok) throw new Error(`${res.status}: ${b.error ?? b.title ?? JSON.stringify(b)}`); return b; }

/**
 * Bring the dry run up. Returns { dir, studio, link, cp, secret, adminToken, control, bare, team, down() } and writes
 * <dir>/state.json. `runner`: 'process' (node apps/runner/bin.mjs) or 'docker' (the runner image, host network).
 */
export async function up({ dir = mkdtempSync(join(tmpdir(), 'm3-dry-run-')), port = 4849, studioPort = 4848, runner = 'process', image = 'agent-team-runner', log = console.error } = {}) {
  if (!existsSync(join(KIT, 'apps/server/node_modules'))) throw new Error('run npm ci --prefix apps/server first');
  if (!existsSync(join(KIT, 'apps/runner/node_modules')) && runner === 'process') throw new Error('run npm ci --prefix apps/runner first');
  dir = resolve(dir);
  mkdirSync(dir, { recursive: true });
  const control = join(dir, 'control');
  mkdirSync(control, { recursive: true });
  writeFileSync(join(control, 'builder.json'), JSON.stringify(BUILDER));
  const { root, bare } = teamRepo(dir);
  log(`[dry-run] team repository in ${root}, its remote ${bare}`);

  // The control plane, in this process, on PGlite in the folder.
  const { openDb } = await import(pathToFileURL(join(KIT, 'apps/server/db.mjs')));
  const { masterKey } = await import(pathToFileURL(join(KIT, 'apps/server/vault.mjs')));
  const store = await import(pathToFileURL(join(KIT, 'apps/server/store.mjs')));
  const { createControlPlane } = await import(pathToFileURL(join(KIT, 'apps/server/server.mjs')));
  const { hashStepUpSecret, stepUpVerifier } = await import(pathToFileURL(join(KIT, 'apps/server/m3.mjs')));
  const secret = `dry-run ${randomBytes(9).toString('base64url')}`;
  const adminToken = `adm_${randomBytes(18).toString('base64url')}`;
  const db = await openDb({ dataDir: join(dir, 'control-plane') });
  await store.ensureTenant(db, TENANT);
  const plane = createControlPlane({ db, key: masterKey(randomBytes(32).toString('base64')), tenant: TENANT, adminToken, stepUpVerifier: stepUpVerifier(await hashStepUpSecret(secret)), pollMs: 200 });
  await new Promise((r, j) => { plane.once('error', j); plane.listen(port, '127.0.0.1', r); });
  const cp = `http://127.0.0.1:${plane.address().port}`;
  log(`[dry-run] control plane on ${cp}`);
  const auth = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' };
  await json(await fetch(`${cp}/v1/teams`, { method: 'POST', headers: auth, body: JSON.stringify({ id: TEAM }) }));

  // The Studio, pointed at it.
  const { createStudio } = await import(pathToFileURL(join(KIT, 'apps/studio/server.mjs')));
  const studio = createStudio({ root, env: { ...process.env, AGENT_TEAM_SERVER: cp, AGENT_TEAM_SERVER_TOKEN: adminToken, AGENT_TEAM_SERVER_TEAM: TEAM } });
  await new Promise((r, j) => { studio.once('error', j); studio.listen(studioPort, '127.0.0.1', r); });
  const studioUrl = `http://127.0.0.1:${studio.address().port}`;
  const link = `${studioUrl}/?t=${studio.launchToken}`;
  log(`[dry-run] Studio on ${studioUrl}; starting the runner (${runner})`);

  // The runner: a one-time code (minted with step-up), redeemed, then started with the fake model.
  const su = (await json(await fetch(`${cp}/v1/auth/step-up`, { method: 'POST', headers: auth, body: JSON.stringify({ secret }) }))).token;
  const { code } = await json(await fetch(`${cp}/v1/runners/codes`, { method: 'POST', headers: { ...auth, 'x-step-up': su } }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC_|CLAUDE_|AGENT_TEAM_)/.test(k)));
  Object.assign(env, { AGENT_TEAM_RUNNER_ADAPTER: 'dryrun', AGENT_TEAM_DRYRUN_CONTROL: control, AGENT_TEAM_PROPOSALS: 'local', NO_PROXY: '127.0.0.1,localhost' });
  let child;
  if (runner === 'docker') {
    // Same paths inside as outside, so repo.url (file:///…) and the control folder mean the same in both.
    // The runner and its sessions are other users in there: the stand-in remote and the control folder are shared.
    git(bare, 'config', 'core.sharedRepository', '0777');
    // Only what the container's users must write: the stand-in remote and the control folder. The folder itself is
    // only passable (state.json, the control plane's data and the team copy stay this user's).
    execFileSync('chmod', ['a+x', dir]);
    execFileSync('chmod', ['-R', 'a+rwX', bare, control]);
    const vol = `m3-dry-run-${randomBytes(4).toString('hex')}`;
    const run = (...cmd) => ['run', '--rm', '--network', 'host', '-v', `${vol}:/data`, '-v', `${dir}:${dir}`, '-e', 'AGENT_TEAM_RUNNER_ADAPTER', '-e', 'AGENT_TEAM_DRYRUN_CONTROL', '-e', 'AGENT_TEAM_PROPOSALS', '-e', 'AGENT_TEAM_RUNNER_GITCONFIG=/data/runner/gitconfig', image, ...cmd];
    // The runner's git trusts the folder it does not own (the bare repository, made by this user).
    execFileSync('docker', ['run', '--rm', '-v', `${vol}:/data`, image, 'sh', '-c', `printf '[safe]\\n\\tdirectory = *\\n' > /data/runner/gitconfig`], { stdio: 'inherit' });
    await runChild('docker', run('node', 'apps/runner/bin.mjs', 'register', '--server', cp, '--code', code, '--name', 'dry-run'), { env });
    child = spawn('docker', ['run', '--name', vol, ...run('node', 'apps/runner/bin.mjs', 'start').slice(1)], { env, stdio: ['ignore', 'inherit', 'inherit'] });
    child.dockerName = vol;
  } else {
    const data = join(dir, 'runner');
    const bin = join(KIT, 'apps/runner/bin.mjs');
    await runChild(process.execPath, [bin, 'register', '--server', cp, '--code', code, '--name', 'dry-run', '--data', data], { env });
    child = spawn(process.execPath, [bin, 'start', '--data', data], { env, stdio: ['ignore', 'inherit', 'inherit'] });
  }
  const state = { dir, link, studio: studioUrl, cp, secret, adminToken, team: TEAM, control, bare, root, runner, pid: child.pid };
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state, null, 2), { mode: 0o600 });
  // Ready when the runner has said hello on its connection.
  await waitFor(() => plane.runners?.connected?.(TENANT)?.length, 30_000).catch(() => log('the runner has not connected yet; carrying on'));

  async function down() {
    if (child.dockerName) { try { execFileSync('docker', ['rm', '-f', child.dockerName], { stdio: 'ignore' }); } catch { /* gone */ } } else child.kill('SIGTERM');
    await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
    studio.closeAllConnections?.(); studio.close();
    plane.runners?.closeAll?.(); plane.closeAllConnections?.(); plane.close();
    await db.close?.();
  }
  /** What the control plane recorded for the sessions and pull requests (the harness's debugging aid). */
  const events = async () => (await db.system("select type, actor_id, envelope->'data' as data from events where team = $1 and (type like 'session.%' or type like 'proposal.%' or type like 'message.%') order by seq", [TEAM]));
  return { ...state, plane, events, down };
}

export async function waitFor(fn, ms = 60_000, every = 200) {
  const until = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* not yet */ }
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, every));
  }
}

/** The hooks QA steers the run with, on a folder `up` made (also used by the CI test). */
export function hooks(dir) {
  const s = JSON.parse(readFileSync(join(resolve(dir), 'state.json'), 'utf8'));
  const proposals = () => { try { return JSON.parse(readFileSync(join(s.bare, 'agent-team-proposals.json'), 'utf8')).proposals; } catch { return {}; } };
  return {
    state: s,
    proposals,
    log: () => { try { return readFileSync(join(s.control, 'log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } },
    signoff: ({ evidence = ['qa/dry-run.log'], result = 'pass', walked, testedOn } = {}) => writeFileSync(join(s.control, 'qa-signoff.json'), JSON.stringify({ evidence, result, walked, testedOn })),
    spend: (usd) => writeFileSync(join(s.control, 'spend.json'), JSON.stringify({ usd: Number(usd) })),
    meetingSpend: (usd) => writeFileSync(join(s.control, 'meeting-spend.json'), JSON.stringify({ usd: Number(usd) })),
    /** Start a meeting now, as the Studio's button will: POST /v1/teams/{team}/meetings with the admin token. */
    meeting: async (meeting = 'standup') => {
      const res = await fetch(`${s.cp}/v1/teams/${s.team}/meetings`, { method: 'POST', headers: { authorization: `Bearer ${s.adminToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ meeting }) });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`${res.status}: ${b.error ?? JSON.stringify(b)}`);
      return b;
    },
    /** One meeting as the control plane has it. */
    meetingNow: async (mid) => (await fetch(`${s.cp}/v1/teams/${s.team}/meetings/${mid}`, { headers: { authorization: `Bearer ${s.adminToken}` } })).json(),
    /**
     * The stand-in host deploys a merge commit (G-12): a successful deployment with a preview link, as Vercel or
     * Netlify would write to GitHub's deployment statuses. The runner reads it; the model never sees the file.
     */
    deploy: ({ ref, url = `https://preview-${ref ?? 'latest'}.dry-run.example/`, environment = 'Preview' } = {}) => {
      const merged = Object.values(proposals()).filter((p) => p.state === 'merged' && (ref === undefined || p.ref === Number(ref)));
      const p = merged.at(-1);
      if (!p) throw new Error('no merged pull request to deploy');
      const f = join(s.bare, 'agent-team-deployments.json');
      const list = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : [];
      const d = { id: list.length + 1, sha: p.result, environment, state: 'success', url };
      writeFileSync(`${f}.tmp`, JSON.stringify([...list, d], null, 2)); chmodSync(`${f}.tmp`, 0o644); renameSync(`${f}.tmp`, f);
      return { ...d, ref: p.ref };
    },
    hold: () => writeFileSync(join(s.control, 'hold-merge'), ''),
    release: () => rmSync(join(s.control, 'hold-merge'), { force: true }),
    /** Push one more commit to the open pull request's branch on the stand-in remote: its head moves. */
    moveHead: () => {
      const open = Object.values(proposals()).find((p) => p.state === 'open');
      if (!open) throw new Error('no open pull request to move');
      const w = join(s.dir, `move-${Date.now()}`);
      git(s.dir, 'clone', '-q', '-b', open.branch, '--', s.bare, w);
      writeFileSync(join(w, BUILDER.file), `${existsSync(join(w, BUILDER.file)) ? readFileSync(join(w, BUILDER.file), 'utf8') : ''}\nPushed after the approval (step 9b).\n`);
      git(w, 'commit', '-qam', 'A push after the approval (step 9b)');
      git(w, 'push', '-q', 'origin', open.branch);
      const head = git(w, 'rev-parse', 'HEAD');
      rmSync(w, { recursive: true, force: true });
      return { branch: open.branch, ref: open.ref, head };
    },
  };
}

async function main() {
  const { values: o, positionals: [cmd, arg] } = parseArgs({ allowPositionals: true, options: {
    dir: { type: 'string' }, port: { type: 'string', default: '4849' }, 'studio-port': { type: 'string', default: '4848' },
    runner: { type: 'string', default: 'process' }, image: { type: 'string', default: 'agent-team-runner' },
    evidence: { type: 'string' }, result: { type: 'string', default: 'pass' },
  } });
  if (cmd === 'up') {
    const h = await up({ dir: o.dir, port: Number(o.port), studioPort: Number(o['studio-port']), runner: o.runner, image: o.image });
    console.log(`\nM3 dry run is up (folder ${h.dir}).\n  Studio:          ${h.link}\n  Step-up secret:  ${h.secret}\n  Control plane:   ${h.cp} (admin token in ${join(h.dir, 'state.json')})\n  Stand-in remote: ${h.bare}\n\nSteer it from another terminal with: node tools/dry-run/m3.mjs <signoff|hold|move-head|release|deploy [pr]|spend <usd>|meeting|meeting-spend <usd>|status> --dir ${h.dir}\nCtrl-C stops it.`);
    const stop = async () => { await h.down(); process.exit(0); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    return;
  }
  if (!o.dir) throw new Error(`${cmd ?? 'a command'} needs --dir <the folder up printed>`);
  const h = hooks(o.dir);
  if (cmd === 'signoff') h.signoff({ evidence: o.evidence ? o.evidence.split(',') : undefined, result: o.result });
  else if (cmd === 'hold') h.hold();
  else if (cmd === 'deploy') console.log(JSON.stringify(h.deploy({ ref: arg })));
  else if (cmd === 'release') h.release();
  else if (cmd === 'move-head') console.log(JSON.stringify(h.moveHead()));
  else if (cmd === 'spend') h.spend(arg);
  else if (cmd === 'meeting-spend') h.meetingSpend(arg);
  else if (cmd === 'meeting') console.log(JSON.stringify(await h.meeting(arg ?? 'standup')));
  else if (cmd === 'status') console.log(JSON.stringify({ proposals: h.proposals(), log: h.log() }, null, 2));
  else throw new Error(`unknown command ${cmd}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((e) => { console.error(`m3 dry run: ${e.message}`); process.exit(1); });
