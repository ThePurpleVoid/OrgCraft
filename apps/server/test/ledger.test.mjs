// L22 (ADR 0013, R11.2, R11.3 Now): the ledger keeps the person's words; standing rules cover signed calls within
// their limits and never what they must not; declines stick; a changed call raises a new card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashCalls, callOf } from '../../../packages/calls/index.mjs';
import { approveScope } from '../signed.mjs';
import { formHash, ruleForm, ruleLine } from '../ledger.mjs';
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
const refund = (customer, amount = 1200) => ({ tool: 'mcp__payments__refund', input: { amount, currency: 'USD', customer } });
async function ask(p, s, calls, why = 'Refund the customer', changed = undefined) {
  const callsHash = hashCalls(calls.map((c) => callOf(c.tool, c.input)));
  const r = await p.call('POST', `/sessions/${s.session}/tools/request_approval`, { action: 'payment', call: JSON.stringify(calls), why, calls, callsHash, ...(changed ? { changed } : {}) }, { authorization: `Bearer ${s.token}` });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { ...r.body, callsHash, card: (await p.call('GET', `/cards/${r.body.card}`)).body };
}
const RULE = { kind: 'refund', tool: 'mcp__payments__refund', amountField: 'amount', currency: 'USD', currencyField: 'currency', recipientField: 'customer', maxEach: 2000, total: 3000, period: 'week', system: 'Payments' };

test('rule forms: the fixed list, a limit per period, never deleting or going live', () => {
  assert.equal(ruleLine(ruleForm(RULE)), 'Refunds · up to $20.00 each · at most $30.00 per customer per week · in Payments');
  assert.equal(ruleLine(ruleForm({ kind: 'send.known', tool: 'mcp__mail__send', recipientField: 'to', n: 50, period: 'day', channel: 'Email' })), 'Messages to people the team has written to before · in Email · at most 50 per day');
  assert.throws(() => ruleForm({ ...RULE, period: undefined }), /limit per period/);
  assert.throws(() => ruleForm({ ...RULE, tool: 'mcp__shop__delete_order' }), /never cover deleting/);
  assert.throws(() => ruleForm({ ...RULE, tool: 'mcp__site__deploy' }), /going live/);
  assert.throws(() => ruleForm({ ...RULE, kind: 'merge' }), /not enforced yet/);
  assert.throws(() => ruleForm({ ...RULE, total: 1000 }), /at least maxEach/);
  assert.throws(() => ruleForm({ ...RULE, maxEach: 12.5 }), /whole number/);
});

test('a refund rule covers small refunds per customer per week, in the ledger, and the rest still asks', async () => {
  await plane(async (p) => {
    const { runner, s } = await setup(p);
    const form = ruleForm(RULE);
    // An owner's decision in advance: words required, a step-up scoped to this exact rule.
    assert.equal((await p.call('POST', '/teams/shop/standing-rules', { ...RULE, words: 'small refunds don\'t need me' }, await p.su())).status, 401);
    assert.equal((await p.call('POST', '/teams/shop/standing-rules', { ...RULE }, await p.su(`rule:${formHash(form)}`))).status, 400, 'words first');
    const made = await p.call('POST', '/teams/shop/standing-rules', { ...RULE, words: 'small refunds don\'t need me' }, await p.su(`rule:${formHash(form)}`));
    assert.equal(made.status, 201, JSON.stringify(made.body));

    const a = await ask(p, s, [refund('cus_dana')]);
    assert.equal(a.card.state, 'answered', 'covered: no card waits for anyone');
    assert.equal(a.card.answer.by, `rule:${made.body.id}`);
    assert.equal(a.card.answer.note, 'Done under standing rule #1: Refunds · up to $20.00 each · at most $30.00 per customer per week · in Payments');
    assert.deepEqual([a.card.answer.ruleNumber, a.card.answer.ruleLine], [1, 'Refunds · up to $20.00 each · at most $30.00 per customer per week · in Payments']);
    const res = await runner.next((f) => f.op === 'approval.result' && f.body.approval === a.approval);
    assert.deepEqual([res.body.decision, res.body.callsHash], ['approved', a.callsHash]);

    // Over the amount each, another currency, or over the customer's weekly total: a card for a person.
    assert.equal((await ask(p, s, [refund('cus_dana', 2500)])).card.state, 'open');
    assert.equal((await ask(p, s, [{ ...refund('cus_eli'), input: { ...refund('cus_eli').input, currency: 'EUR' } }])).card.state, 'open');
    assert.equal((await ask(p, s, [refund('cus_dana', 1500)])).card.state, 'answered', '12 + 15 = 27 of 30');
    assert.equal((await ask(p, s, [refund('cus_dana', 400)])).card.state, 'open', '27 + 4 is over 30 for Dana this week');
    assert.equal((await ask(p, s, [refund('cus_eli', 400)])).card.state, 'answered', 'per customer');

    const rules = (await p.call('GET', '/teams/shop/standing-rules')).body;
    assert.deepEqual(rules.rules.map((r) => [r.number, r.line, r.words, r.used]), [[1, 'Refunds · up to $20.00 each · at most $30.00 per customer per week · in Payments', 'small refunds don\'t need me', { n: 3, amount: 3100 }]]);
    assert.deepEqual(rules.never, ['newrecipient', 'live', 'delete', 'passkey', 'outside']);

    // Withdrawn: at once, no step-up, and the next one asks.
    assert.equal((await p.call('DELETE', `/teams/shop/standing-rules/${made.body.id}`)).status, 200);
    assert.equal((await ask(p, s, [refund('cus_fay', 100)])).card.state, 'open');

    const ledger = (await p.call('GET', '/teams/shop/ledger')).body.items;
    assert.deepEqual(ledger.map((l) => l.kind).reverse(), ['rule-added', 'rule-used', 'rule-used', 'rule-used', 'rule-withdrawn']);
    assert.equal(ledger.at(-1).words, 'small refunds don\'t need me', 'the owner\'s words, exactly');
  });
});

