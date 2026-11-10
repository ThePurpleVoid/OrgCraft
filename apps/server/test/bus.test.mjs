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
  return { runner, run: run.body, runnerId: r.id, key: r.key };
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
    assert.equal((await tool(p.call, s, 'request_approval', { ...ask, pr: 7, headSha: 'abc1234' })).status, 422, 'a short sha is refused: the merge is bound to the full head');
    const r = await tool(p.call, s, 'request_approval', { ...ask, pr: 7, headSha: 'abc1234'.padEnd(40, '0') });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const card = (await p.call('GET', `/cards/${r.body.card}`)).body;
    assert.equal(card.title, 'chief-of-staff asks to merge #7 at abc1234', 'the person sees the PR and the head they approve');
    assert.ok(card.links.some((l) => l.url === 'https://github.com/example/shop/pull/7'));
    // QA (M3 exit pass A): the body is the role's words; the held call is data, for the client to show as code.
    assert.equal(card.body, 'tests pass\n\nIt will merge pull request #7 at commit abc1234.');
    assert.equal(typeof card.data.call, 'string');
    assert.ok(!card.data.call.includes('ghp_'), 'the card shows the redacted call');
    const [a] = await p.db.system('select call from approvals where id = $1', [r.body.approval]);
    assert.deepEqual([a.call.pr, a.call.headSha], [7, 'abc1234'.padEnd(40, '0')]);
    assert.ok(!a.call.command.includes('ghp_'), 'a token in the command is redacted before it is stored');
    const ok = await p.call('POST', `/approvals/${r.body.approval}`, { decision: 'approved', version: 1 }, await p.su());
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const res = await runner.next((f) => f.op === 'approval.result');
    // The policy path is bound the same way.
    const nope = await runner.request('approval.wait', { session: s.session, approval: { action: 'accept', call: 'gh pr merge 7', why: 'green' } });
    assert.equal(nope.op, 'nack');
    const yes = await runner.request('approval.wait', { session: s.session, approval: { action: 'accept', call: 'gh pr merge 7', why: 'green', pr: 7, headSha: 'def5678'.padEnd(40, '0') } });
    assert.equal(yes.op, 'ack');
    assert.deepEqual([res.body.approval, res.body.decision, res.body.headSha], [r.body.approval, 'approved', 'abc1234'.padEnd(40, '0')]);
  }, { tickMs: 0 });
});

test('D1: proposal.failed head-moved supersedes the approval and asks nothing itself (the runner asks again)', async () => {
  await plane(async (p) => {
    const { runner } = await setup(p);
    await p.call('POST', '/teams/shop/chat', { text: 'go' });
    const s = (await start(runner, 'chief-of-staff')).body;
    const head = 'abc1234'.padEnd(40, '0');
    const r = await tool(p.call, s, 'request_approval', { action: 'accept', call: 'merge #7', why: 'tests pass', pr: 7, headSha: head });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await p.call('POST', `/approvals/${r.body.approval}`, { decision: 'approved', version: 1 }, await p.su())).status, 200);
    await runner.next((f) => f.op === 'approval.result');
    const failed = { specversion: '1.0', id: 'ev_failed_1', type: 'proposal.failed', version: 1, source: '/tenants/acme/teams/shop', tenant: 'acme', team: 'shop', time: new Date().toISOString(), actor: { kind: 'role', id: 'chief-of-staff', session: s.session }, data: { connector: 'github', ref: 7, branch: 'x', headSha: head, approval: r.body.approval, reason: 'head-moved' } };
    assert.equal((await runner.request('events', { events: [failed] })).op, 'ack');
    const rows = await p.db.system("select id, state from approvals where session = $1", [s.session]);
    assert.deepEqual(rows.map((a) => [a.id, a.state]), [[r.body.approval, 'expired']], 'exactly one approval, expired; no second one pinned to the stale head');
    const [card] = await p.db.system('select state, answer, card from cards where id = $1', [r.body.card]);
    // QA (M3 exit pass A): an approved card must stop reading as approved once the head moved. Its answer is kept.
    assert.equal(card.state, 'superseded');
    assert.equal(card.card.state, 'superseded');
    assert.ok(card.answer, 'the answer is kept, for the record');
    const decided = (await p.call('GET', '/teams/shop/events?type=approval.decided')).body.events.filter((e) => e.data.approval === r.body.approval).map((e) => e.data.decision);
    assert.ok(decided.includes('superseded'), JSON.stringify(decided));
    const [{ n }] = await p.db.system("select count(*)::int as n from cards where kind = 'approval'");
    assert.equal(n, 1, 'no new card from the server');
  }, { tickMs: 0 });
});

