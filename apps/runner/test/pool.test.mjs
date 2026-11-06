// Each session its own agent user (#28, before a runner serves more than one customer), with the security review's
// conditions: A (no agent user owns anything in a copy it no longer holds; nothing runs as an agent user that holds
// another's group), B (no link is followed), C (every process, temporary file and IPC object of the user goes at the
// end), E (one shared user serves one team), F (a slot is checked empty before it is used again).
// Needs root and setpriv (or the container image, whose runner user is in every slot's group); skips otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { origin } from './helpers.mjs';

const IMAGE = process.env.AGENT_TEAM_SANDBOX_UIDS && process.env.AGENT_TEAM_SANDBOX_EXEC
  ? { uids: process.env.AGENT_TEAM_SANDBOX_UIDS, gid: Number(process.env.AGENT_TEAM_SANDBOX_GID), exec: process.env.AGENT_TEAM_SANDBOX_EXEC } : null;
const canSwitch = !!IMAGE || (process.getuid?.() === 0 && (() => { try { execFileSync('setpriv', ['--version']); return true; } catch { return false; } })());
const skip = canSwitch ? false : 'needs root and setpriv to switch users (the container image has both)';

async function world() {
  const { Session } = await import('../session.mjs');
  const { sandboxPool, parseSlots, privateDir, sandboxSpawn, processesOf } = await import('../sandbox.mjs');
  const { bare } = origin();
  const top = mkdtempSync(join(tmpdir(), 'runner-pool-'));
  chmodSync(top, 0o711);
  const root = join(top, 'data'), work = join(top, 'work');
  privateDir(root);
  const pool = sandboxPool(IMAGE
    ? { slots: parseSlots(IMAGE.uids).slice(0, 2), sharedGid: IMAGE.gid, exec: IMAGE.exec }
    : { slots: parseSlots('10100-10101'), sharedGid: 10010, exec: 'setpriv' });
  const start = async (session, role, branch) => {
    const events = [];
    const s = new Session({ session, role, team: 't', repo: { url: bare }, worktree: branch, areas: [`${role}/`] }, { root, work, sandbox: pool, emit: async (_s, type, data) => events.push({ type, data }), adapter: { turn: async () => ({}) }, log: (m) => process.env.DBG && console.error('LOG', m) });
    s.pump = () => {};
    s.events = events;
    await s.start();
    return s;
  };
  const as = (s, script, ...args) => new Promise((done) => {
    const c = sandboxSpawn(s.slot)({ command: '/bin/sh', args: ['-c', script, 'agent', ...args], cwd: s.copy?.cwd ?? work, env: s.env ?? { PATH: process.env.PATH } });
    let out = ''; c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (out += d));
    c.stdin.end(); c.on('close', (code) => done({ code, out }));
  });
  return { pool, start, as, work, bare, processesOf };
}

test('#28: two live sessions run as two agent users, and neither can read or list the other\'s copy, home or memory', { skip }, async () => {
  const { pool, start, as, work } = await world();
  const umask = process.umask(0o007);
  try {
    const a = await start('ses_a', 'web-dev', 'web/a');
    const b = await start('ses_b', 'qa', 'qa/b');
    assert.notEqual(a.slot.uid, b.slot.uid);
    assert.equal((await as(a, 'id -u')).out.trim(), String(a.slot.uid));
    assert.equal((await as(b, 'id -u')).out.trim(), String(b.slot.uid));
    assert.equal(statSync(a.copy.cwd).gid, a.slot.gid, 'the copy is in the session\'s own group');
    assert.equal(statSync(join(work, 'worktrees')).mode & 0o777, 0o710, 'folders on the way are traverse-only');
    assert.equal((await as(a, 'echo mine > a.txt && cat a.txt')).out.trim(), 'mine', 'a session works in its own copy');
    for (const target of [b.copy.cwd, b.home, b.memoryPath, join(work, 'worktrees'), join(work, 'homes')]) {
      const r = await as(a, 'ls "$1" 2>/dev/null || cat "$1" 2>/dev/null; exit 0', target);
      assert.equal(r.out.trim(), '', `${target} is closed to the other session`);
    }
    // Without hidepid every user can read every command line (review of #28, D): no secret may ever be in one.
    const lines = (await as(b, 'for f in /proc/[0-9]*/cmdline; do tr "\\0" " " < "$f" 2>/dev/null; echo; done')).out;
    const secrets = [a.token, b.token, process.env.RUNNER_F3_MARKER, ...Object.entries(process.env).filter(([k]) => /KEY|TOKEN|SECRET/.test(k)).map(([, v]) => v)].filter((v) => typeof v === 'string' && v.length >= 8);
    for (const v of secrets) assert.ok(!lines.includes(v), 'a secret is in a command line another agent user can read');
    // A third session finds every agent user in use: refused, nothing started.
    const c = await start('ses_c', 'designer', 'design/c');
    assert.equal(c.events.at(-1).type, 'session.ended');
    assert.equal(c.events.at(-1).data.reason, 'capacity');
    await a.stop('now'); await b.stop('now');
    assert.equal(pool.take('x') !== null, true, 'the slots come back');
  } finally { process.umask(umask); }
});

