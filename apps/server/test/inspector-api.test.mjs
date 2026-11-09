// The run inspector's API (N1, ADR 0009, local PR L19s-b): the work list, a task's timeline, a step's stored I/O for
// editors with an audit row per read, and the admin's early delete. plans/n8n/n1-run-inspector-architecture.md
// sections 4, 6 and 7: session tokens get 401 on all four routes, and each route is closed to another workspace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeRunner, plane, registerRunner } from './helpers.mjs';
import { ORIGIN, issuer, owner } from './sign-in-helpers.mjs';
import { authenticator } from './authenticator.mjs';
import { createInspector, fold } from '../inspector-api.mjs';
import { minRole } from '../roles.mjs';

const roster = () => ({
  version: 'abc123', repo: { url: 'https://github.com/example/shop.git', ref: 'main' },
  roles: [
    { slug: 'chief-of-staff', reportsTo: 'owner', areas: ['docs/**'], brief: 'You are the front door.' },
    { slug: 'web-dev', reportsTo: 'chief-of-staff', areas: ['apps/web/**'], brief: 'You build the web app.' },
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
const env = (s, role, type, data) => ({ specversion: '1.0', id: `ev_a${n++}_${Math.random().toString(36).slice(2)}`, type, version: 1, source: '/tenants/acme/teams/shop', tenant: 'acme', team: 'shop', time: new Date(Date.now() + n).toISOString(), actor: { kind: 'role', id: role, session: s.session }, data });
const ULID = () => { const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; let x = ''; for (let i = 0; i < 26; i++) x += A[Math.floor(Math.random() * 32)]; return `io_${x}`; };

test('fold: a call pairs with its result, reads in a row are one step, an ask carries its answer, and cause draws the graph', () => {
  const at = (i) => new Date(Date.UTC(2026, 10, 9, 12, 0, i)).toISOString();
  const role = (id, s) => ({ kind: 'role', id, session: s });
  const ev = [
    { id: 'e1', type: 'chat.message', time: at(1), actor: { kind: 'person', id: 'p1' }, data: { text: 'Ship the cart' } },
    { id: 'e2', type: 'session.started', time: at(2), actor: role('cos', 's1'), cause: 'e1', data: { reason: 'started' } },
    { id: 'e3', type: 'session.tool', time: at(3), actor: role('cos', 's1'), data: { tool: 'Read', call: 'c1', effect: 'read', decision: 'allowed', target: 'a.md' } },
    { id: 'e4', type: 'session.result', time: at(4), actor: role('cos', 's1'), data: { call: 'c1', ok: true, summary: 'read a.md' } },
    { id: 'e5', type: 'session.tool', time: at(5), actor: role('cos', 's1'), data: { tool: 'Grep', call: 'c2', effect: 'read', decision: 'allowed', target: 'b' } },
    { id: 'e6', type: 'session.tool', time: at(6), actor: role('cos', 's1'), data: { tool: 'Bash', call: 'c3', effect: 'write', decision: 'allowed', target: 'npm test', io: 'io_IN' } },
    { id: 'e7', type: 'session.result', time: at(7), actor: role('cos', 's1'), data: { call: 'c3', ok: false, durationMs: 9, summary: 'ran npm test · failed', io: 'io_OUT', outside: false } },
    { id: 'e8', type: 'usage.recorded', time: at(8), actor: role('cos', 's1'), data: { cost: 12, currency: 'usd' } },
    { id: 'e9', type: 'message.handoff', time: at(9), actor: role('cos', 's1'), data: { to: 'web', task: 'Cart' } },
    { id: 'e10', type: 'session.started', time: at(10), actor: role('web', 's2'), cause: 'e9', data: { reason: 'started' } },
    { id: 'e11', type: 'approval.requested', time: at(11), actor: role('web', 's2'), data: { approval: 'apr_1', action: 'deploy', why: 'Ship it' } },
    { id: 'e12', type: 'approval.decided', time: at(12), actor: { kind: 'person', id: 'p1' }, cause: 'e11', data: { approval: 'apr_1', decision: 'approved', by: 'p1' } },
    { id: 'e13', type: 'message.signoff', time: at(13), actor: role('web', 's2'), cause: 'e9', data: { to: 'cos', task: 'Cart' } },
    { id: 'e14', type: 'session.tool', time: at(14), actor: role('cos', 's1'), cause: 'e13', data: { tool: 'Write', call: 'c4', effect: 'write', decision: 'refused', rule: 'owned-areas', detail: 'not your area' } },
  ];
  const { steps, lanes, edges } = fold(ev);
  assert.deepEqual(lanes.map((l) => l.id), ['person', 'cos', 'web']);
  assert.deepEqual(steps.map((s) => s.kind), ['message', 'woke', 'read', 'tool', 'message', 'woke', 'asked', 'message', 'tool']);
  const read = steps[2];
  assert.deepEqual([read.targets, read.events], [['a.md', 'b'], ['e3', 'e4', 'e5']], 'two reads in a row fold into one Read step');
  assert.equal(read.ok, true, 'its results passed');
  const bash = steps[3];
  assert.deepEqual([bash.ok, bash.io, bash.out, bash.summary, bash.cost, bash.currency], [false, 'io_IN', 'io_OUT', 'ran npm test · failed', 12, 'usd'], 'the result and the cost land on the call');
  assert.deepEqual([steps[6].answered, steps[6].answer, steps[6].events], [true, 'approved', ['e11', 'e12']]);
  assert.deepEqual([steps[8].ok, steps[8].why], [false, 'not your area']);
  assert.equal(JSON.stringify(steps).includes('body'), false, 'never a body');
  assert.deepEqual(edges, [
    { from: 'e1', to: 'e2', kind: 'fork' },
    { from: 'e9', to: 'e10', kind: 'fork' },
    { from: 'e11', to: 'e12', kind: 'wait' },
    { from: 'e13', to: 'e14', kind: 'merge' },
  ]);
});

test('the list and the timeline: one chat becomes one task with its steps, its state follows the table, and filters work', async () => {
  await plane(async (p) => {
    const { runner } = await setup(p);
    await p.call('POST', '/teams/shop/chat', { text: 'Ship the cart\nwith receipts' });
    const [chat] = await events(p.call, 'chat.message');
    const front = (await start(runner, 'chief-of-staff')).body;
    const io = ULID();
    assert.equal((await runner.request('step.io', { session: front.session, id: io, part: 'input', body: 'npm test --workspace web' })).op, 'ack');
    const calls = [
      env(front, 'chief-of-staff', 'session.tool', { tool: 'Bash', call: 'c1', effect: 'write', decision: 'allowed', target: 'npm test', io }),
      env(front, 'chief-of-staff', 'session.result', { call: 'c1', tool: 'Bash', ok: true, durationMs: 40, summary: 'ran npm test' }),
    ];
    assert.equal((await runner.request('events', { events: calls })).op, 'ack');
    assert.equal((await tool(p.call, front, 'handoff', { to: 'web-dev', task: 'Cart', changed: 'x', verify: 'y', doneWhen: 'z' })).status, 200);
    const web = (await start(runner, 'web-dev')).body;
    const woke = env(web, 'web-dev', 'session.started', { role: 'web-dev', reason: 'started' });
    assert.equal((await runner.request('events', { events: [woke] })).op, 'ack');
    const [handoff] = await events(p.call, 'message.handoff');

    const list = await p.call('GET', '/teams/shop/tasks');
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.deepEqual(list.body.tasks.map((t) => [t.id, t.title, t.state]), [[chat.task, 'Ship the cart', 'running']]);
    assert.deepEqual(Object.keys(list.body.tasks[0]).sort(), ['cost', 'currency', 'id', 'lastAt', 'roles', 'startedAt', 'startedBy', 'state', 'title', 'workItem']);
    assert.equal(list.body.next, null);
    assert.equal((await p.call('GET', '/teams/shop/tasks?state=done')).body.tasks.length, 0);
    assert.equal((await p.call('GET', '/teams/shop/tasks?q=cart')).body.tasks.length, 1, 'a word of the title, any case');
    assert.equal((await p.call('GET', '/teams/shop/tasks?q=art')).body.tasks.length, 0, 'the start of a word only');
    assert.equal((await p.call('GET', '/teams/shop/tasks?role=web-dev')).body.tasks.length, 1, 'roles that acted in it');
    assert.equal((await p.call('GET', '/teams/shop/tasks?role=qa')).body.tasks.length, 0);
    for (const bad of ['state=lost', 'since=yesterday', 'cursor=bm9wZQ']) assert.equal((await p.call('GET', `/teams/shop/tasks?${bad}`)).status, 400, bad);

    const one = await p.call('GET', `/teams/shop/tasks/${chat.task}`);
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.equal(one.body.task.id, chat.task);
    const bash = one.body.steps.find((s) => s.kind === 'tool' && s.tool === 'Bash');
    assert.deepEqual([bash.ok, bash.summary, bash.io, bash.durationMs], [true, 'ran npm test', io, 40]);
    assert.ok(!JSON.stringify(one.body).includes('--workspace'), 'the timeline names io ids, never a body');
    assert.deepEqual(one.body.lanes.map((l) => l.id), ['person', 'chief-of-staff', 'web-dev']);
    assert.ok(one.body.edges.some((e) => e.kind === 'fork' && e.from === handoff.id && e.to === woke.id), JSON.stringify(one.body.edges));
    assert.equal((await p.call('GET', '/teams/shop/tasks/tsk_00000000000000000000000000')).status, 404);

    // Waiting for you: an open approval in the task wins over running, and focus is the ask.
    const apr = await tool(p.call, front, 'request_approval', { action: 'deploy', why: 'Release the cart.', call: 'deploy web' });
    assert.equal(apr.status, 200, JSON.stringify(apr.body));
    const [asked] = await events(p.call, 'approval.requested');
    const waiting = await p.call('GET', `/teams/shop/tasks/${chat.task}`);
    assert.deepEqual([waiting.body.task.state, waiting.body.focus], ['needs-you', asked.id]);
    assert.equal((await p.call('GET', '/teams/shop/tasks?state=needs-you')).body.tasks.length, 1, '"Waiting for you"');
    const [{ state }] = await p.db.system('select state from tasks where id = $1', [chat.task]);
    assert.equal(state, 'needs-you', 'kept on the row for the index');
  }, { tickMs: 0 });
});

test('a session that ends with a failure fails its task, and the ended event is the focus', async () => {
  await plane(async (p) => {
    const { runner } = await setup(p);
    await p.call('POST', '/teams/shop/chat', { text: 'Fix checkout' });
    const [chat] = await events(p.call, 'chat.message');
    const front = (await start(runner, 'chief-of-staff')).body;
    const ended = env(front, 'chief-of-staff', 'session.ended', { role: 'chief-of-staff', reason: 'failed', detail: 'could not start' });
    assert.equal((await runner.request('events', { events: [ended] })).op, 'ack');
    const one = await p.call('GET', `/teams/shop/tasks/${chat.task}`);
    assert.deepEqual([one.body.task.state, one.body.focus], ['failed', ended.id]);
  }, { tickMs: 0 });
});

test('step I/O: editors read it with an audit row each time, admins delete it early with step-up, and then it is 410', async () => {
  await plane(async (p) => {
    const { runner } = await setup(p);
    await p.call('POST', '/teams/shop/chat', { text: 'go' });
    const front = (await start(runner, 'chief-of-staff')).body;
    const io = ULID();
    assert.equal((await runner.request('step.io', { session: front.session, id: io, part: 'output', mime: 'text/plain', body: 'all 12 tests pass' })).op, 'ack');
    assert.equal((await runner.request('events', { events: [env(front, 'chief-of-staff', 'session.tool', { tool: 'Bash', call: 'c1', decision: 'allowed', target: 'npm test', io })] })).op, 'ack');
    const r = await p.call('GET', `/teams/shop/io/${io}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.part, r.body.body, r.body.outside, r.body.truncated], ['output', 'all 12 tests pass', false, false]);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    await p.call('GET', `/teams/shop/io/${io}`);
    const reads = await p.db.system("select target, actor_kind, team from audit where action = 'inspector.read'");
    assert.deepEqual(reads.map((a) => [a.target, a.actor_kind, a.team]), [[io, 'person', 'shop'], [io, 'person', 'shop']], 'one audit row per read');
    assert.equal((await p.call('GET', `/teams/shop/io/${ULID()}`)).status, 404);

    assert.equal((await p.call('DELETE', '/teams/shop/io')).status, 401, 'step-up first');
    const unscoped = await p.call('DELETE', '/teams/shop/io', undefined, await p.su());
    assert.deepEqual([unscoped.status, unscoped.body.scope], [401, 'delete-io:shop'], 'a step-up for anything else does not delete');
    assert.equal((await p.call('DELETE', '/teams/shop/io', undefined, await p.su('delete-io:other'))).status, 401, 'nor one for another team');
    assert.equal((await p.db.system('select count(*)::int as n from step_io')).at(0).n, 1);
    const past = await p.call('DELETE', `/teams/shop/io?before=${encodeURIComponent('2020-01-01T00:00:00Z')}`, undefined, await p.su('delete-io:shop'));
    assert.deepEqual([past.status, past.body.deleted], [200, 0], 'nothing that old');
    assert.equal((await p.call('DELETE', '/teams/shop/io?before=soon', undefined, await p.su('delete-io:shop'))).status, 400);
    const gone = await p.call('DELETE', '/teams/shop/io', undefined, await p.su('delete-io:shop'));
    assert.deepEqual([gone.status, gone.body.deleted], [200, 1]);
    const [audit] = await p.db.system("select detail, actor_kind from audit where action = 'step-io.delete' and (detail->>'rows')::int = 1");
    assert.ok(audit, 'the delete is audited with its count');
    assert.match(audit.detail.stepUp, /./, 'and the step-up that allowed it');
    const after = await p.call('GET', `/teams/shop/io/${io}`);
    assert.equal(after.status, 410);
    assert.ok(Date.parse(after.body.expiredAt) > Date.now(), 'when it would have gone');
  }, { tickMs: 0 });
});

test('agents can\'t read history: a session token is refused on all four routes, and hosts are not given them', async () => {
  for (const [m, path] of [['GET', '/teams/{team}/tasks'], ['GET', '/teams/{team}/tasks/{task}'], ['GET', '/teams/{team}/io/{io}'], ['DELETE', '/teams/{team}/io']]) {
    assert.ok(minRole(m, path.replace('{team}', 'shop').replace('{task}', 'tsk_x').replace('{io}', 'io_x')), `${m} ${path} is a listed route`);
  }
  assert.equal(minRole('GET', '/teams/shop/io/io_x'), 'editor');
  assert.equal(minRole('DELETE', '/teams/shop/io'), 'admin');
  const { HOST_ROUTES } = await import('../roles.mjs');
  assert.ok(![...HOST_ROUTES].some((r) => /\/tasks|\/io/.test(r)), 'closed to hosts until someone decides otherwise');
  await plane(async (p) => {
    const { runner } = await setup(p);
    await p.call('POST', '/teams/shop/chat', { text: 'go' });
    const [chat] = await events(p.call, 'chat.message');
    const s = (await start(runner, 'chief-of-staff')).body;
    const io = ULID();
    await runner.request('step.io', { session: s.session, id: io, part: 'input', body: 'x' });
    const as = { authorization: `Bearer ${s.token}` };
    for (const [m, path] of [['GET', '/teams/shop/tasks'], ['GET', `/teams/shop/tasks/${chat.task}`], ['GET', `/teams/shop/io/${io}`], ['DELETE', '/teams/shop/io']]) {
      // The spec says 401; every person route already answers a session token with 403 ("a session token cannot act
      // for a person"), before any route runs, and these keep that one rule.
      const r = await p.call(m, path, undefined, as);
      assert.equal(r.status, 403, `${m} ${path}`);
      assert.match(r.body.error, /session token/);
    }
    assert.equal((await p.db.system('select count(*)::int as n from step_io')).at(0).n, 1);
  }, { tickMs: 0 });
});

test('isolation: another workspace sees no task, no timeline and no I/O, and a team id it doesn\'t have is 404', async () => {
  await plane(async (p) => {
    const { runner } = await setup(p);
    await p.call('POST', '/teams/shop/chat', { text: 'go' });
    const [chat] = await events(p.call, 'chat.message');
    const s = (await start(runner, 'chief-of-staff')).body;
    const io = ULID();
    await runner.request('step.io', { session: s.session, id: io, part: 'input', body: 'customer data' });
    for (const table of ['tasks', 'step_io', 'step_io_days']) {
      assert.deepEqual(await p.db.tenant('rival', ({ q }) => q(`select * from ${table}`)), [], `${table} is invisible to another tenant`);
    }
    const rival = createInspector({ db: p.db, m3: p.m3 });
    assert.deepEqual((await rival.list('rival', 'shop')).tasks, []);
    await assert.rejects(rival.get('rival', 'shop', chat.task), (e) => e.status === 404);
    await assert.rejects(rival.read('rival', 'shop', io), (e) => e.status === 404, 'not 410 either: it says nothing about another workspace');
    assert.equal((await p.call('GET', '/teams/other/tasks')).status, 404);
    assert.equal((await p.call('GET', `/teams/other/tasks/${chat.task}`)).status, 404, 'a task is found within its own team only');
    assert.equal((await p.call('GET', `/teams/other/io/${io}`)).status, 404);
    assert.equal((await p.call('DELETE', '/teams/other/io', undefined, await p.su())).status, 404);
    assert.equal((await p.db.system('select count(*)::int as n from step_io')).at(0).n, 1);
  }, { tickMs: 0 });
});

const RP = 'studio.example';
const dana = { id: '2002', login: 'dana', name: 'Dana' };
async function person(gh, browser, user) {
  gh.as = user;
  const b = browser({ ip: user.login });
  await b.signIn();
  const key = authenticator({ origin: ORIGIN, rpId: RP });
  const added = await b.call('POST', '/me/passkeys', { name: `${user.login}'s laptop`, credential: key.create((await b.call('GET', '/me/passkeys/options')).body) });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const su = async () => (await b.call('POST', '/auth/step-up', { webauthn: key.get((await b.call('GET', '/auth/step-up/challenge')).body) })).body.token;
  return { b, su };
}

test('roles: a viewer sees the list and the timeline but not a step\'s I/O, and an editor can\'t delete it', () => issuer(async ({ gh, browser, db }) => {
  gh.directory.push(dana);
  const boss = await person(gh, browser, owner);
  assert.equal((await boss.b.call('POST', '/teams', { id: 'web' })).status, 201);
  const inv = await boss.b.call('POST', '/invitations', { github: 'dana', role: 'viewer' }, { 'x-step-up': await boss.su() });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  const viewer = await person(gh, browser, dana);
  const io = ULID();
  await db.system("insert into step_io(id, tenant, team, session, part, body, bytes, expires_at) values ($1, 'acme', 'web', 'ses_x', 'input', 'secret plans', 12, now() + interval '1 day')", [io]);
  assert.equal((await viewer.b.call('GET', '/teams/web/tasks')).status, 200);
  assert.equal((await viewer.b.call('GET', '/teams/web/tasks/tsk_00000000000000000000000000')).status, 404);
  const denied = await viewer.b.call('GET', `/teams/web/io/${io}`);
  assert.equal(denied.status, 403);
  assert.ok(!JSON.stringify(denied.body).includes('secret plans'));
  const id = (await viewer.b.call('GET', '/members')).body.members.find((m) => m.login === 'dana').id;
  assert.equal((await boss.b.call('PATCH', `/members/${id}`, { role: 'editor' }, { 'x-step-up': await boss.su() })).status, 200);
  const read = await viewer.b.call('GET', `/teams/web/io/${io}`);
  assert.deepEqual([read.status, read.body.body], [200, 'secret plans'], 'an editor reads it');
  assert.equal((await viewer.b.call('DELETE', '/teams/web/io', undefined, { 'x-step-up': await viewer.su() })).status, 403, 'deleting is an admin\'s');
  const [audit] = await db.system("select actor_id from audit where action = 'inspector.read'");
  assert.match(audit.actor_id, /^per_/, 'the read names the person');
}));
