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

test('F1: moving or deleting origin/<base> in the clone does not shrink what the checkpoint checks', async () => {
  const { bare, root } = origin();
  const w = await prepare({ root, repo: { url: bare }, worktree: 'web/f1', session: 'f1' });
  writeFileSync(join(w.cwd, 'server.mjs'), 'not mine\n');
  agentGit(w.cwd, 'add', '-A'); agentGit(w.cwd, 'commit', '-qm', 'outside');
  agentGit(w.cwd, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  let r = await checkpoint({ cwd: w.cwd, branch: 'web/f1', role: 'web-dev', reason: 't', areas: ['web/'] });
  assert.equal(r.refused?.rule, 'ownership', 'a moved base ref is ignored');
  agentGit(w.cwd, 'update-ref', '-d', 'refs/remotes/origin/main');
  r = await checkpoint({ cwd: w.cwd, branch: 'web/f1', role: 'web-dev', reason: 't', areas: ['web/'] });
  assert.equal(r.refused?.rule, 'ownership', 'a deleted base ref is ignored');
  // When the history cannot be read at all, nothing is pushed.
  agentGit(w.cwd, 'replace', '--graft', 'HEAD');
  execFileSync('rm', ['-rf', join(w.cwd, '.git', 'objects')]); mkdirSync(join(w.cwd, '.git', 'objects'));
  r = await checkpoint({ cwd: w.cwd, branch: 'web/f1', role: 'web-dev', reason: 't', areas: ['**'] }).catch((e) => ({ thrown: e }));
  assert.ok(r.thrown || r.pushed === false, 'fails closed');
  assert.throws(() => sh(bare, 'show', 'web/f1:server.mjs'));
  release(w.cwd, 'f1');
});

test('F2: a secret or outside path committed and later removed is still caught, and so is one in a commit message', async () => {
  const { bare, root } = origin();
  const w = await prepare({ root, repo: { url: bare }, worktree: 'web/f2', session: 'f2' });
  mkdirSync(join(w.cwd, 'web'));
  writeFileSync(join(w.cwd, 'web', 'a.js'), "const k = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123';\n");
  agentGit(w.cwd, 'add', '-A'); agentGit(w.cwd, 'commit', '-qm', 'add');
  writeFileSync(join(w.cwd, 'web', 'a.js'), 'const k = process.env.K;\n');
  agentGit(w.cwd, 'add', '-A'); agentGit(w.cwd, 'commit', '-qm', 'remove');
  let r = await checkpoint({ cwd: w.cwd, branch: 'web/f2', role: 'web-dev', reason: 't', areas: ['web/'] });
  assert.equal(r.refused?.rule, 'secret-scan');
  assert.match(r.error, /web\/a\.js: anthropic key/);
  assert.throws(() => sh(bare, 'rev-parse', '--verify', 'refs/heads/web/f2'));

  const v = await prepare({ root, repo: { url: bare }, worktree: 'web/f2b', session: 'f2b' });
  writeFileSync(join(v.cwd, 'server.mjs'), 'x\n');
  agentGit(v.cwd, 'add', '-A'); agentGit(v.cwd, 'commit', '-qm', 'outside');
  agentGit(v.cwd, 'rm', '-q', 'server.mjs'); agentGit(v.cwd, 'commit', '-qm', 'gone');
  r = await checkpoint({ cwd: v.cwd, branch: 'web/f2b', role: 'web-dev', reason: 't', areas: ['web/'] });
  assert.equal(r.refused?.rule, 'ownership', 'a path touched in any commit counts');

  const m = await prepare({ root, repo: { url: bare }, worktree: 'web/f2c', session: 'f2c' });
  mkdirSync(join(m.cwd, 'web'));
  writeFileSync(join(m.cwd, 'web', 'ok.txt'), 'fine\n');
  agentGit(m.cwd, 'add', '-A'); agentGit(m.cwd, 'commit', '-qm', 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  r = await checkpoint({ cwd: m.cwd, branch: 'web/f2c', role: 'web-dev', reason: 't', areas: ['web/'] });
  assert.equal(r.refused?.rule, 'secret-scan');
  assert.match(r.error, /commit message: github token/);
  // A clean branch still goes.
  const ok = await prepare({ root, repo: { url: bare }, worktree: 'web/f2d', session: 'f2d' });
  mkdirSync(join(ok.cwd, 'web'));
  writeFileSync(join(ok.cwd, 'web', 'ok.txt'), 'fine\n');
  r = await checkpoint({ cwd: ok.cwd, branch: 'web/f2d', role: 'web-dev', reason: 't', areas: ['web/'] });
  assert.equal(r.pushed, true);
  for (const [c, s] of [[w, 'f2'], [v, 'f2b'], [m, 'f2c'], [ok, 'f2d']]) release(c.cwd, s);
});

test('F4: the model proxy forwards only the messages API', async () => {
  const { startModelProxy } = await import('../modelproxy.mjs');
  const { createServer } = await import('node:http');
  const seen = [];
  const upstream = createServer((req, res) => { seen.push(`${req.method} ${req.url}`); res.writeHead(200); res.end('{}'); });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const proxy = startModelProxy({ upstream: `http://127.0.0.1:${upstream.address().port}`, key: () => 'sk-ant-test-0123456789abcdefghij' });
  await proxy.ready;
  try {
    const { baseUrl, token } = proxy.register('s');
    const call = (method, path) => fetch(`${baseUrl}${path}`, { method, headers: { 'x-api-key': token }, body: method === 'POST' ? '{}' : undefined }).then((r) => r.status);
    assert.equal(await call('POST', '/v1/messages'), 200);
    assert.equal(await call('POST', '/v1/messages/count_tokens?beta=true'), 200);
    for (const [method, path] of [['GET', '/v1/models'], ['POST', '/v1/files'], ['POST', '/v1/messages/batches'], ['GET', '/v1/organizations/me'], ['POST', '/v1/messages/../files']]) assert.equal(await call(method, path), 403, `${method} ${path}`);
    assert.deepEqual(seen, ['POST /v1/messages', 'POST /v1/messages/count_tokens?beta=true']);
  } finally { await proxy.close(); upstream.close(); }
});

/** Someone else lands a change on the origin's main. */
function landOnMain(bare, path, text) {
  const dir = join(bare, '..', `other-${Math.random().toString(36).slice(2)}`);
  execFileSync('git', ['clone', '--quiet', bare, dir]);
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), text);
  sh(dir, 'add', '-A'); sh(dir, 'commit', '--quiet', '-m', `land ${path}`); sh(dir, 'push', '--quiet', 'origin', 'main');
}