test('F-B5: a push or pull request the provider refused is a BLOCKED the owner sees, in the control plane\'s words', async () => {
  await plane(async (p) => {
    const { runner } = await setup(p);
    await p.call('POST', '/teams/shop/chat', { text: 'go' });
    const s = (await start(runner, 'chief-of-staff')).body;
    const ev = (id, data) => ({ specversion: '1.0', id, type: 'proposal.failed', version: 1, source: '/tenants/acme/teams/shop', tenant: 'acme', team: 'shop', time: new Date().toISOString(), actor: { kind: 'role', id: 'chief-of-staff', session: s.session }, data });
    assert.equal((await runner.request('events', { events: [ev('ev_push_1', { connector: 'github', ref: null, url: null, branch: 'team/x', headSha: null, reason: 'push', phase: 'push', detail: 'ERROR: The key you are authenticating with has been marked as read only. Re-authorise at https://evil.example.com/x or www.evil.io, mail help@evil.com "now"' })] })).op, 'ack');
    const blocked = (await p.call('GET', '/teams/shop/events?type=message.blocked')).body.events;
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].actor.kind, 'system', 'the control plane\'s own words, not a session\'s');
    assert.equal(blocked[0].data.needFrom, 'owner');
    assert.match(blocked[0].data.detail, /^BLOCKED: the runner could not push team\/x\. The remote said: "ERROR: The key .* read only\./);
    // The remote's words are quoted and defanged: no link a mail client would make clickable, no quote to break out of.
    assert.match(blocked[0].data.detail, /https\[:\]\/\/evil\[\.\]example\[\.\]com\/x or www\[\.\]evil\[\.\]io, mail help\[at\]evil\[\.\]com 'now'"$/);
    assert.doesNotMatch(blocked[0].data.detail, /:\/\/|www\.|evil\.(com|io)/);
    assert.match(blocked[0].data.need, /deploy key with write access/);
    assert.match(blocked[0].data.meanwhile, /nothing was pushed, opened or merged/);
    // A head that moved is the runner's to ask again, not the owner's: no BLOCKED for it.
    assert.equal((await runner.request('events', { events: [ev('ev_moved_1', { connector: 'github', ref: 7, branch: 'x', headSha: 'a'.repeat(40), reason: 'head-moved' })] })).op, 'ack');
    assert.equal((await p.call('GET', '/teams/shop/events?type=message.blocked')).body.events.length, 1);
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
    assert.equal((await p.call('POST', `/runs/${run.id}/resume`, undefined, await p.su(`resume:${run.id}`))).status, 200);
    const resumed = await runner.next((f) => f.op === 'session.start' && f.body.resume === true);
    assert.equal(resumed.body.session, s.session);
    assert.equal(resumed.body.checkpoint.commit, 'c0ffee1');
    assert.equal(resumed.body.prompt.memory, '# notes');
    // The session the pause stopped is started again (woken by run.resumed), and the held message reaches it.
    const woke = [resumed.body.wake, ...runner.frames.filter((f) => f.op === 'session.message').map((f) => f.body.message)];
    await waitFor(() => [resumed.body.wake, ...runner.frames.filter((f) => f.op === 'session.message').map((f) => f.body.message)].some((e) => e.data?.text === 'while paused'));
    assert.ok(['run.resumed', 'chat.message'].includes(woke[0].type));
    assert.equal((await p.call('POST', `/runs/${run.id}/stop`)).status, 200);
    await runner.next((f) => f.op === 'session.stop' && f.body.mode === 'now');
  }, { tickMs: 0 });
});

