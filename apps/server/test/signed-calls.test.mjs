// What you see is what you sign (ADR 0013 rule 1), the control plane's half (local PR L6; security conditions A to C).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashCalls, callOf } from '../../../packages/calls/index.mjs';
import { approveScope, boundCalls, factsOf } from '../signed.mjs';
import * as store from '../store.mjs';
import { fakeRunner, plane, registerRunner } from './helpers.mjs';

const roster = () => ({
  version: 'abc123', repo: { url: 'https://github.com/example/shop.git', ref: 'main' }, summary: 'A small shop',
  roles: [{ slug: 'chief-of-staff', reportsTo: 'owner', areas: ['docs/**'], brief: 'You are the front door.' }, { slug: 'web-dev', reportsTo: 'chief-of-staff', areas: [] }],
});
async function setup({ call, base, su }) {
  await call('POST', '/teams', { id: 'shop' });
  assert.equal((await call('PUT', '/teams/shop/budget', { perDay: 1000, sessions: 3 }, await su())).status, 200);
  const r = await registerRunner(call);
  const runner = await fakeRunner(base, r.key, { runner: r.id, reply: (f) => (f.op === 'session.checkpoint' ? { commit: 'c0ffee1', memory: '# notes' } : {}) });
  assert.equal((await call('POST', '/teams/shop/runs', { team: roster() })).status, 201);
  await call('POST', '/teams/shop/chat', { text: 'go' });
  const s = (await runner.next((f) => f.op === 'session.start' && f.body.role === 'chief-of-staff')).body;
  return { runner, s };
}
const tool = (call, s, name, input) => call('POST', `/sessions/${s.session}/tools/${name}`, input, { authorization: `Bearer ${s.token}` });
const pay = (to) => ({ tool: 'mcp__bank__pay', input: { amount: 2000, currency: 'USD', to } });

test('boundCalls re-canonicalises, checks the hash, and caps a card at 5 calls', () => {
  const calls = [pay('jane')];
  const h = hashCalls(calls.map((c) => callOf(c.tool, c.input)));
  assert.deepEqual(boundCalls(calls, h).calls, [{ tool: 'mcp__bank__pay', input: { amount: 2000, currency: 'USD', to: 'jane' } }]);
  assert.match(boundCalls([pay('attacker')], h).problem, /does not match/);
  assert.match(boundCalls(Array(6).fill(pay('jane')), h).problem, /1 to 5/);
  assert.match(boundCalls([{ ...pay('jane'), extra: 1 }], h).problem, /tool, input/);
  assert.match(boundCalls([{ tool: 'x', input: { amount: 1.5 } }], h).problem, /whole numbers/);
  assert.equal(boundCalls(undefined, undefined), null, 'no calls named: a decision, not a call');
  // A Bash note (description) is not part of what is signed; the facts show the command alone.
  const bash = boundCalls([{ tool: 'Bash', input: { command: 'rm -rf build', description: 'tidy up' } }], hashCalls([{ tool: 'Bash', input: { command: 'rm -rf build' } }]));
  assert.deepEqual(factsOf(bash.calls), [{ tool: 'Bash', text: 'Run: rm -rf build' }]);
});

test('condition A: a duplicate key shows what is signed, never the raw call text; the role\'s risk is ignored', async () => {
  await plane(async (p) => {
    const { s } = await setup(p);
    // The role writes "to: jane" first; JSON.parse keeps the last one, so "attacker" is what would be signed and run.
    const raw = '{"tool":"mcp__bank__pay","input":{"amount":2000,"currency":"USD","to":"jane","to":"attacker"}}';
    const calls = [JSON.parse(raw)];
    const callsHash = hashCalls(calls.map((c) => callOf(c.tool, c.input)));
    const bad = await tool(p.call, s, 'request_approval', { action: 'payment', call: raw, why: 'Refund $20 to Jane', risk: 'low', calls, callsHash: hashCalls([callOf(pay('jane').tool, pay('jane').input)]) });
    assert.equal(bad.status, 422, 'a hash that is not the calls\' own is refused');
    const r = await tool(p.call, s, 'request_approval', { action: 'payment', call: raw, why: 'Refund $20 to Jane', risk: 'low', calls, callsHash });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const card = (await p.call('GET', `/cards/${r.body.card}`)).body;
    assert.equal(card.data.call, undefined, 'the raw call text is never on a bound card');
    assert.equal(card.data.callsHash, callsHash);
    assert.deepEqual(card.data.facts, [{ tool: 'mcp__bank__pay', text: 'mcp__bank__pay {"amount":2000,"currency":"USD","to":"attacker"}' }], 'the facts are what is signed');
    assert.equal(card.body, 'Refund $20 to Jane', 'the role\'s words sit only under why');
    assert.equal(card.risk, 'high', 'risk is the server\'s: bound calls without a facts map are high, whatever the role said');
    const [a] = await p.db.system('select calls, calls_hash from approvals where id = $1', [r.body.approval]);
    assert.deepEqual([a.calls[0].input.to, a.calls_hash], ['attacker', callsHash]);
    // An old-style card (no calls): normal risk, whatever the role said.
    const old = await tool(p.call, s, 'request_approval', { action: 'deploy', call: 'deploy prod', why: 'release', risk: 'low' });
    assert.equal((await p.call('GET', `/cards/${old.body.card}`)).body.risk, 'medium');
  }, { tickMs: 0 });
});

