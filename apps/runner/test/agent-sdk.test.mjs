// The Agent SDK adapter. Its wiring is checked without a model; the real-model smoke test runs only when an
// Anthropic API key is set, because it costs money, and says so when it skips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { agentSdkAdapter, teamToolDefinitions } from '../adapters/agent-sdk.mjs';
import { TOOLS } from '../tools.mjs';
import { startRunner } from '../runner.mjs';
import { fakeControlPlane } from './fake-control-plane.mjs';

const specs = Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, shape: t.shape }));

test('the team tools become an in-process MCP server whose calls go through the checks', async () => {
  const calls = [];
  const defs = teamToolDefinitions(tool, specs, async (name, args) => { calls.push([name, args]); return name === 'signoff' ? { text: 'Refused: evidence', isError: true } : { text: 'ok' }; });
  assert.deepEqual(defs.map((d) => d.name).sort(), Object.keys(TOOLS).sort());
  const server = createSdkMcpServer({ name: 'team', tools: defs });
  assert.equal(server.type, 'sdk');
  assert.equal(server.name, 'team');
  const signoff = defs.find((d) => d.name === 'signoff');
  assert.deepEqual(await signoff.handler({ to: 'qa-web' }, {}), { content: [{ type: 'text', text: 'Refused: evidence' }], isError: true });
  assert.deepEqual(calls, [['signoff', { to: 'qa-web' }]]);
});

test('without a model key in the runner\'s environment the adapter refuses, and never falls back on ambient credentials', async () => {
  let loaded = false;
  const a = agentSdkAdapter();
  await assert.rejects(a.turn({ env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'x' }, signal: new AbortController().signal, tools: [], callTool: () => {}, preToolUse: () => {}, get prompt() { loaded = true; return ''; } }), /no model key/);
  assert.equal(loaded, false, 'nothing was started');
});

