// Sign-offs tied to a version (governance G1 and G2, local PR L23 server half; plans/governance/governance-spec.md
// sections 1 and 2): the server keeps version, versionKind, unverified and the runner's checks; a push past a sign-off
// makes it stale and wakes the role that signed; a merge is approved only with fresh sign-offs on its pull request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeRunner, plane, registerRunner } from './helpers.mjs';
import { checkTool } from '../tools.mjs';
import { judge } from '../signoffs.mjs';

const A = 'a'.repeat(40), B = 'b'.repeat(40);
const roster = () => ({
  version: 'abc123', repo: { url: 'https://github.com/example/shop.git', ref: 'main' },
  roles: [
    { slug: 'chief-of-staff', reportsTo: 'owner', areas: ['docs/**'], brief: 'You are the front door.' },
    { slug: 'qa', reportsTo: 'chief-of-staff', areas: [], brief: 'You check.' },
    { slug: 'code-reviewer', reportsTo: 'chief-of-staff', areas: [], brief: 'You review.' },
  ],
});
async function setup({ call, base, su }) {
  await call('POST', '/teams', { id: 'shop' });
  assert.equal((await call('PUT', '/teams/shop/budget', { perDay: 1000, sessions: 4 }, await su())).status, 200);
  const r = await registerRunner(call);
  const runner = await fakeRunner(base, r.key, { runner: r.id });
  assert.equal((await call('POST', '/teams/shop/runs', { team: roster() })).status, 201);
  return { runner };
}
const start = (runner, role) => runner.next((f) => f.op === 'session.start' && f.body.role === role);
const tool = (call, s, name, input) => call('POST', `/sessions/${s.session}/tools/${name}`, input, { authorization: `Bearer ${s.token}` });
const events = async (call, type) => (await call('GET', `/teams/shop/events${type ? `?type=${type}` : ''}`)).body.events;
const so = (version, extra = {}) => ({ to: 'chief-of-staff', task: 'Cart', testedOn: 'Chrome 140', walked: 'add to cart, pay', result: 'pass', evidence: ['shots/cart.png'], pr: 7, version, unverified: [], ...extra });
let n = 0;
const env = (s, type, data) => ({ specversion: '1.0', id: `ev_s${n++}_${Math.random().toString(36).slice(2)}`, type, version: 1, source: '/tenants/acme/teams/shop', tenant: 'acme', team: 'shop', time: new Date().toISOString(), actor: { kind: 'role', id: 'chief-of-staff', session: s.session }, data });

/** A front door and a QA session, QA woken by a handoff. */
async function team(p) {
  const { runner } = await setup(p);
  await p.call('POST', '/teams/shop/chat', { text: 'Ship the cart' });
  const front = (await start(runner, 'chief-of-staff')).body;
  assert.equal((await tool(p.call, front, 'handoff', { to: 'qa', task: 'Cart', changed: 'x', verify: 'y', doneWhen: 'z', pr: 7 })).status, 200);
  const qa = (await start(runner, 'qa')).body;
  return { runner, front, qa };
}

test('the tool check: a version is exact (a commit in full), versionKind says what it is, and unverified is kept on every message', () => {
  const ctx = { role: 'qa', roster: ['qa', 'chief-of-staff'] };
  const ok = (input) => { const r = checkTool('signoff', input, ctx); assert.ok(r.input, JSON.stringify(r.problems)); return r.input; };
  const no = (input, re) => { const r = checkTool('signoff', input, ctx); assert.ok(r.problems?.some((x) => re.test(x)), JSON.stringify(r)); };
  assert.equal(ok(so(A)).versionKind, 'commit', 'a full commit id alone is a commit');
  assert.deepEqual(ok(so('reply-881 r2', { versionKind: 'draft' })).version, 'reply-881 r2');
  no(so('abc1234'), /versionKind/);
  no(so('abc1234', { versionKind: 'commit' }), /full commit id/);
  no(so(undefined, { versionKind: 'draft' }), /needs the version/);
  no(so(A, { versionKind: 'build' }), /commit, revision, draft/);
  no(so(A, { unverified: ['x'.repeat(501)] }), /unverified/);
  no(so(A, { unverified: 'none' }), /unverified/);
  const kept = ok(so(A, { unverified: ['Android (only checked on iPhone)'] }));
  assert.deepEqual(kept.unverified, ['Android (only checked on iPhone)']);
  assert.equal(ok({ ...so(A), unverified: undefined }).unverified, undefined, 'left out is "not stated", not none');
  for (const [name, input] of [['handoff', { to: 'chief-of-staff', task: 'x', changed: 'a', verify: 'b', doneWhen: 'c' }], ['bug', { to: 'chief-of-staff', task: 'x', where: 'a', steps: 'b', expected: 'c', actual: 'd', severity: 2, evidence: ['l.txt'] }],
    ['blocked', { task: 'x', need: 'a', needFrom: 'chief-of-staff', meanwhile: 'b' }], ['report', { status: 'working', task: 'x' }]]) {
    assert.deepEqual(checkTool(name, { ...input, unverified: [] }, ctx).input?.unverified, [], name);
  }
  assert.equal(checkTool('signoff', { ...so(A), checks: [{ tool: 'Bash' }] }, ctx).input.checks, undefined, 'checks are never the model\'s input');
});

