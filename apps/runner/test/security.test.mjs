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

test('binary files are scanned too: a session credential inside one is not pushed', async () => {
  const { bare, root } = origin();
  const w = await prepare({ root, repo: { url: bare }, worktree: 'web/bin', session: 'bin' });
  mkdirSync(join(w.cwd, 'web'));
  writeFileSync(join(w.cwd, 'web', 'logo.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), Buffer.from('sess-proxytoken-abc123456'), Buffer.alloc(64)]));
  agentGit(w.cwd, 'add', '-A'); agentGit(w.cwd, 'commit', '-qm', 'logo');
  let r = await checkpoint({ cwd: w.cwd, branch: 'web/bin', role: 'web-dev', reason: 't', areas: ['web/'], secrets: ['sess-proxytoken-abc123456'] });
  assert.equal(r.refused?.rule, 'secret-scan');
  assert.match(r.error, /web\/logo\.png: a session credential/);
  // A clean binary goes.
  agentGit(w.cwd, 'reset', '-q', '--hard', 'HEAD~1');
  mkdirSync(join(w.cwd, 'web'), { recursive: true });
  writeFileSync(join(w.cwd, 'web', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2, 3]));
  r = await checkpoint({ cwd: w.cwd, branch: 'web/bin', role: 'web-dev', reason: 't', areas: ['web/'], secrets: ['sess-proxytoken-abc123456'] });
  assert.equal(r.pushed, true, r.error);
  release(w.cwd, 'bin');
});

test('when the remote cannot be reached, the push is refused and the session is told not to push another way', async () => {
  const { bare, root } = origin();
  const w = await prepare({ root, repo: { url: bare }, worktree: 'web/off', session: 'off' });
  mkdirSync(join(w.cwd, 'web'));
  writeFileSync(join(w.cwd, 'web', 'a.txt'), 'a\n');
  execFileSync('mv', [bare, `${bare}.gone`]);
  const r = await checkpoint({ cwd: w.cwd, branch: 'web/off', role: 'web-dev', reason: 't', areas: ['web/'] });
  execFileSync('mv', [`${bare}.gone`, bare]);
  assert.equal(r.pushed, false);
  assert.equal(r.refused?.rule, 'remote-unreachable');
  assert.match(r.error, /Do not push another way/);
  release(w.cwd, 'off');
});

// Needs root (to switch uid without the container's capability-carrying setpriv) and setpriv; skips otherwise.
// In the container image (CI's runner-image job) it runs as the runner user with the image's own sandbox settings.
// The image gives a pool (AGENT_TEAM_SANDBOX_UIDS); this test uses its first agent user with the shared group.
const IMAGE = process.env.AGENT_TEAM_SANDBOX_EXEC ? { uid: Number(process.env.AGENT_TEAM_SANDBOX_UID ?? /^\d+/.exec(process.env.AGENT_TEAM_SANDBOX_UIDS ?? '')?.[0]), gid: Number(process.env.AGENT_TEAM_SANDBOX_GID), exec: process.env.AGENT_TEAM_SANDBOX_EXEC } : null;
const canSwitch = !!IMAGE || (process.getuid?.() === 0 && (() => { try { execFileSync('setpriv', ['--version']); return true; } catch { return false; } })());
test('F3: a session runs as another user and cannot read the runner\'s environment or data folder', { skip: canSwitch ? false : 'needs root and setpriv to switch users (the container image has both)' }, async () => {
  const { Session } = await import('../session.mjs');
  const { sandboxSpawn, privateDir } = await import('../sandbox.mjs');
  const { mkdtempSync, chmodSync: chmod, readFileSync: read } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { bare } = origin();
  const top = mkdtempSync(join(tmpdir(), 'runner-f3-'));
  chmod(top, 0o711);
  const root = join(top, 'data'), work = join(top, 'work');
  privateDir(root);
  writeFileSync(join(root, 'runner.json'), '{"key":"rk_live_secret"}', { mode: 0o600 });
  const sandbox = IMAGE ?? { uid: 10002, gid: 10010, exec: 'setpriv' };
  const umask = process.umask(0o007);
  // A stand-in runner process with a secret in its environment (what /proc/<pid>/environ shows is the environment
  // a process started with, so it has to be a process of its own).
  const { spawn: run } = await import('node:child_process');
  const holder = run('sleep', ['60'], { env: { PATH: process.env.PATH, RUNNER_F3_MARKER: 'sk-ant-f3-marker-0123456789abcdef' }, stdio: 'ignore' });
  try {
    const s = new Session({ session: 'ses_f3', role: 'web-dev', team: 't', repo: { url: bare }, worktree: 'web/f3', areas: ['web/'] }, { root, work, sandbox, emit: async () => {}, adapter: { turn: async () => ({}) } });
    s.pump = () => {};
    await s.start();
    const asAgent = (script) => new Promise((done) => {
      const c = sandboxSpawn(sandbox)({ command: '/bin/sh', args: ['-c', script], cwd: s.copy.cwd, env: s.env });
      let out = ''; c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (out += d));
      c.stdin.end(); c.on('close', (code) => done({ code, out }));
    });
    const who = await asAgent('id -u');
    assert.equal(who.out.trim(), String(sandbox.uid));
    assert.match((await asAgent('grep CapEff /proc/self/status')).out, /CapEff:\s+0+\n/, 'no capabilities');
    assert.match(read(`/proc/${holder.pid}/environ`, 'utf8'), /sk-ant-f3-marker/, 'the stand-in holds the marker');
    const env = await asAgent(`cat /proc/${holder.pid}/environ; cat /proc/1/environ; cat /proc/${process.pid}/environ`);
    assert.equal(env.code === 0, false, 'reading another user\'s environ fails');
    assert.ok(!env.out.includes('sk-ant-'), 'the runner\'s environment is out of reach');
    const data = await asAgent(`cat ${join(root, 'runner.json')}; ls ${root}`);
    assert.notEqual(data.code, 0);
    assert.ok(!data.out.includes('rk_live_secret'));
    if (IMAGE) {
      const own = process.env.AGENT_TEAM_RUNNER_DATA;
      assert.ok(own, 'the image sets AGENT_TEAM_RUNNER_DATA');
      assert.notEqual((await asAgent(`ls ${own}`)).code, 0, 'the runner\'s own folder in the image is closed to the agent');
    }
    // The capability-carrying setpriv is the runner's alone.
    if (IMAGE) assert.match((await asAgent(`${IMAGE.exec} --reuid=0 id`)).out, /Permission denied/);
    // It can work in its copy and commit with git; the runner then checks and pushes what it made.
    const wrote = await asAgent('mkdir -p web && echo hi > web/a.txt && git add web/a.txt && git commit -qm "from the agent" && git log --oneline -1');
    assert.equal(wrote.code, 0, wrote.out);
    const r = await s.checkpoint('t');
    assert.equal(r.pushed, true, r.problem);
    assert.equal(sh(bare, 'show', 'web/f3:web/a.txt'), 'hi');
    // A .git the agent replaces is not trusted.
    await asAgent('mv .git .git-old && cp -r .git-old .git');
    assert.match((await s.checkpoint('t')).problem ?? '', /replaced by the session/);
    assert.equal(read(join(root, 'runner.json'), 'utf8').includes('rk_live'), true);
  } finally {
    process.umask(umask);
    holder.kill();
  }
});

