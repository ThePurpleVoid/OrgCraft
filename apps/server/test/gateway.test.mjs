// L20g (CTO review 2 R1a and R5; decision C1): the outbound governor paces a burst instead of sending it (never drops
// a call), one tenant's burst does not hold up another, a provider's "slow down" holds the keys, and an outward
// effect's idempotency key makes a replay cause exactly one effect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeRunner, fresh, plane, registerRunner } from './helpers.mjs';
import * as store from '../store.mjs';
import { createM3 } from '../m3.mjs';
import { createGateway, keysFor } from '../gateway.mjs';

const LIMITS = { model: { rate: 10, burst: 4 }, 'tenant-model': { rate: 2, burst: 2 }, 'github-app': { rate: 10, burst: 10 }, installation: { rate: 5, burst: 2 }, 'tenant-github': { rate: 100, burst: 100 } };

async function withGateway(fn) {
  const db = await fresh();
  await store.ensureTenant(db, 'acme');
  await store.ensureTenant(db, 'zeta');
  let clock = Date.parse('2026-11-09T12:00:00Z');
  const now = () => new Date(clock);
  const m3 = createM3({ db, now });
  const slept = [];
  const g = createGateway({ db, m3, now, limits: LIMITS, sleep: async (ms) => { slept.push(ms); } });
  try { await fn({ db, g, m3, tick: (ms) => { clock += ms; }, slept }); } finally { await db.close(); }
}

test('keys: account, then installation, then the tenant share; nothing else', () => {
  assert.deepEqual(keysFor({ provider: 'github', installation: '42', tenant: 'acme' }).map((k) => k.key), ['github-app:shared', 'installation:42', 'tenant:acme:github']);
  assert.deepEqual(keysFor({ provider: 'model', account: 'byo-acme', tenant: 'acme' }).map((k) => k.key), ['model:byo-acme', 'tenant:acme:model']);
  assert.throws(() => keysFor({ provider: 'smtp' }), /github or model/);
});

test('acceptance: a burst is paced, not sent; every call gets its turn, in order', async () => {
  await withGateway(async ({ g }) => {
    // Ten calls at the same instant on the shared model key, from ten tenants' worth of shares (no tenant key).
    const waits = [];
    for (let i = 0; i < 10; i++) waits.push((await g.take({ provider: 'model' })).waitMs);
    assert.deepEqual(waits, [0, 0, 0, 0, 100, 200, 300, 400, 500, 600], 'a burst of 4, then one every 100 ms');
  });
});

test('C1 fairness: a tenant that queues a flood waits on its own share; another tenant still goes at once', async () => {
  const db = await fresh();
  await store.ensureTenant(db, 'acme');
  const g = createGateway({ db, limits: { model: { rate: 10, burst: 4 }, 'tenant-model': { rate: 10, burst: 2 } } });
  try {
    const t0 = Date.now();
    // acme queues 12 calls at once: its share (10 a second, burst 2) paces them over about a second.
    const flood = Promise.all(Array.from({ length: 12 }, () => g.pace({ provider: 'model', tenant: 'acme' }).then(() => Date.now() - t0)));
    await new Promise((r) => setTimeout(r, 50));
    const z0 = Date.now();
    const z = await g.pace({ provider: 'model', tenant: 'zeta' });
    assert.ok(Date.now() - z0 < 150, `zeta went at once (${Date.now() - z0} ms, waited ${z.waitedMs})`);
    const done = (await flood).sort((a, b) => a - b);
    assert.ok(done.at(-1) >= 900, `acme\'s flood was paced, not sent (${done.join(', ')})`);
    assert.equal(done.length, 12, 'and none of it was dropped');
  } finally { await db.close(); }
});

