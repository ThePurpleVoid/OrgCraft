// ADR 0013, what you see is what you sign: an approval is bound to the exact calls it covers, and the runner runs
// the signed record. The server's half (hashing the card, refusing other calls) is apps/server's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonical, callOf, hashCalls, parseCalls } from '../calls.mjs';
import { signedFor } from '../session.mjs';
import { startRunner } from '../runner.mjs';
import { stubAdapter } from '../adapters/stub.mjs';
import { fakeControlPlane } from './fake-control-plane.mjs';
import { noFailedTurns, origin } from './helpers.mjs';

const DEPLOY = { command: 'deploy.sh --production', description: 'ship it' };

test('the signed form: sorted keys, notes left out, a list hashed in order, prose names no call', () => {
  assert.equal(canonical({ b: 1, a: [2, { d: 3, c: undefined }] }), '{"a":[2,{"d":3}],"b":1}');
  assert.throws(() => canonical({ x: NaN }), /whole numbers/);
  assert.throws(() => canonical({ amount: 19.99 }), /minor units/, 'no floats in what is signed');
  const a = callOf('Bash', DEPLOY), b = callOf('Bash', { description: 'other words', command: 'deploy.sh --production' });
  assert.deepEqual(a, { tool: 'Bash', input: { command: 'deploy.sh --production' } }, 'a Bash note is not part of the call');
  assert.equal(hashCalls([a]), hashCalls([b]));
  assert.notEqual(hashCalls([a]), hashCalls([callOf('Bash', { command: 'deploy.sh --production ' })]), 'one byte more is another call');
  const pay = callOf('mcp__stripe__refund', { amount: 2000, to: 'cus_1' });
  assert.notEqual(hashCalls([a, pay]), hashCalls([pay, a]), 'order is part of what was signed');
  assert.match(hashCalls([a]), /^[0-9a-f]{64}$/);
  assert.equal(parseCalls('deploy.sh --production'), null, 'a shell line in words names no call');
  assert.equal(parseCalls('{"tool":"Bash","input":{"command":"x"},"why":"extra"}'), null, 'nothing but tool and input');
  assert.equal(parseCalls('[]'), null);
  assert.deepEqual(parseCalls(JSON.stringify([{ tool: 'Bash', input: DEPLOY }])), [a]);
});

test('a result is for the calls only when its hash matches; an unsigned result counts only until signing is required', () => {
  assert.equal(signedFor({ callsHash: 'abc' }, 'abc'), true);
  assert.equal(signedFor({ callsHash: 'abd' }, 'abc'), false);
  assert.equal(signedFor({}, 'abc', { require: false }), true);
  assert.equal(signedFor({}, 'abc', { require: true }), false);
});

async function session(script, decide) {
  const { bare, root } = origin();
  const cp = await fakeControlPlane({ decide });
  const runner = startRunner({ server: cp.url, key: cp.key, root, adapter: stubAdapter({ 'release-manager': script }) });
  await runner.ready;
  cp.start({ role: 'release-manager', run: 'run_1', repo: { url: bare } });
  await cp.until(() => cp.events.some((e) => e.type === 'session.idle'));
  return { cp, close: async () => { await runner.close(); await cp.close(); } };
}

test('a held call: the approval carries its exact calls and hash, and what runs is the signed input', async () => {
  const ran = [];
  const { cp, close } = await session(async (t) => {
    const r = await t.use('Bash', { ...DEPLOY }, (input) => ran.push(input));
    assert.ok(r.ok);
  }, (req) => ({ decision: 'approved', by: 'owner', callsHash: req.callsHash }));
  try {
    const [a] = cp.approvals;
    assert.deepEqual(a.approval.calls, [{ tool: 'Bash', input: { command: 'deploy.sh --production' } }]);
    assert.equal(a.approval.callsHash, hashCalls(a.approval.calls));
    assert.deepEqual(ran, [{ command: 'deploy.sh --production' }], 'the signed record ran, not the model\'s object');
    noFailedTurns(cp);
  } finally { await close(); }
});