test('pay.known and send.known never cover someone new; a merge is never covered', async () => {
  await plane(async (p) => {
    const { s } = await setup(p);
    const PAY = { kind: 'pay.known', tool: 'mcp__bank__pay', amountField: 'amount', currency: 'USD', recipientField: 'to', maxEach: 20000, total: 100000, period: 'week' };
    assert.equal((await p.call('POST', '/teams/shop/standing-rules', { ...PAY, words: 'regular suppliers are fine' }, await p.su(`rule:${formHash(ruleForm(PAY))}`))).status, 201);
    const pay = (to) => [{ tool: 'mcp__bank__pay', input: { amount: 5000, to } }];
    // Someone new: a person decides, with their words in the ledger.
    const first = await ask(p, s, pay('acct_supplier'));
    assert.equal(first.card.state, 'open');
    const scope = approveScope({ tenant: 'acme', team: 'shop', approval: first.approval, version: 1, callsHash: first.callsHash });
    assert.equal((await p.call('POST', `/approvals/${first.approval}`, { decision: 'approved', version: 1, note: 'yes, that is our flour supplier' }, await p.su(scope))).status, 200);
    // Paid before: now the rule covers them, but not someone else.
    assert.equal((await ask(p, s, pay('acct_supplier'))).card.state, 'answered');
    assert.equal((await ask(p, s, pay('acct_stranger'))).card.state, 'open');
    const words = (await p.call('GET', '/teams/shop/ledger')).body.items.find((l) => l.kind === 'approved');
    assert.equal(words.words, 'yes, that is our flour supplier');
  });
});

test('declines stick for 7 days on the same effect and target; a re-ask must say what changed; a changed call supersedes', async () => {
  await plane(async (p) => {
    const { runner, s } = await setup(p);
    const a = await ask(p, s, [refund('cus_zed', 9000)]);
    assert.equal((await p.call('POST', `/approvals/${a.approval}`, { decision: 'denied', note: 'not this week' })).status, 200);
    // Asked again, the same signed calls: answered at once, with when it may be asked again.
    const again = await ask(p, s, [refund('cus_zed', 9000)]);
    assert.equal(again.card.state, 'answered');
    assert.equal(again.card.answer.option, 'deny');
    assert.match(again.card.answer.note, /^Declined on \d{4}-\d\d-\d\d\. The team can't ask for this again until \d{4}-\d\d-\d\d, unless something changes\.$/);
    const before = again.card.data.declinedBefore;
    assert.equal(before.approval, a.approval);
    assert.equal(Date.parse(before.cooldownUntil) - Date.parse(before.declinedOn), 7 * 86_400_000);
    assert.equal(before.declinedBy, 'admin');
    const res = await runner.next((f) => f.op === 'approval.result' && f.body.approval === again.approval);
    assert.equal(res.body.decision, 'denied');
    // A cent less, same customer, same system: still what was declined (AI-10), unless the teammate says what changed.
    const cent = await ask(p, s, [refund('cus_zed', 8999)]);
    assert.deepEqual([cent.card.state, cent.card.answer.option], ['answered', 'deny']);
    // The exact same calls stay declined even with a reason: nothing changed.
    const same = await ask(p, s, [refund('cus_zed', 9000)], 'Refund the customer', 'they called again');
    assert.equal(same.card.state, 'answered');
    // Saying what changed puts it in front of a person, who sees what changed.
    const changed = await ask(p, s, [refund('cus_zed', 8000)], 'Refund the customer', 'The customer sent the receipt; it is $80, not $90.');
    assert.equal(changed.card.state, 'open');
    assert.equal(changed.card.data.changed.what, 'The customer sent the receipt; it is $80, not $90.');
    assert.equal(changed.card.data.declinedBefore.approval, a.approval);
    // Another customer is another target: no cool-down.
    // (Asked in the same session while that card waits: the earlier one is superseded, and the new one says so.)
    const other = await ask(p, s, [refund('cus_amy', 9000)]);
    assert.equal(other.card.state, 'open');
    assert.equal(other.card.data.declinedBefore, undefined);
    assert.deepEqual(other.card.data.changed, { from: [changed.approval] });
    const old = (await p.call('GET', `/cards/${changed.card.id}`)).body;
    assert.deepEqual([old.state, old.answer.note], ['superseded', 'This changed since you were asked.']);
    const ledger = (await p.call('GET', '/teams/shop/ledger')).body.items.map((l) => [l.kind, l.words ?? null]);
    assert.deepEqual(ledger.reverse(), [['denied', 'not this week'], ['declined-again', null], ['declined-again', null], ['declined-again', null]]);
  });
});

test('effectHash: the tool and its targets, not the amount or the wording', async () => {
  const { effectHash } = await import('../ledger.mjs');
  const a = effectHash([refund('cus_zed', 9000)]);
  assert.equal(effectHash([refund('CUS_ZED ', 1)]), a);
  assert.notEqual(effectHash([refund('cus_amy', 9000)]), a);
  assert.notEqual(effectHash([{ tool: 'mcp__other__refund', input: { customer: 'cus_zed', amount: 9000 } }]), a);
  assert.equal(effectHash([{ tool: 'mcp__mail__send', input: { to: 'a@b.example', body: 'Hi' } }]), effectHash([{ tool: 'mcp__mail__send', input: { to: 'a@b.example', body: 'Hello there' } }]));
  assert.equal(effectHash([{ tool: 'mcp__x__do', input: { text: 'no target' } }]), null);
});
