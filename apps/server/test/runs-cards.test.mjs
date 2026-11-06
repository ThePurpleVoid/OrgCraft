// M3 part 2a: migration 003's tables, budgets, runs, chat, cards and approvals with step-up, and the inbox
// (docs/product/m3-design.md sections 1, 4, 5 and 6; issue #28 D3 to D6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../store.mjs';
import { hashStepUpSecret, stepUpVerifier } from '../m3.mjs';
import { ADMIN, envelope, plane, sse } from './helpers.mjs';

const auth = { authorization: `Bearer ${ADMIN}` };
const SECRET = 'a long step-up secret';
const verifier = stepUpVerifier(await hashStepUpSecret(SECRET));
const roster = (extra = []) => ({ version: 'abc123', roles: [
  { slug: 'chief-of-staff', reportsTo: 'owner', areas: ['docs/team/**'] },
  { slug: 'web-dev', reportsTo: 'chief-of-staff', areas: ['apps/web/**'] },
  ...extra,
] });
const M3_TABLES = ['runs', 'sessions', 'deliveries', 'cards', 'approvals', 'chat_messages', 'budgets', 'budget_days', 'audit', 'step_up_tokens', 'step_up_failures'];

const withStepUp = (o) => plane(o, { stepUpVerifier: verifier });
async function stepUp(call) {
  const r = await call('POST', '/auth/step-up', { secret: SECRET });
  assert.equal(r.status, 201);
  return { ...auth, 'x-step-up': r.body.token };
}
/** A team with a daily cap (set with step-up, as raising one needs) and a running run. */
async function running(call, team = 'shop', perDay = 1000) {
  await call('POST', '/teams', { id: team });
  assert.equal((await call('PUT', `/teams/${team}/budget`, { perDay, currency: 'USD' }, await stepUp(call))).status, 200);
  const run = await call('POST', `/teams/${team}/runs`, { team: roster() });
  assert.equal(run.status, 201, JSON.stringify(run.body));
  return run.body;
}
const usage = (team, id, cost, run) => envelope('acme', team, id, 'usage.recorded', { inputTokens: 1, outputTokens: 1, cost, currency: 'USD' }, run ? { run } : {});

test('every M3 table keeps tenants apart, and audit is append-only', async () => {
  await withStepUp(async ({ call, db, m3 }) => {
    await running(call);
    await call('POST', '/teams/shop/chat', { text: 'hi', clientId: 'c1' });
    await call('POST', '/teams/shop/events', { events: [usage('shop', 'u1', 5)] });
    await db.tenant('acme', async ({ q }) => {
      const [{ id: run }] = await q('select id from runs');
      await q("insert into sessions(id, tenant, team, run, role, state) values ('ses_1', 'acme', 'shop', $1, 'web-dev', 'running')", [run]);
      await q("insert into deliveries(id, tenant, team, event, run, role) values ('dlv_1', 'acme', 'shop', 'e1', $1, 'web-dev')", [run]);
    });
    await m3.tx('acme', (ctx) => m3.requestApproval(ctx, 'shop', { action: 'accept', call: 'gh pr merge 1', why: 'tests pass' }));
    await call('POST', '/auth/step-up', { secret: 'wrong secret!!' });
    await store.ensureTenant(db, 'rival');
    for (const table of M3_TABLES) {
      assert.ok((await db.tenant('acme', ({ q }) => q(`select * from ${table}`))).length > 0, `${table} has rows for its tenant`);
      assert.deepEqual(await db.tenant('rival', ({ q }) => q(`select * from ${table}`)), [], `${table} is invisible to another tenant`);
    }
    await assert.rejects(db.tenant('rival', ({ q }) => q("insert into runs(id, tenant, team, state, started_by) values ('run_x', 'acme', 'shop', 'running', 'x')")), /row-level security/);
    await assert.rejects(db.tenant('rival', ({ q }) => q("insert into cards(id, tenant, team, kind, card) values ('card_x', 'acme', 'shop', 'decision', '{}')")), /row-level security/);
    await assert.rejects(db.tenant('rival', ({ q }) => q("insert into audit(tenant, actor_kind, actor_id, action) values ('acme', 'person', 'x', 'run')")), /row-level security/);
    await assert.rejects(db.tenant('acme', ({ q }) => q("update audit set decision = 'x'")), /permission denied/);
    await assert.rejects(db.tenant('acme', ({ q }) => q('delete from audit')), /permission denied/);
    await assert.rejects(db.tenant('acme', ({ q }) => q('delete from chat_messages')), /permission denied/);
  });
});

