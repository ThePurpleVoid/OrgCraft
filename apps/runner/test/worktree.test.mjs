import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkpoint, git, prepare } from '../worktree.mjs';

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
  const again = await prepare({ root, repo: { url: bare }, worktree: 'web/1-a', session: 's3' });
  assert.equal(again.resumed, true);
  assert.equal(readFileSync(join(again.cwd, 'new.txt'), 'utf8'), 'work\n', 'a resumed session finds its work');
  const saved = await checkpoint({ cwd: a.cwd, branch: 'web/1-a', role: 'web-dev', reason: 'test' });
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
