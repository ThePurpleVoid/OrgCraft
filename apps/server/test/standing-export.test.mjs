// L9d (spec L9 section 5.2; ADR 0013 rule 3): a managed team's standing export. Setting a new target waits 24 hours
// and is announced; the cadence alone and turning it off take effect at once; all of it needs the scoped passkey on
// the web. The job writes the same zip to the connection, daily or after a publish, and a failure is recorded and
// announced once a day, never silent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ORIGIN, issuer, owner } from './sign-in-helpers.mjs';
import { authenticator } from './authenticator.mjs';
import { pgObjects, pgRefs } from '../managed-db.mjs';
import { managedBackend } from '../../studio/managed.mjs';
import { createM3 } from '../m3.mjs';
import { createStandingExports } from '../exports.mjs';
import { readZip } from '../../../packages/git-store/zip.mjs';

const RP = 'studio.example';
const H = 3600_000;

async function signedIn(gh, browser) {
  gh.as = owner;
  const b = browser({ ip: owner.login });
  await b.signIn();
  const key = authenticator({ origin: ORIGIN, rpId: RP });
  assert.equal((await b.call('POST', '/me/passkeys', { name: 'laptop', credential: key.create((await b.call('GET', '/me/passkeys/options')).body) })).status, 201);
  const su = async (scope) => (await b.call('POST', '/auth/step-up', { webauthn: key.get((await b.call('GET', `/auth/step-up/challenge${scope ? `?scope=${encodeURIComponent(scope)}` : ''}`)).body), ...(scope ? { scope } : {}) })).body.token;
  return { b, su };
}

async function setUp(db, o) {
  await o.b.call('POST', '/teams', { id: 'shop' }, { 'x-step-up': await o.su() });
  await db.system("update teams set backend = 'managed' where id = 'shop'");
  await db.system("insert into credentials(id, tenant, name, service, created_by) values ('cred_drive000001', 'acme', 'DRIVE', 'google-drive', 'x'), ('cred_drive000002', 'acme', 'DRIVE_TWO', 'google-drive', 'x'), ('cred_slack000001', 'acme', 'SLACK', 'slack', 'x')");
  const b = managedBackend({ store: pgObjects(db, 'acme', 'shop'), refs: pgRefs(db, 'acme', 'shop'), autoAccept: true });
  await b.publish({ base: null, changes: [{ path: '.agent-team/team.json', content: '{}\n' }], message: 'One', branch: 'x', pr: { title: 'One' } });
  return b;
}

test('standing export: a new target waits 24 hours and is announced; cadence alone and off are at once; all need the scoped passkey', () => issuer(async ({ db, gh, browser }) => {
  const o = await signedIn(gh, browser);
  await setUp(db, o);
  const put = async (body, scope = 'standing-export:shop') => o.b.call('PUT', '/teams/shop/standing-export', body, scope === null ? {} : { 'x-step-up': await o.su(scope) });
  const drive = { connection: 'cred_drive000001', target: 'OrgCraft/shop', cadence: 'daily' };
  assert.equal((await put(drive, null)).body.type, 'step-up-required');
  assert.equal((await put(drive, 'export:shop')).status, 401, 'a step-up for the download does not set the standing export');
  assert.equal((await put({ ...drive, connection: 'cred_slack000001' })).body.type, 'wrong-service');
  assert.equal((await put({ ...drive, connection: 'cred_nothere0001' })).status, 404);
  assert.equal((await put({ ...drive, cadence: 'hourly' })).status, 400);

  const on = await put(drive);
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal(on.body.active, null, 'not active yet');
  assert.equal(on.body.pending.target, 'OrgCraft/shop');
  const wait = new Date(on.body.pending.effectiveAt).getTime() - Date.now();
  assert.ok(wait > 23.9 * H && wait <= 24 * H, `${wait} ms`);
  const me = (await o.b.call('GET', '/me')).body;
  assert.ok(me.notices.some((n) => n.action === 'standing-export.changed' && n.team === 'shop'), 'announced to the owner');

  // The pending target becomes active only after 24 hours.
  const m3 = createM3({ db });
  const writes = [];
  const job = (at) => createStandingExports({ db, m3, now: () => at, exportOf: (tenant, team) => managedBackend({ store: pgObjects(db, tenant, team), refs: pgRefs(db, tenant, team), now: () => at }).exportZip({ team }), deliver: async (x) => { writes.push(x); } }).runDue();
  assert.deepEqual(await job(new Date(Date.now() + 23 * H)), { promoted: 0, written: 0, failed: 0 });
  assert.equal(writes.length, 0, 'nothing written to a target still waiting');
  assert.deepEqual(await job(new Date(Date.now() + 25 * H)), { promoted: 1, written: 1, failed: 0 });
  assert.deepEqual([writes[0].connection, writes[0].service, writes[0].target], ['cred_drive000001', 'google-drive', 'OrgCraft/shop']);
  assert.match(writes[0].name, /^shop-v1-\d{4}-\d{2}-\d{2}\.zip$/);
  assert.ok(readZip(writes[0].bytes).some((e) => e.name === 'history.bundle'));
  const got = (await o.b.call('GET', '/teams/shop/standing-export')).body;
  assert.deepEqual([got.active.target, got.active.cadence, got.pending, !!got.last.sha], ['OrgCraft/shop', 'daily', null, true]);

  // The cadence alone: at once, no wait. Another folder: pending again, the active one keeps going meanwhile.
  const cad = await put({ ...drive, cadence: 'on-publish' });
  assert.deepEqual([cad.body.active.cadence, cad.body.pending], ['on-publish', null]);
  const moved = await put({ ...drive, target: 'Elsewhere' });
  assert.deepEqual([moved.body.active.target, moved.body.pending.target], ['OrgCraft/shop', 'Elsewhere']);

  // Off: at once, pending and all.
  assert.equal((await o.b.call('DELETE', '/teams/shop/standing-export', {}, {})).status, 401);
  const off = await o.b.call('DELETE', '/teams/shop/standing-export', {}, { 'x-step-up': await o.su('standing-export:shop') });
  assert.deepEqual(off.body, { active: null, pending: null, last: null });
  const audit = (await db.system("select action from audit where action like 'standing-export.%' order by seq")).map((r) => r.action);
  assert.deepEqual(audit, ['standing-export.set', 'standing-export.active', 'standing-export.set', 'standing-export.set', 'standing-export.off']);
}));

