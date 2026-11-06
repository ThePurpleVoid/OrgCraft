// Email notifications (PRD 6.8, CPO story "Email notifications", criteria 1 to 5): the email sink, the templates,
// the sign-up with a code, unsubscribe without sign-in. A fake provider stands in for the real one; the real one
// is never called without a key in the vault.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, key, plane } from './helpers.mjs';
import { drain } from '../sinks.mjs';
import { KINDS, PROVIDERS, compose, outside, readToken, render, roleTitle } from '../email.mjs';

const PUBLIC = 'https://cp.example';
const STUDIO = 'https://studio.example';

function fakeProvider({ fail = false } = {}) {
  const sent = [];
  return { sent, fail, title: 'Fake', async send(m) { if (this.fail) throw new Error('HTTP 503: try later'); sent.push(m); return { id: `fake_${sent.length}` }; } };
}

let n = 0;
const ev = (type, data, actor = 'web-dev') => ({ specversion: '1.0', id: `ev_${++n}_${Math.random().toString(36).slice(2, 8)}`, type, version: 1, source: '/tenants/acme/teams/shop', tenant: 'acme', team: 'shop', time: '2026-11-06T09:30:00.000Z', actor: { kind: 'role', id: actor }, data });
const LONG = 'Rotate the payments webhook secret and redeploy the API to production, then purge the CDN cache for every region before the evening launch';
const SAMPLES = {
  approval: ev('approval.requested', { approval: 'apr_1', action: 'deploy', why: LONG, recommendation: 'Approve: the change was reviewed and tested', cardId: 'card_1' }),
  budget80: ev('budget.warned', { scope: 'day', day: '2026-11-06', spent: 400, cap: 500, currency: 'USD' }),
  budget100: ev('budget.exhausted', { scope: 'day', day: '2026-11-06', spent: 500, cap: 500, currency: 'USD', cardId: 'card_2' }),
  blocked: ev('message.blocked', { to: 'chief-of-staff', task: 'Footer', detail: 'Which legal entity name goes in the footer: "Acme Inc." or "Acme Labs"?', recommendation: 'Acme Inc., as on the invoices' }, 'qa-web'),
  minutes: ev('meeting.minutes', { meeting: 'Weekly planning', meetingId: 'mtg_1', date: '2026-11-06', decisions: [{ text: 'Ship the footer on Friday' }, { text: 'Hold the pricing page' }], actions: [1, 2, 3], needsYou: 1 }),
};

async function setup(call) {
  await call('POST', '/teams', { id: 'shop', name: 'Shop' });
  const s = await call('POST', '/teams/shop/sinks', { format: 'email', provider: 'fake', sender: 'Shop team <team@shop.example>', secret: 'EMAIL_PROVIDER_KEY' });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  return s.body;
}

