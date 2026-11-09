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
  await withGateway(async ({ g, slept, db }) => {
    let calls = 0;
    const answers = [new Response('{}', { status: 200 }), new Response('{"message":"You have exceeded a secondary rate limit"}', { status: 403 }), new Response('{}', { status: 200 })];
    const f = g.wrapFetch(async () => { calls++; return answers.shift(); });
    assert.equal((await f('https://api.github.com/app/installations/42/access_tokens', { method: 'POST' })).status, 200);
    assert.equal((await f('https://api.github.com/repos/o/r/pulls', { method: 'POST' })).status, 403, 'the answer goes back as it came');
    assert.equal(calls, 2, 'not retried');
    const [b] = await db.system("select blocked_until from governor_buckets where key = 'github-app:shared'");
    assert.ok(b.blocked_until, 'the App is held');
    await f('https://api.github.com/repos/o/r', {});
    assert.equal(slept.at(-1), 60_000, 'the next call waits out the hold instead of being sent');
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

test('runner ops: pace answers a wait, effect.begin and effect.end keep a replay to one effect, governor.report holds the keys', async () => {
  await plane(async (p) => {
    await p.call('POST', '/teams', { id: 'shop' });
    assert.equal((await p.call('PUT', '/teams/shop/budget', { perDay: 1000, sessions: 2 }, await p.su())).status, 200);
    const r = await registerRunner(p.call);
    const runner = await fakeRunner(p.base, r.key, { runner: r.id });
    const roster = { version: 'abc123', repo: { url: 'https://github.com/example/shop.git', ref: 'main' }, roles: [{ slug: 'chief-of-staff', reportsTo: 'owner', areas: [], brief: 'Front door.' }] };
    assert.equal((await p.call('POST', '/teams/shop/runs', { team: roster })).status, 201);
    await p.call('POST', '/teams/shop/chat', { text: 'Hello' });
    const s = (await runner.next((f) => f.op === 'session.start')).body;
    const waits = await Promise.all(Array.from({ length: 4 }, async () => { const f = await runner.request('pace', { session: s.session, provider: 'github', installation: 42 }); assert.equal(f.op, 'ack', JSON.stringify(f)); return f.body.waitedMs; }));
    assert.deepEqual(waits.sort((a, b) => a - b).map((w) => w > 0), [false, false, true, true], 'the ack comes when the call may go: a burst of 2, then the installation\'s 5 a second');
    assert.equal((await runner.request('pace', { session: s.session, provider: 'smtp' })).op, 'nack');
    assert.equal((await runner.request('pace', { session: 'ses_other', provider: 'model' })).op, 'nack', 'only for its own sessions');
    const b1 = await runner.request('effect.begin', { session: s.session, key: 'sha256-abcdef0123', tool: 'mcp__mail__send', callHash: 'c1' });
    assert.deepEqual([b1.op, b1.body.state], ['ack', 'first']);
    assert.equal((await runner.request('effect.end', { session: s.session, key: 'sha256-abcdef0123', ok: true, result: { id: 'm1' } })).op, 'ack');
    const b2 = await runner.request('effect.begin', { session: s.session, key: 'sha256-abcdef0123', tool: 'mcp__mail__send', callHash: 'c1' });
    assert.deepEqual(b2.body, { state: 'repeat', result: { id: 'm1' } });
    const rep = await runner.request('governor.report', { session: s.session, provider: 'model', retryAfterMs: 20_000, reason: 'overloaded' });
    assert.equal(rep.op, 'ack');
    const [held] = await p.db.system("select blocked_until from governor_buckets where key = 'model:shared'");
    assert.ok(Date.parse(held.blocked_until) - Date.now() > 19_000, 'the model account is held for what the provider said');
  }, { tickMs: 0, gatewayLimits: LIMITS });
});
