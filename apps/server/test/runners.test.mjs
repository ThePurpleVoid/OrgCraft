// The runner WebSocket (runner-protocol.md): auth on the upgrade, hello and welcome, acks and nacks, frames that are
// idempotent by id, heartbeats, reconnects and revocation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { plane } from './helpers.mjs';

/** Registers a runner through the API and returns its key. */
async function register(call, name = 'r1') {
  const { code } = (await call('POST', '/runners/codes')).body;
  return (await call('POST', '/runners', { code, name })).body;
}

/** A runner-side socket that records frames and can wait for one. */
function connect(base, key, { pong = true } = {}) {
  const url = base.replace(/^http/, 'ws') + '/runners/connect';
  const ws = new WebSocket(url, key ? { headers: { authorization: `Bearer ${key}` } } : {});
  const frames = [];
  const waiters = [];
  let n = 0;
  ws.on('message', (d) => {
    const f = JSON.parse(String(d));
    frames.push(f);
    if (f.op === 'ping' && pong) ws.send(JSON.stringify({ op: 'pong', id: `p${n++}`, ref: f.id, body: { t: f.body.t } }));
    for (const w of [...waiters]) if (w.match(f)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(f); }
  });
  const closed = new Promise((r) => ws.on('close', (code, reason) => r({ code, reason: String(reason) })));
  const failed = new Promise((r) => ws.on('unexpected-response', (_req, res) => r(res.statusCode)));
  const opened = new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  return {
    ws, frames, closed, failed, opened,
    next: (match, ms = 3000) => new Promise((resolve, reject) => {
      const hit = frames.find(match);
      if (hit) return resolve(hit);
      const t = setTimeout(() => reject(new Error('no such frame in time')), ms);
      waiters.push({ match, resolve: (f) => { clearTimeout(t); resolve(f); } });
    }),
    send: (op, id, body = {}) => ws.send(JSON.stringify({ op, id, body })),
    close: () => ws.close(),
  };
}

test('a runner needs its key to connect, says hello, and is welcomed', async () => {
  await plane(async ({ call, base, db }) => {
    const r = await register(call);
    const none = connect(base, null);
    assert.equal(await none.failed, 401);
    const wrong = connect(base, `${r.id}.nope`);
    assert.equal(await wrong.failed, 401);

    const c = connect(base, r.key);
    await c.opened;
    c.send('events', 'e0', { events: [] });
    assert.equal((await c.next((f) => f.ref === 'e0')).op, 'nack', 'nothing before hello');
    c.send('hello', 'h1', { runner: r.id, version: '0.9.0', capabilities: { runtimes: ['agent-sdk'], maxSessions: 2 } });
    const w = await c.next((f) => f.op === 'welcome');
    assert.equal(w.ref, 'h1');
    assert.equal(w.body.protocol, 'runner/1');
    assert.equal(typeof w.body.heartbeat, 'number');
    assert.deepEqual(w.body.sessions, []);
    const [row] = await db.tenant('acme', ({ q }) => q('select version, capabilities, last_seen from runners where id = $1', [r.id]));
    assert.equal(row.version, '0.9.0');
    assert.equal(row.capabilities.maxSessions, 2);
    assert.ok(row.last_seen);

    c.send('secret.get', 's1', { name: 'X' });
    const no = await c.next((f) => f.ref === 's1');
    assert.equal(no.op, 'nack');
    assert.match(no.body.problem, /not supported/);
    c.ws.send('not json');
    assert.equal((await c.next((f) => f.op === 'nack' && /JSON/.test(f.body.problem))).op, 'nack');
    c.close();
  });
});