test('step-up: a slow hash, the bearer token refused, single use, a lockout after five misses, and never kept', async () => {
  await withStepUp(async ({ call, db }) => {
    assert.match(await hashStepUpSecret(SECRET), /^scrypt\$32768\$/, 'the stored form is scrypt, not a plain SHA-256');
    await assert.rejects(hashStepUpSecret('short'), /12 characters/);
    const bearer = await call('POST', '/auth/step-up', { secret: ADMIN });
    assert.equal(bearer.status, 401, 'the sign-in token is not the step-up secret');
    const ok = await call('POST', '/auth/step-up', { secret: SECRET }, { ...auth, 'idempotency-key': 'su-1' });
    assert.equal(ok.status, 201);
    assert.match(ok.body.token, /^su_/);
    const replay = await call('POST', '/auth/step-up', { secret: SECRET }, { ...auth, 'idempotency-key': 'su-1' });
    assert.equal(replay.status, 409, 'a step-up token is shown once');
    const kept = (await db.system('select response::text as r from idempotency_keys')).map((x) => x.r).join('\n');
    assert.ok(!kept.includes(ok.body.token.split('.')[1]), 'and is never kept in the idempotency table');
    const [row] = await db.system('select hash from step_up_tokens where id = $1', [ok.body.token.split('.')[0]]);
    assert.ok(!row.hash.includes(ok.body.token.split('.')[1]));

    await call('POST', '/teams', { id: 'shop' });
    const h = { ...auth, 'x-step-up': ok.body.token };
    assert.equal((await call('PUT', '/teams/shop/budget', { perDay: 100 }, h)).status, 200);
    const again = await call('PUT', '/teams/shop/budget', { perDay: 200 }, h);
    assert.equal(again.status, 401, 'a step-up token works once');
    assert.equal(again.body.type, 'step-up-required');

    for (let i = 0; i < 4; i++) assert.equal((await call('POST', '/auth/step-up', { secret: `wrong secret ${i}` })).status, 401);
    // five misses so far (the bearer token counted); the next try is locked out, even with the right secret
    assert.equal((await call('POST', '/auth/step-up', { secret: SECRET })).status, 429);
    const [{ n }] = await db.system("select count(*)::int as n from audit where action = 'step-up' and decision = 'refused'");
    assert.equal(n, 6, 'every miss and the lockout are audited');
    await db.system("update step_up_failures set at = now() - interval '16 minutes'");
    assert.equal((await call('POST', '/auth/step-up', { secret: SECRET })).status, 201, 'the lockout lifts after 15 minutes');
  });
  await plane(async ({ call }) => {
    const off = await call('POST', '/auth/step-up', { secret: SECRET });
    assert.deepEqual([off.status, off.body.type], [401, 'step-up-required'], 'with no step-up hash configured, nothing that needs it passes');
  }, { stepUpVerifier: null });
  assert.throws(() => stepUpVerifier('sha256$abc'), /not a scrypt hash/);
  assert.throws(() => stepUpVerifier('scrypt$16384$8$1$c2FsdHNhbHRzYWx0c2FsdA$a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5'), /2\^15 to 2\^17/);
  assert.throws(() => stepUpVerifier('scrypt$262144$8$1$c2FsdHNhbHRzYWx0c2FsdA$a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5'), /2\^15 to 2\^17/);
  assert.throws(() => stepUpVerifier('scrypt$32768$32$1$c2FsdHNhbHRzYWx0c2FsdA$a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5'), /r \(1 to 8\)/, 'r is capped so one check stays under 128 MiB');
});

test('budget: raising or setting a cap needs step-up, lowering does not, and a run needs a daily cap', async () => {
  await withStepUp(async ({ call }) => {
    await call('POST', '/teams', { id: 'shop' });
    assert.deepEqual((await call('GET', '/teams/shop/budget')).body, { currency: 'USD', perDay: null, perRun: null, sessions: 3, meetingCap: null, today: { day: new Date().toISOString().slice(0, 10), spent: 0, raised: 0, state: 'ok' } });
    assert.equal((await call('POST', '/teams/shop/runs', { team: roster() })).status, 409, 'no run without a daily cap');
    const need = await call('PUT', '/teams/shop/budget', { perDay: 1000 });
    assert.equal(need.status, 401);
    assert.equal(need.body.type, 'step-up-required');
    assert.equal((await call('PUT', '/teams/shop/budget', { perDay: 1000, perRun: 500, sessions: 4 }, await stepUp(call))).status, 200);
    assert.equal((await call('PUT', '/teams/shop/budget', { perDay: 800 })).status, 200, 'lowering is one tap');
    assert.equal((await call('PUT', '/teams/shop/budget', { sessions: 2 })).status, 200);
    assert.equal((await call('PUT', '/teams/shop/budget', { perRun: null })).status, 401, 'clearing a cap raises it');
    assert.equal((await call('PUT', '/teams/shop/budget', { sessions: 5 })).status, 401);
    assert.equal((await call('PUT', '/teams/shop/budget', { perDay: -1 })).status, 400);
    assert.equal((await call('PUT', '/teams/shop/budget', { currency: 'dollars' })).status, 400);
    const b = (await call('GET', '/teams/shop/budget')).body;
    assert.equal(b.perDay, 800);
    assert.equal(b.sessions, 2);
  });
});

