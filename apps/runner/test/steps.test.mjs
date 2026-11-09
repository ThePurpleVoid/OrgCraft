// Step boundaries and step I/O for the run inspector (N1, ADR 0009, L19 runner part).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Steps, effectOf, isOutside, redactNamed, summarize, IO_MAX } from '../steps.mjs';
import { startRunner } from '../runner.mjs';
import { stubAdapter } from '../adapters/stub.mjs';
import { fakeControlPlane } from './fake-control-plane.mjs';
import { noFailedTurns, origin } from './helpers.mjs';

test('effects come from the runner\'s policy, never from the agent', () => {
  assert.equal(effectOf('Read'), 'read');
  assert.equal(effectOf('Edit'), 'write');
  assert.equal(effectOf('Bash'), 'write');
  assert.equal(effectOf('Bash', 'accept'), 'deploy');
  assert.equal(effectOf('Bash', 'destructive-data'), 'destructive');
  assert.equal(effectOf('mcp__mail__send_email', 'outbound-message'), 'send');
  assert.equal(effectOf('mcp__crm__lookup'), undefined, 'a connector tool\'s effect comes from its manifest');
  assert.equal(isOutside('WebFetch'), true);
  assert.equal(isOutside('mcp__crm__lookup'), true);
  assert.equal(isOutside('mcp__team__report'), false);
  assert.equal(isOutside('Read'), false);
});

test('redaction names what it hid, and a summary is one line of at most 300 characters', () => {
  const r = redactNamed('token=abcdefgh12345 and abcdefgh12345', [{ name: 'model-key', value: 'abcdefgh12345' }, { name: 'short', value: 'abc' }]);
  assert.equal(r.text, 'token=[secret: model-key] and [secret: model-key]');
  assert.deepEqual(r.names, ['model-key']);
  assert.equal(summarize('Read', { file_path: '/w/src/app.js' }, 'x', true), 'read src/app.js');
  assert.equal(summarize('Bash', { command: 'npm test' }, { stdout: '\n# pass 3\n' }, true), 'ran npm test · # pass 3');
  assert.equal(summarize('Bash', { command: 'x' }, { stdout: 'boom', is_error: true }, false), 'failed: boom');
  assert.ok(summarize('Bash', { command: 'y'.repeat(500) }, { stdout: 'z'.repeat(500) }, true).length <= 300);
});

test('a call repeating a failed one with the same input is a retry; another input is a new call', () => {
  const s = new Steps({ session: 'ses_1' });
  const a = s.begin('Bash', { command: 'npm test' }, { id: 't1' });
  s.decided(a, true);
  assert.equal(s.end('Bash', { command: 'npm test' }, { stdout: 'fail', is_error: true }, { id: 't1' }).ok, false);
  const b = s.begin('Bash', { command: 'npm test' }, { id: 't2' });
  assert.equal(b.retryOf, a.call);
  const c = s.begin('Bash', { command: 'npm test -- --grep x' }, { id: 't3' });
  assert.equal(c.retryOf, undefined, 'tried another way, not a retry');
  const refused = s.begin('Write', { file_path: '/etc/x' });
  s.decided(refused, false);
  assert.equal(s.begin('Write', { file_path: '/etc/x' }).retryOf, refused.call, 'a refused call counts as failed');
  assert.equal(s.end('Read', {}, 'x', { id: 'never-decided' }), null, 'a team tool or unknown call has no result');
});

test('step I/O is sent only when the team captures it: redacted, cut at 64 KiB, and the turn text only with "all"', () => {
  const off = new Steps({ session: 's', send: () => assert.fail('nothing is sent when capture is off') });
  assert.equal(off.begin('Read', { file_path: 'a' }).io, undefined);
  const frames = [];
  const tools = new Steps({ capture: 'tools', session: 'ses_1', send: (f) => frames.push(f), secrets: () => [{ name: 'model-key', value: 'sk-secret-123456' }] });
  const st = tools.begin('Bash', { command: 'echo sk-secret-123456' }, { id: 'x' });
  tools.decided(st, true);
  const res = tools.end('Bash', { command: 'echo sk-secret-123456' }, { stdout: 'y'.repeat(IO_MAX + 10) }, { id: 'x' });
  assert.deepEqual(frames.map((f) => [f.part, f.session]), [['input', 'ses_1'], ['output', 'ses_1']]);
  assert.match(frames[0].body, /\[secret: model-key\]/);
  assert.ok(!frames[0].body.includes('sk-secret-123456'));
  assert.deepEqual(frames[0].redactions, ['model-key']);
  assert.equal(frames[1].truncated, true);
  assert.ok(Buffer.byteLength(frames[1].body) <= IO_MAX);
  assert.ok(frames[1].bytes > IO_MAX);
  assert.equal(res.io, frames[1].id);
  assert.ok(!res.summary.includes('sk-secret-123456'));
  tools.said('thinking out loud');
  assert.equal(tools.turnText(), undefined, '"tools" keeps no turn text');
  const all = new Steps({ capture: 'all', session: 's', send: (f) => frames.push(f) });
  all.said('I will check the logs first.');
  const io = all.turnText();
  assert.equal(frames.at(-1).id, io);
  assert.equal(frames.at(-1).mime, 'text/plain');
});

