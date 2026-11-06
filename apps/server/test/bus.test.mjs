// M3 part 2b: the bus (what wakes whom, delivery to runners), session tokens and the team tool endpoint, the runner
// ops after hello, and the tick (docs/product/m3-design.md sections 2, 3, 4 and 7; issue #28 D1, D6, D8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, fakeRunner, plane, registerRunner } from './helpers.mjs';

const auth = { authorization: `Bearer ${ADMIN}` };
const roster = () => ({
  version: 'abc123', repo: { url: 'https://github.com/example/shop.git', ref: 'main' }, summary: 'A small shop',
  roles: [
    { slug: 'chief-of-staff', reportsTo: 'owner', areas: ['docs/**'], brief: 'You are the front door.' },
    { slug: 'web-dev', reportsTo: 'chief-of-staff', areas: ['apps/web/**'], brief: 'You build the web app.' },
    { slug: 'qa', reportsTo: 'chief-of-staff', areas: [] },
  ],
});

/** A team with a cap, a running run, and one connected runner that acks everything (checkpoints with a commit). */
async function setup({ call, base, su }, { sessions = 3, reply } = {}) {
  await call('POST', '/teams', { id: 'shop' });
  assert.equal((await call('PUT', '/teams/shop/budget', { perDay: 1000, sessions }, await su())).status, 200);
  const r = await registerRunner(call);
  const runner = await fakeRunner(base, r.key, { runner: r.id, reply: reply ?? ((f) => (f.op === 'session.checkpoint' ? { commit: 'c0ffee1', memory: '# notes' } : {})) });
  const run = await call('POST', '/teams/shop/runs', { team: roster() });
  assert.equal(run.status, 201, JSON.stringify(run.body));
  return { runner, run: run.body, runnerId: r.id };
}
const start = (runner, role) => runner.next((f) => f.op === 'session.start' && f.body.role === role);
const tool = (call, s, name, input, extra = {}) => call('POST', `/sessions/${s.session}/tools/${name}`, input, { authorization: `Bearer ${s.token}`, ...extra });

test('the owner\'s chat wakes the front door: session.start carries the roster, brief, branch, token and tools url', async () => {
  await plane(async (p) => {
    const { runner, run, runnerId } = await setup(p);
    assert.equal(runner.welcome.body.tenant, 'acme', 'welcome names the tenant');
    await p.call('POST', '/teams/shop/chat', { text: 'Ship the cart', clientId: 'c1' });
    const f = await start(runner, 'chief-of-staff');
    const b = f.body;
    assert.deepEqual([b.team, b.run, b.teamVersion, b.frontDoor, b.frontDoorRole], ['shop', run.id, 'abc123', true, 'chief-of-staff']);
    assert.deepEqual(b.roster, ['chief-of-staff', 'web-dev', 'qa']);
    assert.deepEqual(b.areas, ['docs/**']);
    assert.equal(b.prompt.brief, 'You are the front door.');
    assert.deepEqual(b.repo, { url: 'https://github.com/example/shop.git', ref: 'main' });
    assert.equal(b.worktree.branch, `team/chief-of-staff/${run.id}`);
    assert.equal(b.wake.type, 'chat.message');
    assert.equal(b.wake.data.text, 'Ship the cart');
    assert.match(b.token, /^st_/);
    assert.match(b.tools.url ?? '', /\/v1\/sessions\/ses_/);
    assert.equal(b.caps.remainingToday, 1000);
    // The ack lands the delivery; the session row knows its runner and keeps only the token's hash.
    await waitFor(async () => (await p.db.system("select state from deliveries")).every((d) => d.state === 'acked'));
    const [s] = await p.db.system('select runner, token_hash from sessions where id = $1', [b.session]);
    assert.equal(s.runner, runnerId);
    assert.ok(!s.token_hash.includes(b.token.split('.')[1]));
    // A second message goes to the live session as session.message, not a second start.
    await p.call('POST', '/teams/shop/chat', { text: 'and the receipts' });
    const m = await runner.next((x) => x.op === 'session.message');
    assert.equal(m.body.session, b.session);
    assert.equal(m.body.message.data.text, 'and the receipts');
    assert.equal(runner.frames.filter((x) => x.op === 'session.start').length, 1);
  }, { publicUrl: 'https://plane.example', tickMs: 0 });
});

