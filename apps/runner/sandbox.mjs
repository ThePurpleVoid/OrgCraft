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
import { chmodSync, chownSync, mkdirSync } from 'node:fs';

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

/** For the Agent SDK's spawnClaudeCodeProcess: the same process the SDK would start, as the agent. */
export function sandboxSpawn(sandbox) {
  const pre = asAgent(sandbox);
  return ({ command, args, cwd, env, signal }) => spawn(pre[0], [...pre.slice(1), command, ...args], { cwd, env, signal, stdio: ['pipe', 'pipe', 'pipe'] });
}

/** A folder the agent may write: the runner's, in the shared group, setgid so what is made inside stays in it. */
export function sharedDir(path, sandbox) {
  mkdirSync(path, { recursive: true, mode: 0o2770 });
  if (!sandbox) return;
  if (process.getuid?.() === 0) chownSync(path, process.getuid(), sandbox.gid); // only in tests run as root
  chmodSync(path, 0o2770);
}

/** The runner's own folder: closed to everyone else, the agent included. */
export function privateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}
