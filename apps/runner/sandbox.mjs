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
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, constants as C, fchmodSync, fchownSync, fstatSync, ftruncateSync, existsSync, lchownSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/**
 * `sandbox` is { uid, gid, exec } (exec: the setpriv to use; default 'setpriv'), or null for no switch (tests,
 * development; not a supported deployment). Returns the argv prefix that runs a command as the agent.
 */
export function asAgent(sandbox) {
  if (!sandbox) return [];
  return [...switchTo(sandbox), '--', '/bin/sh', '-c', 'umask 007 && exec "$@"', 'agent'];
}

/**
 * The setpriv arguments that become `sandbox`'s user: its own group, plus the shared work group (traverse only)
 * when that is another group, and nothing else. `extra` adds groups (a re-home, below).
 */
function switchTo(sandbox, extra = []) {
  const { uid, gid, exec = 'setpriv' } = sandbox;
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid === 0 || gid === 0) throw new Error('the sandbox needs a numeric, non-root uid and gid');
  const groups = [...new Set([sandbox.sharedGid, ...extra].filter((g) => Number.isInteger(g) && g !== gid && g !== 0))];
  return [exec, `--reuid=${uid}`, `--regid=${gid}`, groups.length ? `--groups=${groups.join(',')}` : '--clear-groups', '--inh-caps=-all', '--no-new-privs'];
}

/**
 * The runner's agent users (#28: each session its own uid before a runner serves more than one customer).
 *
 *   { slots: [{ uid, gid }], sharedGid, exec }  a pool: every live session has a slot of its own, and a working copy
 *                                               goes back to the slot it last had when that slot is free
 *   { uid, gid, exec }                          one agent user shared by every session (one customer per runner)
 *
 * take(key) returns { uid, gid, sharedGid, exec, own } or null when every slot is in use; give(slot) hands it back.
 * `own` is true for a pool slot: the session ends by stopping that user's processes and removing its files.
 */
export function sandboxPool(config) {
  if (!config) return null;
  if (config.take) return config;
  const exec = config.exec ?? 'setpriv';
  if (!Array.isArray(config.slots)) {
    const one = { uid: config.uid, gid: config.gid, sharedGid: config.sharedGid ?? config.gid, exec, own: false };
    switchTo(one);
    return { size: Infinity, shared: true, take: () => one, give: () => {}, slots: [one], isSlot: (uid) => uid === one.uid };
  }
  const sharedGid = config.sharedGid;
  if (!Number.isInteger(sharedGid) || sharedGid === 0) throw new Error('a sandbox pool needs the shared work group (sharedGid)');
  const slots = config.slots.map((x) => ({ uid: x.uid, gid: x.gid, sharedGid, exec, own: true }));
  if (!slots.length) throw new Error('a sandbox pool needs at least one slot');
  for (const x of slots) switchTo(x);
  if (new Set(slots.map((x) => x.uid)).size !== slots.length || new Set(slots.map((x) => x.gid)).size !== slots.length) throw new Error('every slot needs a uid and a group of its own');
  if (slots.some((x) => x.gid === sharedGid)) throw new Error('no slot may use the shared work group as its own');
  const busy = new Set();
  const last = new Map(); // key (a working copy) -> the uid that last had it
  return {
    size: slots.length, shared: false, slots,
    isSlot: (uid) => slots.some((x) => x.uid === uid),
    take(key) {
      const want = slots.find((x) => x.uid === last.get(key) && !busy.has(x.uid));
      // Otherwise the free slot used longest ago, so a copy's old slot stays free for it as long as can be.
      const free = want ?? slots.filter((x) => !busy.has(x.uid)).sort((a, b) => (a.at ?? 0) - (b.at ?? 0))[0];
      if (!free) return null;
      busy.add(free.uid);
      if (key) last.set(key, free.uid);
      return free;
    },
    give(slot) { if (slot) { busy.delete(slot.uid); slot.at = Date.now(); } },
  };
}