test('team tools: the actor comes from the token, handoffs wake their role on its own branch, and replays are stored once', async () => {
  await plane(async (p) => {
    const { runner, run } = await setup(p);
    await p.call('POST', '/teams/shop/chat', { text: 'go' });
    const front = (await start(runner, 'chief-of-staff')).body;
    const handoff = { to: 'web-dev', task: 'Cart', changed: 'nothing yet', verify: 'open /cart', doneWhen: 'it loads', branch: 'main', actor: { kind: 'person', id: 'owner' } };
    const h = await tool(p.call, front, 'handoff', handoff, { 'idempotency-key': 'k1' });
    assert.equal(h.status, 200, JSON.stringify(h.body));
    const again = await tool(p.call, front, 'handoff', handoff, { 'idempotency-key': 'k1' });
    assert.deepEqual([again.status, again.body.event], [200, h.body.event], 'a replay answers the first result');
    const evs = (await p.call('GET', '/teams/shop/events?type=message.handoff')).body.events;
    assert.equal(evs.length, 1);
    assert.deepEqual([evs[0].actor.kind, evs[0].actor.id, evs[0].actor.session], ['role', 'chief-of-staff', front.session], 'the body\'s actor is ignored');
    assert.match(evs[0].data.detail, /Changed: nothing yet/);
    const web = (await start(runner, 'web-dev')).body;
    assert.equal(web.worktree.branch, `team/web-dev/${run.id}`, 'a handoff naming main still starts on the role\'s own branch');
    assert.equal(web.prompt.brief, 'You build the web app.');
    assert.equal(web.frontDoor, false);

    // Another role's branch is refused the same way; the role's own team/ branch is kept.
    const qa1 = await tool(p.call, front, 'handoff', { ...handoff, to: 'qa', branch: 'team/web-dev/x' });
    assert.equal(qa1.status, 200);
    assert.equal((await start(runner, 'qa')).body.worktree.branch, `team/qa/${run.id}`);
    const { branchFor } = await import('../bus.mjs');
    assert.equal(branchFor({ data: { branch: 'team/qa/fix-1' } }, 'qa', run.id), 'team/qa/fix-1');
    for (const b of ['main', 'claude/x', 'team/qa/', 'team/qa/../main', 'team/qa/x.lock']) assert.equal(branchFor({ data: { branch: b } }, 'qa', 'run_1'), 'team/qa/run_1', b);

    // A refused call: 422 with the problems, a session.tool event and an audit row; no message.
    const bad = await tool(p.call, web, 'handoff', { to: 'web-dev' });
    assert.equal(bad.status, 422);
    assert.ok(bad.body.problems.some((x) => /yourself/.test(x)));
    const refused = (await p.call('GET', '/teams/shop/events?type=session.tool')).body.events;
    assert.deepEqual([refused[0].data.decision, refused[0].actor.id], ['refused', 'web-dev']);
    const [{ n }] = await p.db.system("select count(*)::int as n from audit where action = 'tool' and decision = 'refused'");
    assert.equal(n, 1);
    assert.equal((await tool(p.call, web, 'ask_owner', { question: 'q', options: [], recommended: 'a' })).status, 403, 'only the front door asks the owner');
    assert.equal((await p.call('POST', `/sessions/${web.session}/tools/report`, { status: 'idle' }, { authorization: `Bearer ${front.token}` })).status, 401, 'a token works only for its session');
  }, { tickMs: 0 });
});