test('the step-up is bound to the card version and the calls, and approval.result echoes the hash (conditions B, C)', async () => {
  await plane(async (p) => {
    const { runner, s } = await setup(p);
    const calls = [pay('jane')];
    const callsHash = hashCalls(calls);
    const r = await tool(p.call, s, 'request_approval', { action: 'payment', call: 'pay jane', why: 'refund', calls, callsHash });
    const apr = r.body.approval;
    const ask = await p.call('POST', `/approvals/${apr}`, { decision: 'approved', version: 1 });
    const want = approveScope({ tenant: 'acme', team: 'shop', approval: apr, version: 1, callsHash });
    assert.deepEqual([ask.status, ask.body.type, ask.body.scope], [401, 'step-up-required', want], 'the answer names the scope to step up for');
    assert.equal((await p.call('POST', `/approvals/${apr}`, { decision: 'approved', version: 1 }, await p.su())).status, 401, 'an unscoped step-up cannot approve a bound card');
    // The card moves to v2 (it changed after the passkey prompt opened): a step-up for v1 no longer approves it.
    const v1 = await p.su(want);
    await p.db.system("update cards set version = 2, card = jsonb_set(card, '{version}', '2') where id = $1", [r.body.card]);
    assert.equal((await p.call('POST', `/approvals/${apr}`, { decision: 'approved', version: 2 }, v1)).status, 401, 'a step-up for v1 cannot approve v2');
    const v2 = approveScope({ tenant: 'acme', team: 'shop', approval: apr, version: 2, callsHash });
    const ok = await p.call('POST', `/approvals/${apr}`, { decision: 'approved', version: 2 }, await p.su(v2));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const res = await runner.next((f) => f.op === 'approval.result');
    assert.deepEqual([res.body.approval, res.body.decision, res.body.callsHash], [apr, 'approved', callsHash]);
    const [audit] = await p.db.system("select detail from audit where action = 'approval' and target = $1 and decision = 'approved'", [apr]);
    assert.equal(audit.detail.callsHash, callsHash);
    // The policy path: a held call is bound too, and a resend echoes the hash.
    const bad = await runner.request('approval.wait', { session: s.session, approval: { action: 'payment', call: 'x', why: 'held', calls, callsHash: 'f'.repeat(64) } });
    assert.equal(bad.op, 'nack', 'a held call whose hash is not its own is refused');
    const held = await runner.request('approval.wait', { session: s.session, approval: { action: 'payment', call: 'x', why: 'held', calls, callsHash } });
    assert.equal(held.op, 'ack');
    const card = (await p.call('GET', `/cards/${held.body.card}`)).body;
    assert.equal(card.data.callsHash, callsHash);
    const scope = approveScope({ tenant: 'acme', team: 'shop', approval: held.body.approval, version: 1, callsHash });
    assert.equal((await p.call('POST', `/approvals/${held.body.approval}`, { decision: 'approved', version: 1 }, await p.su(scope))).status, 200);
    const again = await runner.next((f) => f.op === 'approval.result' && f.body.approval === held.body.approval);
    assert.equal(again.body.callsHash, callsHash);
    await runner.request('approval.wait', { session: s.session, resend: true, approval: { id: held.body.approval } });
    const resent = await runner.next((f) => f.op === 'approval.result' && f.body.approval === held.body.approval && f !== again);
    assert.equal(resent.body.callsHash, callsHash, 'a resend after a reconnect echoes the hash too');
  }, { tickMs: 0 });
});

test('condition C: a step-up minted in one tenant never approves in another, even for the same calls', async () => {
  await plane(async (p) => {
    await store.ensureTenant(p.db, 'globex');
    await store.createTeam(p.db, 'globex', { id: 'news' });
    const calls = [pay('jane')];
    const callsHash = hashCalls(calls);
    const { result } = await p.m3.tx('globex', (ctx) => p.m3.requestApproval(ctx, 'news', { action: 'payment', call: 'pay jane', why: 'refund', bound: { calls, hash: callsHash } }));
    const scope = approveScope({ tenant: 'globex', team: 'news', approval: result.approval, version: 1, callsHash });
    // The same person, the right scope, but the token was minted in acme: globex never sees it.
    const acme = await p.m3.mintStepUp('acme', 'admin', { method: 'test' }, scope);
    await assert.rejects(p.m3.decideApproval('globex', result.approval, { decision: 'approved', version: 1 }, 'admin', { stepUp: acme.token }), (e) => e.status === 401);
    // And a scope computed for acme does not fit globex's card.
    const wrong = await p.m3.mintStepUp('globex', 'admin', { method: 'test' }, approveScope({ tenant: 'acme', team: 'news', approval: result.approval, version: 1, callsHash }));
    await assert.rejects(p.m3.decideApproval('globex', result.approval, { decision: 'approved', version: 1 }, 'admin', { stepUp: wrong.token }), (e) => e.status === 401);
    const right = await p.m3.mintStepUp('globex', 'admin', { method: 'test' }, scope);
    assert.equal((await p.m3.decideApproval('globex', result.approval, { decision: 'approved', version: 1 }, 'admin', { stepUp: right.token })).result.decision, 'approved');
  }, { tickMs: 0 });
});