test('runs: frozen on a roster with one front door, one at a time, paused, resumed and stopped', async () => {
  await withStepUp(async ({ call, base }) => {
    await call('POST', '/teams', { id: 'shop' });
    await call('PUT', '/teams/shop/budget', { perDay: 1000, sessions: 3 }, await stepUp(call));
    assert.equal((await call('POST', '/teams/shop/runs', {})).status, 409, 'a run needs the roles');
    const two = roster([{ slug: 'cto', reportsTo: 'owner', areas: [] }]);
    assert.match((await call('POST', '/teams/shop/runs', { team: two })).body.error, /exactly one role reports to the owner/);
    assert.equal((await call('POST', '/teams/shop/runs', { team: roster([{ slug: 'qa', reportsTo: 'nobody' }]) })).status, 400);
    assert.equal((await call('POST', '/teams/shop/runs', { team: roster(), caps: { sessions: 5 } })).status, 409, 'a run may lower caps, never raise them');

    const stream = await sse(`${base}/teams/shop/events/stream?type=run.`, auth);
    const run = (await call('POST', '/teams/shop/runs', { team: roster(), caps: { sessions: 2 } })).body;
    assert.equal(run.state, 'running');
    assert.equal(run.teamVersion, 'abc123', 'the roster\'s version is the run\'s team version');
    assert.equal((await call('POST', '/teams/shop/runs', { team: roster() })).status, 409, 'one run at a time');
    assert.equal((await call('POST', `/runs/${run.id}/pause`)).body.state, 'paused');
    assert.equal((await call('POST', `/runs/${run.id}/pause`)).status, 409);
    const resumed = (await call('POST', `/runs/${run.id}/resume`)).body;
    assert.equal(resumed.state, 'running', 'resuming after the owner paused needs no step-up');
    assert.equal(resumed.version, 3);
    assert.equal((await call('POST', `/runs/${run.id}/stop`)).body.state, 'stopped');
    assert.equal((await call('POST', `/runs/${run.id}/explode`)).status, 404);
    const types = (await stream.until(4)).map((g) => g.event.type);
    assert.deepEqual(types, ['run.started', 'run.paused', 'run.resumed', 'run.stopped']);
    stream.close();
    assert.equal((await call('GET', '/teams/shop/runs')).body.runs[0].state, 'stopped');
    assert.equal((await call('POST', '/teams/shop/runs', { team: roster() })).status, 201, 'a stopped run makes room for the next');
  });
});

