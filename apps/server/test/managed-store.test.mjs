// The managed team store in Postgres (migration 022, ADR 0012, spec L9 step L9b): the Studio's managed backend on
// pgObjects and pgRefs, compare-and-swap on main, change request numbers, and row-level security between tenants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../store.mjs';
import { plane } from './helpers.mjs';
import { pgObjects, pgRefs } from '../managed-db.mjs';
import { managedBackend } from '../../studio/managed.mjs';

const file = (path, content, mode = '100644') => ({ path, content, mode });
const backend = (db, tenant, team, opts = {}) => managedBackend({ store: pgObjects(db, tenant, team), refs: pgRefs(db, tenant, team), ...opts });

test('022: a managed team publishes and reads back through Postgres; main moves only on accept', async () => {
  await plane(async ({ db }) => {
    await store.createTeam(db, 'acme', { id: 'shop' });
    assert.equal((await db.system("select backend from teams where id = 'shop'"))[0].backend, 'github', 'existing and new teams default to github');
    await db.system("insert into people(id, provider, subject, login) values ('per_adalovelace', 'github', '1', 'ada')");
    const b = backend(db, 'acme', 'shop');
    assert.equal((await b.info()).head, null);
    const one = await b.publish({ base: null, message: 'Start', changes: [file('.agent-team/team.json', '{}\n'), file('scripts/agent-team/sync.sh', '#!/bin/sh\n', '100755')], pr: { title: 'Start', body: 'first' }, by: { id: 'per_adalovelace' }, needsCode: true, capability: [{ kind: 'seat-added', subject: 'lead' }] });
    assert.deepEqual([one.branch, one.pr.number], ['cr/1', 1]);
    const [row] = await db.system("select number, base, head, title, body, state, needs_code, created_by, capability_diff from change_requests where team = 'shop'");
    assert.deepEqual({ ...row }, { number: 1, base: null, head: one.commit, title: 'Start', body: 'first', state: 'open', needs_code: true, created_by: 'per_adalovelace', capability_diff: [{ kind: 'seat-added', subject: 'lead' }] });
    assert.equal((await b.info()).head, null);
    await b.accept(1, { by: { id: 'per_adalovelace' } });
    assert.deepEqual((await db.system("select name, sha, version from managed_refs where team = 'shop' order by name")).map((r) => [r.name, r.sha, Number(r.version)]), [['cr/1', one.commit, 1], ['main', one.commit, 1]]);
    const read = await b.readTeam((await b.info()).head.sha);
    assert.deepEqual(read.files.map((f) => [f.path, f.mode, f.content]), [['.agent-team/team.json', '100644', '{}\n'], ['scripts/agent-team/sync.sh', '100755', '#!/bin/sh\n']]);
    assert.equal((await b.prStatus('cr/1')).state, 'merged');
    const [acc] = await db.system("select state, accepted_by, accepted_sha from change_requests where team = 'shop' and number = 1");
    assert.deepEqual({ ...acc }, { state: 'accepted', accepted_by: 'per_adalovelace', accepted_sha: one.commit });
  });
});

test('022: concurrent publishes straight away, exactly one wins; numbers never repeat; a stale accept is refused', async () => {
  await plane(async ({ db }) => {
    await store.createTeam(db, 'acme', { id: 'shop' });
    const b = backend(db, 'acme', 'shop', { autoAccept: true });
    const first = await b.publish({ base: null, message: 'Start', changes: [file('.agent-team/team.json', '{}\n')] });
    const results = await Promise.allSettled([1, 2, 3, 4].map((n) => b.publish({ base: first.commit, message: `edit ${n}`, changes: [file('.agent-team/team.json', `{"n":${n}}\n`)] })));
    const won = results.filter((r) => r.status === 'fulfilled');
    assert.equal(won.length, 1, JSON.stringify(results.map((r) => r.reason?.message ?? 'ok')));
    assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.status === 409 && r.reason.type === 'stale'));
    const numbers = (await db.system("select number, state from change_requests where team = 'shop' order by number")).map((r) => [r.number, r.state]);
    assert.deepEqual(numbers.map(([n]) => n), [1, 2, 3, 4, 5]);
    assert.equal(numbers.filter(([, s]) => s === 'accepted').length, 2);
    assert.equal(numbers.filter(([, s]) => s === 'closed').length, 3);
    const [main] = await db.system("select sha, version from managed_refs where team = 'shop' and name = 'main'");
    assert.deepEqual([main.sha, Number(main.version)], [won[0].value.commit, 2]);
  });
});

test('022: accept moves main and marks the change in one transaction: a closed change never moves main', async () => {
  await plane(async ({ db }) => {
    await store.createTeam(db, 'acme', { id: 'shop' });
    const b = backend(db, 'acme', 'shop');
    const one = await b.publish({ base: null, message: 'Start', changes: [file('.agent-team/team.json', '{}\n')] });
    await b.close(one.pr.number);
    await assert.rejects(b.accept(one.pr.number), (e) => e.status === 409);
    assert.equal((await db.system("select count(*)::int as n from managed_refs where team = 'shop' and name = 'main'"))[0].n, 0, 'main never moved');
    const two = await b.publish({ base: null, message: 'Start again', changes: [file('.agent-team/team.json', '{"a":1}\n')] });
    const [x, y] = await Promise.allSettled([b.accept(two.pr.number), b.close(two.pr.number)]);
    const [cr] = await db.system("select state from change_requests where team = 'shop' and number = $1", [two.pr.number]);
    const [main] = await db.system("select sha from managed_refs where team = 'shop' and name = 'main'");
    // Whichever won, the two agree: accepted with main at its head, or closed with main never moved.
    if (cr.state === 'accepted') assert.equal(main?.sha, two.commit, JSON.stringify([x.status, y.status]));
    else assert.equal(main, undefined, JSON.stringify([x.status, y.status]));
  });
});

test('022: row-level security keeps one tenant\'s objects, refs and changes from another', async () => {
  await plane(async ({ db }) => {
    await store.ensureTenant(db, 'globex');
    await store.createTeam(db, 'acme', { id: 'shop' });
    await store.createTeam(db, 'globex', { id: 'news' });
    const mine = backend(db, 'acme', 'shop', { autoAccept: true });
    const one = await mine.publish({ base: null, message: 'Start', changes: [file('.agent-team/team.json', '{"secret":true}\n')] });
    // The other tenant, naming acme's team and commit, sees nothing.
    const theirs = backend(db, 'globex', 'shop');
    assert.equal((await theirs.info()).head, null);
    assert.equal(await pgObjects(db, 'globex', 'shop').get(one.commit), null);
    assert.equal(await pgRefs(db, 'globex', 'shop').getChange(1), null);
    await assert.rejects(theirs.readTeam(one.commit), (e) => e.status === 404);
    // And cannot write into it: the policy's check refuses a row for another tenant.
    await assert.rejects(db.tenant('globex', ({ q }) => q("insert into managed_refs(tenant, team, name, sha) values ('acme', 'shop', 'main', $1)", ['0'.repeat(40)])));
    // The app role cannot rewrite or delete stored objects.
    await assert.rejects(db.tenant('acme', ({ q }) => q("delete from managed_objects where team = 'shop'")));
    await assert.rejects(db.tenant('acme', ({ q }) => q("update managed_objects set body = '\\x00' where team = 'shop'")));
  });
});
