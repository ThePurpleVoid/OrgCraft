// The run inspector's server half, storage and attribution (N1, ADR 0009, local PR L19s-a): tasks the server mints
// and carries through deliveries, the runner's cause hint, step I/O outside the log, and retention.
// plans/n8n/n1-run-inspector-architecture.md section 8, proofs 1 to 5.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeRunner, plane, registerRunner } from './helpers.mjs';
import { IO_DAY_CAP, redactPatterns, taskId } from '../inspector.mjs';

const roster = () => ({
  version: 'abc123', repo: { url: 'https://github.com/example/shop.git', ref: 'main' },
  roles: [
    { slug: 'chief-of-staff', reportsTo: 'owner', areas: ['docs/**'], brief: 'You are the front door.' },
    { slug: 'web-dev', reportsTo: 'chief-of-staff', areas: ['apps/web/**'], brief: 'You build the web app.' },
    { slug: 'qa', reportsTo: 'chief-of-staff', areas: [] },
  ],
});
async function setup({ call, base, su }) {
  await call('POST', '/teams', { id: 'shop' });
  assert.equal((await call('PUT', '/teams/shop/budget', { perDay: 1000, sessions: 3 }, await su())).status, 200);
  const r = await registerRunner(call);
  const runner = await fakeRunner(base, r.key, { runner: r.id });
  assert.equal((await call('POST', '/teams/shop/runs', { team: roster() })).status, 201);
  return { runner };
}
const start = (runner, role) => runner.next((f) => f.op === 'session.start' && f.body.role === role);
const tool = (call, s, name, input) => call('POST', `/sessions/${s.session}/tools/${name}`, input, { authorization: `Bearer ${s.token}` });
const events = async (call, type) => (await call('GET', `/teams/shop/events${type ? `?type=${type}` : ''}`)).body.events;
let n = 0;
const env = (s, role, type, data, extra = {}) => ({ specversion: '1.0', id: `ev_t${n++}_${Math.random().toString(36).slice(2)}`, type, version: 1, source: '/tenants/acme/teams/shop', tenant: 'acme', team: 'shop', time: new Date().toISOString(), actor: { kind: 'role', id: role, session: s.session }, data, ...extra });
const ULID = () => { const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; let x = ''; for (let i = 0; i < 26; i++) x += A[Math.floor(Math.random() * 32)]; return `io_${x}`; };

test('pure parts: task ids sort by time, and the server\'s patterns hide credential shapes', () => {
  assert.match(taskId(), /^tsk_[0-9A-Z]{26}$/);
  assert.ok(taskId(1000) < taskId(2000));
  const r = redactPatterns(`token ghp_${'a'.repeat(36)} and AKIAABCDEFGHIJKLMNOP and sk-ant-${'b'.repeat(30)}`);
  assert.equal(r.hit, true);
  assert.equal(r.text, 'token [secret] and [secret] and [secret]');
  assert.equal(redactPatterns('nothing here').hit, false);
});

test('proof 1: an owner\'s chat that leads to a handoff and a sign-off is one task, and each cause points back', async () => {
  await plane(async (p) => {
    const { runner } = await setup(p);
    await p.call('POST', '/teams/shop/chat', { text: 'Ship the cart\nwith receipts' });
    const [chat] = await events(p.call, 'chat.message');
    assert.match(chat.task, /^tsk_/, 'a person\'s chat starts a task');
    assert.equal(chat.cause, undefined);
    const front = (await start(runner, 'chief-of-staff')).body;
    assert.deepEqual([front.task, front.cause], [chat.task, chat.id], 'session.start names the task and the wake');
    const h = await tool(p.call, front, 'handoff', { to: 'web-dev', task: 'Cart', changed: 'x', verify: 'y', doneWhen: 'z' });
    assert.equal(h.status, 200, JSON.stringify(h.body));
    const [handoff] = await events(p.call, 'message.handoff');
    assert.deepEqual([handoff.task, handoff.cause], [chat.task, chat.id]);
    const web = (await start(runner, 'web-dev')).body;
    assert.deepEqual([web.task, web.cause], [chat.task, handoff.id]);
    const so = await tool(p.call, web, 'signoff', { to: 'chief-of-staff', task: 'Cart', testedOn: 'Chrome', walked: 'cart', result: 'pass', evidence: ['shots/cart.png'] });
    assert.equal(so.status, 200, JSON.stringify(so.body));
    const [signoff] = await events(p.call, 'message.signoff');
    assert.deepEqual([signoff.task, signoff.cause], [chat.task, handoff.id]);
    // The front door's session takes the sign-off as its next wake.
    const m = await runner.next((f) => f.op === 'session.message' && f.body.session === front.session);
    assert.deepEqual([m.body.task, m.body.cause], [chat.task, signoff.id]);
    const [t] = await p.db.system('select * from tasks where id = $1', [chat.task]);
    assert.equal(t.title, 'Ship the cart');
    assert.equal(t.root_event, chat.id);
    assert.deepEqual(t.started_by, { kind: 'chat', id: t.started_by.id, label: 'Owner in chat' });
    assert.deepEqual([...t.roles].sort(), ['chief-of-staff', 'web-dev']);
    const [{ n: rows }] = await p.db.system('select count(*)::int as n from events where task = $1', [chat.task]);
    assert.ok(rows >= 3, 'the column is set too, for the index');
  }, { tickMs: 0 });
});

