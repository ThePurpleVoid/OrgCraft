// Sessions as their own OS user (security review F3). Inside the container, the runner runs as `runner` and every
// session's Claude Code process (and so its shell) runs as `agent`, a user that cannot read the runner's process
// environment (/proc/<runner>/environ holds the runner key and the model key), the runner's data folder (the runner
// key file, the push credential, the repository caches) or another user's memory.
//
// The switch is made by `setpriv`. In the container a copy of it carries only the capabilities to change uid and
// gid and is executable only by the runner's group (see Dockerfile), so the agent cannot use it to switch back.
// It drops every inheritable capability and sets no_new_privs, so nothing the agent runs can gain privileges.
// Files the session writes are group-readable and group-writable (umask 007), in folders the runner made with the
// shared group, so the runner can commit and check them at checkpoints.
import { spawn } from 'node:child_process';
import { chmodSync, closeSync, constants as C, fchmodSync, fchownSync, fstatSync, ftruncateSync, mkdirSync, openSync, readSync, realpathSync, writeSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

/**
 * `sandbox` is { uid, gid, exec } (exec: the setpriv to use; default 'setpriv'), or null for no switch (tests,
 * development; not a supported deployment). Returns the argv prefix that runs a command as the agent.
 */
export function asAgent(sandbox) {
  if (!sandbox) return [];
  const { uid, gid, exec = 'setpriv' } = sandbox;
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid === 0 || gid === 0) throw new Error('the sandbox needs a numeric, non-root uid and gid');
  return [exec, `--reuid=${uid}`, `--regid=${gid}`, '--clear-groups', '--inh-caps=-all', '--no-new-privs', '--', '/bin/sh', '-c', 'umask 007 && exec "$@"', 'agent'];
}

/**
 * For the Agent SDK's spawnClaudeCodeProcess: the same process the SDK would start, as the agent, in a process group
 * of its own. The runner cannot signal another user's processes, so kill() sends the signal to the whole group
 * through the same setpriv, as the agent (Claude Code and the commands it started), and follows up with SIGKILL
 * when the group has not exited after `grace` ms.
 */
export function sandboxSpawn(sandbox, { grace = 5000 } = {}) {
  const pre = asAgent(sandbox);
  return ({ command, args, cwd, env, signal }) => {
    const child = spawn(pre[0], [...pre.slice(1), command, ...args], { cwd, env, detached: !!sandbox, stdio: ['pipe', 'pipe', 'pipe'] });
    if (sandbox) {
      let closed = false, timer = null;
      // When the leader exits, whatever it left in its group (a background command that ignored TERM, or one still
      // running at a normal end) is killed too.
      child.on('exit', () => { closed = true; clearTimeout(timer); groupKill('SIGKILL'); });
      const groupKill = (sig) => {
        const k = spawn(sandbox.exec ?? 'setpriv', [`--reuid=${sandbox.uid}`, `--regid=${sandbox.gid}`, '--clear-groups', '--inh-caps=-all', '--no-new-privs', '--', 'kill', `-${String(sig).replace(/^SIG/, '')}`, '--', `-${child.pid}`], { stdio: 'ignore' });
        k.on('error', () => {});
      };
      child.kill = (sig = 'SIGTERM') => {
        if (closed || !child.pid) return false;
        groupKill(sig);
        if (sig !== 'SIGKILL' && !timer) { timer = setTimeout(() => { if (!closed) groupKill('SIGKILL'); }, grace); timer.unref?.(); }
        return true;
      };
    }
    if (signal) { if (signal.aborted) child.kill(); else signal.addEventListener('abort', () => child.kill(), { once: true }); }
    return child;
  };
}

// Everything under the work folder can be changed by the agent, so the runner never follows a link there (G1): a
// planted link could make the runner read its own /proc/self/environ as "the memory file", or write a credential
// helper into its own git config. Folders the runner makes are its own and closed to the agent's writes except the
// leaf it works in (a home, a memory folder, a clone), so the path down to a leaf cannot be swapped; the last step
// is opened with O_NOFOLLOW and checked on the open descriptor.
const NOFOLLOW = C.O_NOFOLLOW ?? 0, NONBLOCK = C.O_NONBLOCK ?? 0, DIRECTORY = C.O_DIRECTORY ?? 0;

/** Throws unless `dir` is exactly where it should be under `base`, with no link on the way. */
function checkedDir(dir, base) {
  const want = resolve(realpathSync(base), relative(resolve(base), resolve(dir)));
  if (relative(resolve(base), resolve(dir)).split(sep)[0] === '..') throw new Error(`${dir} is outside ${base}`);
  if (realpathSync(dir) !== want) throw new Error(`${dir} goes through a link; not using it`);
}

/** A regular file with one name, read without following links; at most `max` bytes. */
export function safeRead(path, { base, max = 64 * 1024 } = {}) {
  if (base) checkedDir(dirname(path), base);
  const fd = openSync(path, C.O_RDONLY | NOFOLLOW | NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) throw new Error(`${path} is not a plain file`);
    const buf = Buffer.alloc(Math.min(st.size, max));
    let n = 0;
    while (n < buf.length) { const r = readSync(fd, buf, n, buf.length - n, n); if (!r) break; n += r; }
    return buf.subarray(0, n).toString('utf8');
  } finally { closeSync(fd); }
}

/** Write a regular file with one name, never through a link. */
export function safeWrite(path, data, { base } = {}) {
  if (base) checkedDir(dirname(path), base);
  const fd = openSync(path, C.O_WRONLY | C.O_CREAT | NOFOLLOW | NONBLOCK, 0o660);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) throw new Error(`${path} is not a plain file`);
    ftruncateSync(fd, 0);
    writeSync(fd, String(data), 0);
  } finally { closeSync(fd); }
}

/**
 * A folder for the session, made by the runner. `leaf` folders are the ones the agent writes in (2770); the ones on
 * the way to them stay the runner's (2750), so the agent cannot rename or replace what is inside them. A link in
 * its place is refused, and the mode is set on the opened folder, not the path.
 */
export function sharedDir(path, sandbox, { leaf = false } = {}) {
  try { mkdirSync(path, { mode: leaf ? 0o2770 : 0o2750 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const fd = openSync(path, C.O_RDONLY | DIRECTORY | NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isDirectory()) throw new Error(`${path} is not a folder`);
    if (process.getuid && st.uid !== process.getuid()) throw new Error(`${path} is not the runner's`);
    if (!sandbox) return;
    if (process.getuid?.() === 0) fchownSync(fd, 0, sandbox.gid); // only in tests run as root
    fchmodSync(fd, leaf ? 0o2770 : 0o2750);
  } finally { closeSync(fd); }
}

/** The runner's own folder: closed to everyone else, the agent included. */
export function privateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}