test('a pause with nothing said meanwhile still restarts the session on resume; a resume during the checkpoint keeps it', async () => {
  let slowOnce = false;
  await plane(async (p) => {
    const { runner, run } = await setup(p, { reply: (f) => (f.op === 'session.checkpoint' ? (slowOnce ? { commit: 'c0ffee2' } : null) : {}) });
    await p.call('POST', '/teams/shop/chat', { text: 'go' });
    const s = (await start(runner, 'chief-of-staff')).body;
    // First pause: the runner is slow to checkpoint (no ack yet), and the owner resumes before it answers.
    await p.call('POST', `/runs/${run.id}/pause`);
    const cp = await runner.next((f) => f.op === 'session.checkpoint');
    await p.call('POST', `/runs/${run.id}/resume`, undefined, await p.su(`resume:${run.id}`));
    runner.ws.send(JSON.stringify({ op: 'ack', id: 'late', ref: cp.id, body: { commit: 'c0ffee1' } }));
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!runner.frames.some((f) => f.op === 'session.stop'), 'a resumed run keeps its session');
    const [row] = await p.db.system('select state from sessions where id = $1', [s.session]);
    assert.notEqual(row.state, 'stopped');
    // Second pause runs to the end; the resume restarts the session with nothing new said.
    slowOnce = true;
    await p.call('POST', `/runs/${run.id}/pause`);
    await runner.next((f) => f.op === 'session.stop');
    await waitFor(async () => (await p.db.system('select state from sessions where id = $1', [s.session]))[0].state === 'stopped');
    await p.call('POST', `/runs/${run.id}/resume`, undefined, await p.su(`resume:${run.id}`));
    const again = await runner.next((f) => f.op === 'session.start' && f.body.resume === true);
    assert.deepEqual([again.body.session, again.body.wake.type, again.body.checkpoint.commit], [s.session, 'run.resumed', 'c0ffee2']);
  }, { tickMs: 0 });
});

test('after a budget pause, run.resumed restarts every stopped session from its checkpoint', async () => {
  await plane(async (p) => {
    const { runner, run } = await setup(p);
    await p.call('POST', '/teams/shop/chat', { text: 'go' });
    const front = (await start(runner, 'chief-of-staff')).body;
    await tool(p.call, front, 'handoff', { to: 'web-dev', task: 'Cart', changed: 'x', verify: 'y', doneWhen: 'z' });
    const web = (await start(runner, 'web-dev')).body;
    const usage = { specversion: '1.0', id: 'u-all', type: 'usage.recorded', version: 1, source: '/tenants/acme/teams/shop', tenant: 'acme', team: 'shop', time: new Date().toISOString(), run: run.id, actor: { kind: 'role', id: 'web-dev', session: web.session }, data: { inputTokens: 1, outputTokens: 1, cost: 1000, currency: 'USD' } };
    assert.equal((await runner.request('events', { events: [usage] })).op, 'ack');
    await waitFor(async () => (await p.db.system("select count(*)::int as n from sessions where state = 'stopped'"))[0].n === 2);
    const [card] = (await p.call('GET', '/me/inbox')).body.cards;
    assert.equal((await p.call('POST', `/cards/${card.id}`, { option: 'raise', version: 1 }, await p.su())).status, 200);
    const restarted = await Promise.all(['chief-of-staff', 'web-dev'].map((r) => runner.next((f) => f.op === 'session.start' && f.body.resume === true && f.body.role === r)));
    for (const f of restarted) {
      assert.equal(f.body.wake.type, 'run.resumed');
      assert.equal(f.body.checkpoint.commit, 'c0ffee1');
    }
  }, { tickMs: 0 });
});

