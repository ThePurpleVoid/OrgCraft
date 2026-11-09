// L24s (vision G15.1 caps, G15.2 cost warning; CTO review 2 R4 spend leases, R14 the team's budget day): the cap tree,
// spend leases that keep two sessions from both being given the last cent, and cost estimates from the team's history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeRunner, plane, registerRunner } from './helpers.mjs';

const roster = () => ({
  version: 'abc123', repo: { url: 'https://github.com/example/shop.git', ref: 'main' },
  roles: [
    { slug: 'chief-of-staff', reportsTo: 'owner', areas: ['docs/**'], brief: 'You are the front door.' },
    { slug: 'qa', reportsTo: 'chief-of-staff', areas: [], brief: 'You check.' },
  ],
});
const start = (runner, role) => runner.next((f) => f.op === 'session.start' && f.body.role === role);
const tool = (call, s, name, input) => call('POST', `/sessions/${s.session}/tools/${name}`, input, { authorization: `Bearer ${s.token}` });
let n = 0;
const usage = (s, cost, extra = {}) => ({ specversion: '1.0', id: `ev_u${n++}_${Math.random().toString(36).slice(2)}`, type: 'usage.recorded', version: 1, source: '/tenants/acme/teams/shop', tenant: 'acme', team: 'shop', time: new Date().toISOString(), run: s.run, actor: { kind: 'role', id: s.role, session: s.session }, data: { cost, currency: 'EUR', inputTokens: 1, outputTokens: 1 }, ...extra });

/** A team budgeted in euros in Berlin time, a run, and two sessions (front door and QA). */
async function team(p, budget = {}) {
  await p.call('POST', '/teams', { id: 'shop' });
  const b = await p.call('PUT', '/teams/shop/budget', { perDay: 100, currency: 'EUR', timeZone: 'Europe/Berlin', sessions: 4, ...budget }, await p.su());
  assert.equal(b.status, 200, JSON.stringify(b.body));
  const r = await registerRunner(p.call);
  const runner = await fakeRunner(p.base, r.key, { runner: r.id });
  assert.equal((await p.call('POST', '/teams/shop/runs', { team: roster() })).status, 201);
  await p.call('POST', '/teams/shop/chat', { text: 'Ship the cart' });
  const front = (await start(runner, 'chief-of-staff')).body;
  assert.equal((await tool(p.call, front, 'handoff', { to: 'qa', task: 'Cart', changed: 'x', verify: 'y', doneWhen: 'z' })).status, 200);
  const qa = (await start(runner, 'qa')).body;
  return { runner, front, qa };
}
const lease = async (runner, s, amount) => {
  const f = await runner.request('spend.lease', { session: s.session, ...(amount === undefined ? {} : { amount }) });
  assert.equal(f.op, 'ack', JSON.stringify(f));
  return f.body;
};

test('the cap tree: today in the team\'s time zone with warn and pause steps, each live run, and the meeting cap; in the budget\'s currency', async () => {
  await plane(async (p) => {
    const { runner, qa } = await team(p);
    await lease(runner, qa, 30);
    const r = await p.call('GET', '/teams/shop/caps');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.currency, r.body.timeZone], ['EUR', 'Europe/Berlin']);
    const [day, run, meeting] = r.body.caps;
    assert.deepEqual([day.id, day.cap, day.spent, day.leased, day.remaining, day.state], ['day', 100, 0, 30, 70, 'ok']);
    assert.deepEqual(day.steps, [{ at: 0.8, then: 'warn' }, { at: 1, then: 'pause', ask: 'owner' }]);
    assert.ok(Date.parse(day.resetsAt) > Date.now() && Date.parse(day.startedAt) <= Date.now());
    assert.equal(run.scope, 'run');
    assert.equal(run.leased, 30);
    assert.deepEqual([meeting.id, meeting.cap, meeting.default], ['meeting', 10, true]);
    // No daily cap set: nothing starts, and the tree says so.
    await p.call('POST', '/teams', { id: 'empty' });
    const e = (await p.call('GET', '/teams/empty/caps')).body;
    assert.deepEqual([e.caps[0].cap, e.caps[0].state, e.caps[0].steps[0].then], [null, 'unset', 'stop']);
    assert.equal((await p.call('GET', '/teams/nope/caps')).status, 404);
  }, { tickMs: 0 });
});

