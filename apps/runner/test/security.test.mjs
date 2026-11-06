// Proofs for the security review of PR #42 (R1 is in agent-sdk.test.mjs). The agent is the untrusted part: each
// test plays an agent whose shell is under someone else's control.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { checkpoint, git, prepare, release } from '../worktree.mjs';
import { agentSdkAdapter } from '../adapters/agent-sdk.mjs';
import { findSecrets, redactSecrets } from '../secrets.mjs';
import { origin, sh } from './helpers.mjs';

const agentGit = (cwd, ...a) => execFileSync('git', a, { cwd, env: { PATH: process.env.PATH, HOME: cwd, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@a', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@a' } });

test('R2: a planted pre-push hook, core.fsmonitor and a credential helper do not run on checkpoint', async () => {
  const { bare, root } = origin();
  const w = await prepare({ root, repo: { url: bare }, worktree: 'web/r2', session: 'r2' });
  const pwned = join(root, 'pwned');
  const script = join(root, 'evil.sh');
  writeFileSync(script, `#!/bin/sh\necho "$@ $AGENT_TEAM_RUNNER_KEY" >> ${pwned}\nexit 0\n`);
  chmodSync(script, 0o755);
  // What an agent's shell can do to its own clone.
  writeFileSync(join(w.cwd, '.git', 'hooks', 'pre-push'), `#!/bin/sh\n${script} pre-push\n`); chmodSync(join(w.cwd, '.git', 'hooks', 'pre-push'), 0o755);
  writeFileSync(join(w.cwd, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\n${script} pre-commit\n`); chmodSync(join(w.cwd, '.git', 'hooks', 'pre-commit'), 0o755);
  agentGit(w.cwd, 'config', 'core.fsmonitor', script);
  agentGit(w.cwd, 'config', 'core.hooksPath', join(w.cwd, '.git', 'hooks'));
  agentGit(w.cwd, 'config', 'credential.helper', `!${script} credential`);
  agentGit(w.cwd, 'config', 'remote.origin.pushurl', join(root, 'elsewhere.git'));
  process.env.AGENT_TEAM_RUNNER_KEY = 'rk_must_not_leak';
  try {
    mkdirSync(join(w.cwd, 'web'));
    writeFileSync(join(w.cwd, 'web', 'a.txt'), 'x\n');
    const r = await checkpoint({ cwd: w.cwd, branch: 'web/r2', base: 'main', role: 'web-dev', reason: 't', areas: ['web/'] });
    assert.equal(r.pushed, true, r.error);
    assert.equal(existsSync(pwned), false, 'nothing the agent planted ran');
    assert.equal(sh(bare, 'show', 'web/r2:web/a.txt'), 'x', 'pushed to the real origin, not the planted pushurl');
    assert.equal(existsSync(join(root, 'elsewhere.git')), false);
  } finally {
    delete process.env.AGENT_TEAM_RUNNER_KEY;
    release(w.cwd, 'r2');
  }
});

test('R2: sessions share no git directory, so one cannot plant a hook in another', async () => {
  const { bare, root } = origin();
  const a = await prepare({ root, repo: { url: bare }, worktree: 'a/1', session: 'sa' });
  const b = await prepare({ root, repo: { url: bare }, worktree: 'b/1', session: 'sb' });
  assert.notEqual(await git(a.cwd, 'rev-parse', '--absolute-git-dir'), await git(b.cwd, 'rev-parse', '--absolute-git-dir'));
  assert.equal(existsSync(join(a.cwd, '.git', 'objects', 'info', 'alternates')), false, 'no alternates into the cache');
});

test('R3: the Agent SDK gets no project settings, only the runner\'s env, and the policy on every tool', async () => {
  let options;
  const sdk = {
    tool: (name, description, shape, handler) => ({ name, description, shape, handler }),
    createSdkMcpServer: (o) => ({ type: 'sdk', ...o }),
    query: ({ options: o }) => { options = o; return (async function* () { yield { type: 'result', subtype: 'success', session_id: 'x', usage: {}, total_cost_usd: 0, result: '' }; })(); },
  };
  const env = { PATH: '/bin', HOME: '/tmp/h', ANTHROPIC_API_KEY: 'sess-token', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/s/x' };
  await agentSdkAdapter({ sdk }).turn({ env, cwd: '/tmp', prompt: 'p', systemPrompt: 's', signal: new AbortController().signal, tools: [], mcp: {}, callTool: async () => ({ text: '' }), preToolUse: async () => ({ allow: false, reason: 'no' }) });
  assert.deepEqual(options.settingSources, [], 'a branch\'s .claude settings, hooks and .mcp.json are not loaded');
  assert.equal(options.env, env, 'the session env replaces the process env');
  assert.equal(options.hooks.PreToolUse.length, 1);
  assert.deepEqual(await options.canUseTool('Bash', {}), { behavior: 'deny', message: 'no' });
  const out = await options.hooks.PreToolUse[0].hooks[0]({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});

test('R4: a shell write outside the owned areas never leaves, even when the agent commits it itself', async () => {
  const { bare, root } = origin();
  const w = await prepare({ root, repo: { url: bare }, worktree: 'web/r4', session: 'r4' });
  mkdirSync(join(w.cwd, 'web'));
  writeFileSync(join(w.cwd, 'web', 'ok.txt'), 'mine\n');
  writeFileSync(join(w.cwd, 'server.mjs'), 'not mine\n');
  mkdirSync(join(w.cwd, '.claude'));
  writeFileSync(join(w.cwd, '.claude', 'settings.json'), '{"hooks":{}}');
  const r = await checkpoint({ cwd: w.cwd, branch: 'web/r4', base: 'main', role: 'web-dev', reason: 't', areas: ['web/'] });
  assert.equal(r.pushed, true);
  assert.deepEqual(r.held.sort(), ['.claude/settings.json', 'server.mjs']);
  agentGit(w.cwd, 'add', '-A'); agentGit(w.cwd, 'commit', '-qm', 'from the shell');
  const again = await checkpoint({ cwd: w.cwd, branch: 'web/r4', base: 'main', role: 'web-dev', reason: 't', areas: ['web/'] });
  assert.equal(again.pushed, false);
  assert.equal(again.refused.rule, 'ownership');
  assert.throws(() => sh(bare, 'show', 'web/r4:server.mjs'));
  // An area that covers everything still does not cover .claude/ unless it names it.
  const all = await checkpoint({ cwd: w.cwd, branch: 'web/r4', base: 'main', role: 'web-dev', reason: 't', areas: ['**'] });
  assert.deepEqual(all.refused?.items, ['.claude/settings.json']);
  release(w.cwd, 'r4');
});

test('R4: secrets, key files and escaping symlinks are never pushed; the memory file is redacted', async () => {
  const { bare, root } = origin();
  const w = await prepare({ root, repo: { url: bare }, worktree: 'web/r4b', session: 'r4b' });
  mkdirSync(join(w.cwd, 'web'));
  writeFileSync(join(w.cwd, 'web', '.env'), 'API=1\n');
  let r = await checkpoint({ cwd: w.cwd, branch: 'web/r4b', base: 'main', role: 'web-dev', reason: 't', areas: ['web/'] });
  assert.equal(r.refused.rule, 'secret-scan');
  assert.equal(r.pushed, false);
  assert.equal(await git(w.cwd, 'diff', '--cached', '--name-only'), '', 'nothing left staged');
  execFileSync('rm', [join(w.cwd, 'web', '.env')]);
  writeFileSync(join(w.cwd, 'web', 'config.js'), "export const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123';\n");
  r = await checkpoint({ cwd: w.cwd, branch: 'web/r4b', base: 'main', role: 'web-dev', reason: 't', areas: ['web/'] });
  assert.match(r.error, /anthropic key/);
  writeFileSync(join(w.cwd, 'web', 'config.js'), "export const token = 'sess-proxytoken-abc123456';\n");
  r = await checkpoint({ cwd: w.cwd, branch: 'web/r4b', base: 'main', role: 'web-dev', reason: 't', areas: ['web/'], secrets: ['sess-proxytoken-abc123456'] });
  assert.match(r.error, /a session credential/);
  execFileSync('rm', [join(w.cwd, 'web', 'config.js')]);
  symlinkSync('../../../../', join(w.cwd, 'web', 'escape'));
  r = await checkpoint({ cwd: w.cwd, branch: 'web/r4b', base: 'main', role: 'web-dev', reason: 't', areas: ['web/'] });
  assert.deepEqual(r.held, ['web/escape'], 'an escaping symlink is not committed');
  agentGit(w.cwd, 'add', '-A'); agentGit(w.cwd, 'commit', '-qm', 'link');
  r = await checkpoint({ cwd: w.cwd, branch: 'web/r4b', base: 'main', role: 'web-dev', reason: 't', areas: ['web/'] });
  assert.equal(r.refused.rule, 'symlink');
  assert.deepEqual(findSecrets({ text: 'note: ghp_abcdefghijklmnopqrstuvwxyz0123456789' }), ['memory: github token']);
  assert.equal(redactSecrets('use ghp_abcdefghijklmnopqrstuvwxyz0123456789 and sess-x12345678', ['sess-x12345678']), 'use [redacted] and [redacted]');
  release(w.cwd, 'r4b');
});