test('proof 2: a sender\'s task is replaced, and a runner\'s cause is kept only for an event delivered to that session', async () => {
  await plane(async (p) => {
    const { runner } = await setup(p);
    await p.call('POST', '/teams/shop/chat', { text: 'one' });
    const [chat] = await events(p.call, 'chat.message');
    const s = (await start(runner, 'chief-of-staff')).body;
    const forged = env(s, 'chief-of-staff', 'report.heartbeat', { status: 'working' }, { task: 'tsk_FORGED', cause: 'ev_not_delivered' });
    assert.equal((await runner.request('events', { events: [forged] })).op, 'ack');
    const [hb] = (await events(p.call, 'report.heartbeat')).filter((e) => e.id === forged.id);
    assert.deepEqual([hb.task, hb.cause], [chat.task, chat.id], 'the session\'s own task and wake stand');
    // The second chat is delivered to the live session; the runner's hint for it is kept.
    await p.call('POST', '/teams/shop/chat', { text: 'two' });
    const second = (await events(p.call, 'chat.message')).find((e) => e.data.text === 'two');
    await runner.next((f) => f.op === 'session.message' && f.body.message.id === second.id);
    const early = env(s, 'chief-of-staff', 'report.heartbeat', { status: 'working' }, { cause: chat.id });
    assert.equal((await runner.request('events', { events: [early] })).op, 'ack');
    const [e2] = (await events(p.call, 'report.heartbeat')).filter((e) => e.id === early.id);
    assert.deepEqual([e2.task, e2.cause], [chat.task, chat.id], 'still on the first wake: the runner says so, and that event was delivered to it');
    assert.notEqual(second.task, chat.task, 'each chat from a person is a task of its own');
  }, { tickMs: 0 });
});

test('proof 3: step I/O is stored outside the log, redacted again, and only ever a session\'s own', async () => {
  await plane(async (p) => {
    const { runner } = await setup(p);
    await p.call('POST', '/teams/shop/chat', { text: 'go' });
    const front = (await start(runner, 'chief-of-staff')).body;
    await tool(p.call, front, 'handoff', { to: 'web-dev', task: 'Cart', changed: 'x', verify: 'y', doneWhen: 'z' });
    const web = (await start(runner, 'web-dev')).body;
    const io = ULID();
    const ok = await runner.request('step.io', { session: front.session, id: io, part: 'output', mime: 'application/json', body: `{"stdout":"ghp_${'z'.repeat(36)} done"}`, bytes: 60, truncated: false, redactions: ['session-token'] });
    assert.equal(ok.op, 'ack', JSON.stringify(ok.body));
    const [row] = await p.db.system('select * from step_io where id = $1', [io]);
    assert.ok(!row.body.includes('ghp_'), row.body);
    assert.deepEqual([...row.redactions].sort(), ['secret', 'session-token']);
    assert.equal(row.session, front.session);
    assert.equal(row.task, front.task);
    assert.ok(Date.parse(row.expires_at) - Date.now() > 29 * 86_400_000, 'kept 30 days by default');
    const other = await runner.request('step.io', { session: web.session, id: io, part: 'input', body: 'x' });
    assert.equal(other.op, 'nack');
    assert.match(other.body.problem, /another session/);
    for (const bad of [{ id: 'io_short' }, { part: 'middle' }, { body: 'x'.repeat(64 * 1024 + 1) }]) {
      assert.equal((await runner.request('step.io', { session: front.session, id: ULID(), part: 'input', body: 'x', ...bad })).op, 'nack', JSON.stringify(Object.keys(bad)));
    }
    // An event may name only its own session's I/O; session.result with outside marks the row.
    const theirs = env(web, 'web-dev', 'session.result', { call: 'call_1', tool: 'Read', ok: true, durationMs: 3, summary: 'read x', io });
    const mine = env(front, 'chief-of-staff', 'session.result', { call: 'call_2', tool: 'WebFetch', ok: true, durationMs: 3, summary: 'WebFetch', io, outside: true });
    assert.equal((await runner.request('events', { events: [theirs, mine] })).op, 'ack');
    const results = await events(p.call, 'session.result');
    assert.equal(results.find((e) => e.id === theirs.id).data.io, undefined);
    assert.equal(results.find((e) => e.id === theirs.id).data.ioNotKept, true);
    assert.equal(results.find((e) => e.id === mine.id).data.io, io);
    assert.equal((await p.db.system('select outside from step_io where id = $1', [io]))[0].outside, true);
    // Another runner can't send for this one's sessions.
    const r2 = await registerRunner(p.call);
    const stranger = await fakeRunner(p.base, r2.key, { runner: r2.id });
    assert.equal((await stranger.request('step.io', { session: front.session, id: ULID(), part: 'input', body: 'x' })).op, 'nack');
    stranger.close();
  }, { tickMs: 0 });
});