test('spend leases (R4): two sessions can\'t both be given the last cent; usage counts against a lease; a session that ends frees it', async () => {
  await plane(async (p) => {
    const { runner, front, qa } = await team(p);
    const a = await lease(runner, front, 60);
    assert.deepEqual([a.amount, a.currency, a.remainingToday], [60, 'EUR', 40]);
    assert.match(a.lease, /^lse_/);
    const b = await lease(runner, qa, 60);
    assert.deepEqual([b.amount, b.remainingToday], [40, 0], 'only what the first lease left');
    // A new ask replaces the session's own lease: QA's 40 is free again for it, never counted twice.
    assert.equal((await lease(runner, qa, 10)).amount, 10);
    const a2 = await lease(runner, front, 100);
    assert.deepEqual([a2.amount, a2.remainingToday], [90, 0], 'QA holds 10');
    assert.deepEqual([(await lease(runner, qa, 20)).amount], [10], 'the front door holds 90: QA gets the 10 it gave back, no more');
    // The front door spends 25 of its 90: counted against its lease, so what is held drops by 25 and spent rises by 25.
    assert.equal((await runner.request('events', { events: [usage(front, 25)] })).op, 'ack');
    const [row] = await p.db.system("select amount, used from spend_leases where id = $1", [a2.lease]);
    assert.deepEqual([Number(row.amount), Number(row.used)], [90, 25]);
    let day = (await p.call('GET', '/teams/shop/caps')).body.caps[0];
    assert.deepEqual([day.spent, day.leased, day.remaining], [25, 75, 0]);
    // The front door ends: its lease ends with it, and the 65 it held is free again.
    assert.equal((await runner.request('events', { events: [{ ...usage(front, 0), type: 'session.ended', data: { reason: 'done' } }] })).op, 'ack');
    day = (await p.call('GET', '/teams/shop/caps')).body.caps[0];
    assert.deepEqual([day.leased, day.remaining], [10, 65]);
    const c = await lease(runner, qa);
    assert.equal(c.amount, 5, 'the default ask is a twentieth of the daily cap');
    // Bad input and someone else's session are refused.
    assert.equal((await runner.request('spend.lease', { session: qa.session, amount: -1 })).op, 'nack');
    assert.equal((await runner.request('spend.lease', { session: 'ses_nope' })).op, 'nack');
  }, { tickMs: 0 });
});

test('spend leases: an expired lease holds nothing; a paused run and a team with no daily cap are given nothing', async () => {
  let clock = Date.now();
  await plane(async (p) => {
    const { runner, front, qa } = await team(p);
    assert.equal((await lease(runner, front, 100)).amount, 100);
    assert.equal((await lease(runner, qa, 1)).amount, 0);
    clock += 6 * 60_000;
    assert.equal((await lease(runner, qa, 50)).amount, 50, 'after five minutes the front door\'s lease is gone');
    // The run pauses: nothing more is leased.
    const [run] = await p.db.system("select id from runs where team = 'shop'");
    assert.equal((await p.call('POST', `/runs/${run.id}/pause`, {})).status, 200);
    const paused = await runner.request('spend.lease', { session: qa.session, amount: 1 });
    assert.ok(paused.op === 'nack' || paused.body.reason === 'paused', JSON.stringify(paused));
  }, { tickMs: 0, now: () => new Date(clock) });
});

test('estimates (G15.2): no history says so; a role\'s sessions, a teammate\'s working day and a meeting per attendee, against what is left today', async () => {
  await plane(async (p) => {
    const { runner, front, qa } = await team(p, { perDay: 1000 });
    let e = await p.call('GET', '/teams/shop/estimate?kind=trial&role=qa');
    assert.equal(e.status, 200, JSON.stringify(e.body));
    assert.deepEqual([e.body.estimate, e.body.basis.from, e.body.currency, e.body.mayNotFit], [null, 'none', 'EUR', false]);
    // Five sessions' worth of QA spend (fresh session ids) and some front-door spend.
    const costs = [10, 20, 30, 40, 50];
    for (const [i, c] of costs.entries()) assert.ok((await p.inject('shop', [usage({ ...qa, session: `ses_hist${i}` }, c)])).stored.length >= 1);
    assert.equal((await runner.request('events', { events: [usage(front, 7)] })).op, 'ack');
    e = await p.call('GET', '/teams/shop/estimate?kind=trial&role=qa');
    assert.deepEqual([e.body.estimate, e.body.basis], [{ low: 20, typical: 30, high: 40 }, { from: 'role', samples: 5, days: 30 }]);
    // A role with too little history falls back to the whole team.
    e = await p.call('GET', '/teams/shop/estimate?kind=trial&role=chief-of-staff');
    assert.deepEqual([e.body.basis.from, e.body.basis.samples], ['team', 6]);
    // A teammate: a working day of that role (here all of QA's spend fell on one day).
    e = await p.call('GET', '/teams/shop/estimate?kind=teammate&role=qa');
    // QA has one working day (150) here, too few, so the team's: QA's day and the front door's day (7).
    assert.deepEqual([e.body.basis, e.body.estimate], [{ from: 'team', samples: 2, days: 30 }, { low: 43, typical: 79, high: 114 }]);
    // More than is left today: a warning, never a block.
    assert.equal((await p.call('PUT', '/teams/shop/budget', { perDay: 160 })).status, 200, 'lowering needs no step-up');
    e = await p.call('GET', '/teams/shop/estimate?kind=trial&role=qa');
    assert.deepEqual([e.body.remainingToday, e.body.mayNotFit], [160 - 157, true]);
    // Meetings: none closed yet.
    e = await p.call('GET', '/teams/shop/estimate?kind=meeting&attendees=3');
    assert.deepEqual([e.body.estimate, e.body.basis.from, e.body.attendees], [null, 'none', 3]);
    for (const q of ['kind=lunch', 'kind=meeting', 'kind=meeting&attendees=0', 'kind=trial', 'kind=trial&role=Bad Role']) assert.equal((await p.call('GET', `/teams/shop/estimate?${q}`)).status, 400, q);
  }, { tickMs: 0 });
});