test('F3: stopping a sandboxed session signals its whole process group through setpriv, then SIGKILL', async () => {
  const { sandboxSpawn } = await import('../sandbox.mjs');
  const { mkdtempSync, readFileSync: read, chmodSync: chmod } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  // A stand-in setpriv that records how it was called and runs the command after `--` as the same user.
  const dir = mkdtempSync(join(tmpdir(), 'runner-kill-'));
  const log = join(dir, 'calls'), fake = join(dir, 'setpriv');
  writeFileSync(fake, `#!/bin/sh\necho "$*" >> ${log}\nwhile [ "$1" != "--" ]; do shift; done; shift\nexec "$@"\n`);
  chmod(fake, 0o755);
  const sandbox = { uid: 10002, gid: 10010, exec: fake };
  const child = sandboxSpawn(sandbox, { grace: 300 })({ command: '/bin/sh', args: ['-c', 'trap "" TERM; sleep 30 & echo $!; wait'], cwd: dir, env: { PATH: process.env.PATH } });
  const grandchild = await new Promise((r) => child.stdout.once('data', (d) => r(Number(String(d).trim()))));
  const exited = new Promise((r) => child.on('exit', r));
  assert.equal(child.kill('SIGTERM'), true);
  await exited;
  const calls = read(log, 'utf8').trim().split('\n');
  assert.ok(calls.some((c) => c.endsWith(`kill TERM ${child.pid}`)), calls.join('\n'));
  assert.ok(calls.some((c) => c.endsWith(`kill KILL ${child.pid}`)), 'SIGKILL after the grace period');
  assert.ok(calls.every((c) => c.startsWith('--reuid=10002 --regid=10010')), 'as the agent');
  await new Promise((r) => setTimeout(r, 100));
  // Gone, or a zombie waiting for init to reap it: either way it no longer runs.
  let state = 'gone';
  try { state = read(`/proc/${grandchild}/stat`, 'utf8').split(') ')[1][0]; } catch {}
  assert.ok(['gone', 'Z'].includes(state), `the group is gone, children included (state ${state})`);
});