test('a provider\'s slow-down holds the keys until it says; an abuse answer holds the whole account; the team hears it once', async () => {
  await withGateway(async ({ g, db, tick }) => {
    await db.system("insert into teams(id, tenant, name) values ('shop', 'acme', 'shop')");
    await g.block({ provider: 'github', installation: '7', tenant: 'acme' }, { retryAfterMs: 30_000, reason: 'rate-limited' });
    const w = await g.take({ provider: 'github', installation: '7', tenant: 'acme', team: 'shop' });
    assert.equal(w.waitMs, 30_000);
    assert.equal((await g.take({ provider: 'github', installation: '8', tenant: 'zeta' })).waitMs, 30_000, 'the App itself was held too: a plain limit holds every key the call used');
    const slowed = await db.system("select envelope from events where type = 'gateway.slowed'");
    assert.equal(slowed.length, 1);
    assert.match(slowed[0].envelope.data.detail, /being paced: this one waits about 30 s\. Nothing is dropped\./);
    await g.take({ provider: 'github', installation: '7', tenant: 'acme', team: 'shop' });
    assert.equal((await db.system("select count(*)::int as n from events where type = 'gateway.slowed'"))[0].n, 1, 'at most once a minute per key');
    tick(31_000);
    await g.block({ provider: 'github', installation: '9', tenant: 'acme' }, { retryAfterMs: 5000, reason: 'secondary rate limit' });
    const rows = await db.system("select key from governor_buckets where blocked_reason = 'secondary rate limit'");
    assert.deepEqual(rows.map((r) => r.key), ['github-app:shared'], 'an abuse or secondary limit is the account\'s');
  });
});

test('the code-host fetch is paced and learns from a 429 or a secondary-limit 403, and never retries', async () => {
  await withGateway(async ({ g, slept, db, tick }) => {
    let calls = 0;
    const answers = [new Response('{}', { status: 200 }), new Response('{"message":"You have exceeded a secondary rate limit"}', { status: 403 }), new Response('{}', { status: 200 })];
    const f = g.wrapFetch(async () => { calls++; return answers.shift(); });
    assert.equal((await f('https://api.github.com/app/installations/42/access_tokens', { method: 'POST' })).status, 200);
    assert.equal((await f('https://api.github.com/repos/o/r/pulls', { method: 'POST' })).status, 403, 'the answer goes back as it came');
    assert.equal(calls, 2, 'not retried');
    const [b] = await db.system("select blocked_until from governor_buckets where key = 'github-app:shared'");
    assert.ok(b.blocked_until, 'the App is held');
    const busy = await f('https://api.github.com/repos/o/r', {});
    assert.equal(busy.status, 503, 'a person\'s request is not held for a minute: it is told to try again');
    assert.equal(busy.headers.get('retry-after'), '60');
    assert.equal((await busy.json()).type, 'paced');
    assert.equal(calls, 2, 'and nothing was sent');
    tick(50_000);
    assert.equal((await f('https://api.github.com/repos/o/r', {})).status, 200);
    assert.ok(slept.at(-1) > 9_000 && slept.at(-1) <= 10_000, `a wait under the cap is waited out (${slept.at(-1)} ms)`);
    assert.equal(calls, 3);
  });
});

test('acceptance R5: replaying an effect\'s idempotency key causes exactly one effect, with the first result', async () => {
  await withGateway(async ({ g, m3 }) => {
    const sent = [];
    const send = async (key, body) => {
      const { result } = await m3.tx('acme', async (ctx) => {
        const b = await g.begin(ctx, { key, tool: 'mcp__mail__send', callHash: 'h1' });
        if (b.state === 'repeat') return b.result;
        sent.push(body);
        const r = { id: `msg_${sent.length}` };
        await g.end(ctx, { key, ok: true, result: r });
        return r;
      });
      return result;
    };
    const first = await send('eff_0123456789', 'Hello');
    const again = await send('eff_0123456789', 'Hello');
    assert.deepEqual([sent.length, first, again], [1, { id: 'msg_1' }, { id: 'msg_1' }]);
    // Another tenant's key space is its own.
    await m3.tx('zeta', (ctx) => g.begin(ctx, { key: 'eff_0123456789', tool: 'mcp__mail__send' }));
    // In flight: refused; for another call: refused; failed: may be tried again.
    await m3.tx('acme', (ctx) => g.begin(ctx, { key: 'eff_inflight01', tool: 't' }));
    await assert.rejects(m3.tx('acme', (ctx) => g.begin(ctx, { key: 'eff_inflight01', tool: 't' })), /already being sent/);
    await assert.rejects(m3.tx('acme', (ctx) => g.begin(ctx, { key: 'eff_0123456789', tool: 'mcp__mail__delete' })), /belongs to another call/);
    await m3.tx('acme', (ctx) => g.end(ctx, { key: 'eff_inflight01', ok: false }));
    assert.deepEqual((await m3.tx('acme', (ctx) => g.begin(ctx, { key: 'eff_inflight01', tool: 't' }))).result, { state: 'first', retry: true });
    await assert.rejects(m3.tx('acme', (ctx) => g.begin(ctx, { key: 'short', tool: 't' })), /idempotency key/);
  });
});