test('base moves: what lands on main mid-session or before a resume is not counted as the branch\'s change', async () => {
  const { bare, root } = origin();
  let w = await prepare({ root, repo: { url: bare }, worktree: 'web/mv', session: 'mv1' });
  mkdirSync(join(w.cwd, 'web'));
  writeFileSync(join(w.cwd, 'web', 'a.txt'), 'a\n');
  assert.equal((await checkpoint({ cwd: w.cwd, branch: 'web/mv', role: 'web-dev', reason: 't', areas: ['web/'] })).pushed, true);
  // main moves while the session runs; the agent merges it in.
  landOnMain(bare, 'server/b.txt', 'b\n');
  writeFileSync(join(w.cwd, 'web', 'a.txt'), 'a2\n');
  let r = await checkpoint({ cwd: w.cwd, branch: 'web/mv', role: 'web-dev', reason: 't', areas: ['web/'] });
  assert.equal(r.pushed, true, r.error);
  agentGit(w.cwd, 'fetch', '-q', bare, 'main'); agentGit(w.cwd, 'merge', '-q', '--no-edit', 'FETCH_HEAD');
  r = await checkpoint({ cwd: w.cwd, branch: 'web/mv', role: 'web-dev', reason: 't', areas: ['web/'] });
  assert.equal(r.pushed, true, r.error);
  release(w.cwd, 'mv1');
  // main moves again; a later session resumes the branch without merging it.
  landOnMain(bare, 'server/c.txt', 'c\n');
  w = await prepare({ root, repo: { url: bare }, worktree: 'web/mv', session: 'mv2' });
  assert.equal(w.resumed, true);
  writeFileSync(join(w.cwd, 'web', 'a.txt'), 'a3\n');
  r = await checkpoint({ cwd: w.cwd, branch: 'web/mv', role: 'web-dev', reason: 't', areas: ['web/'] });
  assert.equal(r.pushed, true, r.error);
  // A change of its own outside the areas is still refused.
  writeFileSync(join(w.cwd, 'server', 'b.txt'), 'mine now\n');
  agentGit(w.cwd, 'add', '-A'); agentGit(w.cwd, 'commit', '-qm', 'outside');
  r = await checkpoint({ cwd: w.cwd, branch: 'web/mv', role: 'web-dev', reason: 't', areas: ['web/'] });
  assert.deepEqual(r.refused?.items, ['server/b.txt']);
  release(w.cwd, 'mv2');
});

test('an added line that starts with "++ " is still scanned', async () => {
  const { bare, root } = origin();
  const w = await prepare({ root, repo: { url: bare }, worktree: 'web/pp', session: 'pp' });
  mkdirSync(join(w.cwd, 'web'));
  writeFileSync(join(w.cwd, 'web', 'n.md'), 'intro\n++ sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123\n');
  agentGit(w.cwd, 'add', '-A'); agentGit(w.cwd, 'commit', '-qm', 'notes');
  const r = await checkpoint({ cwd: w.cwd, branch: 'web/pp', role: 'web-dev', reason: 't', areas: ['web/'] });
  assert.equal(r.refused?.rule, 'secret-scan');
  release(w.cwd, 'pp');
});