test('a chat to a front door whose session ended, or that its runner no longer runs, is not dropped: the session starts again', async () => {
  await plane(async (p) => {
    const { runner } = await setup(p);
    await p.call('POST', '/teams/shop/chat', { text: 'one' });
    const s = (await start(runner, 'chief-of-staff')).body;
    const env = (type, data) => ({ specversion: '1.0', id: `ev_${Math.random().toString(36).slice(2)}`, type, version: 1, source: '/tenants/acme/teams/shop', tenant: 'acme', team: 'shop', time: new Date().toISOString(), actor: { kind: 'role', id: 'chief-of-staff', session: s.session }, data });
    const starts = () => runner.frames.filter((f) => f.op === 'session.start' && f.body.session === s.session).length;
    // Ended, and the server heard it: the next chat starts the session again (a resume).
    assert.equal((await runner.request('events', { events: [env('session.ended', { reason: 'done' })] })).op, 'ack');
    await p.call('POST', '/teams/shop/chat', { text: 'two' });
    await waitFor(async () => starts() === 2);
    const again = runner.frames.filter((f) => f.op === 'session.start' && f.body.session === s.session).at(-1);
    assert.deepEqual([again.body.resume, again.body.wake.data.text], [true, 'two']);
    // Ended on the runner but the server never heard: the message is nacked no-session, and the session starts again.
    assert.equal((await runner.request('events', { events: [env('session.idle', {})] })).op, 'ack');
    const before = runner.frames.length;
    const nackOnce = (f) => {
      if (f.op !== 'session.message' || f.body.session !== s.session) return false;
      runner.ws.send(JSON.stringify({ op: 'nack', id: `n${f.id}`, ref: f.id, body: { problem: 'no session', error: 'no-session' } }));
      return true;
    };
    runner.ws.removeAllListeners('message').on('message', (d) => {
      const f = JSON.parse(String(d)); runner.frames.push(f);
      if (f.op === 'ping') runner.ws.send(JSON.stringify({ op: 'pong', id: `p${f.id}`, ref: f.id, body: { t: f.body.t } }));
      else if (!['ack', 'nack', 'welcome'].includes(f.op) && !nackOnce(f)) runner.ws.send(JSON.stringify({ op: 'ack', id: `a${f.id}`, ref: f.id, body: {} }));
    });
    await p.call('POST', '/teams/shop/chat', { text: 'three' });
    await waitFor(async () => starts() === 3);
    const later = runner.frames.slice(before);
    assert.ok(later.some((f) => f.op === 'session.message' && f.body.session === s.session), 'it was a message first');
    assert.equal(runner.frames.filter((f) => f.op === 'session.start' && f.body.session === s.session).at(-1).body.wake.data.text, 'three', 'started again, woken by the chat');
  }, { tickMs: 0 });
});

test('a session whose runner went quiet is not started a second time elsewhere', async () => {
  await plane(async (p) => {
    const { runner } = await setup(p);
    await p.call('POST', '/teams/shop/chat', { text: 'go' });
    const s = (await start(runner, 'chief-of-staff')).body;
    await p.db.system("update sessions set state = 'unknown' where id = $1", [s.session]);
    await p.call('POST', '/teams/shop/chat', { text: 'still there?' });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(runner.frames.filter((f) => f.op === 'session.start').length, 1);
    const [d] = await p.db.system("select state from deliveries order by created_at desc limit 1");
    assert.equal(d.state, 'pending', 'it waits for the runner, or for the tick to give the session up');
  }, { tickMs: 0 });
});