test('standing export job: daily once a day, on-publish when main moves, failures recorded and announced once a day', () => issuer(async ({ db, gh, browser }) => {
  const o = await signedIn(gh, browser);
  const b = await setUp(db, o);
  await db.system("insert into standing_exports(tenant, team, connection, target, cadence) values ('acme', 'shop', 'cred_drive000001', 'Backups', 'on-publish')");
  const m3 = createM3({ db });
  let fail = null;
  const writes = [];
  const job = (at) => createStandingExports({ db, m3, now: () => at, exportOf: (tenant, team) => managedBackend({ store: pgObjects(db, tenant, team), refs: pgRefs(db, tenant, team), now: () => at }).exportZip({ team }), deliver: async (x) => { if (fail) throw new Error(fail); writes.push(x); } }).runDue();
  const t0 = new Date('2026-11-12T08:00:00Z');
  assert.equal((await job(t0)).written, 1);
  assert.equal((await job(new Date(t0.getTime() + 2 * H))).written, 0, 'main did not move');
  const main = (await pgRefs(db, 'acme', 'shop').getRef('main')).sha;
  await b.publish({ base: main, changes: [{ path: '.agent-team/team.json', content: '{"x":1}\n' }], message: 'Two', branch: 'y', pr: { title: 'Two' } });
  fail = 'the folder is gone';
  assert.equal((await job(new Date(t0.getTime() + 3 * H))).failed, 1);
  assert.equal((await job(new Date(t0.getTime() + 3.5 * H))).failed, 0, 'at most one try an hour');
  assert.equal((await job(new Date(t0.getTime() + 4.5 * H))).failed, 1);
  const failed = await db.system("select envelope from events where team = 'shop' and type = 'standing-export.failed'");
  assert.equal(failed.length, 1, 'announced once that day');
  assert.equal(failed[0].envelope.data.error, 'the folder is gone');
  assert.equal((await o.b.call('GET', '/teams/shop/standing-export')).body.last.error, 'the folder is gone');
  fail = null;
  assert.equal((await job(new Date(t0.getTime() + 6 * H))).written, 1);
  const st = (await o.b.call('GET', '/teams/shop/standing-export')).body;
  assert.deepEqual([st.last.error, st.last.sha], [null, (await pgRefs(db, 'acme', 'shop').getRef('main')).sha]);
  const exported = await db.system("select envelope from events where team = 'shop' and type = 'team.exported' order by seq");
  assert.deepEqual(exported.map((e) => [e.envelope.data.kind, e.envelope.data.target]), [['standing', 'Backups'], ['standing', 'Backups']]);
  // Daily: once per UTC day.
  await db.system("update standing_exports set cadence = 'daily'");
  assert.equal((await job(new Date(t0.getTime() + 8 * H))).written, 0, 'already written today');
  assert.equal((await job(new Date(t0.getTime() + 24 * H))).written, 1, 'the next day');
  // With no connector wired, the default deliver fails with words a person can act on.
  await db.system("update standing_exports set last_at = null, last_try_at = null");
  const real = await createStandingExports({ db, m3, now: () => new Date(t0.getTime() + 30 * H), exportOf: (tenant, team) => managedBackend({ store: pgObjects(db, tenant, team), refs: pgRefs(db, tenant, team) }).exportZip({ team }) }).runDue();
  assert.equal(real.failed, 1);
  assert.match((await o.b.call('GET', '/teams/shop/standing-export')).body.last.error, /can't write to google-drive yet/);
}));