test('chat: the owner\'s text byte for byte, a clientId stored once, pages backwards, and asOf resumes the stream', async () => {
  await withStepUp(async ({ call, base, db }) => {
    await running(call);
    const text = '  leading spaces, an emoji 🚀, a tab\tand a trailing newline\n';
    const first = await call('POST', '/teams/shop/chat', { text, clientId: '01JC8Z7Q6V9W3X2Y1Z0A9B8C7D' });
    assert.equal(first.status, 201);
    assert.equal(first.body.type, 'chat.message');
    assert.equal(first.body.data.text, text);
    const again = await call('POST', '/teams/shop/chat', { text, clientId: '01JC8Z7Q6V9W3X2Y1Z0A9B8C7D' });
    assert.equal(again.status, 200, 'a resend returns the first message');
    assert.equal(again.body.id, first.body.id);
    const [{ n }] = await db.system('select count(*)::int as n from chat_messages');
    assert.equal(n, 1);
    const [row] = await db.system('select text from chat_messages');
    assert.equal(row.text, text);
    assert.equal((await call('POST', '/teams/shop/chat', { text: '' })).status, 400);

    for (let i = 0; i < 5; i++) await call('POST', '/teams/shop/chat', { text: `m${i}`, clientId: `c${i}` });
    await call('POST', '/teams/shop/events', { events: [envelope('acme', 'shop', 'not-chat', 'report.note', {})] });
    const page = (await call('GET', '/teams/shop/chat?limit=3')).body;
    assert.deepEqual(page.items.map((e) => e.data.text), ['m2', 'm3', 'm4'], 'the newest page, oldest first');
    assert.equal(page.asOf, 'not-chat', 'asOf is the newest event of the log, so the stream resumes after everything');
    assert.equal(page.run.state, 'running');
    assert.deepEqual(page.cost, { today: 0, capPerDay: 1000, currency: 'USD', state: 'ok' });
    const older = (await call('GET', `/teams/shop/chat?limit=3&cursor=${page.next}`)).body;
    assert.deepEqual(older.items.map((e) => e.data.text ?? e.type), ['run.started', text, 'm0', 'm1'].slice(-3));
    assert.deepEqual((await call('GET', `/teams/shop/chat?before=${page.items[0].id}&limit=1`)).body.items.map((e) => e.data.text), ['m1']);

    const s = await sse(`${base}/teams/shop/events/stream`, { ...auth, 'last-event-id': page.asOf });
    await call('POST', '/teams/shop/chat', { text: 'after' });
    assert.deepEqual((await s.until(1)).map((g) => g.event.data.text), ['after'], 'nothing between the page and the stream is lost or repeated');
    s.close();
  });
});

test('cards: a stale version gets 409 with the current card, approvals need a fresh step-up, and the inbox shows them', async () => {
  await withStepUp(async ({ call, base, m3 }) => {
    const run = await running(call);
    const { result: apr } = await m3.tx('acme', (ctx) => m3.requestApproval(ctx, 'shop', { action: 'accept', call: 'gh pr merge 42 --match-head-commit abc', why: 'QA signed off', risk: 'high', run: run.id, session: 'ses_9', role: 'web-dev', links: [{ rel: 'pr', url: 'https://example.com/pr/42' }] }));
    const { result: dec } = await m3.tx('acme', (ctx) => m3.createCard(ctx, 'shop', { kind: 'decision', subject: 'decision/x', session: 'ses_1', run: run.id, title: 'Which theme?', options: [{ id: 'dark', label: 'Dark' }, { id: 'light', label: 'Light' }], recommendation: { option: 'dark', why: 'matches' } }));

    const res = await fetch(`${base}/me/inbox`, { headers: auth });
    const box = await res.json();
    assert.deepEqual(box.cards.map((c) => c.kind), ['approval', 'decision'], 'approvals first');
    const card = box.cards[0];
    assert.equal(card.version, 1);
    assert.equal(card.url, `/t/shop/approvals/${apr.approval}`);
    assert.deepEqual(card.options.map((o) => [o.id, o.stepUp]), [['approve', true], ['deny', false]]);
    assert.ok(box.asOf);
    assert.equal((await fetch(`${base}/me/inbox`, { headers: { ...auth, 'if-none-match': res.headers.get('etag') } })).status, 304);
    assert.equal((await call('GET', '/me/summary')).body.teams[0].inbox, 2);

    const noStepUp = await call('POST', `/approvals/${apr.approval}`, { decision: 'approved', version: 1 });
    assert.equal(noStepUp.status, 401);
    assert.equal(noStepUp.body.type, 'step-up-required', 'never a silent approval');
    const stale = await call('POST', `/approvals/${apr.approval}`, { decision: 'approved', version: 0 }, await stepUp(call));
    assert.equal(stale.status, 409);
    assert.equal(stale.body.id, card.id, 'the 409 carries the current card');
    assert.equal(stale.body.version, 1);

    const s = await sse(`${base}/teams/shop/events/stream?type=approval.`, auth);
    const ok = await call('POST', `/approvals/${apr.approval}`, { decision: 'approved', version: 1, note: 'ship it' }, await stepUp(call));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.card.version, 2);
    assert.equal(ok.body.card.state, 'answered');
    const [requested, decided] = (await s.until(2)).map((g) => g.event);
    s.close();
    assert.equal(requested.data.cardId, card.id);
    assert.equal(decided.type, 'approval.decided');
    assert.deepEqual([decided.data.decision, decided.data.session, decided.data.by], ['approved', 'ses_9', 'admin']);
    const twice = await call('POST', `/approvals/${apr.approval}`, { decision: 'denied' });
    assert.equal(twice.status, 409, 'an answered approval cannot be answered again');
    assert.equal(twice.body.version, 2);

    const old = await call('POST', `/cards/${dec.id}`, { option: 'dark', version: 7 });
    assert.equal(old.status, 409);
    assert.equal(old.body.title, 'Which theme?');
    assert.equal((await call('POST', `/cards/${dec.id}`, { option: 'blue', version: 1 })).status, 400);
    const chose = await call('POST', `/cards/${dec.id}`, { option: 'light', version: 1 });
    assert.equal(chose.status, 200, 'a decision without stepUp options is one tap');
    assert.deepEqual([chose.body.card.version, chose.body.card.answer.option], [2, 'light']);
    const chat = (await call('GET', '/teams/shop/chat')).body;
    const answered = chat.items.find((e) => e.type === 'decision.answered');
    assert.deepEqual([answered.data.cardId, answered.data.session, answered.data.answer], [dec.id, 'ses_1', 'light']);
    assert.equal(chat.cards[dec.id].version, 2, 'the chat carries the current version of every card it mentions');
    assert.equal((await call('GET', '/me/inbox')).body.cards.length, 0);
    assert.equal((await call('GET', `/cards/${dec.id}`)).body.state, 'answered');

    // Denying never needs step-up.
    const { result: apr2 } = await m3.tx('acme', (ctx) => m3.requestApproval(ctx, 'shop', { action: 'deploy-production', call: 'deploy', why: 'release' }));
    assert.equal((await call('POST', `/cards/${apr2.card.id}`, { option: 'deny', version: 1 })).status, 200);
  });
});