test('judge: a draft and its revisions go stale the same way as a commit', () => {
  const e = (version, extra = {}) => ({ id: 'ev_1', actor: { kind: 'role', id: 'support-lead' }, data: { version, versionKind: 'draft', result: 'pass', unverified: [], ...extra } });
  assert.equal(judge(e('reply-881 r1'), 'reply-881 r1').fresh, true);
  assert.match(judge(e('reply-881 r1'), 'reply-881 r2').problem, /needs a fresh sign-off from support-lead \(theirs was for reply-881 r1\)/);
  assert.match(judge(e('reply-881 r2', { unverified: ['the tone'] }), 'reply-881 r2').problem, /unchecked items: "the tone"/);
  assert.match(judge(e('reply-881 r2', { unverified: undefined }), 'reply-881 r2').problem, /not stated/);
  assert.match(judge(e('reply-881 r2', { result: 'fail' }), 'reply-881 r2').problem, /did not pass/);
});

test('the server stores version, unverified and the runner\'s checks, and an io in checks must be the session\'s own', async () => {
  await plane(async (p) => {
    const { runner, front, qa } = await team(p);
    const ULID = () => { const C = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; let x = ''; for (let i = 0; i < 26; i++) x += C[Math.floor(Math.random() * 32)]; return `io_${x}`; };
    const mine = ULID(), theirs = ULID();
    assert.equal((await runner.request('step.io', { session: qa.session, id: mine, part: 'output', body: 'ok' })).op, 'ack');
    assert.equal((await runner.request('step.io', { session: front.session, id: theirs, part: 'output', body: 'ok' })).op, 'ack');
    const checks = [{ call: 'c1', tool: 'Bash', effect: 'write', summary: 'ran npm test', at: new Date().toISOString(), io: mine }, { call: 'c2', tool: 'Bash', summary: 'ran x', io: theirs }, { nonsense: true }];
    const r = await tool(p.call, qa, 'signoff', { ...so(A), checks });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const [e] = await events(p.call, 'message.signoff');
    assert.deepEqual([e.data.version, e.data.versionKind, e.data.unverified], [A, 'commit', []]);
    assert.deepEqual(e.data.checks.map((c) => [c.call, c.io ?? null]), [['c1', mine], ['c2', null]], 'another session\'s io is taken off; junk is dropped');
    assert.match(e.data.detail, /Version: a{40}.*Unverified: none/);
    // Posted through the API, a sign-off's checks are the sender's words: dropped.
    const posted = { ...env(front, 'message.signoff', { ...so(A), checks }), actor: { kind: 'role', id: 'qa' } };
    assert.equal((await p.call('POST', '/teams/shop/events', { events: [posted] })).status, 200);
    assert.equal((await events(p.call, 'message.signoff')).find((x) => x.id === posted.id).data.checks, undefined);
  }, { tickMs: 0 });
});

