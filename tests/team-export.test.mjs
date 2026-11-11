// L9d (spec L9 sections 5.1 and 5.3): a managed team's export imports back, into a new team or with
// `agent-team import <zip>`, only when every object hashes right and the team passes its checks; and the store is
// read a level (or a batch of blobs) at a time (code review L9b sev4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { KIT } from '../bin/agent-team.mjs';
import { listTree, memoryStore } from '../packages/git-store/index.mjs';
import { readZip, writeZip } from '../packages/git-store/zip.mjs';
import { managedBackend, memoryRefs } from '../apps/studio/managed.mjs';
import * as core from '../apps/studio/core.mjs';

const cli = join(KIT, 'bin/agent-team.mjs');
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' } }).trim();

/** A real team (agent-team init, synced), published into a managed backend: every file of the repo as version 1. */
async function publishedTeam() {
  const root = mkdtempSync(join(tmpdir(), 'export-team-'));
  git(root, 'init', '-q', '-b', 'main');
  const r = spawnSync(process.execPath, [cli, 'init', '--preset', 'minimal', '--project', 'Acme', '--kit', 'file:' + KIT], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const walk = (d) => readdirSync(d).flatMap((f) => (f === '.git' ? [] : statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  const changes = walk(root).map((f) => ({ path: relative(root, f), content: readFileSync(f, 'utf8'), mode: statSync(f).mode & 0o111 ? '100755' : '100644' })).filter((c) => core.inReadSet(c.path));
  const store = memoryStore();
  const b = managedBackend({ store, refs: memoryRefs(), autoAccept: true, now: () => new Date('2026-11-11T12:00:00Z') });
  await b.publish({ base: null, changes, message: 'Start the team', branch: 'x', pr: { title: 'Start' } });
  return { b, store, root };
}

test('an export imports into a new, empty team: same main, same files; never into a team that has a history', async () => {
  const { b } = await publishedTeam();
  const out = await b.exportZip({ team: 'acme' });
  assert.equal(out.name, 'acme-v1-2026-11-11.zip');
  const store = memoryStore();
  const fresh = managedBackend({ store, refs: memoryRefs() });
  const got = await fresh.importZip(out.zip, { check: core.checkTeam });
  assert.equal(got.sha, out.sha);
  assert.deepEqual((await fresh.readTeam(out.sha)).files, (await b.readTeam(out.sha)).files);
  await assert.rejects(fresh.importZip(out.zip, { check: core.checkTeam }), (e) => e.status === 409 && e.type === 'not-empty');
});

test('import refuses a zip with no bundle, a bundle that is not whole, and a team that fails its checks; nothing is written', async () => {
  const { b } = await publishedTeam();
  const out = await b.exportZip({ team: 'acme' });
  const entries = readZip(out.zip);
  const without = (name) => writeZip(entries.filter((e) => e.name !== name));
  const store = memoryStore();
  const fresh = managedBackend({ store, refs: memoryRefs() });
  await assert.rejects(fresh.importZip(without('history.bundle')), (e) => e.status === 422 && e.type === 'bad-zip');
  await assert.rejects(fresh.importZip(Buffer.from('not a zip')), (e) => e.status === 422 && e.type === 'bad-zip');
  // A bundle cut short, and one with a byte changed inside the pack: the pack checksum or an object hash fails.
  const bundle = entries.find((e) => e.name === 'history.bundle').data;
  const swap = (data) => writeZip(entries.map((e) => (e.name === 'history.bundle' ? { ...e, data } : e)));
  await assert.rejects(fresh.importZip(swap(bundle.subarray(0, bundle.length - 40))), (e) => e.status === 422 && e.type === 'bad-bundle');
  const flipped = Buffer.from(bundle); flipped[flipped.length - 30] ^= 0xff;
  await assert.rejects(fresh.importZip(swap(flipped)), (e) => e.status === 422 && e.type === 'bad-bundle');
  // A team whose generated files were edited by hand fails the checks (sync's output must match what is committed).
  await assert.rejects(fresh.importZip(out.zip, { check: () => ({ ok: false, errors: ['docs/team/protocols.md: edited by hand'], drift: [] }) }), (e) => e.status === 422 && e.type === 'checks' && /edited by hand/.test(e.message));
  assert.equal(store.size, 0, 'nothing was written');
  assert.equal(await (await fresh.info()).head, null);
});

test('agent-team import <zip> clones the history into a new folder after the checks, and refuses a broken export', async () => {
  const { b } = await publishedTeam();
  const out = await b.exportZip({ team: 'acme' });
  const here = mkdtempSync(join(tmpdir(), 'import-cli-'));
  const zip = join(here, 'acme-v1.zip');
  writeFileSync(zip, out.zip);
  const ok = spawnSync(process.execPath, [cli, 'import', zip], { cwd: here, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  assert.match(ok.stdout, /Imported acme-v1\.zip/);
  assert.equal(git(join(here, 'acme-v1'), 'rev-parse', 'HEAD'), out.sha);
  assert.equal(git(join(here, 'acme-v1'), 'remote'), '', 'no remote pointing at a temporary bundle');
  assert.equal(spawnSync(process.execPath, [cli, 'check'], { cwd: join(here, 'acme-v1'), encoding: 'utf8' }).status, 0, 'the imported team is in sync');
  const again = spawnSync(process.execPath, [cli, 'import', zip], { cwd: here, encoding: 'utf8' });
  assert.equal(again.status, 64);
  assert.match(again.stderr, /already exists/);
  const bad = join(here, 'bad.zip');
  writeFileSync(bad, writeZip(readZip(out.zip).filter((e) => e.name !== 'history.bundle')));
  const r = spawnSync(process.execPath, [cli, 'import', bad], { cwd: here, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no history\.bundle/);
  assert.equal(existsSync(join(here, 'bad')), false);
});

test('reads are batched: one getMany per tree level, and blobs a batch at a time (code review L9b sev4)', async () => {
  const { b, store } = await publishedTeam();
  const main = (await b.info()).head.sha;
  const calls = { get: 0, getMany: 0 };
  const counted = { ...store, get: async (s) => { calls.get++; return store.get(s); }, getMany: async (s) => { calls.getMany++; return store.getMany(s); }, put: store.put, has: store.has };
  const c = managedBackend({ store: counted, refs: { ...memoryRefs(), getRef: async () => ({ sha: main, version: 1 }) } });
  calls.get = 0; calls.getMany = 0;
  const read = await c.readTeam(main);
  assert.ok(read.files.length > 20, `${read.files.length} files`);
  const depth = Math.max(...read.files.map((f) => f.path.split('/').length));
  assert.ok(calls.getMany <= depth + Math.ceil(read.files.length / 200), `getMany ${calls.getMany} for ${read.files.length} files, depth ${depth}`);
  assert.ok(calls.get <= 2, `get ${calls.get} (the commit only)`);
  // listTree order is Git's tree order, as before batching.
  const tree = (await listTree(counted, (await import('../packages/git-store/index.mjs')).readCommit((await (await import('../packages/git-store/index.mjs')).readObject(store, main, 'commit')).body).tree)).map((f) => f.path);
  assert.deepEqual(tree, read.files.map((f) => f.path).filter((p) => tree.includes(p)));
});
