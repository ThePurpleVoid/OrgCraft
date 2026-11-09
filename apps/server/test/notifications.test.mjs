// L25 notifications: quiet hours hold non-urgent email for the digest, the digest goes out once a day at the
// person's own time, and the delivery log shows what was sent, held, skipped or failed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { key, plane } from './helpers.mjs';
import { drain } from '../sinks.mjs';
import { composeDigest, createNotifications, digests, flushHeld, inQuiet, localDate, maskEmail, minuteOfDay } from '../email.mjs';
import { readSecret } from '../store.mjs';

const PUBLIC = 'https://cp.example';
function fakeProvider() {
  const sent = [];
  return { sent, title: 'Fake', async send(m) { sent.push(m); return { id: `fake_${sent.length}` }; } };
}
let n = 0;
const ev = (type, data) => ({ specversion: '1.0', id: `nev_${++n}`, type, version: 1, source: '/tenants/acme/teams/shop', tenant: 'acme', team: 'shop', time: new Date().toISOString(), actor: { kind: 'role', id: 'qa-web' }, data });
const hm = (m) => `${String(Math.floor(((m + 1440) % 1440) / 60)).padStart(2, '0')}:${String(((m + 1440) % 1440) % 60).padStart(2, '0')}`;

test('quiet hours wrap past midnight, in the person\'s own zone', () => {
  const at = new Date('2026-11-09T06:30:00Z'); // 22:30 the day before in Los Angeles
  assert.equal(minuteOfDay(at, 'America/Los_Angeles'), 22 * 60 + 30);
  assert.equal(localDate(at, 'America/Los_Angeles'), '2026-11-08');
  const p = { timezone: 'America/Los_Angeles', quiet_start: 22 * 60, quiet_end: 7 * 60 };
  assert.equal(inQuiet(p, at), true);
  assert.equal(inQuiet(p, new Date('2026-11-09T16:00:00Z')), false, '08:00 local');
  assert.equal(inQuiet({ ...p, quiet_start: 9 * 60, quiet_end: 17 * 60 }, new Date('2026-11-09T18:00:00Z')), true, '10:00 local');
  assert.equal(inQuiet({ timezone: 'UTC', quiet_start: null, quiet_end: null }, at), false);
});

test('the digest lists at most 20 updates and says how many more', () => {
  const many = Array.from({ length: 25 }, (_, i) => ev('message.blocked', { question: `Q${i}` }));
  const d = composeDigest(many, { team: 'shop', teamName: 'Shop', date: '2026-11-09' });
  assert.equal(d.subject, '[Shop] Daily digest: 25 updates (2026-11-09)');
  assert.equal(d.lines.filter((l) => l.startsWith('- ')).length, 20);
  assert.equal(d.lines.at(-1), 'And 5 more in the Studio.');

  assert.equal(maskEmail('owner@shop.example'), 'o****@shop.example');
});

