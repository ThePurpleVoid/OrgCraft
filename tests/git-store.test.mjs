// packages/git-store: Git objects without git (spec L9a). Golden ids first; then, with the real git binary (tests only),
// fsck what we write, clone our bundles, and read bundles git wrote (with deltas). Skipped with a message without git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import {
  EMPTY_TREE, GitStoreError, applyChanges, hashObject, importBundle, listTree, memoryStore, readBundle, readCommit,
  readObject, readTree, reachable, writeBundle, writeCommit, writeObject, writeTree,
} from '../packages/git-store/index.mjs';
import { crc32, writeZip } from '../packages/git-store/zip.mjs';

const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const ENV = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_NOSYSTEM: '1', HOME: mkdtempSync(join(tmpdir(), 'gs-home-')) };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const DANA = { name: 'Dana', email: 'dana@example.com', time: 1762682400, tz: '+0000' };
const BOT = { name: 'OrgCraft', email: 'noreply@orgcraft.example', time: 1762682400, tz: '+0000' };

async function twoVersions(store) {
  const t1 = await applyChanges(store, null, [
    { path: '.agent-team/team.json', content: '{"kit":"orgcraft@0.21.1"}\n' },
    { path: '.agent-team/roles/support.md', content: '# Support\n' },
    { path: 'docs/team/README.md', content: '# Team\n' },
    { path: 'scripts/agent-team/sync.sh', mode: '100755', content: '#!/bin/sh\necho sync\n' },
  ]);
  const c1 = await writeObject(store, 'commit', writeCommit({ tree: t1, author: DANA, committer: BOT, message: 'Start the team' }));
  const t2 = await applyChanges(store, t1, [
    { path: '.agent-team/roles/support.md', content: '# Support\n\nAnswers customers. Ünïcode ✓\n' },
    { path: 'docs/team/README.md', content: null },
  ]);
  const c2 = await writeObject(store, 'commit', writeCommit({ tree: t2, parents: [c1], author: DANA, committer: BOT, message: 'Version 2\n\nPublished-by: Dana (p_1) via OrgCraft Studio' }));
  return { t1, c1, t2, c2 };
}