test('G1: the runner never follows a link the agent planted in its home, memory folder or .git', async () => {
  const { Session } = await import('../session.mjs');
  const { sharedDir } = await import('../sandbox.mjs');
  const { readFileSync: read, rmSync: rm, symlinkSync: link, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { bare, root } = origin();
  const outside = mkdtempSync(join(tmpdir(), 'runner-outside-'));
  const secretFile = join(outside, 'environ'), target = join(outside, 'gitconfig');
  writeFileSync(secretFile, 'AGENT_TEAM_RUNNER_KEY=rnr_abcdefghijkl.abcdefghijklmnopqrstuvwxyz0123456789ABCD\n');
  writeFileSync(target, '[credential]\n\thelper = store\n');
  const start = () => { const s = new Session({ session: 'ses_g1', role: 'web-dev', team: 't', repo: { url: bare }, worktree: 'web/g1', areas: ['web/'] }, { root, emit: async () => {}, adapter: { turn: async () => ({}) }, runnerKey: 'rnr_abcdefghijkl.abcdefghijklmnopqrstuvwxyz0123456789ABCD' }); s.pump = () => {}; return s; };
  let s = start();
  await s.start();
  // Reading: the memory file becomes a link to something the runner can read and the agent cannot.
  rm(s.memoryPath); link(secretFile, s.memoryPath);
  let r = await s.checkpoint('t');
  assert.equal(r.memory, '', 'nothing read through the link');
  assert.match(r.problem, /memory file was not sent: it is a link/);
  // Writing: on the next start, .gitconfig and the memory file are links to the runner's own files.
  await s.stop('now', 't');
  rm(join(s.home, '.gitconfig')); link(target, join(s.home, '.gitconfig'));
  s = start();
  await s.start();
  assert.equal(read(target, 'utf8'), '[credential]\n\thelper = store\n', 'the runner did not write through the link');
  assert.equal(s.state, 'ended', 'the session does not start on a planted link');
  // .git: a link in it, or .git/config as a link, is refused or replaced without touching the target.
  const { prepare: prep, checkpoint: save, release: rel } = await import('../worktree.mjs');
  const w = await prep({ root, repo: { url: bare }, worktree: 'web/g1b', session: 'g1b' });
  rm(join(w.cwd, '.git', 'config')); link(target, join(w.cwd, '.git', 'config'));
  await assert.rejects(() => save({ cwd: w.cwd, branch: 'web/g1b', role: 'r', reason: 't', areas: ['web/'] }), /is a link/);
  assert.equal(read(target, 'utf8'), '[credential]\n\thelper = store\n');
  rel(w.cwd, 'g1b');
  // sharedDir refuses a folder that is a link.
  link(outside, join(root, 'planted'));
  assert.throws(() => sharedDir(join(root, 'planted'), null), /ELOOP|ENOTDIR|not a folder/);
  // The runner key is a secret like the others.
  assert.deepEqual(findSecrets({ text: 'rnr_abcdefghijkl.abcdefghijklmnopqrstuvwxyz0123456789ABCD' }), ['memory: runner key']);
});

test('F3: when the leader exits (on TERM, or at a normal end), the rest of its group is killed too', async () => {
  const { sandboxSpawn } = await import('../sandbox.mjs');
  const { mkdtempSync, readFileSync: read, chmodSync: chmod } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'runner-kill2-'));
  const fake = join(dir, 'setpriv');
  writeFileSync(fake, '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done; shift\nexec "$@"\n');
  chmod(fake, 0o755);
  const gone = (pid) => { try { return read(`/proc/${pid}/stat`, 'utf8').split(') ')[1][0] === 'Z'; } catch { return true; } };
  for (const [name, script, stop] of [['TERM', '(trap "" TERM; exec sleep 30) & echo $!; wait', true], ['normal end', '(trap "" TERM; exec sleep 30) & echo $!; exit 0', false]]) {
    const child = sandboxSpawn({ uid: 10002, gid: 10010, exec: fake }, { grace: 60000 })({ command: '/bin/sh', args: ['-c', script], cwd: dir, env: { PATH: process.env.PATH } });
    const bg = await new Promise((r) => child.stdout.once('data', (d) => r(Number(String(d).trim()))));
    const exited = new Promise((r) => child.on('exit', r));
    if (stop) child.kill('SIGTERM');
    await exited;
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(gone(bg), `${name}: the background command is gone`);
  }
});