test('in a session: every tool call has a call id and effect, an allowed one ends with session.result, and the wake is the cause', async () => {
  const { bare, root } = origin();
  const cp = await fakeControlPlane({ sessionDefaults: () => ({}) });
  const adapter = stubAdapter({
    'docs-keeper': async (t) => {
      await t.use('Read', { file_path: 'README.md' }, () => 'the readme');
      await t.use('Bash', { command: 'npm test' }, () => ({ stdout: 'fail', is_error: true }));
      await t.use('Bash', { command: 'npm test' }, () => ({ stdout: '# pass 1' }));
      await t.use('Write', { file_path: '/etc/passwd', content: 'x' });
      await t.say('Done reading.');
      return {};
    },
  });
  const runner = startRunner({ server: cp.url, key: cp.key, root, adapter });
  try {
    await runner.ready;
    const wake = { specversion: '1.0', id: 'ev_wake_1', type: 'chat.message', data: { text: 'go' } };
    cp.start({ role: 'docs-keeper', run: 'run_1', repo: { url: bare }, areas: ['docs/'], caps: { capture: 'all' }, wake });
    await cp.until(() => cp.events.some((e) => e.type === 'session.idle'));
    const tools = cp.events.filter((e) => e.type === 'session.tool');
    const results = cp.events.filter((e) => e.type === 'session.result');
    assert.deepEqual(tools.map((e) => [e.data.tool, e.data.decision, e.data.effect]), [['Read', 'allowed', 'read'], ['Bash', 'allowed', 'write'], ['Bash', 'allowed', 'write'], ['Write', 'refused', 'write']]);
    assert.ok(tools.every((e) => /^call_/.test(e.data.call)));
    assert.equal(tools[2].data.retryOf, tools[1].data.call, 'the same failed call again is a retry');
    assert.deepEqual(results.map((e) => [e.data.tool, e.data.ok, e.data.call]), [['Read', true, tools[0].data.call], ['Bash', false, tools[1].data.call], ['Bash', true, tools[2].data.call]], 'a refused call has no result');
    const io = cp.frames.filter((f) => f.op === 'step.io');
    assert.ok(io.some((f) => f.body.part === 'input' && f.body.id === tools[0].data.io), 'the input io is sent and named');
    assert.ok(io.some((f) => f.body.part === 'output' && f.body.id === results[0].data.io));
    const usage = cp.events.find((e) => e.type === 'usage.recorded');
    assert.ok(io.some((f) => f.body.id === usage.data.io && /Done reading/.test(f.body.body)), 'the turn\'s own text');
    assert.ok(cp.events.filter((e) => e.actor?.session && e.type !== 'session.started').every((e) => e.cause === 'ev_wake_1'), 'events in the turn name the wake as their cause');
    noFailedTurns(cp);
  } finally {
    await runner.close();
    await cp.close();
  }
});

test('without capture: no step.io and no cause, but call ids and results still go out', async () => {
  const { bare, root } = origin();
  const cp = await fakeControlPlane();
  const adapter = stubAdapter({ 'docs-keeper': async (t) => { await t.use('Read', { file_path: 'README.md' }, () => 'x'); return {}; } });
  const runner = startRunner({ server: cp.url, key: cp.key, root, adapter });
  try {
    await runner.ready;
    cp.start({ role: 'docs-keeper', run: 'run_1', repo: { url: bare }, areas: ['docs/'], wake: { id: 'ev_w', type: 'chat.message', data: { text: 'go' } } });
    await cp.until(() => cp.events.some((e) => e.type === 'session.idle'));
    assert.equal(cp.frames.filter((f) => f.op === 'step.io').length, 0);
    assert.ok(cp.events.every((e) => e.cause === undefined));
    assert.ok(cp.events.some((e) => e.type === 'session.result' && e.data.ok));
    noFailedTurns(cp);
  } finally {
    await runner.close();
    await cp.close();
  }
});