test('a runner that restarted gets its sessions started again with what woke them; one stopped while it was away is told to stop', async () => {
  await plane(async (p) => {
    const { runner, run, runnerId, key } = await setup(p);
    await p.call('POST', '/teams/shop/chat', { text: 'go' });
    const s = (await start(runner, 'chief-of-staff')).body;
    const state = async () => (await p.db.system('select state from sessions where id = $1', [s.session]))[0].state;
    runner.close();
    await waitFor(async () => (await state()) === 'unknown');
    // Restarted: its hello names none of the sessions it had, so they are not "resumed" on it as ghosts.
    const again = await fakeRunner(p.base, key, { runner: runnerId });
    assert.deepEqual(again.welcome.body.sessions, []);
    const re = await again.next((f) => f.op === 'session.start' && f.body.role === 'chief-of-staff');
    assert.deepEqual([re.body.session, re.body.resume, re.body.wake.data.text], [s.session, true, 'go'], 'started again, woken by what it had not finished');
    // Away again; the run stops meanwhile. Back, still running the session: it is told to stop.
    again.close();
    await waitFor(async () => (await state()) === 'unknown');
    assert.equal((await p.call('POST', `/runs/${run.id}/stop`, {}, await p.su())).status, 200);
    assert.equal(await state(), 'stopped', 'stopped here although its runner was away');
    const third = await fakeRunner(p.base, key, { runner: runnerId, sessions: [s.session] });
    assert.deepEqual(third.welcome.body.sessions, []);
    const stop = await third.next((f) => f.op === 'session.stop' && f.body.session === s.session);
    assert.equal(stop.body.mode, 'now');
    third.close();
  }, { tickMs: 0 });
});

test('a run paused while its runner was away and resumed during the checkpoint: the session is not stopped after all', async () => {
  await plane(async (p) => {
    const { runner, run, runnerId, key } = await setup(p);
    await p.call('POST', '/teams/shop/chat', { text: 'go' });
    const s = (await start(runner, 'chief-of-staff')).body;
    const state = async () => (await p.db.system('select state from sessions where id = $1', [s.session]))[0].state;
    runner.close();
    await waitFor(async () => (await state()) === 'unknown');
    assert.equal((await p.call('POST', `/runs/${run.id}/pause`)).status, 200);
    // The checkpoint is slow: the runner holds its answer while the owner resumes.
    const back = await fakeRunner(p.base, key, { runner: runnerId, sessions: [s.session], reply: (f) => (f.op === 'session.checkpoint' ? null : {}) });
    const cp = await back.next((f) => f.op === 'session.checkpoint' && f.body.session === s.session);
    assert.equal((await p.call('POST', `/runs/${run.id}/resume`, undefined, await p.su(`resume:${run.id}`))).status, 200);
    back.ws.send(JSON.stringify({ op: 'ack', id: 'late-cp', ref: cp.id, body: {} }));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(back.frames.find((f) => f.op === 'session.stop' && f.body.session === s.session && f.body.reason === 'run-paused'), undefined, 'a running run keeps its session');
    back.close();
  }, { tickMs: 0 });
});

test('a run paused while its runner was away: back, the session goes through the pause path (checkpoint, then stop)', async () => {
  await plane(async (p) => {
    const { runner, run, runnerId, key } = await setup(p);
    await p.call('POST', '/teams/shop/chat', { text: 'go' });
    const s = (await start(runner, 'chief-of-staff')).body;
    const row = async () => (await p.db.system('select state, checkpoint from sessions where id = $1', [s.session]))[0];
    runner.close();
    await waitFor(async () => (await row()).state === 'unknown');
    assert.equal((await p.call('POST', `/runs/${run.id}/pause`)).status, 200);
    const back = await fakeRunner(p.base, key, { runner: runnerId, sessions: [s.session], reply: (f) => (f.op === 'session.checkpoint' ? { commit: 'beef123', memory: '# newest' } : {}) });
    const cp = await back.next((f) => f.op === 'session.checkpoint' && f.body.session === s.session);
    const stop = await back.next((f) => f.op === 'session.stop' && f.body.session === s.session);
    assert.ok(back.frames.indexOf(cp) < back.frames.indexOf(stop), 'checkpoint first');
    assert.deepEqual([stop.body.mode, stop.body.reason], ['finish-step', 'run-paused']);
    const r = await row();
    assert.deepEqual([r.state, r.checkpoint.commit, r.checkpoint.memory], ['stopped', 'beef123', '# newest'], 'the resume starts from the newest work');
    back.close();
  }, { tickMs: 0 });
});

