// Working copies. One clone per repository (a cache), and one git worktree per session on that session's branch, so
// builders work in parallel without touching each other's files. A role that builds nothing gets a detached worktree
// at the ref, read-only by policy (it owns no areas).
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

export async function git(cwd, ...args) {
  const { stdout } = await run('git', args, { cwd, env: ENV, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80);
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/#-]{1,200}(?<![./])$/;

/** Locks per clone, so two sessions on one repository never run git on it at the same time. */
const locks = new Map();
async function locked(key, fn) {
  const prev = locks.get(key) ?? Promise.resolve();
  let done;
  const next = new Promise((r) => (done = r));
  locks.set(key, prev.then(() => next));
  await prev;
  try { return await fn(); } finally { done(); if (locks.get(key) === next) locks.delete(key); }
}

/**
 * Make (or reuse) the working copy for a session. `repo` is { url, ref } (a URL or a local path git can clone),
 * `worktree` a branch name or { branch, base } (omit for a read-only checkout). Returns { cwd, branch, base, head }.
 */
export async function prepare({ root, repo, worktree, session }) {
  if (!repo?.url) throw new Error('session.start needs repo.url');
  const ref = repo.ref || 'main';
  const branch = typeof worktree === 'string' ? worktree : worktree?.branch ?? null;
  const base = (typeof worktree === 'object' && worktree?.base) || ref;
  if (branch && !BRANCH.test(branch)) throw new Error(`"${branch}" is not a branch name the runner will create`);
  const clone = join(root, 'repos', createHash('sha256').update(repo.url).digest('hex').slice(0, 16));
  const cwd = join(root, 'worktrees', safe(branch ?? `read-${session}`));
  return locked(clone, async () => {
    if (!existsSync(join(clone, '.git'))) {
      mkdirSync(join(root, 'repos'), { recursive: true });
      await run('git', ['clone', '--no-checkout', '--quiet', repo.url, clone], { env: ENV });
    } else {
      await git(clone, 'fetch', '--quiet', '--prune', 'origin');
    }
    if (existsSync(cwd)) {
      // Resume: keep the worktree and whatever the last session left in it.
      return { cwd, branch, base, head: await git(cwd, 'rev-parse', 'HEAD'), resumed: true };
    }
    mkdirSync(join(root, 'worktrees'), { recursive: true });
    const start = `origin/${base}`;
    if (branch) {
      // Reuse the branch when it already exists on the remote (a session resumed on another runner).
      const remote = await git(clone, 'ls-remote', '--heads', 'origin', branch).catch(() => '');
      await git(clone, 'worktree', 'add', '--quiet', '-B', branch, cwd, remote ? `origin/${branch}` : start);
    } else {
      await git(clone, 'worktree', 'add', '--quiet', '--detach', cwd, start);
    }
    return { cwd, branch, base, head: await git(cwd, 'rev-parse', 'HEAD'), resumed: false };
  });
}

/**
 * Bring a working copy to a safe point: commit what is uncommitted (as a checkpoint commit on the session's branch)
 * and push the branch. Read-only checkouts have nothing to save. Returns { commit, pushed, error? }.
 */
export async function checkpoint({ cwd, branch, role, reason }) {
  if (!branch) return { commit: await git(cwd, 'rev-parse', 'HEAD'), pushed: false };
  if (await git(cwd, 'status', '--porcelain')) {
    await git(cwd, 'add', '-A');
    await git(cwd, '-c', `user.name=${role}`, '-c', 'user.email=runner@agent-team.invalid', 'commit', '--quiet', '--no-verify', '-m', `checkpoint (${role}): ${reason}`);
  }
  const commit = await git(cwd, 'rev-parse', 'HEAD');
  try {
    await git(cwd, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`);
    return { commit, pushed: true };
  } catch (e) {
    return { commit, pushed: false, error: String(e.stderr || e.message).trim().split('\n').pop() };
  }
}