test('proof 4: past the daily cap a session\'s I/O is not kept, and its events still are, without io', async () => {
  await plane(async (p) => {
    const { runner } = await setup(p);
    await p.call('POST', '/teams/shop/chat', { text: 'go' });
    const s = (await start(runner, 'chief-of-staff')).body;
    await p.db.system('insert into step_io_days(tenant, session, day, bytes) values ($1, $2, $3::date, $4)', ['acme', s.session, new Date().toISOString().slice(0, 10), IO_DAY_CAP - 10]);
    const io = ULID();
    const r = await runner.request('step.io', { session: s.session, id: io, part: 'input', body: 'more than ten bytes of input' });
    assert.deepEqual([r.op, r.body.kept, r.body.reason], ['ack', false, 'daily-limit']);
    assert.equal((await p.db.system('select count(*)::int as n from step_io')).at(0).n, 0);
    const t = env(s, 'chief-of-staff', 'session.tool', { tool: 'Read', decision: 'allowed', call: 'call_1', io });
    assert.equal((await runner.request('events', { events: [t] })).op, 'ack');
    const [stored] = (await events(p.call, 'session.tool')).filter((e) => e.id === t.id);
    assert.deepEqual([stored.data.io, stored.data.ioNotKept], [undefined, true]);
  }, { tickMs: 0 });
});

test('proof 5: retention deletes for real, follows a shortened io_days, and writes one audit row per batch', async () => {
  await plane(async (p) => {
    const { runner } = await setup(p);
    await p.call('POST', '/teams/shop/chat', { text: 'go' });
    const s = (await start(runner, 'chief-of-staff')).body;
    const ids = [ULID(), ULID(), ULID()];
    for (const id of ids) assert.equal((await runner.request('step.io', { session: s.session, id, part: 'input', body: id })).op, 'ack');
    await p.db.system("update step_io set expires_at = now() - interval '1 minute' where id = $1", [ids[0]]);
    await p.db.system("update step_io set created_at = now() - interval '8 days' where id = $1", [ids[1]]);
    await p.server.bus.tick();
    assert.deepEqual((await p.db.system('select id from step_io')).map((r) => r.id).sort(), [ids[1], ids[2]].sort(), 'expired rows go; 8 days is within 30');
    await p.db.system("update budgets set io_days = 7 where team = 'shop'");
    await p.server.bus.tick();
    assert.deepEqual((await p.db.system('select id from step_io')).map((r) => r.id), [ids[2]], 'shortening io_days applies to stored rows');
    const audits = await p.db.system("select team, detail from audit where action = 'step-io.purge' order by seq");
    assert.deepEqual(audits.map((a) => [a.team, a.detail.rows]), [['shop', 1], ['shop', 1]]);
    await assert.rejects(p.db.tenant('acme', ({ q }) => q('delete from step_io')), 'the app role never deletes step I/O');
  }, { tickMs: 0 });
});
