// Review findings on PR #47 (code reviewer sev 2 and 3, security reviewer U1 to U3), each with the scenario that
// broke it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashStepUpSecret, stepUpVerifier } from '../m3.mjs';
import { ADMIN, envelope, plane } from './helpers.mjs';

const auth = { authorization: `Bearer ${ADMIN}` };
const SECRET = 'a long step-up secret';
const verifier = stepUpVerifier(await hashStepUpSecret(SECRET));
const roster = () => ({ version: 'abc123', roles: [
  { slug: 'chief-of-staff', reportsTo: 'owner', areas: [] },
  { slug: 'web-dev', reportsTo: 'chief-of-staff', areas: [] },
] });
const usage = (team, id, cost, run) => envelope('acme', team, id, 'usage.recorded', { inputTokens: 1, outputTokens: 1, cost, currency: 'USD' }, run ? { run } : {});
const withStepUp = (fn, extra = {}) => plane(fn, { stepUpVerifier: verifier, ...extra });
async function stepUp(call) {
  const r = await call('POST', '/auth/step-up', { secret: SECRET });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...auth, 'x-step-up': r.body.token };
}
async function running(call, budget = { perDay: 1000 }, caps) {
  await call('POST', '/teams', { id: 'shop' });
  assert.equal((await call('PUT', '/teams/shop/budget', { currency: 'USD', ...budget }, await stepUp(call))).status, 200);
  const run = await call('POST', '/teams/shop/runs', { team: roster(), ...(caps ? { caps } : {}) });
  assert.equal(run.status, 201, JSON.stringify(run.body));
  return run.body;
}
const runOf = async (call) => (await call('GET', '/teams/shop/runs')).body.runs[0];

test('ADR 0013: resuming a run a person paused needs step-up; pausing and stopping never do', async () => {
  await withStepUp(async ({ call, db }) => {
    const run = await running(call, { perDay: 1000 });
    assert.equal((await call('POST', `/runs/${run.id}/pause`)).status, 200, 'pause is one tap');
    const bare = await call('POST', `/runs/${run.id}/resume`);
    assert.deepEqual([bare.status, bare.body.type], [401, 'step-up-required']);
    assert.match(bare.body.detail ?? bare.body.title ?? '', /Resuming a paused run/);
    assert.equal((await runOf(call)).state, 'paused', 'refused, so still paused');
    const ok = await call('POST', `/runs/${run.id}/resume`, undefined, await stepUp(call));
    assert.equal(ok.status, 200);
    assert.equal((await runOf(call)).state, 'running');
    const [a] = await db.system("select detail from audit where action = 'run' and detail->>'op' = 'resume'");
    assert.equal(a.detail.stepUp, true);
    // A used step-up token does not resume a second time.
    assert.equal((await call('POST', `/runs/${run.id}/pause`)).status, 200);
    const token = await stepUp(call);
    assert.equal((await call('POST', `/runs/${run.id}/resume`, undefined, token)).status, 200);
    assert.equal((await call('POST', `/runs/${run.id}/pause`)).status, 200);
    assert.equal((await call('POST', `/runs/${run.id}/resume`, undefined, token)).status, 401, 'single use');
    assert.equal((await call('POST', `/runs/${run.id}/stop`)).status, 200, 'stop is one tap');
  });
});

test('U2: an owner-paused run cannot resume past a spent day, and usage on a spent day pauses what runs', async () => {
  await withStepUp(async ({ call, db }) => {
    const run = await running(call, { perDay: 100 });
    assert.equal((await call('POST', `/runs/${run.id}/pause`)).status, 200);
    await call('POST', '/teams/shop/events', { events: [usage('shop', 'u1', 100, run.id)] });
    assert.equal((await call('GET', '/teams/shop/budget')).body.today.state, 'exhausted');
    const r = await call('POST', `/runs/${run.id}/resume`, undefined, await stepUp(call));
    assert.equal(r.status, 409, 'the owner paused it, but today is spent: no resume, with or without step-up');
    assert.equal((await runOf(call)).state, 'paused');
    // However a run came to be running on a spent day, the next usage pauses it.
    await db.system("update runs set state = 'running', reason = 'owner' where id = $1", [run.id]);
    await call('POST', '/teams/shop/events', { events: [usage('shop', 'u2', 1, run.id)] });
    const after = await runOf(call);
    assert.deepEqual([after.state, after.reason], ['paused', 'budget']);
  });
});

