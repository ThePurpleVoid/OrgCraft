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
  assert.equal(ruleLine(ruleForm(RULE)), 'Refunds · up to $20 each · at most $30 per customer a week · in Payments · may include: customer, amount, currency');
  assert.equal(ruleLine(ruleForm({ kind: 'send.known', tool: 'mcp__mail__send', recipientField: 'to', n: 50, period: 'day', channel: 'Email' })), 'Messages to people the team has written to before · in Email · at most 50 a day · may include: to');
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
    assert.equal(a.card.answer.note, 'Done under standing rule #1: Refunds · up to $20 each · at most $30 per customer a week · in Payments · may include: customer, amount, currency');
    assert.deepEqual([a.card.answer.ruleNumber, a.card.answer.ruleLine], [1, 'Refunds · up to $20 each · at most $30 per customer a week · in Payments · may include: customer, amount, currency']);
    const res = await runner.next((f) => f.op === 'approval.result' && f.body.approval === a.approval);
    assert.deepEqual([res.body.decision, res.body.callsHash], ['approved', a.callsHash]);

    // Over the amount each, another currency, or over the customer's weekly total: a card for a person.
    assert.equal((await ask(p, s, [refund('cus_dana', 2500)])).card.state, 'open');
    assert.equal((await ask(p, s, [{ ...refund('cus_eli'), input: { ...refund('cus_eli').input, currency: 'EUR' } }])).card.state, 'open');
    assert.equal((await ask(p, s, [refund('cus_dana', 1500)])).card.state, 'answered', '12 + 15 = 27 of 30');
    assert.equal((await ask(p, s, [refund('cus_dana', 400)])).card.state, 'open', '27 + 4 is over 30 for Dana this week');
    assert.equal((await ask(p, s, [refund('cus_eli', 400)])).card.state, 'answered', 'per customer');

    const rules = (await p.call('GET', '/teams/shop/standing-rules')).body;
    assert.deepEqual(rules.rules.map((r) => [r.number, r.line, r.words, r.used.n, r.used.amount]), [[1, 'Refunds · up to $20 each · at most $30 per customer a week · in Payments · may include: customer, amount, currency', 'small refunds don\'t need me', 3, 3100]]);
    // A calendar week (Monday to Monday in the team's zone, UTC here): it resets next Monday at midnight.
    const resets = new Date(rules.rules[0].used.resetsAt);
    assert.deepEqual([resets.getUTCDay(), resets.getUTCHours(), resets.getUTCMinutes()], [1, 0, 0]);
    assert.ok(resets > new Date() && resets - new Date() <= 7 * 86_400_000);
    assert.deepEqual(rules.never, ['newrecipient', 'live', 'delete', 'passkey', 'outside']);

    // Withdrawn: at once, no step-up, and the next one asks.
    assert.equal((await p.call('DELETE', `/teams/shop/standing-rules/${made.body.id}`)).status, 200);
    assert.equal((await ask(p, s, [refund('cus_fay', 100)])).card.state, 'open');

    const ledger = (await p.call('GET', '/teams/shop/ledger')).body.items;
    assert.deepEqual(ledger.map((l) => l.kind).reverse(), ['rule-added', 'rule-used', 'rule-used', 'rule-used', 'rule-withdrawn']);
    assert.equal(ledger.at(-1).words, 'small refunds don\'t need me', 'the owner\'s words, exactly');
    // Every rule row says which rule, as the list would (web-dev: no cross-reference).
    const line = 'Refunds · up to $20 each · at most $30 per customer a week · in Payments · may include: customer, amount, currency';
    assert.ok(ledger.every((l) => l.ruleNumber === 1 && l.ruleLine === line));
    const used = ledger.find((l) => l.kind === 'rule-used');
    assert.equal(typeof used.what, 'string');
    assert.deepEqual([used.channel, used.name, used.letter], [null, null, null], 'the server decided; no letters yet');
    assert.equal(ledger[0].words, null, 'no words: null (ledger.noword)');
  });
});

test('pay.known and send.known never cover someone new; a merge is never covered', async () => {
  await plane(async (p) => {
    const { s } = await setup(p);
    const PAY = { kind: 'pay.known', tool: 'mcp__bank__pay', amountField: 'amount', currency: 'USD', currencyField: 'currency', recipientField: 'to', maxEach: 20000, total: 100000, period: 'week' };
    assert.equal((await p.call('POST', '/teams/shop/standing-rules', { ...PAY, words: 'regular suppliers are fine' }, await p.su(`rule:${formHash(ruleForm(PAY))}`))).status, 201);
    const pay = (to) => [{ tool: 'mcp__bank__pay', input: { amount: 5000, currency: 'USD', to } }];
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
    assert.equal(words.channel, 'approvals', 'decided through POST /v1/approvals');
    assert.match(words.what, /acct_stranger|acct_supplier|pay/i);
  });
});