/** A pool parsed from the environment form "10100-10107" (each uid's group has the same number) or "10100,10101". */
export function parseSlots(spec) {
  const ids = [];
  for (const part of String(spec ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new Error(`"${part}" is not a uid or a range of uids`);
    const a = Number(m[1]), b = Number(m[2] ?? m[1]);
    if (b < a || b - a > 255) throw new Error(`"${part}" is not a range of at most 256 uids`);
    for (let i = a; i <= b; i++) ids.push(i);
  }
  return ids.map((uid) => ({ uid, gid: uid }));
}

/**
 * Make every entry under `dir` the runner's own, never following a link (security review of #28, A and B): a file
 * another user owns is replaced by a copy the runner writes (a new inode, so no hard link made earlier reaches it),
 * a folder by a new one with the same entries, a link by a new link with the same text, and anything else
 * (a fifo, a socket) is removed. It runs only while no process of that user can touch the folder (after reap), and
 * nothing here runs as an agent user. A folder the agent closed to its group cannot be adopted: that throws.
 */
export function adopt(dir) {
  const me = process.getuid?.();
  if (me === undefined) return;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      let st = lstatSync(p);
      if (st.uid !== me) {
        if (st.isSymbolicLink()) { const t = readlinkSync(p); unlinkSync(p); symlinkSync(t, p); }
        else if (st.isFile()) {
          const tmp = join(d, `.adopt-${process.pid}-${name}`.slice(0, 200));
          const fd = openSync(p, C.O_RDONLY | NOFOLLOW | NONBLOCK);
          try {
            if (!fstatSync(fd).isFile()) throw new Error(`${p} changed while it was adopted`);
            const out = openSync(tmp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | NOFOLLOW, st.mode & 0o770);
            try {
              const buf = Buffer.alloc(1 << 16);
              for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0;) writeSync(out, buf, 0, n);
              fchmodSync(out, st.mode & 0o770);
            } finally { closeSync(out); }
          } finally { closeSync(fd); }
          renameSync(tmp, p);
        } else if (st.isDirectory()) {
          const tmp = join(d, `.adopt-${process.pid}-${name}`.slice(0, 200));
          mkdirSync(tmp, { mode: 0o2770 });
          for (const child of readdirSync(p)) renameSync(join(p, child), join(tmp, child));
          rmdirSync(p);
          renameSync(tmp, p);
        } else unlinkSync(p);
        st = lstatSync(p);
      }
      if (st.isDirectory() && !st.isSymbolicLink()) walk(p);
    }
  };
  walk(dir);
}

/**
 * Hand a working copy (a leaf the runner made) to `slot`. The same slot again: it is only opened. Another slot: every
 * entry becomes the runner's (adopt; park already did it) and takes the slot's group by lchown, never through a
 * link, and folders keep that group for what the agent adds. Runs before the session's user has any process.
 */
export function grant(dir, slot) {
  if (!slot) return;
  const me = process.getuid?.();
  const fd = openSync(dir, C.O_RDONLY | DIRECTORY | NOFOLLOW);
  let same;
  try {
    const st = fstatSync(fd);
    if (!st.isDirectory() || (me !== undefined && st.uid !== me)) throw new Error(`${dir} is not the runner's folder`);
    same = st.gid === slot.gid;
  } finally { closeSync(fd); }
  if (!same) {
    adopt(dir);
    const walk = (d) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        const st = lstatSync(p);
        if (st.uid !== me) throw new Error(`${p} is not the runner's; not handing ${dir} over`);
        if (st.gid !== slot.gid) lchownSync(p, me, slot.gid);
        if (st.isDirectory()) { chmodSync(p, (st.mode & 0o777) | 0o2070); walk(p); }
      }
    };
    walk(dir);
  }
  const top = openSync(dir, C.O_RDONLY | DIRECTORY | NOFOLLOW);
  try { if (!same) fchownSync(top, me, slot.gid); fchmodSync(top, 0o2770); } finally { closeSync(top); }
}

/**
 * Close a working copy to every agent user while no session holds it (only the runner can reach it), and make all
 * of it the runner's, so no agent user owns anything in a copy it no longer holds. Call it after reap.
 */
export function park(dir) {
  const fd = openSync(dir, C.O_RDONLY | DIRECTORY | NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (process.getuid && st.uid !== process.getuid()) throw new Error(`${dir} is not the runner's folder`);
    fchmodSync(fd, 0o2700);
  } finally { closeSync(fd); }
  adopt(dir);
}

// Shared folders an agent user can leave files in (and so hard links into its old copy), cleaned at each session end.
const SHARED_TMP = ['/tmp', '/var/tmp', '/dev/shm', '/run', '/var/lock', '/dev/mqueue'];