test('#28: a session ends with nothing of its user left: no daemon, no temporary files or IPC, no home; the copy is parked and the runner\'s, and no link is followed', { skip }, async () => {
  const { start, as, processesOf, work } = await world();
  const umask = process.umask(0o007);
  const outside = join(mkdtempSync(join(tmpdir(), 'runner-outside-')), 'target');
  writeFileSync(outside, 'not the agent\'s\n');
  const before = statSync(outside);
  try {
    const a = await start('ses_d', 'web-dev', 'web/d');
    const uid = a.slot.uid;
    // What an agent could leave behind: a daemon outside its process group, a temporary file, a hard link of its
    // own file into /tmp (into the copy that is about to be parked), SysV shared memory, and links to elsewhere.
    const daemon = spawn(a.slot.exec, [`--reuid=${uid}`, `--regid=${a.slot.gid}`, '--clear-groups', '--', 'setsid', 'sleep', '300'], { detached: true, stdio: 'ignore' });
    daemon.unref();
    const left = await as(a, `echo hi > own.txt && ln own.txt /tmp/runner-pool-link-${uid} && echo t > /tmp/runner-pool-tmp-${uid} && ln -s "$1" escape && mkdir -p sub && ln -s / sub/root && (ipcmk -M 4096 >/dev/null 2>&1 || true); echo ok`, outside);
    assert.match(left.out, /ok/);
    assert.ok(processesOf(uid).length > 0);
    await a.stop('now');
    assert.deepEqual(processesOf(uid), [], 'every process of the user is gone');
    assert.equal(existsSync(`/tmp/runner-pool-link-${uid}`), false);
    assert.equal(existsSync(`/tmp/runner-pool-tmp-${uid}`), false);
    assert.equal(existsSync(a.home), false, 'the home is removed');
    assert.equal(existsSync(join(work, 'memory', 'ses_d')), false, 'so is the memory folder (its content went to the checkpoint)');
    const parked = statSync(a.copy.cwd);
    assert.equal(parked.mode & 0o777, 0o700, 'the copy is closed to every agent user');
    const owners = execFileSync('find', [a.copy.cwd, '-xdev', '!', '-user', String(process.getuid()), '-print'], { encoding: 'utf8' }).trim();
    assert.equal(owners, '', 'and everything in it is the runner\'s');
    assert.ok(lstatSync(join(a.copy.cwd, 'escape')).isSymbolicLink(), 'a link stays a link');
    assert.equal(readFileSync(join(a.copy.cwd, 'own.txt'), 'utf8'), 'hi\n', 'the work stays in the copy');
    const after = statSync(outside);
    assert.deepEqual([after.uid, after.gid, after.mode], [before.uid, before.gid, before.mode], 'what a link points at is never changed');
    assert.equal(readFileSync(outside, 'utf8'), 'not the agent\'s\n');
    assert.equal(statSync('/').uid, 0);
  } finally { process.umask(umask); }
});

test('#28: a copy resumed on another agent user is handed over by the runner alone, and the old user cannot reach it', { skip }, async () => {
  const { start, as } = await world();
  const umask = process.umask(0o007);
  try {
    const a = await start('ses_e1', 'web-dev', 'web/e');
    const first = a.slot.uid;
    await as(a, 'mkdir -p web && echo one > web/one.txt && chmod 660 web/one.txt');
    await a.stop('now');
    // The old user is busy elsewhere (another session took it), so the copy comes back on the other user.
    const hold = await start('ses_h', 'designer', 'design/h');
    assert.notEqual(hold.slot.uid, first, 'a new copy takes the user never used, keeping the old one free');
    const other = await start('ses_f', 'qa', 'qa/f');
    assert.equal(other.slot.uid, first, 'the only free user now');
    await hold.stop('now');
    const again = await start('ses_e2', 'web-dev', 'web/e');
    assert.notEqual(again.slot.uid, first);
    assert.equal((await as(again, 'cat web/one.txt && echo two >> web/one.txt && cat web/one.txt')).out, 'one\none\ntwo\n', 'the new user reads and writes what the old one left');
    const r = await as(other, 'cat "$1/web/one.txt" 2>/dev/null; ls "$1" 2>/dev/null; exit 0', again.copy.cwd);
    assert.equal(r.out.trim(), '', 'the old user, now another session\'s, cannot reach the copy');
    await other.stop('now'); await again.stop('now');
  } finally { process.umask(umask); }
});

test('#28 E: one shared agent user serves one team only', async () => {
  const { startRunner } = await import('../runner.mjs');
  const { fakeControlPlane } = await import('./fake-control-plane.mjs');
  const { bare, root } = origin();
  const cp = await fakeControlPlane();
  const runner = startRunner({ server: cp.url, key: cp.key, root, adapter: { turn: async () => ({}) }, sandbox: { uid: 10002, gid: 10010, exec: '/nonexistent/setpriv' }, modelProxy: null });
  try {
    await runner.ready;
    cp.start({ role: 'web-dev', team: 'shop', run: 'run_1', repo: { url: bare }, worktree: 'web/1' });
    cp.start({ role: 'web-dev', team: 'other', run: 'run_2', repo: { url: bare }, worktree: 'web/2' });
    await cp.until(() => cp.events.filter((e) => e.type === 'session.ended').length >= 1 && cp.events.some((e) => /already serves another team/.test(e.data?.detail ?? '')));
    const refused = cp.events.find((e) => /already serves another team/.test(e.data?.detail ?? ''));
    assert.equal(refused.data.reason, 'capacity');
  } finally {
    await runner.close();
    await cp.close();
  }
});