test('a held call whose approval was signed for other calls does not run', async () => {
  const ran = [];
  const { cp, close } = await session(async (t) => {
    const r = await t.use('Bash', { ...DEPLOY }, () => ran.push('ran'));
    assert.match(r.refused, /signed for a different call/);
  }, () => ({ decision: 'approved', by: 'owner', callsHash: '0'.repeat(64) }));
  try {
    assert.deepEqual(ran, []);
    assert.ok(cp.events.some((e) => e.type === 'session.tool' && e.data.decision === 'refused' && /other calls/.test(e.data.detail ?? '')));
    noFailedTurns(cp);
  } finally { await close(); }
});

test('request_approval with its call as JSON lets through exactly that call, once; anything else is asked for again', async () => {
  const ran = [];
  const { cp, close } = await session(async (t) => {
    const asked = await t.call('request_approval', { action: 'deploy-production', call: JSON.stringify({ tool: 'Bash', input: DEPLOY }), why: 'the release is signed off' });
    assert.match(asked.text, /Approved for exactly this call, each once/);
    // The same call with other notes: it rides the approval, and runs as signed. No second card.
    assert.ok((await t.use('Bash', { command: 'deploy.sh --production', description: 'go' }, (i) => ran.push(i))).ok);
    // Once only: the same call again is held and asked for (and denied here).
    assert.match((await t.use('Bash', { ...DEPLOY }, () => ran.push('again'))).refused, /did not approve/);
    // A different call never rides it.
    assert.match((await t.use('Bash', { command: 'deploy.sh --production --all-regions' }, () => ran.push('other'))).refused, /did not approve/);
  }, (() => { const answers = ['approved', 'denied', 'denied']; return (req) => ({ decision: answers.shift(), by: 'owner', ...(req.callsHash ? { callsHash: req.callsHash } : {}) }); })());
  try {
    assert.deepEqual(ran, [{ command: 'deploy.sh --production' }]);
    const [tool, again, other] = cp.approvals;
    assert.equal(tool.via, 'tool');
    assert.equal(tool.input.callsHash, hashCalls([callOf('Bash', DEPLOY)]), 'the card is signed over the call');
    assert.deepEqual([again.via, other.via], ['policy', 'policy'], 'the second and the different call were each held and asked for');
    assert.ok(cp.events.some((e) => e.type === 'session.tool' && e.data.approval === tool.approval && e.data.decision === 'allowed'));
    noFailedTurns(cp);
  } finally { await close(); }
});

test('request_approval in words approves a decision, never a call: the step itself is still held', async () => {
  const ran = [];
  const { cp, close } = await session(async (t) => {
    const asked = await t.call('request_approval', { action: 'deploy-production', call: 'deploy.sh --production', why: 'signed off' });
    assert.match(asked.text, /Approved as a decision\. It approves no particular call/);
    assert.ok((await t.use('Bash', { ...DEPLOY }, () => ran.push('ran'))).ok);
  }, (req) => ({ decision: 'approved', by: 'owner', ...(req.callsHash ? { callsHash: req.callsHash } : {}) }));
  try {
    assert.deepEqual(cp.approvals.map((a) => a.via), ['tool', 'policy'], 'the deploy was asked for again, with its exact call');
    assert.equal(cp.approvals[0].input.callsHash, undefined);
    assert.deepEqual(ran, ['ran']);
    noFailedTurns(cp);
  } finally { await close(); }
});

test('an approved call never overrides a refusal: a write outside the role\'s areas stays refused', async () => {
  const { cp, close } = await session(async (t) => {
    const call = { tool: 'Write', input: { file_path: 'secrets/prod.env', content: 'x' } };
    await t.call('request_approval', { action: 'secret-write', call: JSON.stringify(call), why: 'needed' });
    assert.ok((await t.use('Write', call.input)).refused);
  }, (req) => ({ decision: 'approved', by: 'owner', callsHash: req.callsHash }));
  try {
    assert.ok(cp.events.some((e) => e.type === 'session.tool' && e.data.tool === 'Write' && e.data.decision === 'refused'));
    noFailedTurns(cp);
  } finally { await close(); }
});