test('requests are acked once per frame id, and the control plane can ask the runner and wait for its ack', async () => {
  let ran = 0;
  const ops = { 'approval.wait': async (conn, body) => { ran++; return { approval: `apr_for_${body.session}`, tenant: conn.tenant }; } };
  await plane(async ({ call, base, server }) => {
    const r = await register(call);
    const c = connect(base, r.key);
    await c.opened;
    c.send('hello', 'h', {});
    await c.next((f) => f.op === 'welcome');
    c.send('approval.wait', 'a1', { session: 'ses_1' });
    const first = await c.next((f) => f.ref === 'a1');
    c.send('approval.wait', 'a1', { session: 'ses_1' });
    await new Promise((res) => setTimeout(res, 100));
    const acks = c.frames.filter((f) => f.ref === 'a1');
    assert.equal(acks.length, 2);
    assert.deepEqual(acks[1].body, first.body);
    assert.deepEqual(first.body, { approval: 'apr_for_ses_1', tenant: 'acme' });
    assert.equal(ran, 1, 'a resent frame is answered, not run again');

    assert.equal(server.runners.connected('acme').length, 1);
    assert.equal(server.runners.connected('rival').length, 0);
    const conn = server.runners.get(r.id);
    const asked = conn.send('session.message', { session: 'ses_1', message: { id: 'e1' } });
    const f = await c.next((x) => x.op === 'session.message');
    c.ws.send(JSON.stringify({ op: 'ack', id: 'k1', ref: f.id, body: { delivered: true } }));
    assert.deepEqual(await asked, { delivered: true });
    const refused = conn.send('session.stop', { session: 'ses_1', mode: 'now' });
    const g = await c.next((x) => x.op === 'session.stop');
    c.ws.send(JSON.stringify({ op: 'nack', id: 'k2', ref: g.id, body: { ref: g.id, problem: 'no such session' } }));
    await assert.rejects(refused, /no such session/);
    c.close();
  }, { runnerOptions: { ops } });
});

test('a runner that misses three heartbeats is lost; a reconnect replaces the old socket; revoking ends it', async () => {
  const lost = [];
  await plane(async ({ call, base }) => {
    const r = await register(call);
    const quiet = connect(base, r.key, { pong: false });
    await quiet.opened;
    quiet.send('hello', 'h', {});
    await quiet.next((f) => f.op === 'welcome');
    await quiet.next((f) => f.op === 'ping');
    await quiet.closed;
    assert.deepEqual(lost, [`${r.id}: missed three heartbeats`]);

    const a = connect(base, r.key);
    await a.opened;
    a.send('hello', 'h', {});
    await a.next((f) => f.op === 'welcome');
    const b = connect(base, r.key);
    await b.opened;
    assert.equal((await a.closed).code, 4000, 'the newer connection wins');
    b.send('hello', 'h', {});
    await b.next((f) => f.op === 'welcome');
    assert.equal(lost.length, 1, 'a replaced socket is not a lost runner');

    assert.equal((await call('DELETE', `/runners/${r.id}`)).status, 200);
    assert.equal((await b.closed).code, 4003);
    assert.equal(await connect(base, r.key).failed, 401, 'and the key no longer connects');
  }, { runnerOptions: { heartbeat: 0.1, onLost: async (conn, why) => { lost.push(`${conn.runner}: ${why}`); } } });
});

test('a runner that never says hello is closed', async () => {
  await plane(async ({ call, base }) => {
    const r = await register(call);
    const c = connect(base, r.key);
    await c.opened;
    assert.equal((await c.closed).code, 4001);
  }, { runnerOptions: { helloMs: 100 } });
});

test('a runner\'s requests are handled one at a time, in the order it sent them', async () => {
  const order = [];
  const ops = { events: async (conn, body) => { await new Promise((r) => setTimeout(r, Math.random() * 20)); order.push(body.n); return { n: body.n }; } };
  await plane(async ({ call, base }) => {
    const r = await register(call);
    const c = connect(base, r.key);
    await c.opened;
    c.send('hello', 'h', {});
    await c.next((f) => f.op === 'welcome');
    for (let n = 0; n < 20; n++) c.send('events', `e${n}`, { n });
    c.ws.send(JSON.stringify({ op: 'ping', id: 'pg', body: { t: 1 } }));
    const pong = await c.next((f) => f.op === 'pong');
    assert.ok(order.length < 20, 'a ping is answered without waiting behind the requests');
    assert.equal(pong.ref, 'pg');
    await c.next((f) => f.ref === 'e19');
    assert.deepEqual(order, Array.from({ length: 20 }, (_, n) => n));
    assert.deepEqual(c.frames.filter((f) => f.op === 'ack' && /^e/.test(f.ref)).map((f) => f.body.n), order, 'and acked in that order');
    c.close();
  }, { runnerOptions: { ops } });
});