/** Pids whose real, effective or saved uid is `uid` (from /proc; the runner can read other users' status). */
export function processesOf(uid) {
  const out = [];
  let names = [];
  try { names = readdirSync('/proc'); } catch { return out; }
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    try {
      const line = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(readFileSync(`/proc/${n}/status`, 'utf8'));
      if (line && [line[1], line[2], line[3]].some((u) => Number(u) === uid)) out.push(Number(n));
    } catch { /* gone */ }
  }
  return out;
}

/** SysV IPC objects (shared memory, semaphores, queues) owned or made by `uid`, from /proc/sysvipc. */
function ipcOf(uid) {
  let n = 0;
  for (const f of ['shm', 'sem', 'msg']) {
    try {
      const [head, ...rows] = readFileSync(`/proc/sysvipc/${f}`, 'utf8').trim().split('\n');
      const cols = head.trim().split(/\s+/);
      const at = ['uid', 'cuid'].map((c) => cols.indexOf(c));
      for (const r of rows) { const v = r.trim().split(/\s+/); if (at.some((k) => k >= 0 && Number(v[k]) === uid)) n++; }
    } catch { /* not there */ }
  }
  return n;
}

/**
 * The end of a session on a slot of its own (security review of #28, C and F): every process of that user is
 * killed, again until /proc shows none (a fork can race one kill); then, as that user with no process left to
 * reach it, its files in the shared temporary folders, its SysV IPC and what is in `leaves` (its home, its memory
 * folder) go; the runner removes the leaves; and the slot is checked empty. `ok: false` means the slot must not
 * be handed to anyone again (the runner keeps it out of the pool).
 */
export function reap(slot, leaves = [], { stopped = () => {} } = {}) {
  if (!slot?.own) return { ok: true, skipped: true };
  const sw = switchTo(slot);
  const as = (script, ...args) => spawnSync(sw[0], [...sw.slice(1), '--', '/bin/sh', '-c', script, 'reap', ...args], { encoding: 'utf8', timeout: 30_000 });
  for (let i = 0; i < 50 && processesOf(slot.uid).length; i++) as('kill -9 -1 2>/dev/null; exit 0');
  // With no process of the user left: park its working copy (all of it becomes the runner's), so the clean-up
  // below, which removes whatever the user still owns in the shared folders, never touches the work.
  const problems = [];
  try { stopped(); } catch (e) { problems.push(`its working copy could not be parked: ${e.message}`); }
  as(`for d in ${SHARED_TMP.join(' ')}; do [ -d "$d" ] && find "$d" -xdev -user "$(id -u)" -delete 2>/dev/null; done; ipcrm --all 2>/dev/null; for l in "$@"; do [ -d "$l" ] && find "$l" -mindepth 1 -delete 2>/dev/null; done; exit 0`, ...leaves);
  for (let i = 0; i < 50 && processesOf(slot.uid).length; i++) as('kill -9 -1 2>/dev/null; exit 0');
  // What is left in the leaves (a folder the agent closed to its group) the runner cannot remove; it stays closed.
  for (const l of leaves) { try { rmSync(l, { recursive: true, force: true }); } catch { try { chmodSync(l, 0o2700); } catch { /* gone */ } } }
  const procs = processesOf(slot.uid);
  if (procs.length) problems.push(`${procs.length} process(es) of uid ${slot.uid} still running`);
  for (const d of SHARED_TMP) {
    const r = spawnSync('find', [d, '-xdev', '-user', String(slot.uid), '-print', '-quit'], { encoding: 'utf8' });
    if ((r.stdout ?? '').trim()) problems.push(`uid ${slot.uid} still has files in ${d}`);
  }
  const ipc = ipcOf(slot.uid);
  if (ipc) problems.push(`uid ${slot.uid} still holds ${ipc} SysV IPC object(s)`);
  for (const l of leaves) if (existsSync(l)) problems.push(`${l} could not be removed`);
  return { ok: problems.length === 0, problems };
}

