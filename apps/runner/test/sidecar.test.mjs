// The sidecar (L20 runner part): local MCP servers run outside the agent, with their secrets, behind the policy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { cleanResult, effectOfTool, idempotencyKey, localServers, serverProblem, RESULT_MAX } from '../sidecar.mjs';
import { startRunner } from '../runner.mjs';
import { stubAdapter } from '../adapters/stub.mjs';
import { fakeControlPlane } from './fake-control-plane.mjs';
import { noFailedTurns, origin } from './helpers.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-notes.mjs', import.meta.url));
const SECRET = 'notes-token-0123456789abcdef';
const notes = (extra = {}) => ({ notes: { command: process.execPath, args: [FIXTURE], secrets: ['NOTES_TOKEN'], effects: { read_env: 'read', key: 'read', big: 'read', send_note: 'send' }, ...extra } });

/** Calls one tool through the sidecar's endpoint, as the Agent SDK's MCP client would. */
async function viaSidecar(entry, name, args) {
  const client = new Client({ name: 'agent', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers: entry.headers } }));
  try { return await client.callTool({ name, arguments: args }); } finally { await client.close(); }
}
const textOf = (r) => r.content.map((c) => c.text).join('');

test('pure parts: which servers are local, their checks, effects, keys and clean results', () => {
  assert.deepEqual(Object.keys(localServers({ a: { command: 'x' }, b: { url: 'https://x' }, c: null })), ['a']);
  assert.equal(serverProblem('notes', { command: 'x', secrets: ['NOTES_TOKEN'] }), null);
  assert.match(serverProblem('no_tes', { command: 'x' }), /not a server name/);
  assert.match(serverProblem('n', { command: 'x', secrets: ['lower'] }), /names like/);
  assert.match(serverProblem('n', { command: 'x', effects: { a: 'nuke' } }), /one of/);
  assert.match(serverProblem('n', { command: 'x', tier: 'community' }), /community/);
  assert.equal(serverProblem('n', { command: 'x', tier: 'community' }, { egressEnforced: true }), null);
  assert.equal(effectOfTool({ send_note: 'send', 'list_*': 'read' }, 'list_notes'), 'read');
  assert.equal(effectOfTool({ send_note: 'send' }, 'anything_else'), 'write', 'a tool the manifest does not name counts as write');
  assert.equal(idempotencyKey('ses_1', 'call_1'), idempotencyKey('ses_1', 'call_1'));
  assert.notEqual(idempotencyKey('ses_1', 'call_1'), idempotencyKey('ses_1', 'call_2'));
  const big = cleanResult({ content: [{ type: 'text', text: `k=${SECRET} ` + 'y'.repeat(RESULT_MAX) }] }, [{ name: 'NOTES_TOKEN', value: SECRET }]);
  assert.ok(!JSON.stringify(big).includes(SECRET));
  assert.deepEqual(big.names, ['NOTES_TOKEN']);
  assert.match(big.content.at(-1).text, /cut at/);
});

test('a local server runs in the sidecar with its secret; the agent never sees it, and only decided calls run', async () => {
  const { bare, root } = origin();
  const cp = await fakeControlPlane({ secrets: { NOTES_TOKEN: SECRET } });
  const seen = {};
  const adapter = stubAdapter({
    'docs-keeper': async (t) => {
      seen.env = JSON.stringify(t.env);
      seen.mcp = t.mcp;
      const env = await t.use('mcp__notes__read_env', { name: 'NOTES_TOKEN' }, () => viaSidecar(t.mcp.notes, 'read_env', { name: 'NOTES_TOKEN' }));
      seen.envResult = textOf(env.value);
      const k1 = await t.use('mcp__notes__key', { n: 1 }, () => viaSidecar(t.mcp.notes, 'key', { n: 1 }));
      seen.key = textOf(k1.value);
      seen.callId = cp.events.filter((e) => e.type === 'session.tool' && e.data.tool === 'mcp__notes__key').at(-1)?.data.call;
      // Straight at the port, with the token but no decision by the runner: refused.
      seen.undecided = await viaSidecar(t.mcp.notes, 'send_note', { text: 'sneaky' });
      seen.big = textOf((await t.use('mcp__notes__big', {}, () => viaSidecar(t.mcp.notes, 'big', {}))).value);
      return {};
    },
  });
  const runner = startRunner({ server: cp.url, key: cp.key, root, adapter });
  try {
    await runner.ready;
    cp.start({ role: 'docs-keeper', run: 'run_1', repo: { url: bare }, areas: ['docs/'], tools: { mcp: notes() }, wake: { id: 'ev_w', type: 'chat.message', data: { text: 'go' } } });
    await cp.until(() => cp.events.some((e) => e.type === 'session.idle'), 30_000);
    assert.deepEqual(cp.secretGets.map((g) => g.name), ['NOTES_TOKEN'], 'only the names the server lists are asked for');
    assert.ok(!seen.env.includes(SECRET), 'the agent\'s environment has no secret');
    assert.equal(seen.mcp.notes.type, 'http', 'the agent gets the sidecar\'s endpoint, not the command');
    assert.ok(!JSON.stringify(seen.mcp).includes(FIXTURE));
    assert.match(seen.envResult, /NOTES_TOKEN=\[secret: NOTES_TOKEN\]/, 'the server had it; the result is redacted');
    assert.match(seen.envResult, /keys=HOME,NOTES_TOKEN,PATH/, 'the server gets PATH, HOME and its own secrets only');
    assert.equal(seen.key, idempotencyKey(cp.events.find((e) => e.type === 'session.started').actor.session, seen.callId), 'the key is made from the decided call\'s id');
    assert.equal(seen.undecided.isError, true);
    assert.match(textOf(seen.undecided), /did not decide/);
    assert.ok(Buffer.byteLength(seen.big) <= RESULT_MAX + 40);
    const tools = cp.events.filter((e) => e.type === 'session.tool' && e.data.tool.startsWith('mcp__notes__'));
    assert.deepEqual([...new Set(tools.map((e) => e.data.effect))], ['read'], 'the effect comes from the manifest');
    assert.ok(!JSON.stringify(cp.events).includes(SECRET) && !JSON.stringify(cp.frames).includes(SECRET), 'no event or frame carries the secret');
    noFailedTurns(cp);
  } finally {
    await runner.close();
    await cp.close();
  }
});

