// `report.mjs published` (CTO, 2026-11-06): the repository's CI tells the control plane a team version reached main,
// so the rollout view does not depend on the Studio being open when the PR merges. Idempotent per commit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parsePlan, publishedBody, teamVersionAt } from '../tools/report.mjs';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Dana', GIT_AUTHOR_EMAIL: 'd@example.com', GIT_COMMITTER_NAME: 'Dana', GIT_COMMITTER_EMAIL: 'd@example.com', GIT_COMMITTER_DATE: '2026-11-06T10:10:00Z', GIT_AUTHOR_DATE: '2026-11-06T10:10:00Z' } }).trim();
const put = (root, path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };

test('the plan comes back from the commit message the Studio writes (safety.js planText)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'published-plan-'));
  copyFileSync(join(KIT, 'apps/studio/public/safety.js'), join(dir, 'safety.mjs'));
  writeFileSync(join(dir, 'team-model.mjs'), `export * from ${JSON.stringify(pathToFileURL(join(KIT, 'packages/team-model/index.mjs')).href)};\n`);
  const { planText } = await import(pathToFileURL(join(dir, 'safety.mjs')).href);
  const items = [
    { id: 'a', kind: 'role-off', role: 'backend-dev', severity: 'choice', inFlight: { task: 'Fix: refunds (EU)', branch: 'b', pr: '4' }, recommended: 'handoff' },
    { id: 'b', kind: 'brief', role: 'qa-web', severity: 'choice', inFlight: null, recommended: 'pause' },
    { id: 'c', kind: 'path-moved', role: 'web-dev', detail: 'web/ moves from web-dev to designer', severity: 'choice', inFlight: { pr: '9' }, recommended: 'move-after-merge' },
    { id: 'd', kind: 'path-moved', role: 'docs', detail: 'd/ moves from docs to cto', severity: 'choice', inFlight: null, recommended: 'move-after-merge' },
    { id: 'e', kind: 'tier', role: 'cto', severity: 'choice', inFlight: null, recommended: 'finish' },
    { id: 'f', kind: 'brief', role: 'cpo', severity: 'safe', recommended: 'finish' },
  ];
  const picks = new Map([['a', { choice: 'handoff', target: 'web-dev' }], ['c', { choice: 'move-and-handover', target: 'designer' }]]);
  const message = `Publish the team (#12)\n\n${planText(items, picks, (s) => s.toUpperCase(), 'chief of staff')}\n`;
  assert.deepEqual(parsePlan(message), {
    'backend-dev': { choice: 'handoff', to: 'web-dev' }, 'qa-web': { choice: 'pause' }, 'web-dev': { choice: 'move-and-handover', to: 'designer' },
    docs: { choice: 'move-after-merge' }, cto: { choice: 'finish' },
  });
  assert.deepEqual(parsePlan('Publish the team\n\nNo plan here.'), {});
  rmSync(dir, { recursive: true, force: true });
});

/** A repository with two publishes; the second switches clerk off and is a merge commit on main. */
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'published-repo-'));
  git(root, 'init', '-q', '-b', 'main');
  put(root, '.agent-team/team.json', '{"include":["clerk","filer"]}\n');
  put(root, 'docs/team/roles/clerk.md', '# Clerk\n'); put(root, 'docs/team/roles/filer.md', '# Filer\n'); put(root, 'docs/team/roles/README.md', 'x\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Set up the team');
  const first = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-qb', 'publish');
  put(root, '.agent-team/team.json', '{"include":["filer"]}\n');
  rmSync(join(root, 'docs/team/roles/clerk.md'));
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'Switch clerk off\n\nWork in progress\n\n- Clerk (clerk): Index, branch b. Switched off: hand the work off now, to filer.\n\nThe team carries these out when this change is merged.');
  git(root, 'checkout', '-q', 'main');
  put(root, 'README.md', 'other work\n'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'Unrelated');
  git(root, 'merge', '-q', '--no-ff', 'publish', '-m', 'Merge pull request #12 from acme/publish\n\nWork in progress\n\n- Clerk (clerk): Index, branch b. Switched off: hand the work off now, to filer.');
  return { root, first, merge: git(root, 'rev-parse', 'HEAD') };
}

test('the body names the merge commit on main, the roles it runs, the ones switched off and the plan', () => {
  const { root, first, merge } = repo();
  put(root, 'notes.md', 'later\n'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'Not a team change');
  const b = publishedBody(root);
  assert.equal(b.version, merge, 'first-parent: the merge, not the branch commit');
  assert.equal(teamVersionAt(root), merge.slice(0, 12), 'what roles report is the same version');
  assert.deepEqual({ ...b, version: undefined }, {
    kind: 'published', version: undefined, publishedAt: '2026-11-06T10:10:00.000Z', pr: 12, roles: ['filer'], off: ['clerk'],
    plan: { clerk: { choice: 'handoff', to: 'filer' } }, changes: ['.agent-team/team.json', 'docs/team/roles/clerk.md'], by: 'Dana', source: 'report.mjs',
  });
  const old = publishedBody(root, { sha: first.slice(0, 9), pr: '3', by: 'ci-bot' });
  assert.deepEqual([old.version, old.pr, old.roles, old.off, old.by], [first, 3, ['clerk', 'filer'], [], 'ci-bot']);
  assert.throws(() => publishedBody(root, { sha: 'nope' }), /no commit nope/);
  rmSync(root, { recursive: true, force: true });
});

test('the CLI posts to the report URL and the mirror with their tokens, never the local log, and exits 0 when refused', async () => {
  const { root, merge } = repo();
  const got = [];
  const server = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => { got.push({ url: req.url, token: req.headers['x-team-token'], body: JSON.parse(raw) }); res.writeHead(req.url === '/mirror' ? 400 : 200, { 'content-type': 'application/json' }).end(req.url === '/mirror' ? '{"error":"kind must be status"}' : '{"ok":true}'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const home = mkdtempSync(join(tmpdir(), 'published-home-'));
  const run = () => new Promise((resolve) => {
    const p = spawn(process.execPath, [join(KIT, 'tools/report.mjs'), 'published'], { cwd: root, env: { ...process.env, AGENT_TEAM_HOME: home, GITHUB_ACTOR: 'octo', TEAM_REPORT_URL: `${base}/main`, TEAM_REPORT_TOKEN: 't1', TEAM_REPORT_MIRROR_URL: `${base}/mirror`, TEAM_REPORT_MIRROR_TOKEN: 't2' } });
    let out = '', err = ''; p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { err += c; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
  const r = await run();
  assert.equal(r.code, 0);
  assert.match(r.out, new RegExp(`published ${merge.slice(0, 12)} \\(PR #12\\), 1 roles`));
  assert.match(r.err, /mirror board refused \(HTTP 400\): kind must be status/);
  assert.deepEqual(got.map((g) => [g.url, g.token, g.body.kind, g.body.version, g.body.by]), [['/main', 't1', 'published', merge, 'octo'], ['/mirror', 't2', 'published', merge, 'octo']]);
  assert.equal(execFileSync('ls', ['-A', home], { encoding: 'utf8' }), '', 'nothing written to the local log');
  server.close();
  rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
});
