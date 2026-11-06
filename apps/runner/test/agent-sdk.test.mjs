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
  await assert.rejects(a.turn({ env: { PATH: process.env.PATH }, signal: new AbortController().signal, tools: [], callTool: () => {}, preToolUse: () => {}, get prompt() { loaded = true; return ''; } }), /no model key/);
  assert.equal(loaded, false, 'nothing was started');
});

test('a session gets the model key only from the runner\'s own environment, and nothing else of it but the toolchain', async () => {
  const { Session } = await import('../session.mjs');
  const saved = { ...process.env };
  try {
    process.env.ANTHROPIC_API_KEY = 'sk-test-runner-own';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'ambient';
    process.env.AGENT_TEAM_RUNNER_KEY = 'rk_secret';
    process.env.GITHUB_TOKEN = 'ghp_ambient';
    const { origin } = await import('./helpers.mjs');
    const { bare, root } = origin();
    const s = new Session({ session: 'ses_env', role: 'web-dev', team: 't', repo: { url: bare } }, { root, emit: async () => {}, adapter: { turn: async () => ({}) } });
    s.pump = () => {};
    await s.start();
    assert.equal(s.env.ANTHROPIC_API_KEY, 'sk-test-runner-own');
    for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'AGENT_TEAM_RUNNER_KEY', 'GITHUB_TOKEN']) assert.equal(s.env[k], undefined, k);
    delete process.env.ANTHROPIC_API_KEY;
    const t = new Session({ session: 'ses_env2', role: 'web-dev', team: 't', repo: { url: bare } }, { root, emit: async () => {}, adapter: { turn: async () => ({}) } });
    t.pump = () => {};
    await t.start();
    assert.equal(t.env.ANTHROPIC_API_KEY, undefined);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
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