test('a send effect waits for a person, a secret that is not bound stops the server, and a community server needs egress', async () => {
  const { bare, root } = origin();
  const cp = await fakeControlPlane({ secrets: { NOTES_TOKEN: SECRET }, decide: () => ({ decision: 'denied', by: 'owner' }) });
  const seen = {};
  const adapter = stubAdapter({
    'docs-keeper': async (t) => {
      seen.mcp = Object.keys(t.mcp);
      seen.send = await t.use('mcp__notes__send_note', { text: 'hello' }, () => viaSidecar(t.mcp.notes, 'send_note', { text: 'hello' }));
      return {};
    },
  });
  const runner = startRunner({ server: cp.url, key: cp.key, root, adapter });
  try {
    await runner.ready;
    const mcp = { ...notes(), locked: { command: process.execPath, args: [FIXTURE], secrets: ['OTHER_TOKEN'] }, shared: { command: process.execPath, args: [FIXTURE], tier: 'community' } };
    cp.start({ role: 'docs-keeper', run: 'run_1', repo: { url: bare }, areas: ['docs/'], tools: { mcp }, wake: { id: 'ev_w', type: 'chat.message', data: { text: 'go' } } });
    await cp.until(() => cp.events.some((e) => e.type === 'session.idle'), 30_000);
    assert.deepEqual(seen.mcp, ['notes'], 'only the server that started is offered');
    assert.match(seen.send.refused, /did not approve/);
    assert.deepEqual(cp.approvals.map((a) => a.action ?? a.approval?.action), ['outbound-message']);
    const refused = cp.events.filter((e) => e.type === 'session.tool' && e.data.rule === 'sidecar').map((e) => e.data.detail);
    assert.equal(refused.length, 2);
    assert.ok(refused.some((d) => /locked: a secret was not released/.test(d)));
    assert.ok(refused.some((d) => /community server/.test(d)));
    noFailedTurns(cp);
  } finally {
    await runner.close();
    await cp.close();
  }
});

test('a stopped session stops its servers', async () => {
  const { bare, root } = origin();
  const cp = await fakeControlPlane({ secrets: { NOTES_TOKEN: SECRET } });
  let entry;
  const adapter = stubAdapter({ 'docs-keeper': async (t) => { entry = t.mcp.notes; return {}; } });
  const runner = startRunner({ server: cp.url, key: cp.key, root, adapter });
  try {
    await runner.ready;
    const start = cp.start({ role: 'docs-keeper', run: 'run_1', repo: { url: bare }, areas: ['docs/'], tools: { mcp: notes() }, wake: { id: 'ev_w', type: 'chat.message', data: { text: 'go' } } });
    await cp.until(() => cp.events.some((e) => e.type === 'session.idle'), 30_000);
    const s = [...runner.sessions.values()][0];
    await s.stop('now', 'test');
    await cp.until(() => cp.events.some((e) => e.type === 'session.ended'));
    await assert.rejects(viaSidecar(entry, 'key', {}), 'the endpoint is gone');
    assert.ok(start);
  } finally {
    await runner.close();
    await cp.close();
  }
});