test('an approved merge is not let go to the runner while its run is not running, not even on a resend', async () => {
  await plane(async (p) => {
    const { runner, run } = await setup(p);
    await p.call('POST', '/teams/shop/chat', { text: 'go' });
    const s = (await start(runner, 'chief-of-staff')).body;
    const w = await runner.request('approval.wait', { session: s.session, approval: { action: 'accept', call: 'merge pull request 7', why: 'qa signed off', pr: 7, headSha: 'a'.repeat(40) } });
    assert.equal(w.op, 'ack', JSON.stringify(w.body));
    assert.equal((await p.call('POST', `/runs/${run.id}/pause`)).status, 200);
    const results = () => runner.frames.filter((f) => f.op === 'approval.result').length;
    const before = results();
    assert.equal((await p.call('POST', `/approvals/${w.body.approval}`, { decision: 'approved', version: 1 }, await p.su())).status, 200);
    await runner.request('approval.wait', { session: s.session, approval: { id: w.body.approval }, resend: true });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(results(), before, 'held: a paused run merges nothing, whatever the runner does');
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
  const secret = 'a-cron-secret-of-at-least-32-characters';
  await plane(async ({ call }) => {
    assert.equal((await call('POST', '/internal/tick', undefined, { authorization: `Bearer ${secret}` })).status, 200);
    for (let i = 0; i < 10; i++) assert.equal((await call('POST', '/internal/tick', undefined, { authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await call('POST', '/internal/tick', undefined, { authorization: 'Bearer wrong' })).status, 429, 'ten misses a minute and guesses are refused');
    assert.equal((await call('POST', '/internal/tick', undefined, { authorization: `Bearer ${secret}` })).status, 200, 'the real cron is never locked out');
  }, { tickMs: 0, cronSecret: secret });
  await assert.rejects(plane(async () => {}, { tickMs: 0, cronSecret: 'short' }), /at least 32 characters/);
});

async function waitFor(fn, ms = 5000) {
  const until = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('G-12 ready_to_try: front door only, only after a merge, preview from the runner, attached later, "Got it" wakes nobody', async () => {
  await plane(async (p) => {
    const { runner } = await setup(p);
    await p.call('POST', '/teams/shop/chat', { text: 'go' });
    const s = (await start(runner, 'chief-of-staff')).body;
    await tool(p.call, s, 'handoff', { to: 'web-dev', task: 'Dark mode', changed: 'x', verify: 'y', doneWhen: 'z' });
    const web = (await start(runner, 'web-dev')).body;
    const env = (type, data, sess = s, id = `ev_${Math.random().toString(36).slice(2)}`) => ({ specversion: '1.0', id, type, version: 1, source: '/tenants/acme/teams/shop', tenant: 'acme', team: 'shop', time: new Date().toISOString(), actor: { kind: 'role', id: 'x', session: sess.session }, data });
    const ask = { pr: 7, title: 'Dark mode', summary: 'Dark mode follows the system setting.' };

    assert.equal((await tool(p.call, web, 'ready_to_try', ask)).status, 403, 'only the front door tells the owner');
    const forged = env('proposal.accepted', { connector: 'github', ref: 7, url: 'https://evil.example/pull/7', result: 'e'.repeat(40) });
    assert.equal((await p.call('POST', '/teams/shop/events', { events: [forged] })).status, 403, 'an admin cannot post a merge: only the runner says a PR merged');
    const early = await tool(p.call, s, 'ready_to_try', ask);
    assert.equal(early.status, 422, 'not before the PR merged with an approval');
    assert.match(early.body.problems.join(' '), /has not merged/);
    assert.equal((await tool(p.call, s, 'ready_to_try', { pr: 7 })).status, 422, 'a title is required');

    const merge = 'abcdef1'.padEnd(40, '0');
    assert.equal((await runner.request('events', { events: [env('proposal.accepted', { connector: 'github', ref: 7, url: 'https://github.com/example/shop/pull/7', headSha: 'f'.repeat(40), result: merge, approval: 'apr_x' })] })).op, 'ack');
    const r = await tool(p.call, s, 'ready_to_try', ask);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.preview, null);
    let card = (await p.call('GET', `/cards/${r.body.card}`)).body;
    assert.deepEqual([card.kind, card.title, card.subject, card.data.pr, card.data.commit, card.data.preview], ['ready', 'Dark mode', 'ready/7', 7, merge, null]);
    assert.match(card.body, /preview link is not up yet/);
    assert.deepEqual(card.links, [{ rel: 'pull-request', url: 'https://github.com/example/shop/pull/7' }]);
    assert.deepEqual(card.options.map((o) => [o.id, o.stepUp]), [['seen', false]]);
    const posted = (await p.call('GET', '/teams/shop/events?type=ready.posted')).body.events;
    assert.deepEqual([posted.length, posted[0].data.cardId, posted[0].data.commit, posted[0].actor.id], [1, card.id, merge, 'chief-of-staff']);
    const chat = (await p.call('GET', '/teams/shop/events?type=chat.message')).body.events.at(-1);
    assert.match(chat.data.text, /^Dark mode: ready to try\. The preview link follows/);
    assert.deepEqual(chat.data.attachments, [card.url]);

    // The runner's preview: checked, stored once per deployment, and added to the open card.
    const prev = { connector: 'github', ref: 7, sha: merge, url: 'https://shop-git-dark.example.app', environment: 'Preview', state: 'success', deployment: 991 };
    assert.equal((await runner.request('events', { events: [env('proposal.previewed', { ...prev, url: 'http://insecure.example' })] })).op, 'nack', 'only https');
    assert.equal((await runner.request('events', { events: [env('proposal.previewed', { ...prev, state: 'failure' })] })).op, 'nack', 'only a successful deployment');
    assert.equal((await runner.request('events', { events: [env('proposal.previewed', { ...prev, url: 'https://user:pw@evil.example' })] })).op, 'nack', 'no user or password in the link');
    assert.equal((await runner.request('events', { events: [env('proposal.previewed', { ...prev, sha: 'b'.repeat(40) })] })).op, 'nack', 'only the merge commit of the approved merge');
    assert.equal((await runner.request('events', { events: [env('proposal.previewed', { ...prev, sha: undefined })] })).op, 'nack', 'the sha is required');
    assert.equal((await runner.request('events', { events: [env('proposal.previewed', { ...prev, ref: 8 })] })).op, 'nack', 'not for a PR that has not merged');
    assert.equal((await runner.request('events', { events: [env('proposal.previewed', prev)] })).op, 'ack');
    assert.equal((await runner.request('events', { events: [env('proposal.previewed', prev)] })).op, 'ack', 'a repeat is fine');
    assert.equal((await p.call('GET', '/teams/shop/events?type=proposal.previewed')).body.events.length, 1, 'stored once per deployment');
    card = (await p.call('GET', `/cards/${r.body.card}`)).body;
    assert.deepEqual([card.version, card.state, card.data.preview, card.data.environment], [2, 'open', prev.url, 'Preview']);
    assert.equal(card.body, ask.summary, 'the pending line is gone');
    assert.ok(card.links.some((l) => l.rel === 'preview' && l.url === prev.url));
    const pv = (await p.call('GET', '/teams/shop/events?type=ready.previewed')).body.events;
    assert.deepEqual([pv.length, pv[0].data.url, pv[0].data.cardId], [1, prev.url, card.id]);

    // Telling the owner again supersedes the old card, and the new one has the preview at once.
    const again = await tool(p.call, s, 'ready_to_try', { ...ask, title: 'Dark mode, now with contrast fixes' });
    assert.equal(again.body.preview, prev.url);
    assert.equal((await p.call('GET', `/cards/${r.body.card}`)).body.state, 'superseded');
    const inbox = (await p.call('GET', '/me/inbox')).body.cards.filter((c) => c.kind === 'ready');
    assert.deepEqual(inbox.map((c) => c.id), [again.body.card]);

    // "Got it" closes it and wakes nobody (no decision.answered).
    const before = runner.frames.length;
    const got = await p.call('POST', `/cards/${again.body.card}`, { option: 'seen', version: 1 });
    assert.equal(got.status, 200, JSON.stringify(got.body));
    assert.equal(got.body.event, null);
    assert.equal((await p.call('GET', '/teams/shop/events?type=decision.answered')).body.events.length, 0);
    await new Promise((res) => setTimeout(res, 200));
    assert.ok(!runner.frames.slice(before).some((f) => f.op === 'session.message' || f.op === 'session.start'), 'nobody is woken');
  }, { tickMs: 0 });
});

test('session.start carries repo.installations, the GitHub App installations the workspace proved (S9), and only when there are some', async () => {
  const asked = [];
  const installationsFor = async (tenant, url) => { asked.push([tenant, url]); return url.includes('example/shop') ? [42, 7] : []; };
  await plane(async (p) => {
    const { runner } = await setup(p);
    await p.call('POST', '/teams/shop/chat', { text: 'Ship the cart' });
    const f = await start(runner, 'chief-of-staff');
    assert.deepEqual(f.body.repo, { url: 'https://github.com/example/shop.git', ref: 'main', installations: [42, 7] });
    assert.deepEqual(asked[0], ['acme', 'https://github.com/example/shop.git']);
  }, { publicUrl: 'https://plane.example', tickMs: 0, installationsFor });
  await plane(async (p) => {
    const { runner } = await setup(p);
    await p.call('POST', '/teams/shop/chat', { text: 'Ship the cart' });
    const f = await start(runner, 'chief-of-staff');
    assert.deepEqual(f.body.repo, { url: 'https://github.com/example/shop.git', ref: 'main' }, 'left off when none is bound');
  }, { publicUrl: 'https://plane.example', tickMs: 0, installationsFor: async () => [] });
});

test('F-B5: in local mode the operator\'s pinned installation rides session.start, only for the repositories it names', async () => {
  const { installationPin } = await import('../pin.mjs');
  const pin = installationPin({ AGENT_TEAM_GITHUB_INSTALLATION_ID: '5687048' }, { tenant: 'acme' });
  await plane(async (p) => {
    const { runner } = await setup(p);
    await p.call('POST', '/teams/shop/chat', { text: 'Ship the cart' });
    const f = await start(runner, 'chief-of-staff');
    assert.deepEqual(f.body.repo, { url: 'https://github.com/example/shop.git', ref: 'main', installations: [5687048] });
  }, { publicUrl: 'https://plane.example', tickMs: 0, installationsFor: pin.installationsFor });
  // AGENT_TEAM_GITHUB_REPOS leaves any other repository without one, so the runner refuses as it does today.
  const narrow = installationPin({ AGENT_TEAM_GITHUB_INSTALLATION_ID: '5687048', AGENT_TEAM_GITHUB_REPOS: 'example/other' }, { tenant: 'acme' });
  await plane(async (p) => {
    const { runner } = await setup(p);
    await p.call('POST', '/teams/shop/chat', { text: 'Ship the cart' });
    const f = await start(runner, 'chief-of-staff');
    assert.deepEqual(f.body.repo, { url: 'https://github.com/example/shop.git', ref: 'main' });
  }, { publicUrl: 'https://plane.example', tickMs: 0, installationsFor: narrow.installationsFor });
});