test('a session\'s shell sees neither the real model key nor the runner\'s HOME, and reaches the model only through the proxy (R1)', async () => {
  const { Session } = await import('../session.mjs');
  const { startModelProxy } = await import('../modelproxy.mjs');
  const { createServer } = await import('node:http');
  const saved = { ...process.env };
  // A stand-in model API that records what reaches it.
  const seen = [];
  const upstream = createServer((req, res) => { seen.push({ url: req.url, key: req.headers['x-api-key'] }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const proxy = startModelProxy({ upstream: `http://127.0.0.1:${upstream.address().port}` });
  try {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-runner-own-key-0123456789';
    for (const [k, v] of Object.entries({ CLAUDE_CODE_OAUTH_TOKEN: 'ambient', AGENT_TEAM_RUNNER_KEY: 'rk_secret', GITHUB_TOKEN: 'ghp_ambient', GH_TOKEN: 'gh_ambient', SSH_AUTH_SOCK: '/tmp/agent.sock' })) process.env[k] = v;
    const { origin } = await import('./helpers.mjs');
    const { bare, root } = origin();
    const s = new Session({ session: 'ses_env', role: 'web-dev', team: 't', repo: { url: bare } }, { root, modelProxy: proxy, emit: async () => {}, adapter: { turn: async () => ({}) } });
    s.pump = () => {};
    await s.start();
    const env = JSON.stringify(s.env);
    assert.ok(!env.includes('sk-ant-test-runner-own'), 'no real model key');
    assert.ok(s.env.HOME.startsWith(root) && s.env.HOME !== saved.HOME, 'a home of its own');
    for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'AGENT_TEAM_RUNNER_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'SSH_AUTH_SOCK']) assert.equal(s.env[k], undefined, k);
    assert.match(s.env.ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+\/s\/ses_env$/);
    // The session's token works through the proxy, which swaps in the real key; any other token does not.
    const ok = await fetch(`${s.env.ANTHROPIC_BASE_URL}/v1/messages`, { method: 'POST', headers: { 'x-api-key': s.env.ANTHROPIC_API_KEY, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(ok.status, 200);
    assert.deepEqual(seen, [{ url: '/v1/messages', key: 'sk-ant-test-runner-own-key-0123456789' }]);
    const bad = await fetch(`${s.env.ANTHROPIC_BASE_URL}/v1/messages`, { method: 'POST', headers: { 'x-api-key': 'guess' }, body: '{}' });
    assert.equal(bad.status, 401);
    await s.stop('now', 'test');
    const after = await fetch(`${s.env.ANTHROPIC_BASE_URL}/v1/messages`, { method: 'POST', headers: { 'x-api-key': s.env.ANTHROPIC_API_KEY }, body: '{}' });
    assert.equal(after.status, 401, 'the token dies with the session');
    // With no key in the runner's environment, a session gets no model access at all.
    delete process.env.ANTHROPIC_API_KEY;
    const t = new Session({ session: 'ses_env2', role: 'web-dev', team: 't', repo: { url: bare } }, { root, modelProxy: proxy, emit: async () => {}, adapter: { turn: async () => ({}) } });
    t.pump = () => {};
    await t.start();
    assert.equal(t.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(t.env.ANTHROPIC_BASE_URL, undefined);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    await proxy.close();
    await new Promise((r) => upstream.close(r));
  }
});

// Real model calls spend money, which is the owner's step: the smoke test is opt-in, with both set explicitly.
const key = process.env.ANTHROPIC_API_KEY;
const smoke = process.env.RUNNER_SMOKE === '1' && key;
test('smoke: a real model reports through the team tools', { skip: smoke ? false : 'skipped: opt in with RUNNER_SMOKE=1 and ANTHROPIC_API_KEY (a real model call, a few cents)' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-smoke-'));
  const bare = join(dir, 'team.git'), seed = join(dir, 'seed');
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['init', '--quiet', '-b', 'main', seed]);
  writeFileSync(join(seed, 'README.md'), '# smoke\n');
  const g = (...a) => execFileSync('git', a, { cwd: seed, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  g('add', '-A'); g('commit', '--quiet', '-m', 'seed'); g('push', '--quiet', bare, 'main');
  const cp = await fakeControlPlane();
  const runner = startRunner({ server: cp.url, key: cp.key, root: join(dir, 'root'), adapter: agentSdkAdapter({ effort: 'low', settingSources: [] }) });
  try {
    await runner.ready;
    cp.start({
      role: 'qa-web', run: 'run_smoke', repo: { url: bare }, caps: { remainingToday: 50, time: 240 },
      prompt: { brief: '# QA web\n\n**Model:** light\n\nYou test the product and report.' },
      wake: 'Call the team tool `report` once with status "done" and task "runner smoke test". Then stop; do nothing else.',
    });
    await cp.until(() => cp.events.some((e) => e.type === 'session.idle' || e.type === 'session.ended'), 240_000);
    const report = cp.toolCalls.find((c) => c.tool === 'report' && c.input.task === 'runner smoke test');
    assert.ok(report, `the model reported through the tool server; events: ${cp.events.map((e) => e.type).join(', ')}`);
    assert.equal(report.as.role, 'qa-web');
    assert.ok(cp.events.some((e) => e.type === 'usage.recorded' && e.data.outputTokens > 0));
  } finally {
    await runner.close({ mode: 'now' });
    await cp.close();
  }
});

test('the tier map and the cost fallback come from the shared price table; the SDK\'s reported cost wins when it has one', async () => {
  const { agentSdkAdapter } = await import('../adapters/agent-sdk.mjs');
  const { Session, PRICES } = await import('../session.mjs');
  const { estimate } = await import('../../../packages/model-prices/index.mjs');
  // A fake SDK (no model, no network): one result message with or without total_cost_usd.
  const sdkWith = (result) => ({
    createSdkMcpServer: () => ({}), tool: (name, d, s, fn) => ({ name, fn }),
    query: () => (async function* () { yield { type: 'result', subtype: 'success', result: 'ok', session_id: 'x', ...result }; })(),
  });
  const usage = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 };
  const o = { env: { ANTHROPIC_API_KEY: 'st_session_token', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/s/x' }, model: PRICES.tiers.routine, tools: [], callTool: async () => ({ text: '' }), signal: new AbortController().signal, preToolUse: async () => ({ allow: true }), prompt: 'p', systemPrompt: 's', cwd: process.cwd() };
  const none = await agentSdkAdapter({ sdk: sdkWith({ usage }) }).turn(o);
  assert.equal(none.usage.costUsd, estimate({ model: PRICES.tiers.routine, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000 }, PRICES).usd);
  assert.ok(none.usage.costUsd > 0, 'no reported cost: the list price, not zero');
  // A model the table does not list is not free: it counts at the dearest listed model's prices.
  const unlisted = await agentSdkAdapter({ sdk: sdkWith({ usage }) }).turn({ ...o, model: 'claude-not-in-the-table' });
  const dearest = Math.max(...Object.keys(PRICES.models).map((id) => estimate({ model: id, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000 }, PRICES).usd));
  assert.ok(unlisted.usage.costUsd > 0, 'an unlisted model is never counted as free');
  assert.ok(unlisted.usage.costUsd >= none.usage.costUsd && Math.abs(unlisted.usage.costUsd - dearest) < 1e-12, 'at the dearest listed model');
  const reported = await agentSdkAdapter({ sdk: sdkWith({ usage, total_cost_usd: 0.1234 }) }).turn(o);
  assert.equal(reported.usage.costUsd, 0.1234);
  // The SDK may not know an unlisted model's price either and report it as free: still the dearest listed price.
  const free = await agentSdkAdapter({ sdk: sdkWith({ usage, total_cost_usd: 0 }) }).turn({ ...o, model: 'claude-not-in-the-table' });
  assert.ok(Math.abs(free.usage.costUsd - dearest) < 1e-12, 'an SDK-reported zero for an unlisted model is not taken');
  const cheap = await agentSdkAdapter({ sdk: sdkWith({ usage, total_cost_usd: 0.000001 }) }).turn({ ...o, model: 'claude-not-in-the-table' });
  assert.ok(Math.abs(cheap.usage.costUsd - dearest) < 1e-12, 'nor a reported cost below the dearest list price');
  const zero = await agentSdkAdapter({ sdk: sdkWith({ usage, total_cost_usd: 0 }) }).turn(o);
  assert.equal(zero.usage.costUsd, none.usage.costUsd, 'a zero reported for a turn that used tokens: the list price');
  for (const bad of [NaN, -1, Infinity]) assert.equal((await agentSdkAdapter({ sdk: sdkWith({ usage, total_cost_usd: bad }) }).turn(o)).usage.costUsd, none.usage.costUsd);
  // End to end to the budget: the unlisted model's turn reaches usage.recorded with a cost above zero.
  const sent = [];
  const s = new Session({ session: 's_u', role: 'r', team: 't', prompt: { brief: '**Model:** light' } }, { root: '/nonexistent', tiers: { light: 'claude-not-in-the-table' }, emit: async (_s, type, data) => sent.push({ type, data }) });
  assert.equal(s.model, 'claude-not-in-the-table');
  await s.record(free.usage, { last: true });
  const rec = sent.find((e) => e.type === 'usage.recorded');
  assert.equal(rec.data.model, 'claude-not-in-the-table');
  assert.equal(rec.data.cost, Math.ceil(dearest * 100 - 1e-9), 'counted in whole cents at the dearest listed price');
  assert.ok(rec.data.cost > 0);

  const model = (brief, deps = {}) => new Session({ session: 's', role: 'r', team: 't', prompt: { brief } }, { root: '/nonexistent', ...deps }).model;
  assert.equal(model('**Model:** light'), PRICES.tiers.light);
  assert.equal(model('**Model:** deep'), PRICES.tiers.deep);
  assert.equal(model('no tier line'), PRICES.tiers.standard, 'no tier: standard');
  assert.equal(model('**Model:** light', { tiers: { light: 'claude-other' } }), 'claude-other', 'the runner config overrides a tier');
});

test('ADR 0013: an approved call runs as signed: the PreToolUse hook and canUseTool hand the policy\'s input to the SDK', async () => {
  const signed = { command: 'deploy.sh --production' };
  const seen = {};
  const sdk = {
    tool, createSdkMcpServer,
    query: ({ options }) => (async function* () {
      const [guard] = options.hooks.PreToolUse[0].hooks;
      seen.hook = await guard({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'deploy.sh --production', description: 'mine' } });
      seen.denied = await guard({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf /' } });
      seen.can = await options.canUseTool('Bash', { command: 'deploy.sh --production', description: 'mine' });
      seen.plain = await options.canUseTool('Read', { file_path: 'x' });
      yield { type: 'result', session_id: 'sdk-1', usage: {}, total_cost_usd: 0 };
    })(),
  };
  await agentSdkAdapter({ sdk }).turn({
    env: { ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/s/x' }, signal: new AbortController().signal, tools: [], callTool: async () => ({ text: '' }), prompt: 'go', systemPrompt: '',
    preToolUse: async (name, input) => (name === 'Read' ? { allow: true } : input.command === signed.command ? { allow: true, input: { ...signed } } : { allow: false, reason: 'no' }),
  });
  assert.deepEqual(seen.hook.hookSpecificOutput.updatedInput, signed, 'the hook replaces the model\'s input with the signed one');
  assert.equal(seen.hook.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(seen.denied.hookSpecificOutput.updatedInput, undefined, 'a refusal carries no input');
  assert.deepEqual(seen.can, { behavior: 'allow', updatedInput: signed });
  assert.deepEqual(seen.plain, { behavior: 'allow', updatedInput: { file_path: 'x' } }, 'a call with no signed record runs as given');
});