test('budget: warns once at 80%, and at 100% pauses the run and sends one card; raising resumes it', async () => {
  await withStepUp(async ({ call, base, db }) => {
    const run = await running(call, 'shop', 1000);
    const s = await sse(`${base}/teams/shop/events/stream?type=budget.`, auth);
    await call('POST', '/teams/shop/events', { events: [usage('shop', 'u1', 500, run.id)] });
    await call('POST', '/teams/shop/events', { events: [usage('shop', 'u2', 310, run.id)] });
    await call('POST', '/teams/shop/events', { events: [usage('shop', 'u3', 10, run.id)] });
    assert.equal((await call('GET', '/teams/shop/budget')).body.today.state, 'warned');
    await call('POST', '/teams/shop/events', { events: [usage('shop', 'u4', 200, run.id), usage('shop', 'u5', 50, run.id)] });
    const got = (await s.until(3)).map((g) => g.event).filter((e) => e.type !== 'budget.updated');
    assert.deepEqual(got.map((e) => e.type), ['budget.warned', 'budget.exhausted']);
    assert.deepEqual([got[0].data.spent, got[0].data.cap], [810, 1000]);
    assert.equal(got[1].data.spent, 1020);
    s.close();
    const r = (await call('GET', '/teams/shop/runs')).body.runs[0];
    assert.deepEqual([r.state, r.reason], ['paused', 'budget']);
    const cards = (await call('GET', '/me/inbox')).body.cards;
    assert.equal(cards.length, 1, 'one card, however many usage events crossed the line');
    assert.equal(cards[0].kind, 'budget');
    assert.match(cards[0].body, /spent \$\d+\.\d\d of \$\d+\.\d\d /, 'money, not minor units (QA, M3 exit pass A)');
    assert.equal(cards[0].id, got[1].data.cardId);
    const summary = (await call('GET', '/me/summary')).body.teams[0];
    assert.deepEqual([summary.run, summary.cost.today, summary.cost.capPerDay, summary.inbox], ['paused', 1070, 1000, 1]);

    const refused = await call('POST', `/runs/${run.id}/resume`, undefined, await stepUp(call));
    assert.equal(refused.status, 409, 'resuming is refused while today is still spent');
    assert.match(refused.body.type ?? '', /budget-exhausted$/, 'a typed problem, so a client can say it in its own words');
    assert.equal((await call('POST', `/cards/${cards[0].id}`, { option: 'raise', version: 1 })).body.type, 'step-up-required', 'raising spends money, so it needs step-up');
    const raised = await call('POST', `/cards/${cards[0].id}`, { option: 'raise', version: 1 }, await stepUp(call));
    assert.equal(raised.status, 200);
    const after = (await call('GET', '/teams/shop/budget')).body.today;
    assert.deepEqual([after.raised, after.state], [500, 'ok']);
    assert.equal((await call('GET', '/teams/shop/runs')).body.runs[0].state, 'running', 'the budget-paused run carries on');
    assert.equal((await call('GET', '/teams/shop/chat')).body.cost.capPerDay, 1500);
    const [{ n }] = await db.system("select count(*)::int as n from events where type = 'budget.exhausted'");
    assert.equal(n, 1);
  });
});