test('GET/PUT /v1/me/notifications validates times, zones and digest kinds', async () => {
  await plane(async ({ call }) => {
    assert.deepEqual((await call('GET', '/me/notifications')).body, { timezone: 'UTC', quietHours: null, digest: null, breakthrough: ['approval', 'budget100'] });
    assert.equal((await call('PUT', '/me/notifications', { timezone: 'Mars/Olympus' })).status, 400);
    assert.equal((await call('PUT', '/me/notifications', { quietHours: { from: '25:00', to: '07:00' } })).status, 400);
    assert.equal((await call('PUT', '/me/notifications', { quietHours: { from: '07:00', to: '07:00' } })).status, 400);
    assert.equal((await call('PUT', '/me/notifications', { digest: { at: '08:00', kinds: ['digest'] } })).status, 400);
    const r = await call('PUT', '/me/notifications', { timezone: 'America/Los_Angeles', quietHours: { from: '22:00', to: '07:00' }, digest: { at: '07:30', kinds: ['minutes'] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { timezone: 'America/Los_Angeles', quietHours: { from: '22:00', to: '07:00' }, digest: { at: '07:30', kinds: ['minutes'] }, breakthrough: ['approval', 'budget100'] });
    // A field left out keeps its value; null turns it off.
    const r2 = await call('PUT', '/me/notifications', { quietHours: null });
    assert.deepEqual([r2.body.timezone, r2.body.quietHours, r2.body.digest.at], ['America/Los_Angeles', null, '07:30']);
  });
});

test('quiet hours hold what does not break through, the digest sends it once a day, and the log shows it', async () => {
  const provider = fakeProvider();
  const real = new Date();
  // A zone where it is not near midnight, so "today" holds for the whole test.
  const zone = ['UTC', 'Asia/Tokyo', 'America/Los_Angeles', 'Europe/Berlin'].find((z) => { const m = minuteOfDay(real, z); return m > 120 && m < 1300; });
  const m = minuteOfDay(real, zone);
  await plane(async ({ db, call, su, inject }) => {
    await call('POST', '/teams', { id: 'shop', name: 'Shop' });
    assert.equal((await call('POST', '/teams/shop/sinks', { format: 'email', provider: 'fake', sender: 'Shop <team@shop.example>', secret: 'EMAIL_PROVIDER_KEY' })).status, 201);
    assert.equal((await call('PUT', '/secrets/EMAIL_PROVIDER_KEY', { value: 're_test_key' }, await su())).status, 200);
    const add = await call('POST', '/teams/shop/emails', { email: 'owner@shop.example' });
    const code = /(\d{6})$/.exec(provider.sent.at(-1).subject)[1];
    assert.equal((await call('POST', `/teams/shop/emails/${add.body.id}/verify`, { code })).status, 200);
    assert.equal((await call('PATCH', `/teams/shop/emails/${add.body.id}`, { kinds: ['approval', 'blocked', 'digest'] })).status, 200);
    assert.equal((await call('PUT', '/me/notifications', { timezone: zone, quietHours: { from: hm(m - 60), to: hm(m + 60) }, digest: { at: hm(m - 1), kinds: ['minutes'] } })).status, 200);
    const sentBefore = provider.sent.length;
    assert.equal(await digests(db, key, { providers: { fake: provider }, readSecret, publicUrl: PUBLIC, now: new Date() }), 0, 'an empty digest is not sent');

    const blocked = ev('message.blocked', { question: 'Which footer name?' });
    const approval = ev('approval.requested', { approval: 'apr_1', action: 'deploy', why: 'ship it', cardId: 'card_1' });
    const minutes = ev('meeting.minutes', { meeting: 'Weekly', date: '2026-11-09', decisions: [], actions: [] });
    await inject('shop', [blocked, approval, minutes]);
    await drain(db, key, { email: { providers: { fake: provider }, publicUrl: PUBLIC, now: () => real } });
    assert.deepEqual(provider.sent.slice(sentBefore).map((x) => x.subject.split(' ')[1]), ['Approval'], 'approval breaks through; blocked is held');
    const held = await db.tenant('acme', ({ q }) => q("select event, status, error from email_deliveries where held"));
    assert.deepEqual(held, [{ event: blocked.id, status: 'skipped', error: 'quiet hours: kept for the digest' }]);

    const opts = { providers: { fake: provider }, readSecret, publicUrl: PUBLIC, now: new Date() };
    assert.equal(await digests(db, key, opts), 1);
    const digest = provider.sent.at(-1);
    assert.equal(digest.subject, `[Shop] Daily digest: 2 updates (${localDate(real, zone)})`);
    assert.match(digest.text, /- QA web is waiting on a decision/i);
    assert.match(digest.text, /- Minutes: Weekly/);
    assert.match(digest.text, /You get this because you turned on "Daily digest" emails for Shop\./);
    assert.equal(await digests(db, key, opts), 0, 'once a day');


    const log = (await call('GET', '/teams/shop/notifications/log')).body;
    assert.deepEqual(log.items.map((r) => [r.channel, r.kind, r.status, r.to]).slice(0, 3), [
      ['email', 'digest', 'sent', 'o****@shop.example'],
      ['email', 'approval', 'sent', 'o****@shop.example'],
      ['email', 'blocked', 'held', 'o****@shop.example'],
    ]);
    assert.equal(log.items.find((r) => r.status === 'held').why, 'quiet hours: kept for the digest');
    const all = await call('GET', '/teams/shop/notifications/log?all=1');
    assert.equal(all.status, 200, 'the admin token may see everyone');
    // Someone else's rows never say where they went, even masked (review sev 3).
    await db.tenant('acme', ({ q }) => q("insert into email_subscriptions(id, tenant, team, principal, email, kinds, verified_at) values ('es_other1', 'acme', 'shop', 'per_otherperson1', 'dana@else.example', '{blocked}', now())"));
    await db.tenant('acme', ({ q }) => q("insert into email_deliveries(tenant, team, subscription, event, kind, status) values ('acme', 'shop', 'es_other1', 'ev_x', 'blocked', 'sent')"));
    const theirs = (await call('GET', '/teams/shop/notifications/log?all=1')).body.items.find((r) => r.principal === 'per_otherperson1');
    assert.equal(theirs.to, undefined);
    assert.ok((await call('GET', '/teams/shop/notifications/log?all=1')).body.items.filter((r) => r.principal === 'admin').every((r) => r.to === 'o****@shop.example'));
    // Someone else sees none of these rows.
    const other = await createNotifications({ db }).log('acme', 'shop', 'someone-else');
    assert.deepEqual(other.items, []);
    assert.equal((await call('GET', '/teams/shop/notifications/log?before=abc')).status, 400);

    // Without the digest, held mail goes out on its own when quiet hours end, once; what a digest carried is not
    // sent again (review sev 2).
    assert.equal((await call('PUT', '/me/notifications', { digest: null })).status, 200);
    const night = ev('message.blocked', { question: 'Still there?' });
    const before = provider.sent.length;
    await inject('shop', [night]);
    await drain(db, key, { email: { providers: { fake: provider }, publicUrl: PUBLIC, now: () => real } });
    assert.equal(provider.sent.length, before, 'held during quiet hours');
    const flush = (at) => flushHeld(db, key, { providers: { fake: provider }, readSecret, publicUrl: PUBLIC, now: at });
    assert.equal(await flush(new Date()), 0, 'still quiet');
    const after = new Date(Date.now() + 2 * 3600_000);
    assert.equal(await flush(after), 1, 'quiet hours are over');
    assert.match(provider.sent.at(-1).text, /Still there\?/);
    assert.equal(await flush(after), 0, 'once');
  }, { publicUrl: PUBLIC, email: { providers: { fake: provider } } });
});