test('an effect cut off mid-send becomes unknown, and is sent again only with a person\'s approval', async () => {
  await withGateway(async ({ g, m3, db, tick }) => {
    await db.system("insert into teams(id, tenant, name) values ('shop', 'acme', 'shop')");
    const begin = (extra = {}) => m3.tx('acme', (ctx) => g.begin(ctx, { key: 'eff_crashed01', team: 'shop', session: 'ses_a', tool: 'mcp__mail__send', ...extra })).then((r) => r.result);
    assert.equal((await begin()).state, 'first');
    tick(10 * 60_000);
    await assert.rejects(begin(), /already being sent/, 'ten minutes in, it may still be going');
    tick(6 * 60_000);
    const u = await begin();
    assert.equal(u.state, 'unknown', 'fifteen minutes on, nobody knows whether it went');
    assert.match(u.detail, /Ask a person/);
    assert.equal((await begin()).state, 'unknown', 'and it stays that way on a runner\'s word');
    await assert.rejects(m3.tx('acme', (ctx) => g.end(ctx, { key: 'eff_crashed01', ok: false, session: 'ses_a' })), /a person decides/, 'marking it failed would let it be resent');
    const card = async (id, state, command, decidedAt) => db.system(`insert into approvals(id, tenant, team, session, action, call, card, state, decided_at, expires_at) values ($1, 'acme', 'shop', 'ses_a', 'effect-resend', $2, 'crd_' || $1, $3, $4, now() + interval '1 day')`, [id, JSON.stringify({ command }), state, decidedAt]);
    await card('apr_pending', 'pending', 'eff_crashed01', null);
    await card('apr_other', 'approved', 'eff_someother', '2026-11-09T12:17:00Z');
    await card('apr_early', 'approved', 'eff_crashed01', '2026-11-09T11:00:00Z');
    await card('apr_yes', 'approved', 'eff_crashed01', '2026-11-09T12:17:00Z');
    assert.equal((await begin({ approval: 'apr_pending' })).state, 'unknown', 'a pending card is not an answer');
    assert.equal((await begin({ approval: 'apr_other' })).state, 'unknown', 'an approval for another effect does not count');
    assert.equal((await begin({ approval: 'apr_early' })).state, 'unknown', 'nor one decided before the attempt that was cut off');
    tick(2 * 60_000);
    assert.deepEqual(await begin({ approval: 'apr_yes' }), { state: 'first', retry: true }, 'the person said send it again');
    tick(16 * 60_000);
    await assert.rejects(begin({ approval: 'apr_yes' }), (e) => e.status === 409 && /already used/.test(e.message), 'cut off again: the same approval never resends it twice');
    assert.equal((await begin()).state, 'unknown');
    await card('apr_settle', 'approved', 'eff_crashed01', '2026-11-09T12:40:00Z');
    tick(10 * 60_000);
    assert.deepEqual((await m3.tx('acme', (ctx) => g.end(ctx, { key: 'eff_crashed01', ok: true, result: { id: 'm9' }, approval: 'apr_settle' }))).result, { state: 'done' }, 'a person said it went');
    assert.deepEqual(await begin(), { state: 'repeat', result: { id: 'm9' } });
  });
});