test('a rule covers only the fields it names, only its own kind of action, and never after outside text (security review)', async () => {
  await plane(async (p) => {
    const { s } = await setup(p);
    const askAs = async (action, calls) => {
      const callsHash = hashCalls(calls.map((c) => callOf(c.tool, c.input)));
      const r = await p.call('POST', `/sessions/${s.session}/tools/request_approval`, { action, call: JSON.stringify(calls), why: 'Pay the supplier', calls, callsHash }, { authorization: `Bearer ${s.token}` });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return { ...r.body, callsHash, card: (await p.call('GET', `/cards/${r.body.card}`)).body };
    };
    const approve = async (a) => {
      const scope = approveScope({ tenant: 'acme', team: 'shop', approval: a.approval, version: 1, callsHash: a.callsHash });
      assert.equal((await p.call('POST', `/approvals/${a.approval}`, { decision: 'approved', version: 1, note: 'ok' }, await p.su(scope))).status, 200);
    };
    const PAY = { kind: 'pay.known', tool: 'mcp__bank__pay', amountField: 'amount', currency: 'USD', currencyField: 'currency', recipientField: 'to', maxEach: 20000, total: 100000, period: 'week', free: ['memo'] };
    assert.equal(ruleLine(ruleForm(PAY)), "Payments to people you've paid before · up to $200 each · at most $1,000 a week · may include: to, amount, currency, memo");
    assert.equal((await p.call('POST', '/teams/shop/standing-rules', { ...PAY, fixed: { 'bad key': 1 }, words: 'regular suppliers' }, await p.su('rule:x'))).status, 400);
    assert.equal((await p.call('POST', '/teams/shop/standing-rules', { ...PAY, words: 'regular suppliers are fine' }, await p.su(`rule:${formHash(ruleForm(PAY))}`))).status, 201);
    const SEND = { kind: 'send.known', tool: 'mcp__mail__send', recipientField: 'to', n: 10, period: 'day', free: ['subject', 'body'] };
    assert.equal((await p.call('POST', '/teams/shop/standing-rules', { ...SEND, words: 'replies to known customers' }, await p.su(`rule:${formHash(ruleForm(SEND))}`))).status, 201);
    const pay = (input) => [{ tool: 'mcp__bank__pay', input: { amount: 5000, currency: 'USD', to: 'acct_supplier', ...input } }];
    const mail = (input) => [{ tool: 'mcp__mail__send', input: { to: 'jo@shop.example', subject: 'Hi', body: 'Thanks', ...input } }];
    await approve(await askAs('payment', pay({})));
    await approve(await askAs('outbound-message', mail({})));
    // Known now: covered, with a free field too.
    assert.equal((await askAs('payment', pay({ memo: 'May invoice' }))).card.state, 'answered');
    assert.equal((await askAs('outbound-message', mail({}))).card.state, 'answered');
    // A field the owner never saw, or anything nested: a person decides.
    assert.equal((await askAs('payment', pay({ destination_account: 'acct_attacker' }))).card.state, 'open');
    assert.equal((await askAs('payment', pay({ memo: { note: 'x' } }))).card.state, 'open');
    assert.equal((await askAs('outbound-message', mail({ bcc: 'attacker@evil.example' }))).card.state, 'open');
    // Not the kind of action the rule is for (a deploy, a secret, anything passkey-only): a person decides.
    assert.equal((await askAs('secret-write', pay({}))).card.state, 'open');
    // A person decided just now, so the next one is covered again ...
    const pending = await askAs('payment', pay({ memo: 'June' }));
    assert.equal(pending.card.state, 'answered');
    // ... until the teammate reads something from outside the team (an email, through a connector).
    await p.db.tenant('acme', ({ q }) => q(`insert into events(tenant, team, id, type, version, time, actor_kind, actor_id, envelope)
      values ('acme', 'shop', 'ev_outside1', 'session.result', 1, now(), 'role', 'chief-of-staff', $1)`,
    [JSON.stringify({ id: 'ev_outside1', type: 'session.result', actor: { kind: 'role', id: 'chief-of-staff', session: s.session }, data: { call: 'c1', tool: 'mcp__mail__read', ok: true, outside: true } })]));
    const after = await askAs('payment', pay({ memo: 'July' }));
    assert.equal(after.card.state, 'open', 'rule.never.outside: a connector read counts, not only trigger wakes');
    await approve(after);
    assert.equal((await askAs('payment', pay({ memo: 'August' }))).card.state, 'answered', 'a person decided since');
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
    // A renamed target field, or one more target field, is still the same customer (code review sev 3).
    assert.equal((await ask(p, s, [{ tool: 'mcp__payments__refund', input: { amount: 8999, currency: 'USD', customer_id: 'cus_zed' } }])).card.state, 'answered');
    assert.equal((await ask(p, s, [{ tool: 'mcp__payments__refund', input: { amount: 8999, currency: 'USD', customer: 'cus_zed', email: 'zed@x.example' } }])).card.state, 'answered');
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
    assert.deepEqual(ledger.reverse(), [['denied', 'not this week'], ...Array(5).fill(['declined-again', null])]);
    // A person's rows carry their display name, for people who are or were members of this workspace.
    await p.db.system("insert into people(id, provider, subject, login, name) values ('per_danaruiz1', 'github', '777', 'dana-gh', null)");
    await p.db.system("insert into members(id, tenant, person, role) values ('mem_dana1', 'acme', 'per_danaruiz1', 'approver')");
    await p.db.tenant('acme', ({ q }) => q("insert into approval_ledger(tenant, team, kind, by, words, channel) values ('acme', 'shop', 'denied', 'per_danaruiz1', 'no', 'chat')"));
    const top = (await p.call('GET', '/teams/shop/ledger')).body.items[0];
    assert.deepEqual([top.by, top.name, top.channel], ['per_danaruiz1', 'dana-gh', 'chat']);
  });
});