test('an expired approval cannot be approved, however fresh the step-up', async () => {
  await withStepUp(async ({ call, m3 }) => {
    await running(call);
    const { result } = await m3.tx('acme', (ctx) => m3.requestApproval(ctx, 'shop', { action: 'accept', call: 'gh pr merge 3', why: 'tests pass', hours: -1 }));
    const r = await call('POST', `/approvals/${result.approval}`, { decision: 'approved', version: 1 }, await stepUp(call));
    assert.equal(r.status, 409);
    assert.equal(r.body.state, 'expired', 'the 409 carries the card, marked expired');
    const card = await call('POST', `/cards/${result.card.id}`, { option: 'approve', version: 1 }, await stepUp(call));
    assert.equal(card.status, 409, 'nor through the card');
  });
});

test('two runs started at once: one wins, the other gets 409', async () => {
  await withStepUp(async ({ call, db }) => {
    await call('POST', '/teams', { id: 'shop' });
    await call('PUT', '/teams/shop/budget', { perDay: 1000 }, await stepUp(call));
    const got = await Promise.all(Array.from({ length: 4 }, () => call('POST', '/teams/shop/runs', { team: roster() })));
    assert.deepEqual(got.map((g) => g.status).sort(), [201, 409, 409, 409]);
    const [{ n }] = await db.system("select count(*)::int as n from runs where state <> 'stopped'");
    assert.equal(n, 1);
  });
});

test('U1: parallel wrong guesses are counted before any is checked, and only five slow checks ever run', async () => {
  let checks = 0;
  const counting = async (s) => { checks++; return verifier(s); };
  await plane(async ({ call, db }) => {
    const got = await Promise.all(Array.from({ length: 20 }, (_, i) => call('POST', '/auth/step-up', { secret: `wrong secret ${i}` })));
    assert.ok(got.every((g) => g.status === 401 || g.status === 429), JSON.stringify(got.map((g) => g.status)));
    assert.ok(checks <= 5, `${checks} slow checks ran; at most five may`);
    // Retried one by one until the window is full: still at most five checks, then the lockout holds.
    for (let i = 0; i < 10; i++) await call('POST', '/auth/step-up', { secret: `wrong again ${i}` });
    assert.equal(checks, 5);
    assert.equal((await call('POST', '/auth/step-up', { secret: SECRET })).status, 429, 'the right secret is locked out too');
    const [{ n }] = await db.system("select count(*)::int as n from audit where action = 'step-up' and rule = 'wrong-secret'");
    assert.equal(n, 5);
    // A right secret does not count against the window.
    await db.system('delete from step_up_failures');
    for (let i = 0; i < 6; i++) assert.equal((await call('POST', '/auth/step-up', { secret: SECRET })).status, 201);
  }, { stepUpVerifier: counting });
});

test('U3: a secret the same length as the bearer token in characters, but not bytes, is a 401, not a 500', async () => {
  await withStepUp(async ({ call }) => {
    const r = await call('POST', '/auth/step-up', { secret: 'é'.repeat(ADMIN.length) });
    assert.deepEqual([r.status, r.body.type], [401, 'step-up-failed']);
  });
});

test('caps.costPerDay is the run\'s own daily cap', async () => {
  await withStepUp(async ({ call }) => {
    const run = await running(call, { perDay: 1000 }, { costPerDay: 50 });
    await call('POST', '/teams/shop/events', { events: [usage('shop', 'u1', 60, run.id)] });
    const r = await runOf(call);
    assert.deepEqual([r.state, r.reason], ['paused', 'budget']);
    assert.equal((await call('GET', '/teams/shop/budget')).body.today.state, 'ok', 'the team still has budget today');
    const [card] = (await call('GET', '/me/inbox')).body.cards;
    assert.deepEqual([card.data.scope, card.data.cap], ['run', 50]);
  });
});

