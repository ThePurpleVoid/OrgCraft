// L39 (governance G3, ADR 0013 rule 1): "Do it" approves up to five lettered asks at once, each bound to the card
// version the person saw, with one step-up for the set; nothing is recorded when any ask changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { hashCalls, callOf } from '../../../packages/calls/index.mjs';
import { approveScope } from '../signed.mjs';
import { fakeRunner, plane, registerRunner } from './helpers.mjs';

const roster = () => ({
  version: 'abc123', repo: { url: 'https://github.com/example/shop.git', ref: 'main' }, summary: 'A small shop',
  roles: [{ slug: 'chief-of-staff', reportsTo: 'owner', areas: ['docs/**'], brief: 'You are the front door.' }],
});
async function setup({ call, base, su }) {
  await call('POST', '/teams', { id: 'shop' });
  assert.equal((await call('PUT', '/teams/shop/budget', { perDay: 1000, sessions: 3 }, await su())).status, 200);
  const r = await registerRunner(call);
  const runner = await fakeRunner(base, r.key, { runner: r.id });
  assert.equal((await call('POST', '/teams/shop/runs', { team: roster() })).status, 201);
  await call('POST', '/teams/shop/chat', { text: 'go' });
  const s = (await runner.next((f) => f.op === 'session.start' && f.body.role === 'chief-of-staff')).body;
  return { runner, s };
}
const send = (to) => ({ tool: 'mcp__mail__send', input: { to, subject: 'Spring menu', body: 'Hello' } });
/** A bound ask (signed calls) or a plain one; returns the approval id and the card as the person sees it. */
async function ask(p, s, { calls = null, why = 'Please' } = {}) {
  const body = calls
    ? { action: 'send', call: JSON.stringify(calls), why, calls, callsHash: hashCalls(calls.map((c) => callOf(c.tool, c.input))) }
    : { action: 'publish', call: 'publish the spring menu page', why };
  const r = await p.call('POST', `/sessions/${s.session}/tools/request_approval`, body, { authorization: `Bearer ${s.token}` });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { approval: r.body.approval, card: (await p.call('GET', `/cards/${r.body.card}`)).body, callsHash: body.callsHash ?? null };
}
const seen = (...xs) => xs.map((x) => ({ approval: x.approval, version: x.card.version }));
const doItScope = (scopes) => `do-it:${createHash('sha256').update(['do-it/1', ...[...scopes].sort()].join('\n')).digest('hex')}`;

test('asks are lettered A to E per team; Do it approves the ones shown with one step-up for the set, one ledger row each', async () => {
  await plane(async (p) => {
    const { runner, s } = await setup(p);
    const a = await ask(p, s, { calls: [send('dana@example.com')], why: 'Send the menu to Dana' });
    const b = await ask(p, s, { why: 'Publish the page' });
    const c = await ask(p, s, { why: 'Publish the other page' });
    assert.deepEqual([a.card.data.letter, b.card.data.letter, c.card.data.letter], ['A', 'B', 'C']);

    // No step-up: the 401 names the one scope that covers exactly these asks.
    const none = await p.call('POST', '/approvals/do-it', { asks: seen(a, b) });
    assert.equal(none.status, 401);
    const scope = doItScope([approveScope({ tenant: 'acme', team: 'shop', approval: a.approval, version: a.card.version, callsHash: a.callsHash }), `ask:${b.approval}@${b.card.version}`]);
    assert.equal(none.body.scope, scope);
    assert.match(none.body.error, /covers A/);
    // A's own approve step-up is not the set's.
    const single = approveScope({ tenant: 'acme', team: 'shop', approval: a.approval, version: a.card.version, callsHash: a.callsHash });
    assert.equal((await p.call('POST', '/approvals/do-it', { asks: seen(a, b) }, await p.su(single))).status, 401);
    // A token for this set can't be spent on another set (A, B and C).
    assert.equal((await p.call('POST', '/approvals/do-it', { asks: seen(a, b, c) }, await p.su(scope))).status, 401);

    const ok = await p.call('POST', '/approvals/do-it', { asks: seen(a, b) }, await p.su(scope));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.decided.map((x) => [x.letter, x.approval, x.decision]), [['A', a.approval, 'approved'], ['B', b.approval, 'approved']]);
    assert.equal((await runner.next((f) => f.op === 'approval.result' && f.body.approval === a.approval)).body.decision, 'approved');
    assert.equal((await p.call('GET', `/cards/${c.card.id}`)).body.state, 'open', 'C was not shown in the tap: it stays open');

    const ledger = (await p.call('GET', '/teams/shop/ledger')).body.items.filter((x) => x.approval);
    const mine = ledger.filter((x) => [a.approval, b.approval].includes(x.approval));
    assert.deepEqual(mine.map((x) => [x.letter, x.words, x.channel]).sort(), [['A', 'Tapped "Do it" (A)', 'approvals'], ['B', 'Tapped "Do it" (B)', 'approvals']]);
    // A and B are answered, so the next ask takes the first free letter.
    assert.equal((await ask(p, s, { why: 'One more' })).card.data.letter, 'A');
  });
});

test('Do it records nothing when an ask changed, was answered or has no letter; typed "do it" from chat keeps the words', async () => {
  await plane(async (p) => {
    const { s } = await setup(p);
    const asks = [];
    for (let i = 0; i < 6; i++) asks.push(await ask(p, s, { why: `Publish page ${i}` }));
    assert.deepEqual(asks.map((x) => x.card.data.letter ?? null), ['A', 'B', 'C', 'D', 'E', null], 'a sixth open ask waits for a letter');
    assert.equal((await p.call('POST', '/approvals/do-it', { asks: seen(...asks) })).status, 400, 'at most five');
    // An unlettered ask, a stale version, or one already answered fails the whole tap.
    const f = await p.call('POST', '/approvals/do-it', { asks: seen(asks[0], asks[5]) });
    assert.deepEqual([f.status, f.body.type], [409, 'asks-changed']);
    const old = await p.call('POST', '/approvals/do-it', { asks: [{ approval: asks[0].approval, version: asks[0].card.version }, { approval: asks[1].approval, version: asks[1].card.version - 1 }] });
    assert.deepEqual([old.status, old.body.type, old.body.cards.length], [409, 'asks-changed', 1]);
    assert.equal((await p.call('GET', `/cards/${asks[0].card.id}`)).body.state, 'open', 'nothing was approved');
    assert.equal((await p.call('POST', `/approvals/${asks[1].approval}`, { decision: 'denied', version: asks[1].card.version })).status, 200);
    assert.equal((await p.call('POST', '/approvals/do-it', { asks: seen(asks[0], asks[1]) })).status, 409);
    assert.equal((await p.call('POST', '/approvals/do-it', { asks: [{ approval: asks[0].approval }] })).status, 400, 'the version you saw is required');

    const typed = await p.call('POST', '/approvals/do-it', { asks: seen(asks[0], asks[2]), via: 'chat', words: 'do it' });
    assert.equal(typed.status, 200, 'no bound ask: no step-up, as for one approval');
    const items = (await p.call('GET', '/teams/shop/ledger')).body.items.filter((x) => [asks[0].approval, asks[2].approval].includes(x.approval));
    assert.deepEqual(items.map((x) => [x.words, x.channel]).sort(), [['do it (A)', 'chat'], ['do it (C)', 'chat']]);
  });
});
