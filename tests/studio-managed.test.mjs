// The Studio's managed backend (ADR 0012, spec L9 section 4.3, step L9b): a team in OrgCraft's own Git store with no
// code host. Publish opens a change request; accepting it moves main by compare-and-swap, fast-forward only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedBackend, memoryRefs } from '../apps/studio/managed.mjs';
import { createStudioHandler } from '../apps/studio/handler.mjs';
import { applyChanges, memoryStore, writeBundle, writeCommit, writeObject } from '../packages/git-store/index.mjs';

const ORIGIN = 'https://admin.example.com';
const BASE = '/api/agent-team/studio';
const at = () => new Date('2026-11-09T12:00:00Z');
const make = (opts = {}) => { const store = memoryStore(); const refs = memoryRefs(); return { store, refs, b: managedBackend({ store, refs, now: at, ...opts }) }; };
const file = (path, content, mode = '100644') => ({ path, content, mode });

test('a team with no version yet reads as empty; the first publish opens change 1, and accepting it makes main', async () => {
  const { b, refs } = make();
  assert.deepEqual(await b.info(), { repo: null, defaultBranch: 'main', head: null, pr: true, managed: true });
  assert.deepEqual(await b.readTeam(null), { files: [], base: null });
  const out = await b.publish({ base: null, message: 'Start the team', changes: [file('.agent-team/team.json', '{}\n'), file('scripts/agent-team/sync.sh', '#!/bin/sh\n', '100755')], pr: { title: 'Start the team', body: '' } });
  assert.deepEqual([out.branch, out.pr.state, out.pr.number, out.pr.url], ['cr/1', 'opened', 1, '/studio/changes/1']);
  assert.equal(await refs.getRef('main'), null, 'publishing alone does not move main');
  assert.equal((await b.prStatus('cr/1')).state, 'open');
  const done = await b.accept(1, { by: { id: 'p_1' } });
  assert.equal(done.sha, out.commit);
  assert.deepEqual(await refs.getRef('main'), { sha: out.commit, version: 1 });
  assert.equal((await b.prStatus('cr/1')).state, 'merged');
  const info = await b.info();
  assert.equal(info.head.sha, out.commit);
  assert.equal(info.head.at, '2026-11-09T12:00:00.000Z');
  const read = await b.readTeam(out.commit);
  assert.deepEqual(read.files.map((f) => [f.path, f.mode, f.content]), [['.agent-team/team.json', '100644', '{}\n'], ['scripts/agent-team/sync.sh', '100755', '#!/bin/sh\n']]);
  await assert.rejects(b.accept(1), (e) => e.status === 409, 'a change is accepted once');
});

test('publish refuses a stale base and a path outside the team\'s files; accept refuses when main moved', async () => {
  const { b } = make();
  const one = await b.publish({ base: null, message: 'one', changes: [file('.agent-team/team.json', '{"a":1}\n')] });
  await b.accept(one.pr.number);
  await assert.rejects(b.publish({ base: null, message: 'stale', changes: [file('.agent-team/team.json', '{}\n')] }), (e) => e.status === 409 && e.type === 'stale' && /reload/.test(e.message));
  await assert.rejects(b.publish({ base: one.commit, message: 'x', changes: [file('src/app.js', 'x')] }), (e) => e.status === 400 && /outside the team's files/.test(e.message));
  // Two changes from the same base: the second to be accepted is stale, and nothing is forced.
  const a = await b.publish({ base: one.commit, message: 'a', changes: [file('.agent-team/team.json', '{"a":2}\n')] });
  const c = await b.publish({ base: one.commit, message: 'c', changes: [file('.agent-team/team.json', '{"a":3}\n')] });
  await b.accept(a.pr.number);
  await assert.rejects(b.accept(c.pr.number), (e) => e.status === 409 && e.type === 'stale');
  assert.equal((await b.info()).head.sha, a.commit);
  assert.equal((await b.prStatus(c.branch)).state, 'open', 'the stale change stays open to be rebuilt');
  assert.deepEqual(await b.close(c.pr.number).then((r) => r.state), 'closed');
});

test('two concurrent publishes straight away (one-person organisation): exactly one wins, the other is stale and closed', async () => {
  const { b, refs } = make({ autoAccept: true });
  const first = await b.publish({ base: null, message: 'start', changes: [file('.agent-team/team.json', '{}\n')] });
  assert.equal(first.pr.state, 'merged');
  const results = await Promise.allSettled([1, 2, 3].map((n) => b.publish({ base: first.commit, message: `edit ${n}`, changes: [file('.agent-team/team.json', `{"n":${n}}\n`)] })));
  const won = results.filter((r) => r.status === 'fulfilled');
  assert.equal(won.length, 1, JSON.stringify(results.map((r) => r.status)));
  assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.status === 409 && r.reason.type === 'stale'));
  assert.equal((await refs.getRef('main')).sha, won[0].value.commit);
  assert.equal((await refs.getRef('main')).version, 2);
  for (let n = 2; n <= 4; n++) { const c = await refs.getChange(n); assert.ok(c.state === 'accepted' || c.state === 'closed'); }
});