test('golden ids: blob, empty tree, a tree and a commit match what git computes', async () => {
  assert.equal(hashObject('blob', ''), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  assert.equal(hashObject('blob', 'hello\n'), 'ce013625030ba8dba906f756967f9e9ca394464a');
  assert.equal(hashObject('tree', Buffer.alloc(0)), EMPTY_TREE);
  const s = memoryStore();
  const tree = await applyChanges(s, null, [{ path: 'hello.txt', content: 'hello\n' }]);
  // `printf 'hello\n' > hello.txt && git add hello.txt && git write-tree`
  assert.equal(tree, 'aaa96ced2d9a1c8e72c56b253a0e2fe78393feb7');
  const commit = await writeObject(s, 'commit', writeCommit({ tree, author: DANA, message: 'Hello' }));
  assert.equal(commit, hashObject('commit', `tree ${tree}\nauthor Dana <dana@example.com> 1762682400 +0000\ncommitter Dana <dana@example.com> 1762682400 +0000\n\nHello\n`));
  const c = readCommit((await readObject(s, commit, 'commit')).body);
  assert.deepEqual([c.tree, c.parents, c.author, c.message], [tree, [], DANA, 'Hello\n']);
});

test('trees sort the way git sorts and refuse what the store never holds', () => {
  const sha = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
  // "a.b" sorts before the folder "a" (compared as "a/"), and "a" before "a0".
  const order = readTree(writeTree([{ mode: '100644', name: 'a0', sha }, { mode: '40000', name: 'a', sha: EMPTY_TREE }, { mode: '100644', name: 'a.b', sha }])).map((e) => e.name);
  assert.deepEqual(order, ['a.b', 'a', 'a0']);
  for (const bad of [{ mode: '120000', name: 'link', sha }, { mode: '160000', name: 'sub', sha }, { mode: '100644', name: '..', sha }, { mode: '100644', name: '.git', sha }, { mode: '100644', name: 'a/b', sha }]) {
    assert.throws(() => writeTree([bad]), GitStoreError, JSON.stringify(bad));
  }
  assert.throws(() => writeTree([{ mode: '100644', name: 'x', sha }, { mode: '100644', name: 'x', sha }]), /duplicate/);
});

test('applyChanges: rewrites only changed subtrees, deletes, drops empty folders, refuses bad paths', async () => {
  const s = memoryStore();
  const { t1, t2 } = await twoVersions(s);
  const files = (await listTree(s, t2)).map((f) => `${f.mode} ${f.path}`);
  assert.deepEqual(files, ['100644 .agent-team/roles/support.md', '100644 .agent-team/team.json', '100755 scripts/agent-team/sync.sh']);
  // Unchanged subtrees keep their ids.
  const sub = async (t, name) => readTree((await readObject(s, t, 'tree')).body).find((e) => e.name === name)?.sha;
  assert.equal(await sub(t1, 'scripts'), await sub(t2, 'scripts'));
  assert.notEqual(await sub(t1, '.agent-team'), await sub(t2, '.agent-team'));
  assert.equal(await sub(t2, 'docs'), undefined, 'the emptied folder is gone');
  for (const path of ['../x', '/abs', 'a//b', '.git/config', 'a/./b', '']) {
    await assert.rejects(applyChanges(s, t1, [{ path, content: 'x' }]), GitStoreError, path);
  }
  await assert.rejects(applyChanges(s, t1, [{ path: 'x', mode: '120000', content: 'y' }]), /not allowed/);
  await assert.rejects(applyChanges(s, t1, [{ path: '.agent-team', content: 'y' }]), /is a folder/);
  await assert.rejects(applyChanges(s, t1, [{ path: '.agent-team/team.json/x', content: 'y' }]), /is a file/);
  assert.equal(await applyChanges(s, t1, [{ path: '.agent-team/team.json', content: null }, { path: '.agent-team/roles/support.md', content: null }, { path: 'docs/team/README.md', content: null }, { path: 'scripts/agent-team/sync.sh', content: null }]), EMPTY_TREE);
});

test('a store that answers with the wrong bytes is caught on read', async () => {
  const s = memoryStore();
  const sha = await writeObject(s, 'blob', 'real');
  const evil = { ...s, get: async () => Buffer.from('blob 4\0fake') };
  await assert.rejects(readObject(evil, sha), (e) => e.code === 'corrupt');
  await assert.rejects(readObject(s, 'f'.repeat(40)), (e) => e.code === 'missing');
  await assert.rejects(readObject(s, sha, 'tree'), /not a tree/);
});

test('reachable: everything from the head, minus what the base already has', async () => {
  const s = memoryStore();
  const { c1, c2 } = await twoVersions(s);
  const all = await reachable(s, [c2]);
  assert.equal(all.length, s.size, 'every object in the store is reachable from the second version');
  const fresh = await reachable(s, [c2], [c1]);
  assert.ok(fresh.includes(c2) && !fresh.includes(c1));
  assert.ok(fresh.length < all.length);
});

test('our bundle round-trips through our reader with the same ids', async () => {
  const s = memoryStore();
  const { c2 } = await twoVersions(s);
  const bundle = await writeBundle(s, { 'refs/heads/main': c2 });
  const { refs, objects } = readBundle(bundle);
  assert.deepEqual(refs, { 'refs/heads/main': c2 });
  const back = memoryStore();
  await importBundle(back, bundle);
  assert.deepEqual(back.ids().sort(), s.ids().sort());
  assert.equal(objects.length, s.size);
  await assert.rejects(writeBundle(s, { 'refs/heads/../x': c2 }), /bad ref/);
  assert.throws(() => readBundle(Buffer.from('# v2 git bundle\n-abc\n\nPACK')), /incomplete|bad bundle/);
});

test('zip: entries are readable by the standard format rules (crc, sizes)', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const zip = writeZip([{ name: 'team/README.txt', data: 'hello' }, { name: 'team/big.md', data: 'x'.repeat(5000) }]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  assert.equal(zip.readUInt16LE(zip.length - 12), 2);
  assert.throws(() => writeZip([{ name: '../x', data: '' }]), /bad zip entry/);
  assert.throws(() => writeZip([{ name: 'a', data: '' }, { name: 'a', data: '' }]), /bad zip entry/);
});

test('real git: fsck --strict on what we write, and git clone of our bundle', { skip: !hasGit && 'git is not installed' }, async () => {
  const s = memoryStore();
  const { c1, c2, t2 } = await twoVersions(s);
  // Loose objects into a bare repository, the way git stores them.
  const bare = mkdtempSync(join(tmpdir(), 'gs-bare-'));
  git(bare, 'init', '-q', '--bare');
  for (const sha of s.ids()) {
    const file = join(bare, 'objects', sha.slice(0, 2), sha.slice(2));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, deflateSync(await s.get(sha)));
  }
  git(bare, 'update-ref', 'refs/heads/main', c2);
  git(bare, 'fsck', '--strict', '--no-dangling');
  assert.equal(git(bare, 'rev-parse', 'main^{tree}'), t2);
  assert.equal(git(bare, 'rev-parse', 'main~1'), c1);

  const bundleFile = join(mkdtempSync(join(tmpdir(), 'gs-bundle-')), 'history.bundle');
  writeFileSync(bundleFile, await writeBundle(s, { 'refs/heads/main': c2 }));
  assert.match(git(bare, 'bundle', 'verify', bundleFile), /okay|records a complete history/);
  const work = join(mkdtempSync(join(tmpdir(), 'gs-clone-')), 'team');
  git(dirname(work), 'clone', '-q', '-b', 'main', bundleFile, work);
  assert.equal(git(work, 'rev-parse', 'HEAD'), c2);
  assert.equal(git(work, 'log', '--format=%an|%cn|%s', '-2'), 'Dana|OrgCraft|Version 2\nDana|OrgCraft|Start the team');
  assert.equal(readFileSync(join(work, '.agent-team/roles/support.md'), 'utf8'), '# Support\n\nAnswers customers. Ünïcode ✓\n');
  assert.equal(git(work, 'ls-files', '-s', 'scripts/agent-team/sync.sh').split(' ')[0], '100755');
  git(work, 'fsck', '--strict', '--no-dangling');
});