test('raising a run\'s cap gives that run more and leaves the team\'s per-run cap as set', async () => {
  await withStepUp(async ({ call }) => {
    const run = await running(call, { perDay: 1000, perRun: 100 });
    await call('POST', '/teams/shop/events', { events: [usage('shop', 'u1', 100, run.id)] });
    const [card] = (await call('GET', '/me/inbox')).body.cards;
    assert.equal((await call('POST', `/cards/${card.id}`, { option: 'raise', version: 1 }, await stepUp(call))).status, 200);
    assert.equal((await call('GET', '/teams/shop/budget')).body.perRun, 100, 'the team cap is unchanged');
    const r = await runOf(call);
    assert.deepEqual([r.state, r.caps.raised], ['running', 50]);
    await call('POST', '/teams/shop/events', { events: [usage('shop', 'u2', 40, run.id)] });
    assert.equal((await runOf(call)).state, 'running', '140 of 150');
    await call('POST', '/teams/shop/events', { events: [usage('shop', 'u3', 10, run.id)] });
    assert.equal((await runOf(call)).state, 'paused');
  });
});

test('a budget change is an event, so /me/summary does not answer 304 with the old caps', async () => {
  await withStepUp(async ({ call }) => {
    await call('POST', '/teams', { id: 'shop' });
    await call('PUT', '/teams/shop/budget', { perDay: 1000 }, await stepUp(call));
    const first = await call('GET', '/me/summary');
    const tag = first.headers.get('etag');
    assert.equal((await call('PUT', '/teams/shop/budget', { perDay: 500 })).status, 200, 'lowering needs no step-up');
    const again = await call('GET', '/me/summary', undefined, { ...auth, 'if-none-match': tag });
    assert.equal(again.status, 200);
    assert.equal(again.body.teams[0].cost.capPerDay, 500);
    const ev = (await call('GET', '/teams/shop/events?type=budget.updated')).body.events;
    assert.deepEqual(ev.map((e) => e.data.perDay), [1000, 500]);
  });
});

test('one clientId sent twice at once is stored once, and both sends succeed', async () => {
  await withStepUp(async ({ call, db }) => {
    await call('POST', '/teams', { id: 'shop' });
    const got = await Promise.all(Array.from({ length: 5 }, () => call('POST', '/teams/shop/chat', { text: 'ship it', clientId: 'tap-1' })));
    assert.deepEqual(got.map((g) => g.status).sort(), [200, 200, 200, 200, 201]);
    assert.equal(new Set(got.map((g) => g.body.id)).size, 1, 'every answer is the same message');
    const [{ n }] = await db.system("select count(*)::int as n from chat_messages where client_id = 'tap-1'");
    assert.equal(n, 1);
  });
});

test('step-up-required keeps its problem+json type under an Idempotency-Key', async () => {
  await withStepUp(async ({ call }) => {
    await call('POST', '/teams', { id: 'shop' });
    const r = await call('PUT', '/teams/shop/budget', { perDay: 1000 }, { ...auth, 'idempotency-key': 'b-1' });
    assert.equal(r.status, 401);
    assert.equal(r.body.type, 'step-up-required');
    assert.match(r.headers.get('content-type'), /application\/problem\+json/);
  });
});

test('a usage report dated in the future is counted when it was received: it cannot spend or exhaust a day that has not come', async () => {
  await withStepUp(async ({ call, db }) => {
    await running(call, { perDay: 100 });
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    const future = { ...usage('shop', 'f1', 100), time: tomorrow };
    assert.equal((await call('POST', '/teams/shop/events', { events: [future] })).status, 200);
    const [stored] = (await call('GET', '/teams/shop/events?type=usage.recorded')).body.events;
    assert.ok(Math.abs(Date.parse(stored.time) - Date.now()) < 60_000, `stored at the time it was received, not ${stored.time}`);
    const days = await db.system("select to_char(day, 'YYYY-MM-DD') as day, spent from budget_days where team = 'shop'");
    assert.deepEqual(days.map((d) => [d.day, Number(d.spent)]), [[stored.time.slice(0, 10), 100]], 'spent on the day it arrived, nothing on tomorrow');
    // A few minutes of clock skew is kept as sent.
    const skewed = new Date(Date.now() + 2 * 60_000).toISOString();
    await call('POST', '/teams/shop/events', { events: [{ ...usage('shop', 'f2', 1), time: skewed }] });
    const f2 = (await call('GET', '/teams/shop/events?type=usage.recorded')).body.events.find((e) => e.id === 'f2');
    assert.equal(f2.time, skewed);
  });
});