test('runner ops: pace answers a wait, effect.begin and effect.end keep a replay to one effect, governor.report holds the keys', async () => {
  await plane(async (p) => {
    await p.call('POST', '/teams', { id: 'shop' });
    assert.equal((await p.call('PUT', '/teams/shop/budget', { perDay: 1000, sessions: 2 }, await p.su())).status, 200);
    const r = await registerRunner(p.call);
    const runner = await fakeRunner(p.base, r.key, { runner: r.id });
    await p.db.system("insert into people(id, provider, subject, login) values ('per_gatewaytest1', 'github', '424242', 'octo') on conflict do nothing");
    await store.ensureTenant(p.db, 'other');
    for (const [id, tenant] of [[42, 'acme'], [77, 'other']]) await p.db.system("insert into github_installations(installation_id, tenant, account_login, account_id, account_type, proven_by, github_login, method) values ($1, $2, 'octo', $1, 'User', 'per_gatewaytest1', 'octo', 'install-callback')", [id, tenant]);
    const roster = { version: 'abc123', repo: { url: 'https://github.com/example/shop.git', ref: 'main' }, roles: [{ slug: 'chief-of-staff', reportsTo: 'owner', areas: [], brief: 'Front door.' }] };
    assert.equal((await p.call('POST', '/teams/shop/runs', { team: roster })).status, 201);
    await p.call('POST', '/teams/shop/chat', { text: 'Hello' });
    const s = (await runner.next((f) => f.op === 'session.start')).body;
    const waits = [];
    for (let i = 0; i < 4; i++) { const f = await runner.request('pace', { session: s.session, provider: 'github', installation: 42 }); assert.equal(f.op, 'ack', JSON.stringify(f)); assert.equal(f.body.next, 'account'); waits.push(f.body.waitMs); }
    assert.deepEqual(waits.map((w) => w > 0), [false, false, true, true], 'stage own: a burst of 2, then the installation\'s 5 a second');
    const acct = await runner.request('pace', { session: s.session, provider: 'github', installation: 42, stage: 'account' });
    assert.deepEqual([acct.op, acct.body.stage, acct.body.next], ['ack', 'account', null]);
    assert.equal((await runner.request('pace', { session: s.session, provider: 'github', stage: 'later' })).op, 'nack');
    assert.equal((await runner.request('pace', { session: s.session, provider: 'smtp' })).op, 'nack');
    // Another tenant's installation: a runner can't pace on it, or hold it.
    const theirs = await runner.request('pace', { session: s.session, provider: 'github', installation: 77 });
    assert.deepEqual([theirs.op, theirs.body.problem], ['nack', 'that installation was not proved by this account']);
    assert.equal((await runner.request('governor.report', { session: s.session, provider: 'github', installation: 77, retryAfterMs: 3600_000, reason: 'rate-limited' })).op, 'nack');
    assert.equal((await p.db.system("select count(*)::int as n from governor_buckets where key = 'installation:77'"))[0].n, 0, 'theirs was never touched');
    assert.equal((await runner.request('pace', { session: 'ses_other', provider: 'model' })).op, 'nack', 'only for its own sessions');
    const b1 = await runner.request('effect.begin', { session: s.session, key: 'sha256-abcdef0123', tool: 'mcp__mail__send', callHash: 'c1' });
    assert.deepEqual([b1.op, b1.body.state], ['ack', 'first']);
    assert.equal((await runner.request('effect.end', { session: s.session, key: 'sha256-abcdef0123', ok: true, result: { id: 'm1' } })).op, 'ack');
    const b2 = await runner.request('effect.begin', { session: s.session, key: 'sha256-abcdef0123', tool: 'mcp__mail__send', callHash: 'c1' });
    assert.deepEqual(b2.body, { state: 'repeat', result: { id: 'm1' } });
    // Bracketed by the clock before and after, never by a margin: a slow machine takes as long as it takes between the
    // report and the read (FLAKE-gov: a 1 s margin failed on CI).
    const beforeReport = Date.now();
    const rep = await runner.request('governor.report', { session: s.session, provider: 'model', retryAfterMs: 20_000, reason: 'overloaded' });
    const afterReport = Date.now();
    assert.equal(rep.op, 'ack');
    const [held] = await p.db.system("select blocked_until from governor_buckets where key = 'tenant:acme:model'");
    // A Date from the driver: getTime() keeps the milliseconds, which Date.parse(String(date)) drops (part of the old
    // flake: up to 999 ms of the 1 s margin went there).
    const heldUntil = new Date(held.blocked_until).getTime();
    assert.ok(heldUntil >= beforeReport + 20_000 && heldUntil <= afterReport + 20_000, `its own share is held for what the provider said (20 s from the report): ${held.blocked_until}`);
    const [shared] = await p.db.system("select blocked_until from governor_buckets where key = 'model:shared'");
    assert.equal(shared?.blocked_until ?? null, null, 'one tenant\'s runner never holds the shared key');
    // A paced call never holds the runner's other requests (they run one at a time per connection): the ack says how
    // long to wait, at once, and another session's request right behind it is answered at once too.
    const t0 = Date.now();
    const [slow, other] = await Promise.all([
      runner.request('pace', { session: s.session, provider: 'model' }),
      runner.request('effect.begin', { session: s.session, key: 'sha256-behindpace', tool: 'mcp__mail__send' }),
    ]);
    const t1 = Date.now();
    // The wait is what is left of the hold when the pace was answered, between t0 and t1, whatever the machine's speed.
    assert.ok(slow.body.waitMs >= heldUntil - t1 - 5 && slow.body.waitMs <= heldUntil - t0 + 5, `${JSON.stringify(slow.body)}, hold ends in ${heldUntil - t0} ms`);
    assert.equal(other.body.state, 'first');
    // "At once" against the 20 s hold: a pace that blocked the connection would take the whole hold.
    assert.ok(t1 - t0 < heldUntil - t1, `both answered without waiting out the hold (${t1 - t0} ms)`);
  }, { tickMs: 0, gatewayLimits: LIMITS });
});