test('budget: raising the day\'s cap does not resume a run that is also past its own cap; that run gets its own card', async () => {
  await withStepUp(async ({ call }) => {
    const run = await running(call, 'shop', 1000);
    assert.equal((await call('PUT', '/teams/shop/budget', { perDay: 1000, perRun: 600, currency: 'USD' }, await stepUp(call))).status, 200);
    // One turn crosses both lines: the day pauses the run first.
    await call('POST', '/teams/shop/events', { events: [usage('shop', 'u1', 1100, run.id)] });
    const [day] = (await call('GET', '/me/inbox')).body.cards;
    assert.equal(day.data.scope, 'day');
    assert.equal((await call('POST', `/cards/${day.id}`, { option: 'raise', version: 1 }, await stepUp(call))).status, 200);
    const r = (await call('GET', '/teams/shop/runs')).body.runs[0];
    assert.deepEqual([r.state, r.reason], ['paused', 'budget'], 'not resumed: its sessions would only stop again at once');
    const cards = (await call('GET', '/me/inbox')).body.cards.filter((c) => c.kind === 'budget');
    assert.deepEqual(cards.map((c) => [c.data.scope, c.data.run, c.data.cap]), [['run', run.id, 600]], 'the run\'s own card asks the owner');
  });
});

test('budget: answering "tomorrow" leaves the run paused until the next UTC day', async () => {
  await withStepUp(async ({ call, db }) => {
    const run = await running(call, 'shop', 100);
    await call('POST', '/teams/shop/events', { events: [usage('shop', 'u1', 100, run.id)] });
    const [card] = (await call('GET', '/me/inbox')).body.cards;
    assert.equal((await call('POST', `/cards/${card.id}`, { option: 'tomorrow', version: 1 })).status, 200, 'not spending needs no step-up');
    const [r] = await db.system('select state, resume_on::text as resume_on from runs where id = $1', [run.id]);
    const d = new Date();
    assert.deepEqual([r.state, r.resume_on], ['paused', new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString().slice(0, 10)]);
  });
});

test('budget: after "tomorrow", a stepped-up raise of the daily cap above today\'s spend lets the run resume now (QA #162)', async () => {
  await withStepUp(async ({ call, db }) => {
    const run = await running(call, 'shop', 100);
    await call('POST', '/teams/shop/events', { events: [usage('shop', 'u1', 100, run.id)] });
    const [card] = (await call('GET', '/me/inbox')).body.cards;
    await call('POST', `/cards/${card.id}`, { option: 'tomorrow', version: 1 });
    // Raising to no more than today's spend leaves today spent.
    assert.equal((await call('PUT', '/teams/shop/budget', { perDay: 100 })).status, 200);
    assert.equal((await call('PUT', '/teams/shop/budget', { perDay: 90 })).status, 200, 'lowering never needs step-up');
    assert.equal((await call('PUT', '/teams/shop/budget', { perDay: 100 }, await stepUp(call))).body.today.state, 'exhausted', 'a cap equal to the spend is still spent');
    assert.equal((await call('POST', `/runs/${run.id}/resume`, undefined, await stepUp(call))).status, 409);
    // Above it, today is open again: the raise is newer than the spent mark and was stepped up.
    assert.equal((await call('PUT', '/teams/shop/budget', { perDay: 2000 })).body.type, 'step-up-required');
    const put = await call('PUT', '/teams/shop/budget', { perDay: 2000 }, await stepUp(call));
    assert.deepEqual([put.status, put.body.today.state], [200, 'ok'], 'under 80% of the new cap, so not even warned');
    const resumed = await call('POST', `/runs/${run.id}/resume`, undefined, await stepUp(call));
    assert.deepEqual([resumed.status, resumed.body.state], [200, 'running']);
    const [r] = await db.system('select resume_on from runs where id = $1', [run.id]);
    assert.equal(r.resume_on, null, 'the Resume tomorrow date is gone');
    // Spending past the new cap pauses it again, with a new card.
    await call('POST', '/teams/shop/events', { events: [usage('shop', 'u2', 1900, run.id)] });
    assert.equal((await call('GET', '/teams/shop/runs')).body.runs[0].state, 'paused');
  });
});