test('money rules: the currency is always compared; refunds can also have a total across all customers', async () => {
  const { currencyField, ...noCurrency } = RULE;
  assert.throws(() => ruleForm(noCurrency), /currencyField/);
  const ALL = { ...RULE, all: 3500 };
  assert.equal(ruleLine(ruleForm(ALL)), 'Refunds · up to $20 each · at most $30 per customer a week · at most $35 a week in all · in Payments · may include: customer, amount, currency');
  assert.throws(() => ruleForm({ ...RULE, all: 100 }), /at least maxEach/);
  await plane(async (p) => {
    const { s } = await setup(p);
    assert.equal((await p.call('POST', '/teams/shop/standing-rules', { ...ALL, words: 'small refunds, $35 a week in all' }, await p.su(`rule:${formHash(ruleForm(ALL))}`))).status, 201);
    // Another currency is never this rule's, whatever the amount.
    assert.equal((await ask(p, s, [{ tool: 'mcp__payments__refund', input: { amount: 500, currency: 'GBP', customer: 'cus_a' } }])).card.state, 'open');
    // Per customer $30, in all $35: the third customer's refund would pass its own limit but not the total.
    assert.equal((await ask(p, s, [refund('cus_a', 1500)])).card.state, 'answered');
    assert.equal((await ask(p, s, [refund('cus_b', 1500)])).card.state, 'answered');
    assert.equal((await ask(p, s, [refund('cus_c', 1000)])).card.state, 'open', 'the total in all is hit first');
    assert.equal((await ask(p, s, [refund('cus_c', 500)])).card.state, 'answered', 'exactly the total is fine');
  });
});

test('targetsOf: the tool and the values it acts on, whatever field carries them', async () => {
  const { targetsOf } = await import('../ledger.mjs');
  const overlap = (a, b) => a.some((x) => b.includes(x));
  const a = targetsOf([refund('cus_zed', 9000)]);
  assert.deepEqual(targetsOf([refund('CUS_ZED ', 1)]), a, 'not the amount, not the case');
  assert.ok(overlap(targetsOf([{ tool: 'mcp__payments__refund', input: { customer_id: 'cus_zed', amount: 1 } }]), a), 'a renamed field');
  assert.ok(overlap(targetsOf([{ tool: 'mcp__payments__refund', input: { customer: 'cus_zed', email: 'z@x.example', amount: 1 } }]), a), 'one more target field');
  assert.ok(!overlap(targetsOf([refund('cus_amy', 9000)]), a), 'another customer');
  assert.ok(!overlap(targetsOf([{ tool: 'mcp__other__refund', input: { customer: 'cus_zed', amount: 9000 } }]), a), 'another system');
  assert.deepEqual(targetsOf([{ tool: 'mcp__mail__send', input: { to: 'a@b.example', body: 'Hi' } }]), targetsOf([{ tool: 'mcp__mail__send', input: { to: 'a@b.example', body: 'Hello there' } }]));
  assert.equal(targetsOf([{ tool: 'mcp__x__do', input: { text: 'no target' } }]), null);
});