test('readTeam keeps only the read set\'s regular files, and refuses a team over the limits', async () => {
  const { b, store, refs } = make();
  const tree = await applyChanges(store, null, [file('.agent-team/team.json', '{}\n'), file('src/secret.js', 'no'), file('README.md', '# hi')]);
  const who = { name: 'x', email: 'x@y', time: 1, tz: '+0000' };
  const commit = await writeObject(store, 'commit', writeCommit({ tree, author: who, message: 'imported' }));
  await refs.setRef('main', commit, null);
  assert.deepEqual((await b.readTeam(commit)).files.map((f) => f.path), ['.agent-team/team.json']);
  assert.deepEqual((await b.listPaths(commit)).sort(), ['.agent-team/team.json', 'README.md', 'src/secret.js']);
  assert.equal(await b.readRootFile(commit, 'README.md'), '# hi');
  assert.equal(await b.readRootFile(commit, 'src/secret.js'), null, 'root files only');
  await assert.rejects(b.readTeam('0'.repeat(40)), (e) => e.status === 404);
  await assert.rejects(b.readTeam('../x'), (e) => e.status === 400);
  const many = await applyChanges(store, null, Array.from({ length: 2001 }, (_, i) => file(`.agent-team/f${i}.md`, `${i}\n`)));
  const big = await writeObject(store, 'commit', writeCommit({ tree: many, author: who, message: 'many' }));
  await assert.rejects(b.readTeam(big), (e) => e.status === 413);
});

test('what the store holds clones with real git, byte for byte', async () => {
  const { b, store } = make({ autoAccept: true });
  const one = await b.publish({ base: null, message: 'Start', changes: [file('.agent-team/team.json', '{}\n'), file('docs/team/README.md', '# Team\n')] });
  const two = await b.publish({ base: one.commit, message: 'Edit', changes: [file('docs/team/README.md', null), file('AGENTS.md', 'x\n')] });
  const dir = mkdtempSync(join(tmpdir(), 'managed-clone-'));
  writeFileSync(join(dir, 'team.bundle'), await writeBundle(store, { 'refs/heads/main': two.commit }));
  execFileSync('git', ['clone', '-q', '-b', 'main', join(dir, 'team.bundle'), join(dir, 'c')]);
  assert.equal(execFileSync('git', ['-C', join(dir, 'c'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), two.commit);
  execFileSync('git', ['-C', join(dir, 'c'), 'fsck', '--strict'], { stdio: 'pipe' });
  assert.equal(execFileSync('git', ['-C', join(dir, 'c'), 'ls-files'], { encoding: 'utf8' }), '.agent-team/team.json\nAGENTS.md\n');
});

test('the handler with a managed backend: no repo or token, an empty team gets templates, publish opens cr/1 from base null', async () => {
  const { b } = make();
  assert.throws(() => createStudioHandler({ basePath: BASE, allowedOrigins: [ORIGIN], authorize: async () => null, backend: { kind: 'github' } }), /managedBackend/);
  const handler = createStudioHandler({ basePath: BASE, allowedOrigins: [ORIGIN], backend: b, teamName: 'acme', limiter: async () => true, logger: () => {}, authorize: async () => ({ id: 'u_a', name: 'Ada' }) });
  const call = async (method, path, body) => {
    const res = await handler(new Request(`${ORIGIN}${BASE}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'x-agent-team-studio': '1', 'sec-fetch-site': 'same-origin', ...(body !== undefined ? { origin: ORIGIN, 'content-type': 'application/json' } : {}) } }));
    return { status: res.status, body: await res.json() };
  };
  const empty = await call('GET', '/v1/team');
  assert.equal(empty.status, 200, JSON.stringify(empty.body));
  assert.deepEqual([empty.body.noTeam, empty.body.managed, empty.body.repo, empty.body.git.repo, empty.body.git.head], [true, true, null, false, null]);
  assert.ok(empty.body.templates.length);
  const draft = await call('POST', '/v1/team/from-template', { id: empty.body.templates[0].id, project: 'Acme', owner: 'Ada', timezone: 'UTC' });
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  const pre = await call('POST', '/v1/team/preview', { spec: draft.body.spec, base: null });
  assert.equal(pre.status, 200, JSON.stringify(pre.body));
  assert.ok(pre.body.changes.some((c) => c.path === '.agent-team/team.json'));
  const pub = await call('POST', '/v1/team/publish', { spec: draft.body.spec, base: null, message: 'Start the team' });
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  assert.deepEqual([pub.body.branch, pub.body.pr.number], ['cr/1', 1]);
  const pr = await call('GET', '/v1/team/pr?branch=cr/1');
  assert.deepEqual([pr.status, pr.body.state], [200, 'open']);
  assert.equal((await call('GET', '/v1/team/pr?branch=agent-team/x')).status, 400, 'only cr/<n> names a change');
  await b.accept(1);
  const team = await call('GET', '/v1/team');
  assert.equal(team.body.noTeam, undefined);
  assert.equal(team.body.git.head.sha, pub.body.commit);
  assert.equal((await call('POST', '/v1/team/publish', { spec: draft.body.spec, base: null, message: 'again' })).status, 409, 'base null once main exists is stale');
});