async function withKey(call, su) {
  const r = await call('PUT', '/secrets/EMAIL_PROVIDER_KEY', { value: 're_test_key' }, await su());
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

async function verified(call, provider, email = 'owner@shop.example') {
  const add = await call('POST', '/teams/shop/emails', { email });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  const code = /(\d{6})/.exec(provider.sent.at(-1).subject)[1];
  assert.equal((await call('POST', `/teams/shop/emails/${add.body.id}/verify`, { code })).status, 200);
  return add.body.id;
}

const opts = (provider) => ({ publicUrl: PUBLIC, email: { providers: { fake: provider }, studioUrl: STUDIO } });
const drainOpts = (provider) => ({ email: { providers: { fake: provider }, publicUrl: PUBLIC } });

test('every kind renders: subject under 70 starting with [team], at most four lines, one link, the footer (criterion 1)', () => {
  for (const [kind, e] of Object.entries(SAMPLES)) {
    const mail = compose(e, { teamName: 'Shop' });
    assert.equal(mail.kind, kind);
    assert.ok(mail.subject.startsWith('[Shop] '), mail.subject);
    assert.ok(mail.subject.length < 70, `${kind}: ${mail.subject.length}`);
    assert.ok(mail.lines.length >= 1 && mail.lines.length <= 4, kind);
    const msg = render(key, mail, { base: PUBLIC, tenant: 'acme', team: 'shop', teamName: 'Shop', subscription: 'eml_x', now: new Date('2026-11-06T09:30:00Z') });
    const body = msg.text.split('\n--\n')[0];
    assert.equal((body.match(/https?:\/\//g) ?? []).length, 1, `${kind}: one link in the body`);
    assert.equal((msg.html.match(/<a /g) ?? []).length, 3, `${kind}: the button plus the footer's two links`);
    assert.match(msg.text, new RegExp(`You get this because you turned on "${KINDS[kind].label}" emails for Shop\\.`));
    assert.match(msg.text, /Turn off these emails: https:\/\/cp\.example\/v1\/email\/unsubscribe\?t=/);
    assert.match(msg.headers['List-Unsubscribe'], /^<https:\/\/cp\.example\/v1\/email\/unsubscribe\?t=/);
    assert.equal(msg.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  }
  // The copy, word for word where it has no placeholders.
  assert.equal(compose(SAMPLES.budget80, { teamName: 'Shop' }).subject, "[Shop] 80% of today's budget used");
  assert.deepEqual(compose(SAMPLES.budget80, { teamName: 'Shop' }).lines, ['Your team has used $4.00 of its $5.00 daily budget.', 'Work carries on. At 100% only release-blocking fixes and checks keep running.']);
  assert.deepEqual(compose(SAMPLES.budget100, { teamName: 'Shop' }).lines[1], 'New work is paused until 00:00 UTC. Raise the cap in the Studio to resume sooner.');
  assert.deepEqual(compose(SAMPLES.minutes, { teamName: 'Shop' }).lines, ['2 decisions and 3 action items.', '"Ship the footer on Friday"', '1 item needs you.']);
  assert.equal(compose(ev('report.status', { status: 'working' })), null, 'no email for other events');
});

test('no action by reply; approval links last 24 hours, others 7 days, and land in the Studio (criterion 2)', () => {
  const now = new Date('2026-11-06T09:30:00Z');
  for (const [kind, e] of Object.entries(SAMPLES)) {
    const msg = render(key, compose(e, { teamName: 'Shop' }), { base: PUBLIC, tenant: 'acme', team: 'shop', teamName: 'Shop', subscription: 'eml_x', now });
    assert.doesNotMatch(msg.text, /\breply\b/i, kind);
    const link = /: (https:\/\/cp\.example\/v1\/email\/link\?t=\S+)/.exec(msg.text)[1];
    const tk = readToken(key, new URL(link).searchParams.get('t'));
    assert.equal(tk.e - now.getTime(), kind === 'approval' ? 86_400_000 : 7 * 86_400_000, kind);
    assert.ok(tk.p.startsWith('/teams/shop/'), tk.p);
  }
  const approval = compose(SAMPLES.approval, { teamName: 'Shop' });
  assert.equal(approval.link.label, 'Review in the Studio');
  assert.equal(approval.lines.at(-1), 'Nothing happens until you approve in the Studio.');
  assert.equal(readToken(key, 'x.y'), null);
  assert.equal(readToken(key, `${Buffer.from('{"p":"/x"}').toString('base64url')}.forged`), null);
});

test('outside text is quoted and cut to 120 characters; roles are named by title (criterion 3)', () => {
  const a = compose(SAMPLES.approval, { teamName: 'Shop' });
  const quoted = a.lines[1];
  assert.match(quoted, /^".+"$/);
  assert.equal(quoted.length - 2, 120);
  assert.ok(quoted.endsWith('…"'));
  assert.equal(a.lines[0], 'Web dev needs your approval before it can go on.');
  const b = compose(SAMPLES.blocked, { teamName: 'Shop' });
  assert.equal(b.subject, '[Shop] QA web is waiting on a decision');
  assert.match(b.lines[0], /^QA web is blocked on: ".+"$/);
  assert.equal(roleTitle('chief-of-staff'), 'Chief of staff');
  assert.equal(roleTitle('cto'), 'CTO');
  assert.equal(roleTitle('web-dev', { 'web-dev': 'Front end' }), 'Front end');
  assert.equal(outside('a\n\tb\u0007c'), 'a b c');
  // A 200-character summary: the subject keeps [team] and the start of the summary, and ends with an ellipsis.
  const long = compose(ev('approval.requested', { why: 'x'.repeat(30) + ' ' + 'Publish the pricing page '.repeat(7) }), { teamName: 'Shop' }).subject;
  assert.ok(long.startsWith('[Shop] Approval needed: xxxxxxxxxx'), long);
  assert.ok(long.endsWith('…') && long.length < 70, `${long.length}: ${long}`);
});

test('nothing is sent before verification and opt-in; the code expires in 15 minutes; then each kind arrives once (criterion 5)', async () => {
  const provider = fakeProvider();
  let clock = new Date('2026-11-06T09:00:00Z');
  await plane(async ({ db, call, su }) => {
    await setup(call, provider);
    // No key in the vault: the code cannot go out, and nothing calls the provider.
    assert.deepEqual((({ teamName, ready }) => ({ teamName, ready }))((await call('GET', '/teams/shop/emails')).body), { teamName: 'Shop', ready: false }, 'the page can say emails are not set up');
    const early = await call('POST', '/teams/shop/emails', { email: 'Owner@Shop.example' });
    assert.equal(early.status, 201);
    assert.deepEqual([early.body.sent, early.body.reason], [false, 'no provider key stored as EMAIL_PROVIDER_KEY']);
    assert.equal(provider.sent.length, 0);
    await withKey(call, su);
    // Asking again within a minute is refused; after it, a fresh code goes out.
    assert.equal((await call('POST', '/teams/shop/emails', { email: 'owner@shop.example' })).status, 429);
    clock = new Date(clock.getTime() + 61_000);
    const add = await call('POST', '/teams/shop/emails', { email: 'owner@shop.example' });
    assert.equal(add.body.sent, true);
    assert.equal(add.body.id, early.body.id, 'the same address, not a second one');
    const verify = provider.sent.at(-1);
    assert.equal(verify.to, 'owner@shop.example');
    assert.equal(verify.apiKey, 're_test_key');
    assert.match(verify.subject, /^Your code for Agent Team Studio: \d{6}$/);
    assert.match(verify.text, /It expires in 15 minutes\./);
    assert.doesNotMatch(verify.text, /https?:/, 'the verification email has no link');
    const code = /(\d{6})$/.exec(verify.subject)[1];

    // Events before verification: none sent.
    await call('POST', '/teams/shop/events', { events: [SAMPLES.approval] });
    await drain(db, key, drainOpts(provider));
    assert.equal(provider.sent.length, 1);
    // Choosing kinds before verifying is refused.
    assert.equal((await call('PATCH', `/teams/shop/emails/${add.body.id}`, { kinds: ['approval'] })).status, 409);
    // A wrong code counts a try; an expired code is refused.
    assert.equal((await call('POST', `/teams/shop/emails/${add.body.id}/verify`, { code: code === '000000' ? '111111' : '000000' })).status, 400);
    clock = new Date(clock.getTime() + 16 * 60_000);
    assert.equal((await call('POST', `/teams/shop/emails/${add.body.id}/verify`, { code })).status, 410);
    clock = new Date(clock.getTime() + 61_000);
    await call('POST', '/teams/shop/emails', { email: 'owner@shop.example' });
    const code2 = /(\d{6})$/.exec(provider.sent.at(-1).subject)[1];
    assert.equal((await call('POST', `/teams/shop/emails/${add.body.id}/verify`, { code: code2 })).status, 200);

    // Verified but nothing switched on: still nothing.
    await call('POST', '/teams/shop/events', { events: [SAMPLES.budget100] });
    await drain(db, key, drainOpts(provider));
    assert.equal(provider.sent.length, 2);
    const list = (await call('GET', '/teams/shop/emails')).body;
    assert.equal(list.ready, true);
    assert.deepEqual(list.emails.map((e) => [e.email, e.verified, e.kinds]), [['owner@shop.example', true, []]]);
    assert.deepEqual(list.kinds.filter((k) => k.suggested).map((k) => k.id), ['approval', 'budget100']);
    assert.equal((await call('PATCH', `/teams/shop/emails/${add.body.id}`, { kinds: ['nope'] })).status, 400);

    // Every kind switched on: each event arrives exactly once, a retry after a failure sends only what failed.
    assert.equal((await call('PATCH', `/teams/shop/emails/${add.body.id}`, { kinds: Object.keys(KINDS) })).status, 200);
    const before = provider.sent.length;
    await call('POST', '/teams/shop/events', { events: Object.values(SAMPLES).map((e) => ({ ...e, id: `${e.id}_b` })) });
    await drain(db, key, drainOpts(provider));
    const got = provider.sent.slice(before);
    assert.deepEqual(got.map((m) => m.subject.split(' ')[1]), ['Approval', '80%', 'Daily', 'QA', 'Minutes:']);
    for (const m of got) {
      assert.equal(m.from, 'Shop team <team@shop.example>');
      assert.ok(m.html.includes('<a '), 'an HTML part');
      assert.ok(m.text.length, 'a plain-text part');
    }
    await drain(db, key, drainOpts(provider));
    assert.equal(provider.sent.length, before + 5, 'nothing twice');
    const deliveries = await db.tenant('acme', ({ q }) => q("select status, count(*)::int as n from email_deliveries group by status order by status"));
    assert.deepEqual(deliveries, [{ status: 'sent', n: 5 }]);

    // A provider outage: the event is retried later and sent once it recovers.
    provider.fail = true;
    await call('POST', '/teams/shop/events', { events: [{ ...SAMPLES.blocked, id: 'ev_outage' }] });
    await drain(db, key, drainOpts(provider));
    const [sink] = await db.tenant('acme', ({ q }) => q('select last_error, failures from email_sinks'));
    assert.match(sink.last_error, /503/);
    provider.fail = false;
    await db.tenant('acme', ({ q }) => q('update email_sinks set next_at = now()'));
    await drain(db, key, drainOpts(provider));
    assert.equal(provider.sent.length, before + 6);
  }, { ...opts(provider), now: () => clock });
});

test('without a key in the vault the real provider is never called and deliveries are logged as skipped', async () => {
  let calls = 0;
  const fetch = async () => { calls++; return new Response('{}', { status: 200 }); };
  await plane(async ({ db, call }) => {
    await call('POST', '/teams', { id: 'shop', name: 'Shop' });
    assert.equal((await call('POST', '/teams/shop/sinks', { format: 'email', provider: 'resend', sender: 'team@shop.example', secret: 'EMAIL_PROVIDER_KEY' })).status, 201);
    assert.equal((await call('POST', '/teams/shop/sinks', { format: 'email', provider: 'nope', sender: 'team@shop.example', secret: 'X' })).status, 400);
    assert.equal((await call('POST', '/teams/shop/sinks', { format: 'email', provider: 'resend', sender: 'not an address', secret: 'X' })).status, 400);
    assert.equal((await call('POST', '/teams/shop/sinks', { format: 'email', provider: 'resend', sender: 'team@shop.example' })).status, 400);
    assert.equal((await call('POST', '/teams/shop/sinks', { format: 'email', provider: 'resend', sender: 'team@shop.example', secret: 'GITHUB_TOKEN' })).status, 400, 'only EMAIL_ secrets');
    // Even a verified, opted-in address gets nothing while the key is missing.
    await db.tenant('acme', ({ q }) => q("insert into email_subscriptions(id, tenant, team, principal, email, kinds, verified_at) values ('eml_v', 'acme', 'shop', 'admin', 'owner@shop.example', '{approval}', now())"));
    const add = await call('POST', '/teams/shop/emails', { email: 'second@shop.example' });
    assert.deepEqual([add.body.sent, add.body.reason], [false, 'no provider key stored as EMAIL_PROVIDER_KEY']);
    await call('POST', '/teams/shop/events', { events: [SAMPLES.approval] });
    await drain(db, key, { fetch, email: { publicUrl: PUBLIC } });
    assert.equal(calls, 0);
    const rows = await db.tenant('acme', ({ q }) => q('select status, error from email_deliveries'));
    assert.deepEqual(rows, [{ status: 'skipped', error: 'no provider key stored as EMAIL_PROVIDER_KEY' }]);
  }, { publicUrl: PUBLIC, email: { fetch } });
  // The real provider, given a key, posts one message to its API.
  const seen = [];
  const r = await PROVIDERS.resend.send({ apiKey: 'k', from: 'a@b.example', to: 'c@d.example', subject: 's', text: 't', html: '<p>t</p>', headers: {} },
    { fetch: async (url, init) => { seen.push({ url, init }); return new Response('{"id":"re_1"}', { status: 200 }); } });
  assert.equal(r.id, 're_1');
  assert.equal(seen[0].url, 'https://api.resend.com/emails');
  assert.equal(seen[0].init.headers.authorization, 'Bearer k');
});

test('unsubscribe turns off one kind for one team without sign-in, and "Turn it back on" works (criterion 4)', async () => {
  const provider = fakeProvider();
  await plane(async ({ db, call, su, base }) => {
    await setup(call, provider);
    await withKey(call, su);
    const sid = await verified(call, provider);
    await call('PATCH', `/teams/shop/emails/${sid}`, { kinds: ['approval', 'budget100'] });
    await call('POST', '/teams/shop/events', { events: [SAMPLES.approval] });
    await drain(db, key, drainOpts(provider));
    const mail = provider.sent.at(-1);
    const unsub = /Turn off these emails: (\S+)/.exec(mail.text)[1].replace(PUBLIC + '/v1', base);
    // No cookie, no token: the link alone. Opening it only asks (a mail scanner must not turn emails off).
    const ask = await fetch(unsub);
    assert.equal(ask.status, 200);
    const askHtml = await ask.text();
    assert.match(askHtml, /Stop &quot;Approval needed&quot; emails for Shop\?/);
    assert.match(askHtml, /Turn off these emails/);
    assert.deepEqual((await call('GET', '/teams/shop/emails')).body.emails[0].kinds.sort(), ['approval', 'budget100'], 'a GET changes nothing');
    // "Keep getting them": nothing changes.
    const keep = /href="([^"]+keep=1)"/.exec(askHtml)[1].replace(/&amp;/g, '&');
    const kept = await fetch(new URL(keep, base).toString().replace('/v1/v1/', '/v1/'));
    assert.match(await kept.text(), /Nothing changed[\s\S]*You still get these emails\./);
    assert.deepEqual((await call('GET', '/teams/shop/emails')).body.emails[0].kinds.sort(), ['approval', 'budget100']);
    const off = /action="([^"]+unsubscribe[^"]+)"/.exec(askHtml)[1].replace(/&amp;/g, '&');
    const page = await fetch(new URL(off, base).toString().replace('/v1/v1/', '/v1/'), { method: 'POST' });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /You won&#39;t get &quot;Approval needed&quot; emails for Shop/);
    assert.match(html, /Other emails you turned on still arrive\. Your address stays verified\./);
    assert.match(html, /Turn it back on/);
    assert.match(html, /Manage all emails/);
    let mine = (await call('GET', '/teams/shop/emails')).body.emails[0];
    assert.deepEqual([mine.verified, mine.kinds], [true, ['budget100']]);
    // Turn it back on: a POST from the page's button.
    const again = /action="([^"]+resubscribe[^"]+)"/.exec(html)[1].replace(/&amp;/g, '&');
    const on = await fetch(new URL(again, base).toString().replace('/v1/v1/', '/v1/'), { method: 'POST' });
    assert.equal(on.status, 200);
    mine = (await call('GET', '/teams/shop/emails')).body.emails[0];
    assert.deepEqual(mine.kinds.sort(), ['approval', 'budget100']);
    // A mail client's one-click unsubscribe.
    const one = await fetch(unsub, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
    assert.equal(one.status, 200);
    assert.deepEqual((await call('GET', '/teams/shop/emails')).body.emails[0].kinds, ['budget100']);
    // A forged or altered token does nothing.
    assert.equal((await fetch(`${base}/email/unsubscribe?t=abc.def`)).status, 400);
    // The Studio link redirects into the Studio until it expires.
    const link = /Review in the Studio: (\S+)/.exec(mail.text)[1].replace(PUBLIC + '/v1', base);
    const go = await fetch(link, { redirect: 'manual' });
    assert.equal(go.status, 302);
    assert.equal(go.headers.get('location'), `${STUDIO}/teams/shop/inbox?card=card_1`);
    // Removing the address stops everything.
    assert.equal((await call('DELETE', `/teams/shop/emails/${sid}`)).status, 200);
    assert.deepEqual((await call('GET', '/teams/shop/emails')).body.emails, []);
  }, opts(provider));
});

test('someone who is no longer a member gets nothing, even with a verified address (security review V1)', async () => {
  const provider = fakeProvider();
  await plane(async ({ db, call, su }) => {
    await setup(call);
    await withKey(call, su);
    await db.system(`insert into people(id, provider, subject, login) values ('per_stillhere', 'github', '101', 'stays'), ('per_leftteam', 'github', '102', 'left')`);
    await db.system(`insert into members(id, tenant, person, role, removed_at) values ('mem_1', 'acme', 'per_stillhere', 'viewer', null), ('mem_2', 'acme', 'per_leftteam', 'editor', now())`);
    await db.system(`insert into email_subscriptions(id, tenant, team, principal, email, kinds, verified_at) values
      ('eml_stays', 'acme', 'shop', 'per_stillhere', 'stays@shop.example', '{blocked}', now()),
      ('eml_left', 'acme', 'shop', 'per_leftteam', 'left@shop.example', '{blocked}', now()),
      ('eml_stranger', 'acme', 'shop', 'per_neveramember', 'stranger@shop.example', '{blocked}', now())`);
    await db.system(`insert into email_subscriptions(id, tenant, team, principal, email, kinds, verified_at) values ('eml_admin', 'acme', 'shop', 'admin', 'admin@shop.example', '{blocked}', now())`);
    await call('POST', '/teams/shop/events', { events: [SAMPLES.blocked] });
    await drain(db, key, drainOpts(provider));
    assert.deepEqual(provider.sent.map((m) => m.to).sort(), ['admin@shop.example', 'stays@shop.example'], 'no owner yet: the local admin still gets its emails');
    // Once someone owns the workspace the admin token is retired, so its addresses get nothing (backend-dev review).
    await db.system(`insert into members(id, tenant, person, role) values ('mem_3', 'acme', 'per_stillhere2', 'owner')`).catch(async () => {
      await db.system(`insert into people(id, provider, subject, login) values ('per_stillhere2', 'github', '103', 'boss')`);
      await db.system(`insert into members(id, tenant, person, role) values ('mem_3', 'acme', 'per_stillhere2', 'owner')`);
    });
    provider.sent.length = 0;
    await call('POST', '/teams/shop/events', { events: [{ ...SAMPLES.blocked, id: 'ev_after_owner' }] });
    await drain(db, key, drainOpts(provider));
    assert.deepEqual(provider.sent.map((m) => m.to), ['stays@shop.example']);
  }, opts(provider));
});

test('codes are capped per person per day, and so are wrong codes (security review)', async () => {
  const provider = fakeProvider();
  let clock = new Date('2026-11-06T09:00:00Z');
  await plane(async ({ call, su }) => {
    await setup(call);
    await withKey(call, su);
    for (let i = 0; i < 10; i++) {
      assert.equal((await call('POST', '/teams/shop/emails', { email: `a${i}@shop.example` })).status, 201, `code ${i}`);
    }
    const capped = await call('POST', '/teams/shop/emails', { email: 'a10@shop.example' });
    assert.equal(capped.status, 429);
    assert.match(capped.body.error, /at most 10 codes a day/);
    clock = new Date(clock.getTime() + 25 * 3_600_000);
    // The next day: codes again. 20 wrong codes across addresses, then even the right code is refused until tomorrow.
    const subs = [];
    for (let i = 0; i < 5; i++) {
      const r = await call('POST', '/teams/shop/emails', { email: `b${i}@shop.example` });
      assert.equal(r.status, 201);
      subs.push({ id: r.body.id, code: /(\d{6})$/.exec(provider.sent.at(-1).subject)[1] });
    }
    for (const s of subs) for (let k = 0; k < 4; k++) {
      assert.equal((await call('POST', `/teams/shop/emails/${s.id}/verify`, { code: s.code === '000000' ? '111111' : '000000' })).status, 400);
    }
    // Past the daily cap, any further try is refused too.
    assert.equal((await call('POST', `/teams/shop/emails/${subs[0].id}/verify`, { code: subs[0].code === '000000' ? '111111' : '000000' })).status, 429, 'the daily cap comes first');
    const last = subs.at(-1);
    const refused = await call('POST', `/teams/shop/emails/${last.id}/verify`, { code: last.code });
    assert.equal(refused.status, 429);
    assert.match(refused.body.error, /too many wrong codes today/);
  }, { ...opts(provider), now: () => clock });
});

test('an expired Studio link says so instead of redirecting', async () => {
  const provider = fakeProvider();
  let clock = new Date('2026-11-06T09:00:00Z');
  await plane(async ({ base }) => {
    const mail = compose(SAMPLES.approval, { teamName: 'Shop' });
    const msg = render(key, mail, { base, tenant: 'acme', team: 'shop', teamName: 'Shop', subscription: 'eml_x', now: clock });
    const link = /Review in the Studio: (\S+)/.exec(msg.text)[1].replace(`${base}/v1`, base);
    clock = new Date(clock.getTime() + 25 * 3_600_000);
    const r = await fetch(link, { redirect: 'manual' });
    assert.equal(r.status, 410);
    assert.match(await r.text(), /This link has expired/);
  }, { ...opts(provider), now: () => clock });
  void ADMIN;
});