test('a runner\'s report holds only its own tenant\'s keys, for at most 5 minutes; the shared App only on two tenants\' word, once in 30 minutes; reports are rate limited', async () => {
  await withGateway(async ({ g, db, tick }) => {
    const until = async (key) => { const [r] = await db.system('select blocked_until from governor_buckets where key = $1', [key]); return r?.blocked_until ? Date.parse(r.blocked_until) : null; };
    const t0 = Date.parse('2026-11-09T12:00:00Z');
    await g.reported({ provider: 'github', installation: '7', tenant: 'acme' }, { retryAfterMs: 3600_000, reason: 'secondary rate limit' });
    assert.equal(await until('github-app:shared'), null, 'one tenant\'s word does not hold the shared App, abuse or not');
    assert.equal(await until('tenant:acme:github'), t0 + 5 * 60_000, 'its own share is held, for 5 minutes at most');
    assert.equal(await until('installation:7'), t0 + 5 * 60_000);
    tick(60_000);
    await g.reported({ provider: 'github', tenant: 'zeta' }, { retryAfterMs: 3600_000, reason: 'secondary rate limit' });
    assert.equal(await until('github-app:shared'), t0 + 60_000 + 5 * 60_000, 'two tenants within 5 minutes: the App is held, 5 minutes at most');
    tick(6 * 60_000);
    await g.reported({ provider: 'github', tenant: 'acme' }, { retryAfterMs: 3600_000, reason: 'rate-limited' });
    await g.reported({ provider: 'github', tenant: 'zeta' }, { retryAfterMs: 3600_000, reason: 'rate-limited' });
    assert.equal(await until('github-app:shared'), t0 + 60_000 + 5 * 60_000, 'and re-reporting does not renew it within 30 minutes');
    tick(30 * 60_000);
    await g.reported({ provider: 'github', tenant: 'acme' }, { retryAfterMs: 1000, reason: 'rate-limited' });
    await g.reported({ provider: 'github', tenant: 'zeta' }, { retryAfterMs: 1000, reason: 'rate-limited' });
    assert.ok(await until('github-app:shared') > t0 + 37 * 60_000, 'after 30 minutes, two tenants may hold it again');
    await store.ensureTenant(db, 'noisy');
    for (let i = 0; i < 4; i++) await g.reported({ provider: 'model', tenant: 'noisy' }, { retryAfterMs: 1000 });
    await assert.rejects(g.reported({ provider: 'model', tenant: 'noisy' }, { retryAfterMs: 1000 }), (e) => e.status === 429 && /too many slow-down reports/.test(e.message));
    tick(30_000);
    await g.reported({ provider: 'model', tenant: 'noisy' }, { retryAfterMs: 1000 });
  });
});

test('effect results are redacted before they are kept, and a key from another team is refused', async () => {
  await withGateway(async ({ g, m3, db }) => {
    await db.system("insert into teams(id, tenant, name) values ('shop', 'acme', 'shop'), ('blog', 'acme', 'blog')");
    await m3.tx('acme', (ctx) => g.begin(ctx, { key: 'eff_redact0001', team: 'shop', tool: 'mcp__crm__create' }));
    await m3.tx('acme', (ctx) => g.end(ctx, { key: 'eff_redact0001', ok: true, result: { id: 'c1', token: 'ghp_' + 'a'.repeat(36), list: ['sk-ant-' + 'b'.repeat(30)] } }));
    const [row] = await db.system("select result from effects where key = 'eff_redact0001'");
    assert.deepEqual(row.result, { id: 'c1', token: '[secret]', list: ['[secret]'] });
    await assert.rejects(m3.tx('acme', (ctx) => g.begin(ctx, { key: 'eff_redact0001', team: 'blog', tool: 'mcp__crm__create' })), /belongs to another call/);
  });
});