/** fs.protected_hardlinks: without it an agent can hard-link files it cannot write; a pool refuses to run (C). */
export function hardlinksProtected() {
  try { return readFileSync('/proc/sys/fs/protected_hardlinks', 'utf8').trim() === '1'; } catch { return false; }
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
      // The shell's own kill: the slim image has no /bin/kill.
      const groupKill = (sig) => {
        const sw = switchTo(sandbox);
        const k = spawn(sw[0], [...sw.slice(1), '--', '/bin/sh', '-c', 'kill -s "$1" -- "-$2"', 'kill', String(sig).replace(/^SIG/, ''), String(child.pid)], { stdio: 'ignore' });
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
  // Folders on the way are traverse-only for the shared work group: one session cannot list another's.
  const mode = leaf ? 0o2770 : 0o2710;
  try { mkdirSync(path, { mode }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const fd = openSync(path, C.O_RDONLY | DIRECTORY | NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isDirectory()) throw new Error(`${path} is not a folder`);
    if (process.getuid && st.uid !== process.getuid()) throw new Error(`${path} is not the runner's`);
    if (!sandbox) return;
    const gid = leaf ? sandbox.gid : sandbox.sharedGid ?? sandbox.gid;
    if (st.gid !== gid) fchownSync(fd, st.uid, gid); // the runner is in that group
    fchmodSync(fd, mode);
  } finally { closeSync(fd); }
}

/** The runner's own folder: closed to everyone else, the agent included. */
export function privateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

/**
 * The runner's startup self-check (security review): as the agent, try to read the runner's environment and list
 * its own folder, and read the agent's capabilities. Platforms differ (Fly, Docker Desktop, CI), so the runner
 * checks the sandbox it actually got before it takes any session. Returns { ok, problems }.
 */
export function selfCheck(sandbox, { pid = process.pid, data }) {
  const script = [
    'if cat "/proc/$1/environ" >/dev/null 2>&1; then echo "problem: the runner environment is readable"; fi',
    'if ls "$2" >/dev/null 2>&1; then echo "problem: the runner data folder is readable"; fi',
    'grep "^CapEff:" /proc/self/status',
    'id -u',
  ].join('\n');
  const pre = asAgent(sandbox);
  const r = spawnSync(pre[0], [...pre.slice(1), '/bin/sh', '-c', script, 'check', String(pid), data], { encoding: 'utf8', timeout: 10000 });
  const out = `${r.stdout ?? ''}`;
  const problems = out.split('\n').filter((l) => l.startsWith('problem: ')).map((l) => l.slice(9));
  if (r.error || r.status !== 0) problems.push(`the switch to the agent user failed (${r.error?.message ?? (r.stderr || `exit ${r.status}`).trim()})`);
  const cap = /^CapEff:\s*([0-9a-f]+)/m.exec(out);
  if (!cap || /[1-9a-f]/.test(cap[1])) problems.push(`the agent has capabilities (${cap?.[1] ?? 'unknown'})`);
  const uid = /^(\d+)$/m.exec(out)?.[1];
  if (Number(uid) !== sandbox.uid) problems.push(`the agent runs as uid ${uid ?? "unknown"}, not ${sandbox.uid}`);
  return { ok: problems.length === 0, problems };
}

/**
 * For a pool, at startup (review of #28, F): each agent user starts empty (anything a previous runner process left,
 * reaped and checked), and one user cannot read or list another's folder, nor the folders on the way.
 */
export function crossCheck(pool, work) {
  const problems = [];
  for (const slot of pool.slots) { const r = reap(slot); if (!r.ok) problems.push(...r.problems); }
  if (pool.slots.length < 2) return { ok: problems.length === 0, problems };
  const [a, b] = pool.slots;
  const top = join(work, '.sandbox-check');
  rmSync(top, { recursive: true, force: true });
  sharedDir(work, b);
  sharedDir(top, b);
  const leaf = join(top, 'b');
  sharedDir(leaf, b, { leaf: true });
  writeFileSync(join(leaf, 'secret'), 'cross-check', { mode: 0o660 });
  const run = (slot, script) => { const pre = asAgent(slot); return spawnSync(pre[0], [...pre.slice(1), '/bin/sh', '-c', script, 'check', leaf, top], { encoding: 'utf8', timeout: 10000 }); };
  try {
    if ((run(b, 'cat "$1/secret"').stdout ?? '') !== 'cross-check') problems.push(`agent user ${b.uid} cannot read its own folder`);
    const r = run(a, 'cat "$1/secret" 2>/dev/null; ls "$2" 2>/dev/null; ls "$1" 2>/dev/null; exit 0');
    if ((r.stdout ?? '').trim()) problems.push(`agent user ${a.uid} can read or list agent user ${b.uid}'s folder`);
  } finally { rmSync(top, { recursive: true, force: true }); }
  return { ok: problems.length === 0, problems };
}
