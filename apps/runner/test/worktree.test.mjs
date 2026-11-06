import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkpoint, git, outOfArea, prepare, release } from '../worktree.mjs';

function origin() {
  const dir = mkdtempSync(join(tmpdir(), 'wt-'));
  const bare = join(dir, 'o.git'), seed = join(dir, 'seed');
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['init', '--quiet', '-b', 'main', seed]);
  writeFileSync(join(seed, 'a.txt'), 'a\n');
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  for (const a of [['add', '-A'], ['commit', '--quiet', '-m', 'seed'], ['push', '--quiet', bare, 'main']]) execFileSync('git', a, { cwd: seed, env });
  return { bare, root: join(dir, 'root') };
}

test('one clone per repository, one worktree per branch, reused on resume', async () => {
  const { bare, root } = origin();
  const [a, b] = await Promise.all([
    prepare({ root, repo: { url: bare, ref: 'main' }, worktree: 'web/1-a', session: 's1' }),
    prepare({ root, repo: { url: bare, ref: 'main' }, worktree: { branch: 'api/2-b', base: 'main' }, session: 's2' }),
  ]);
  assert.notEqual(a.cwd, b.cwd);
  assert.equal(await git(a.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), 'web/1-a');
  assert.equal(readFileSync(join(b.cwd, 'a.txt'), 'utf8'), 'a\n');
  writeFileSync(join(a.cwd, 'new.txt'), 'work\n');
  release(a.cwd, 's1');
  const again = await prepare({ root, repo: { url: bare }, worktree: 'web/1-a', session: 's3' });
  assert.equal(again.resumed, true);
  assert.equal(readFileSync(join(again.cwd, 'new.txt'), 'utf8'), 'work\n', 'a resumed session finds its work');
  const saved = await checkpoint({ cwd: a.cwd, branch: 'web/1-a', role: 'web-dev', reason: 'test', areas: ['new.txt'] });
  assert.equal(saved.pushed, true);
  assert.equal(execFileSync('git', ['show', 'web/1-a:new.txt'], { cwd: bare, encoding: 'utf8' }), 'work\n');
});

test('a role that builds nothing gets a detached checkout; bad branch names are refused', async () => {
  const { bare, root } = origin();
  const r = await prepare({ root, repo: { url: bare }, session: 'ro' });
  assert.equal(r.branch, null);
  assert.equal(await git(r.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');
  assert.deepEqual(await checkpoint({ cwd: r.cwd, branch: null, role: 'x', reason: 'y' }).then((c) => c.pushed), false);
  await assert.rejects(prepare({ root, repo: { url: bare }, worktree: '--upload-pack=evil', session: 'z' }), /not a branch name/);
  await assert.rejects(prepare({ root, repo: { url: bare }, worktree: 'a..b', session: 'z' }), /not a branch name/);
  await assert.rejects(prepare({ root, repo: {}, session: 'z' }), /repo.url/);
});

test('working copies are keyed by repository and exact branch, and a resume checks what it resumes into', async () => {
  const one = origin(), two = origin();
  const root = one.root;
  const a = await prepare({ root, repo: { url: one.bare }, worktree: 'feat/a', session: 's1' });
  const b = await prepare({ root, repo: { url: two.bare }, worktree: 'feat/a', session: 's2' });
  const c = await prepare({ root, repo: { url: one.bare }, worktree: 'feat-a', session: 's3' });
  assert.equal(new Set([a.cwd, b.cwd, c.cwd]).size, 3, 'two repositories, or feat/a and feat-a, never share a folder');
  await assert.rejects(prepare({ root, repo: { url: one.bare }, worktree: 'feat/a', session: 'other' }), /in use by session s1/);
  release(a.cwd, 's1');
  await git(a.cwd, 'checkout', '--quiet', '-b', 'something-else');
  await assert.rejects(prepare({ root, repo: { url: one.bare }, worktree: 'feat/a', session: 's4' }), /not resuming into it/);
});

test('a checkpoint commits only inside the owned areas, and never pushes commits outside them', async () => {
  const { bare, root } = origin();
  const w = await prepare({ root, repo: { url: bare }, worktree: 'web/5', session: 's5' });
  mkdirSync(join(w.cwd, 'web'), { recursive: true });
  writeFileSync(join(w.cwd, 'web', 'page.txt'), 'mine\n');
  writeFileSync(join(w.cwd, 'server.txt'), 'written from the shell\n');
  const r = await checkpoint({ cwd: w.cwd, branch: 'web/5', base: 'main', role: 'web-dev', reason: 't', areas: ['web/'] });
  assert.equal(r.pushed, true);
  assert.deepEqual(r.held, ['server.txt']);
  assert.equal(execFileSync('git', ['show', '--name-only', '--format=', 'web/5'], { cwd: bare, encoding: 'utf8' }).trim(), 'web/page.txt');
  // The shell can still commit outside the areas; such a branch is not pushed.
  await git(w.cwd, 'add', 'server.txt');
  await git(w.cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'sneaky');
  assert.deepEqual((await outOfArea({ cwd: w.cwd, base: 'main', areas: ['web/'] })).committed, ['server.txt']);
  const again = await checkpoint({ cwd: w.cwd, branch: 'web/5', base: 'main', role: 'web-dev', reason: 't', areas: ['web/'] });
  assert.equal(again.pushed, false);
  assert.match(again.error, /outside this role's owned areas \(server.txt\)/);
});