test('F3: the runner refuses to start with a model key and no sandbox, unless told it is development', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const data = mkdtempSync(join(tmpdir(), 'runner-gate-'));
  const env = { PATH: process.env.PATH, HOME: data, AGENT_TEAM_RUNNER_DATA: data, AGENT_TEAM_SERVER: 'http://127.0.0.1:9', AGENT_TEAM_RUNNER_KEY: 'rnr_x.y', ANTHROPIC_API_KEY: 'sk-ant-test-not-a-real-key-0123456789' };
  const bin = new URL('../bin.mjs', import.meta.url).pathname;
  const r = spawnSync(process.execPath, [bin, 'start'], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /refusing to start: ANTHROPIC_API_KEY is set but there is no sandbox/);
  // With the development override it gets past the gate (and then fails to reach the made-up server, which is fine).
  const dev = spawnSync(process.execPath, [bin, 'start'], { env: { ...env, AGENT_TEAM_RUNNER_UNSANDBOXED: '1' }, encoding: 'utf8', timeout: 1500 });
  assert.doesNotMatch(dev.stderr, /refusing to start/);
});

test('the startup self-check refuses a sandbox that does not hold', async () => {
  const { selfCheck, privateDir } = await import('../sandbox.mjs');
  const { mkdtempSync, chmodSync: chmod } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'runner-check-'));
  chmod(dir, 0o711);
  const data = join(dir, 'data');
  privateDir(data);
  // A setpriv that does not switch users: the "agent" is the runner, so everything is readable.
  const fake = join(dir, 'setpriv');
  writeFileSync(fake, '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done; shift\nexec "$@"\n');
  chmod(fake, 0o755);
  const bad = selfCheck({ uid: 10002, gid: 10010, exec: fake }, { data });
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((p) => /environment is readable/.test(p)), bad.problems.join('; '));
  assert.ok(bad.problems.some((p) => /data folder is readable/.test(p)), bad.problems.join('; '));
  assert.ok(bad.problems.some((p) => /runs as uid/.test(p)), bad.problems.join('; '));
  // A real switch (root with setpriv here, the runner user with the image's setpriv in the container) holds.
  if (canSwitch) {
    const good = selfCheck(IMAGE ?? { uid: 10002, gid: 10010, exec: 'setpriv' }, { data });
    assert.deepEqual(good.problems, []);
  }
});
