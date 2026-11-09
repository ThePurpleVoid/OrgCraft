// Studio Publish as a pull request (issue #30, "PR through gh"): push the branch, open the PR with gh when it is
// signed in, fall back to the branch and the compare link without it. A local bare repository stands in for GitHub,
// and a fake gh records what it was asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KIT } from '../bin/agent-team.mjs';
import { setField } from '../packages/team-model/index.mjs';
import { createStudio } from '../apps/studio/server.mjs';
import { compareUrl, githubRepo, pullRequestText } from '../apps/studio/pr.mjs';

const cli = join(KIT, 'bin/agent-team.mjs');
const git = (root, ...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' }).trim();

function repo({ remote = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'studio-pr-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'studio@example.com');
  git(root, 'config', 'user.name', 'Studio Test');
  execFileSync(process.execPath, [cli, 'init', '--preset', 'minimal', '--project', 'Studio', '--dir', root], { stdio: 'ignore' });
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  let bare = null;
  if (remote) {
    bare = mkdtempSync(join(tmpdir(), 'studio-pr-origin-'));
    git(bare, 'init', '-q', '--bare');
    git(root, 'remote', 'add', 'origin', bare);
    git(root, 'push', '-q', '-u', 'origin', 'main');
  }
  return { root, bare };
}

/** A gh that answers `auth status` (signed in or not) and `pr create`, and logs its arguments and stdin. */
function fakeGh({ signedIn = true, exists = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-gh-'));
  const log = join(dir, 'log.json');
  const bin = join(dir, 'gh');
  writeFileSync(bin, `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
let input = ''; try { input = fs.readFileSync(0, 'utf8'); } catch {}
const calls = fs.existsSync(${JSON.stringify(log)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(log)}, 'utf8')) : [];
calls.push({ args, input, token: process.env.STUDIO_PAGE_TOKEN ?? null });
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(calls));
if (args[0] === 'auth') process.exit(${signedIn ? 0 : 1});
if (args[0] === 'pr' && args[1] === 'create') {
  if (${exists}) { process.stderr.write('a pull request for branch "x" into branch "main" already exists:\\nhttps://github.com/acme/app/pull/6\\n'); process.exit(1); }
  process.stdout.write('https://github.com/acme/app/pull/7\\n'); process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'view') { process.stdout.write('https://github.com/acme/app/pull/6\\n'); process.exit(0); }
process.exit(2);
`);
  chmodSync(bin, 0o755);
  return { bin, calls: () => (existsSync(log) ? JSON.parse(readFileSync(log, 'utf8')) : []) };
}

async function serve(root, env, fn) {
  const server = createStudio({ root, env: { ...process.env, ...env } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = (await fetch(`${base}/?t=${server.launchToken}`, { redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
  const call = async (path, body) => {
    const res = await fetch(base + path, body === undefined ? { headers: { cookie } } : { method: 'POST', headers: { 'content-type': 'application/json', origin: base, cookie }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try { await fn(call); } finally { server.close(); }
}

const PLAN = 'Make the web dev a deep thinker\n\nWork in progress\n- web-dev: "Login page" (working): finish, then apply';

test('with gh signed in: Publish pushes the branch and opens a pull request whose body is the change-safety plan', async () => {
  const { root, bare } = repo();
  const gh = fakeGh();
  await serve(root, { AGENT_TEAM_GH: gh.bin }, async (call) => {
    const support = (await call('/v1/team/pr-support')).body;
    assert.equal(support.gh, true);
    assert.equal(support.remote, bare);
    const { spec } = (await call('/v1/team')).body;
    setField(spec, 'web-dev', 'Model', 'deep');
    // A token sent by the page is ignored: only the machine's own sign-in is used.
    const r = await call('/v1/team/publish', { spec, branch: 'team/deep-web', message: PLAN, pr: true, token: 'from-the-page', GH_TOKEN: 'from-the-page' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.pr.state, 'opened');
    assert.equal(r.body.pr.url, 'https://github.com/acme/app/pull/7');
    assert.equal(r.body.pr.base, 'main');
    assert.equal(git(bare, 'rev-parse', 'team/deep-web'), git(root, 'rev-parse', 'HEAD'), 'the branch is on the remote');
    const create = gh.calls().find((c) => c.args[0] === 'pr' && c.args[1] === 'create');
    assert.deepEqual(create.args.slice(2, 8), ['--base', 'main', '--head', 'team/deep-web', '--title', 'Make the web dev a deep thinker']);
    assert.match(create.input, /^Work in progress\n- web-dev: "Login page" \(working\): finish, then apply/);
    assert.match(create.input, new RegExp(`commit ${r.body.commit}`));
    assert.ok(!JSON.stringify(gh.calls()).includes('from-the-page'));
  });
});

test('without gh, or gh not signed in: the branch is pushed and the compare link and command are given', async () => {
  for (const env of [{ AGENT_TEAM_GH: join(tmpdir(), 'no-such-gh') }, { AGENT_TEAM_GH: fakeGh({ signedIn: false }).bin }]) {
    const { root, bare } = repo();
    git(root, 'remote', 'set-url', 'origin', bare);
    await serve(root, env, async (call) => {
      assert.equal((await call('/v1/team/pr-support')).body.gh, false);
      const { spec } = (await call('/v1/team')).body;
      setField(spec, 'web-dev', 'Model', 'deep');
      const r = (await call('/v1/team/publish', { spec, branch: 'team/deep-web', message: PLAN, pr: true })).body;
      assert.equal(r.pr.state, 'pushed');
      assert.match(r.pr.reason, /gh is not installed or not signed in/);
      assert.deepEqual(r.pr.commands, ['gh pr create --base main --head team/deep-web --fill']);
      assert.equal(git(bare, 'rev-parse', 'team/deep-web'), git(root, 'rev-parse', 'HEAD'));
    });
  }
});

test('an existing pull request is found, a failed push is reported, and nothing is ever forced', async () => {
  const { root, bare } = repo();
  const gh = fakeGh({ exists: true });
  await serve(root, { AGENT_TEAM_GH: gh.bin }, async (call) => {
    const { spec } = (await call('/v1/team')).body;
    setField(spec, 'web-dev', 'Model', 'deep');
    const r = (await call('/v1/team/publish', { spec, branch: 'team/again', message: 'Again', pr: true })).body;
    assert.equal(r.pr.state, 'exists');
    assert.equal(r.pr.url, 'https://github.com/acme/app/pull/6');
  });
  // The remote already has a different team/next: the push is refused (not forced) and the owner gets the command.
  const other = repo({ remote: false }).root;
  git(other, 'remote', 'add', 'origin', bare);
  git(other, 'checkout', '-q', '-b', 'team/next');
  writeFileSync(join(other, 'x.txt'), 'x');
  git(other, 'add', '-A'); git(other, 'commit', '-q', '-m', 'x');
  git(other, 'push', '-q', 'origin', 'team/next');
  const before = git(bare, 'rev-parse', 'team/next');
  git(root, 'checkout', '-q', 'main');
  await serve(root, { AGENT_TEAM_GH: gh.bin }, async (call) => {
    const { spec } = (await call('/v1/team')).body;
    setField(spec, 'qa-web', 'Model', 'deep');
    const r = (await call('/v1/team/publish', { spec, branch: 'team/next', message: 'Next', pr: true })).body;
    assert.equal(r.pr.state, 'not-pushed');
    assert.deepEqual(r.pr.commands, ['git push -u origin team/next']);
    assert.equal(git(bare, 'rev-parse', 'team/next'), before, 'the remote branch is untouched');
  });
});

test('no remote, publishing on the base branch, and publish without pr are left as they were', async () => {
  const { root } = repo({ remote: false });
  await serve(root, { AGENT_TEAM_GH: fakeGh().bin }, async (call) => {
    let { spec } = (await call('/v1/team')).body;
    setField(spec, 'web-dev', 'Model', 'deep');
    const a = (await call('/v1/team/publish', { spec, branch: 'team/a', message: 'A', pr: true })).body;
    assert.equal(a.pr.state, 'no-remote');
    assert.deepEqual(a.pr.commands, ['git remote add origin <url>', 'git push -u origin team/a']);
    spec = (await call('/v1/team')).body.spec;
    setField(spec, 'qa-web', 'Model', 'deep');
    const b = (await call('/v1/team/publish', { spec, message: 'B' })).body;
    assert.equal(b.pr, undefined);
  });
  const { root: r2 } = repo();
  await serve(r2, { AGENT_TEAM_GH: fakeGh().bin }, async (call) => {
    const { spec } = (await call('/v1/team')).body;
    setField(spec, 'web-dev', 'Model', 'deep');
    // On main itself, with no origin/HEAD known: there is no other branch to open the pull request into.
    const c = (await call('/v1/team/publish', { spec, message: 'C', pr: true })).body;
    assert.equal(c.pr.state, 'same-branch');
  });
});

test('GitHub remotes give a compare link; other hosts do not', () => {
  for (const r of ['git@github.com:acme/app.git', 'https://github.com/acme/app', 'https://github.com/acme/app.git', 'ssh://git@github.com/acme/app.git']) assert.equal(githubRepo(r), 'https://github.com/acme/app', r);
  assert.equal(githubRepo('https://gitlab.com/acme/app.git'), null);
  assert.equal(compareUrl('git@github.com:acme/app.git', 'main', 'team/x'), 'https://github.com/acme/app/compare/main...team%2Fx?expand=1');
  assert.deepEqual(pullRequestText('Title only', 'abc1234'), { title: 'Title only', body: 'Published from OrgCraft Studio (commit abc1234).' });
});