test('D6: a session token is refused on every person endpoint', async () => {
  await plane(async (p) => {
    const { runner, run } = await setup(p);
    await p.call('POST', '/teams/shop/chat', { text: 'go' });
    const s = (await start(runner, 'chief-of-staff')).body;
    const h = { authorization: `Bearer ${s.token}` };
    for (const [m, path, body] of [['POST', '/approvals/apr_x', { decision: 'approved' }], ['POST', '/cards/card_x', { option: 'a', version: 1 }], ['POST', `/runs/${run.id}/resume`],
      ['PUT', '/teams/shop/budget', { perDay: 10 ** 6 }], ['POST', '/auth/step-up', { secret: 'x'.repeat(20) }], ['GET', '/me/inbox'], ['POST', '/teams/shop/chat', { text: 'hi' }]]) {
      assert.equal((await p.call(m, path, body, h)).status, 403, `${m} ${path}`);
    }
  }, { tickMs: 0 });
});

test('D1: an accept approval needs pr and headSha, and approval.result carries the approved head', async () => {
  await plane(async (p) => {
    const { runner } = await setup(p);
    await p.call('POST', '/teams/shop/chat', { text: 'go' });
    const s = (await start(runner, 'chief-of-staff')).body;
    const ask = { action: 'accept', call: 'gh pr merge 7 --match-head-commit abc1234 token=ghp_abcdefghijklmnopqrstuvwxyz0123', why: 'tests pass' };
    assert.equal((await tool(p.call, s, 'request_approval', ask)).status, 422);
    const r = await tool(p.call, s, 'request_approval', { ...ask, pr: 7, headSha: 'abc1234' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const [a] = await p.db.system('select call from approvals where id = $1', [r.body.approval]);
    assert.deepEqual([a.call.pr, a.call.headSha], [7, 'abc1234']);
    assert.ok(!a.call.command.includes('ghp_'), 'a token in the command is redacted before it is stored');
    const ok = await p.call('POST', `/approvals/${r.body.approval}`, { decision: 'approved', version: 1 }, await p.su());
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const res = await runner.next((f) => f.op === 'approval.result');
    assert.deepEqual([res.body.approval, res.body.decision, res.body.headSha], [r.body.approval, 'approved', 'abc1234']);
  }, { tickMs: 0 });
});

test('runner ops: the allowlist, own sessions only, the server sets the actor, renew, and approval.wait resends', async () => {
  await plane(async (p) => {
    const { runner } = await setup(p);
    await p.call('POST', '/teams/shop/chat', { text: 'go' });
    const s = (await start(runner, 'chief-of-staff')).body;
    const env = (type, data, extra = {}) => ({ specversion: '1.0', id: `ev_${Math.random().toString(36).slice(2)}`, type, version: 1, source: '/tenants/acme/teams/shop', tenant: 'acme', team: 'shop', time: new Date().toISOString(), actor: { kind: 'role', id: 'qa', session: s.session }, data, ...extra });

    assert.equal((await runner.request('events', { events: [env('message.handoff', { to: 'web-dev' })] })).op, 'nack', 'a runner key may not send messages: they go through the tools');
    const idle = env('session.idle', { role: 'chief-of-staff' });
    assert.equal((await runner.request('events', { events: [idle] })).op, 'ack');
    const [stored] = (await p.call('GET', '/teams/shop/events?type=session.idle')).body.events;
    assert.deepEqual([stored.actor.id, stored.actor.session], ['chief-of-staff', s.session], 'the actor is the session the runner runs, not what the frame said');
    const [row] = await p.db.system('select state from sessions where id = $1', [s.session]);
    assert.equal(row.state, 'idle');
    assert.equal((await runner.request('events', { events: [env('session.idle', {}, { actor: { kind: 'role', id: 'x', session: 'ses_other' } })] })).op, 'nack', 'not a session this runner runs');
    assert.equal((await runner.request('events', { events: [env('proposal.opened', { pr: 3 })] })).op, 'ack');
    assert.equal((await runner.request('events', { events: [env('chat.message', { text: 'On it.' })] })).op, 'ack', 'the front door may speak in the chat');
    const chat = (await p.call('GET', '/teams/shop/chat')).body.items.filter((e) => e.type === 'chat.message').at(-1);
    assert.deepEqual([chat.data.from, chat.data.text], ['chief-of-staff', 'On it.']);

    // session.renew: an ack, then a session.token frame with a token that works.
    assert.equal((await runner.request('session.renew', { session: s.session })).op, 'ack');
    const tok = await runner.next((f) => f.op === 'session.token');
    assert.equal((await tool(p.call, { session: s.session, token: tok.body.token }, 'report', { status: 'working', task: 'Cart' })).status, 200);

    // approval.wait, then a resend after a reconnect: same ids, no second card.
    const w = await runner.request('approval.wait', { session: s.session, approval: { action: 'deploy', call: 'vercel deploy --prod', why: 'release' } });
    assert.equal(w.op, 'ack');
    assert.match(w.body.approval, /^apr_/);
    const again = await runner.request('approval.wait', { session: s.session, approval: { id: w.body.approval }, resend: true });
    assert.deepEqual([again.body.approval, again.body.card], [w.body.approval, w.body.card]);
    const [{ n }] = await p.db.system("select count(*)::int as n from cards where kind = 'approval'");
    assert.equal(n, 1);
    await p.call('POST', `/approvals/${w.body.approval}`, { decision: 'denied', version: 1 });
    await runner.next((f) => f.op === 'approval.result' && f.body.decision === 'denied');
    const before = runner.frames.filter((f) => f.op === 'approval.result').length;
    await runner.request('approval.wait', { session: s.session, approval: { id: w.body.approval }, resend: true });
    await waitFor(() => runner.frames.filter((f) => f.op === 'approval.result').length > before);
  }, { tickMs: 0 });
});

test('pause checkpoints then stops live sessions; messages while paused are held and go out on resume', async () => {
  await plane(async (p) => {
    const { runner, run } = await setup(p);
    await p.call('POST', '/teams/shop/chat', { text: 'go' });
    const s = (await start(runner, 'chief-of-staff')).body;
    assert.equal((await p.call('POST', `/runs/${run.id}/pause`)).status, 200);
    await runner.next((f) => f.op === 'session.checkpoint' && f.body.session === s.session);
    const stop = await runner.next((f) => f.op === 'session.stop');
    assert.equal(stop.body.mode, 'finish-step');
    await waitFor(async () => (await p.db.system('select checkpoint from sessions where id = $1', [s.session]))[0].checkpoint?.commit === 'c0ffee1');
    await p.call('POST', '/teams/shop/chat', { text: 'while paused' });
    await waitFor(async () => (await p.db.system("select state from deliveries order by created_at desc limit 1"))[0].state === 'held');
    assert.equal((await p.call('POST', `/runs/${run.id}/resume`)).status, 200);
    const resumed = await runner.next((f) => f.op === 'session.start' && f.body.resume === true);
    assert.equal(resumed.body.session, s.session);
    assert.equal(resumed.body.checkpoint.commit, 'c0ffee1');
    assert.equal(resumed.body.prompt.memory, '# notes');
    assert.equal(resumed.body.wake.data.text, 'while paused');
    assert.equal((await p.call('POST', `/runs/${run.id}/stop`)).status, 200);
    await runner.next((f) => f.op === 'session.stop' && f.body.mode === 'now');
  }, { tickMs: 0 });
});

test('the session cap queues the next role, and it starts when a session ends', async () => {
  await plane(async (p) => {
    const { runner } = await setup(p, { sessions: 1 });
    await p.call('POST', '/teams/shop/chat', { text: 'go' });
    const front = (await start(runner, 'chief-of-staff')).body;
    await tool(p.call, front, 'handoff', { to: 'web-dev', task: 'Cart', changed: 'x', verify: 'y', doneWhen: 'z' });
    await waitFor(async () => (await p.call('GET', '/teams/shop/events?type=session.queued')).body.events.length === 1);
    const [q] = (await p.call('GET', '/teams/shop/events?type=session.queued')).body.events;
    assert.deepEqual([q.data.role, q.data.position], ['web-dev', 1]);
    assert.ok(!runner.frames.some((f) => f.op === 'session.start' && f.body.role === 'web-dev'));
    await runner.request('events', { events: [{ specversion: '1.0', id: 'end1', type: 'session.ended', version: 1, source: '/tenants/acme/teams/shop', tenant: 'acme', team: 'shop', time: new Date().toISOString(), actor: { kind: 'role', id: 'chief-of-staff', session: front.session }, data: { reason: 'done' } }] });
    await start(runner, 'web-dev');
  }, { tickMs: 0 });
});

test('the tick: unacked deliveries back off, dead ones tell the front door, expired approvals are closed and sent', async () => {
  await plane(async (p) => {
    const { runner, run } = await setup(p);
    await p.call('POST', '/teams/shop/chat', { text: 'go' });
    const s = (await start(runner, 'chief-of-staff')).body;
    // A delivery to web-dev that was sent ten times without an ack.
    const [{ id: ev }] = await p.db.system("select id from events where type = 'chat.message' limit 1");
    await p.db.tenant('acme', ({ q }) => q("insert into deliveries(id, tenant, team, event, run, role, state, attempts, next_at) values ('dlv_dead', 'acme', 'shop', $1, $2, 'web-dev', 'sent', 10, now() - interval '1 minute')", [ev, run.id]));
    await p.db.tenant('acme', ({ q }) => q("insert into deliveries(id, tenant, team, event, run, role, state, attempts, next_at) values ('dlv_retry', 'acme', 'shop', $1, $2, 'qa', 'sent', 1, now() - interval '1 minute')", [ev, run.id]));
    // An approval past its expiry, from this session.
    const { result } = await p.m3.tx('acme', (ctx) => p.m3.requestApproval(ctx, 'shop', { action: 'deploy', call: 'x', why: 'y', session: s.session, run: run.id, role: 'chief-of-staff', hours: -1 }));
    await p.server.bus.tick();
    const rows = Object.fromEntries((await p.db.system('select id, state, attempts from deliveries')).map((r) => [r.id, r]));
    assert.equal(rows.dlv_dead.state, 'dead');
    assert.ok(['pending', 'sent', 'acked'].includes(rows.dlv_retry.state), 'one try is sent again later');
    const blocked = (await p.call('GET', '/teams/shop/events?type=message.blocked')).body.events;
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].data.to, 'chief-of-staff');
    const [a] = await p.db.system('select state from approvals where id = $1', [result.approval]);
    assert.equal(a.state, 'expired');
    assert.equal((await p.call('GET', `/cards/${result.card.id}`)).body.state, 'expired');
    await runner.next((f) => f.op === 'approval.result' && f.body.decision === 'expired');
    assert.ok(!(await p.call('GET', '/me/inbox')).body.cards.some((c) => c.id === result.card.id), 'the inbox no longer shows it');
  }, { tickMs: 0 });
});

test('D8: /internal/tick is refused without CRON_SECRET and checks it', async () => {
  await plane(async ({ call }) => {
    assert.equal((await call('POST', '/internal/tick', undefined, {})).status, 404);
  }, { tickMs: 0, cronSecret: null });
  await plane(async ({ call }) => {
    assert.equal((await call('POST', '/internal/tick', undefined, { authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await call('POST', '/internal/tick', undefined, { authorization: 'Bearer a-cron-secret' })).status, 200);
  }, { tickMs: 0, cronSecret: 'a-cron-secret' });
});

async function waitFor(fn, ms = 5000) {
  const until = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}