test('acceptance 1 and 2: a push past a sign-off makes it stale once, wakes the signer, and the merge waits for a fresh one', async () => {
  await plane(async (p) => {
    const { runner, front, qa } = await team(p);
    assert.equal((await tool(p.call, qa, 'signoff', so(A))).status, 200);
    const [signed] = await events(p.call, 'message.signoff');

    // The head moves to B: one signoff.stale, however often the runner says so, and QA is woken with it.
    for (let i = 0; i < 2; i++) assert.equal((await runner.request('events', { events: [env(front, 'proposal.updated', { connector: 'github', ref: 7, branch: 'web/cart', headSha: B })] })).op, 'ack');
    const stale = await events(p.call, 'signoff.stale');
    assert.equal(stale.length, 1);
    assert.deepEqual([stale[0].data.signoff, stale[0].data.by, stale[0].data.oldVersion, stale[0].data.newVersion, stale[0].data.pr], [signed.id, 'qa', A, B, 7]);
    assert.match(stale[0].data.detail, /qa's sign-off was for an earlier version \(aaaaaaa\)/);
    const woke = await runner.next((f) => f.op === 'session.message' && f.body.session === qa.session && f.body.message.type === 'signoff.stale');
    assert.equal(woke.body.message.id, stale[0].id);
    // The same head again, or the head the sign-off names, changes nothing.
    assert.equal((await runner.request('events', { events: [env(front, 'proposal.updated', { connector: 'github', ref: 7, headSha: A })] })).op, 'ack');
    assert.equal((await events(p.call, 'signoff.stale')).length, 1);

    // The merge of B: the card shows the stale sign-off and Approve is off; approving is refused with the list.
    const ask = await tool(p.call, front, 'request_approval', { action: 'accept', call: 'merge #7', why: 'ready', pr: 7, headSha: B });
    assert.equal(ask.status, 200, JSON.stringify(ask.body));
    const card = async () => (await p.db.system('select card from cards where id = $1', [ask.body.card]))[0].card;
    let c = await card();
    assert.deepEqual(c.data.signoffs.map((s) => [s.by, s.version, s.fresh]), [['qa', A, false]]);
    assert.equal(c.data.blocked, 'Can\'t ship yet: needs a fresh sign-off from qa (theirs was for aaaaaaa).');
    assert.deepEqual([c.options[0].id, c.options[0].disabled, c.options[1].disabled], ['approve', true, undefined]);
    const refused = await p.call('POST', `/approvals/${ask.body.approval}`, { decision: 'approved', version: c.version }, await p.su());
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.type, 'signoffs');
    assert.deepEqual(refused.body.missing, ['needs a fresh sign-off from qa (theirs was for aaaaaaa)']);
    assert.equal((await p.db.system('select state from approvals where id = $1', [ask.body.approval]))[0].state, 'pending');

    // A partial sign-off on B still blocks; a fresh one with Unverified: none opens the merge, and the card says so.
    assert.equal((await tool(p.call, qa, 'signoff', so(B, { unverified: ['Safari'] }))).status, 200);
    c = await card();
    assert.match(c.data.blocked, /qa's sign-off has unchecked items: "Safari"/);
    assert.equal(c.options[0].disabled, true);
    assert.equal((await tool(p.call, qa, 'signoff', so(B))).status, 200);
    c = await card();
    assert.deepEqual([c.data.signoffs[0].fresh, c.data.blocked, c.options[0].disabled], [true, undefined, undefined]);
    const ok = await p.call('POST', `/approvals/${ask.body.approval}`, { decision: 'approved', version: c.version }, await p.su());
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    // Denying is never gated.
  }, { tickMs: 0 });
});

test('the gate counts every role that signed the pull request: one stale reviewer blocks, a sign-off with no version never counts', async () => {
  await plane(async (p) => {
    const { runner, front, qa } = await team(p);
    assert.equal((await tool(p.call, front, 'handoff', { to: 'code-reviewer', task: 'Cart', changed: 'x', verify: 'y', doneWhen: 'z', pr: 7 })).status, 200);
    const cr = (await start(runner, 'code-reviewer')).body;
    assert.equal((await tool(p.call, qa, 'signoff', so(B))).status, 200);
    assert.equal((await tool(p.call, cr, 'signoff', { ...so(undefined), unverified: [] })).status, 200);
    const ask = await tool(p.call, front, 'request_approval', { action: 'accept', call: 'merge #7', why: 'ready', pr: 7, headSha: B });
    const r = await p.call('POST', `/approvals/${ask.body.approval}`, { decision: 'approved', version: 1 }, await p.su());
    assert.equal(r.status, 409);
    assert.deepEqual(r.body.missing, ['code-reviewer\'s sign-off names no version; it needs to check again and name it']);
    assert.equal((await p.call('POST', `/approvals/${ask.body.approval}`, { decision: 'denied' })).status, 200, 'deny is never gated');
  }, { tickMs: 0 });
});

test('review fixes: only a runner session\'s own sign-off counts, and a revision on a pull request is not compared with its head', async () => {
  await plane(async (p) => {
    const { front, qa } = await team(p);
    assert.equal((await tool(p.call, qa, 'signoff', so(B, { result: 'fail' }))).status, 200);
    // A pass for B posted through the API in QA's name is the sender's word: QA's own failing one still stands.
    const posted = { ...env(front, 'message.signoff', so(B)), actor: { kind: 'role', id: 'qa', session: qa.session, via: 'tool' } };
    assert.equal((await p.call('POST', '/teams/shop/events', { events: [posted] })).status, 200);
    const ask = await tool(p.call, front, 'request_approval', { action: 'accept', call: 'merge #7', why: 'ready', pr: 7, headSha: B });
    let r = await p.call('POST', `/approvals/${ask.body.approval}`, { decision: 'approved', version: 1 }, await p.su());
    assert.deepEqual([r.status, r.body.missing], [409, [`qa's sign-off on bbbbbbb did not pass`]]);
    // A docs revision signed on the same pull request passes or blocks on its own words, never on the head.
    assert.equal((await tool(p.call, qa, 'signoff', so('docs r3', { versionKind: 'revision', unverified: ['the German copy'] }))).status, 200);
    let c = (await p.db.system('select card from cards where id = $1', [ask.body.card]))[0].card;
    assert.match(c.data.blocked, /unchecked items: "the German copy"/, 'the card refreshed from the tool route');
    assert.equal((await tool(p.call, qa, 'signoff', so('docs r3', { versionKind: 'revision' }))).status, 200);
    c = (await p.db.system('select card from cards where id = $1', [ask.body.card]))[0].card;
    assert.deepEqual([c.data.blocked, c.options[0].disabled], [undefined, undefined]);
    r = await p.call('POST', `/approvals/${ask.body.approval}`, { decision: 'approved', version: c.version }, await p.su());
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }, { tickMs: 0 });
});
