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

const key = process.env.ANTHROPIC_API_KEY;
test('smoke: a real model reports through the team tools', { skip: key ? false : 'skipped: set ANTHROPIC_API_KEY to run the real-model smoke test (it costs a few cents)' }, async () => {
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