test('real git: we read a bundle git wrote, deltas included, and write it back with the same ids', { skip: !hasGit && 'git is not installed' }, async () => {
  const repo = mkdtempSync(join(tmpdir(), 'gs-real-'));
  git(repo, 'init', '-q');
  // Many versions of one big file, so git's pack holds deltas.
  let text = Array.from({ length: 400 }, (_, i) => `line ${i} of the support brief, which grows a little each version`).join('\n');
  for (let v = 0; v < 12; v++) {
    text += `\nversion ${v} adds a rule`;
    mkdirSync(join(repo, 'roles'), { recursive: true });
    writeFileSync(join(repo, 'roles/support.md'), `${text}\n`);
    writeFileSync(join(repo, `note-${v % 3}.md`), `note ${v}\n`);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', `v${v}`);
  }
  git(repo, 'repack', '-adq', '--depth=50', '--window=50');
  const bundleFile = join(repo, '..', `${Date.now()}-real.bundle`);
  git(repo, 'bundle', 'create', bundleFile, 'main');
  const raw = readFileSync(bundleFile);
  const { refs, objects, deltas } = readBundle(raw);
  assert.ok(deltas > 0, 'git wrote deltas, so the delta path ran');
  assert.equal(refs['refs/heads/main'], git(repo, 'rev-parse', 'main'));
  assert.equal(objects.length, Number(git(repo, 'rev-list', '--objects', '--all').split('\n').length));
  const s = memoryStore();
  await importBundle(s, raw);
  const files = await listTree(s, readCommit((await readObject(s, refs['refs/heads/main'], 'commit')).body).tree);
  assert.deepEqual(files.map((f) => f.path).sort(), ['note-0.md', 'note-1.md', 'note-2.md', 'roles/support.md']);
  // And back out through our writer: git sees the same history.
  const ours = join(repo, '..', `${Date.now()}-ours.bundle`);
  writeFileSync(ours, await writeBundle(s, refs));
  const work = join(mkdtempSync(join(tmpdir(), 'gs-reclone-')), 'team');
  git(dirname(work), 'clone', '-q', '-b', 'main', ours, work);
  assert.equal(git(work, 'rev-parse', 'HEAD'), refs['refs/heads/main']);
  assert.equal(git(work, 'rev-list', '--count', 'HEAD'), '12');
});
