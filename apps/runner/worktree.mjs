// Working copies, and the one place the runner enforces what leaves them.
//
// Each session gets its own clone (copied from a per-repository cache, sharing no files with it or with other
// sessions) on its own branch. The agent can write anything in its clone, including .git, so the runner treats
// the clone as untrusted: before every git command the runner runs there, it rewrites .git/config from its own
// template and empties the hooks, and it runs git with hooks and fsmonitor off, no system or user config, and an
// environment that holds neither the runner key nor the model key (security review R2).
//
// The session itself holds no credential that can push. The runner pushes at checkpoints, and only after:
//   - every changed path is inside the role's owned areas (writes made from the shell included), and settings
//     that steer agents or CI (.claude/, .mcp.json, .github/workflows/, .git*) are owned explicitly;
//   - no symlink points outside the working copy;
//   - no secret is in the changes (file names and content), the same scan the memory file gets (R4).
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { owns } from './policy.mjs';
import { findSecrets } from './secrets.mjs';

const run = promisify(execFile);
/** Pinned for every runner-side git call; they override anything the repository's config says. */
const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.sshCommand=ssh', '-c', 'protocol.ext.allow=never', '-c', 'core.pager=cat', '-c', 'credential.interactive=false'];
let gitGlobal = '/dev/null';
/** A git config file the operator controls, for the runner's own push credential (a credential helper). */
export function useGitConfig(path) { gitGlobal = path && existsSync(path) ? path : '/dev/null'; }
const gitEnv = () => {
  const keep = ['PATH', 'HOME', 'SSH_AUTH_SOCK', 'LANG', 'TMPDIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'GIT_SSL_CAINFO', 'SSL_CERT_FILE'];
  return { ...Object.fromEntries(keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])), GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitGlobal };
};

export async function git(cwd, ...args) {
  const { stdout } = await run('git', [...SAFE, ...args], { cwd, env: gitEnv(), maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60);
const short = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 10);
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/#-]{1,200}(?<![./])$/;

/** Locks per cache, so two sessions never run git on one cache at the same time. */
const locks = new Map();
async function locked(key, fn) {
  const prev = locks.get(key) ?? Promise.resolve();
  let done;
  const next = new Promise((r) => (done = r));
  locks.set(key, prev.then(() => next));
  await prev;
  try { return await fn(); } finally { done(); if (locks.get(key) === next) locks.delete(key); }
}

/** Which session holds each working copy in this process, so two live sessions never share one. */
const holders = new Map();
export const release = (cwd, session) => { if (holders.get(cwd) === session) holders.delete(cwd); };
const meta = new Map(); // cwd -> { url, branch }

/** Reset what the agent could have planted in .git: the config (from the runner's template) and the hooks. */
export function harden(cwd) {
  const m = meta.get(cwd);
  if (!m) throw new Error(`not a working copy this runner made: ${cwd}`);
  const dot = join(cwd, '.git');
  if (lstatSync(dot).isSymbolicLink() || !lstatSync(dot).isDirectory()) throw new Error('.git is not the runner\'s own directory');
  const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  writeFileSync(join(dot, 'config'), [
    '[core]', '\trepositoryformatversion = 0', '\tfilemode = true', '\tbare = false', '\tlogallrefupdates = true',
    '[remote "origin"]', `\turl = "${esc(m.url)}"`, '\tfetch = +refs/heads/*:refs/remotes/origin/*',
    ...(m.branch ? [`[branch "${esc(m.branch)}"]`, '\tremote = origin', `\tmerge = refs/heads/${m.branch}`] : []), '',
  ].join('\n'));
  rmSync(join(dot, 'hooks'), { recursive: true, force: true });
  mkdirSync(join(dot, 'hooks'));
  rmSync(join(dot, 'info', 'attributes'), { force: true });
}

/**
 * Make (or reuse) the working copy for a session. `repo` is { url, ref } (a URL or a local path git can clone),
 * `worktree` a branch name or { branch, base } (omit for a read-only checkout). Returns { cwd, branch, base, head }.
 * Copies are keyed by the repository and the exact branch (or, read-only, the session), so two repositories with
 * one branch name, or branches that differ only in punctuation, never share a folder.
 */
export async function prepare({ root, repo, worktree, session }) {
  if (!repo?.url) throw new Error('session.start needs repo.url');
  const ref = repo.ref || 'main';
  const branch = typeof worktree === 'string' ? worktree : worktree?.branch ?? null;
  const base = (typeof worktree === 'object' && worktree?.base) || ref;
  if (branch && !BRANCH.test(branch)) throw new Error(`"${branch}" is not a branch name the runner will create`);
  if (!BRANCH.test(base)) throw new Error(`"${base}" is not a branch name`);
  const repoKey = short(repo.url);
  const cache = join(root, 'repos', `${repoKey}.git`);
  const cwd = join(root, 'worktrees', repoKey, branch ? `${safe(branch)}-${short(branch)}` : `read-${safe(session)}-${short(session)}`);
  const holder = holders.get(cwd);
  if (holder && holder !== session) throw new Error(`the working copy for ${branch ?? 'that checkout'} is in use by session ${holder}`);
  return locked(cache, async () => {
    if (!existsSync(cache)) {
      mkdirSync(dirname(cache), { recursive: true });
      await git(root, 'clone', '--bare', '--quiet', repo.url, cache);
    } else {
      await git(cache, 'fetch', '--quiet', '--prune', repo.url, '+refs/heads/*:refs/heads/*');
    }
    meta.set(cwd, { url: repo.url, branch });
    if (existsSync(cwd)) {
      // Resume: keep the copy and whatever the last session left in it, once it is checked to be the same
      // repository and the same branch.
      harden(cwd);
      const on = await git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
      if (branch ? on !== branch : on !== 'HEAD') throw new Error(`the working copy at ${cwd} holds ${on}, not ${branch ?? 'a detached checkout'}; not resuming into it`);
      await git(cwd, 'fetch', '--quiet', cache, '+refs/heads/*:refs/remotes/origin/*');
      holders.set(cwd, session);
      return { cwd, branch, base, head: await git(cwd, 'rev-parse', 'HEAD'), resumed: true };
    }
    mkdirSync(dirname(cwd), { recursive: true });
    // A full copy, with no hard links or alternates into the cache: the session can change only its own files.
    await git(root, 'clone', '--quiet', '--no-hardlinks', '--no-checkout', cache, cwd);
    harden(cwd);
    await git(cwd, 'fetch', '--quiet', cache, '+refs/heads/*:refs/remotes/origin/*');
    const remote = branch ? await git(cwd, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`).catch(() => '') : '';
    if (branch) await git(cwd, 'checkout', '--quiet', '-B', branch, remote ? `origin/${branch}` : `origin/${base}`);
    else await git(cwd, 'checkout', '--quiet', '--detach', `origin/${base}`);
    holders.set(cwd, session);
    return { cwd, branch, base, head: await git(cwd, 'rev-parse', 'HEAD'), resumed: false };
  });
}

/** Paths changed in the working copy and not yet committed (renames counted on both sides). */
async function dirty(cwd) {
  const out = (await run('git', [...SAFE, 'status', '--porcelain', '-z', '--untracked-files=all'], { cwd, env: gitEnv() })).stdout;
  const parts = out.split('\0').filter(Boolean);
  const paths = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2), path = parts[i].slice(3);
    paths.push(path);
    if (code[0] === 'R' || code[0] === 'C') paths.push(parts[++i]);
  }
  return [...new Set(paths)];
}

/** The paths a session changed outside its owned areas: committed on its branch since `base`, and uncommitted. */
export { owns };

export async function outOfArea({ cwd, base, areas }) {
  if (meta.has(cwd)) harden(cwd);
  const committed = (await git(cwd, 'diff', '--name-only', '--no-renames', `origin/${base}...HEAD`).catch(() => '')).split('\n').filter(Boolean).filter((p) => !owns(areas, p));
  const uncommitted = (await dirty(cwd)).filter((p) => !owns(areas, p));
  return { committed, uncommitted };
}

/** A symlink whose target leaves the working copy. */
function escapes(cwd, path) {
  const full = join(cwd, path);
  let st;
  try { st = lstatSync(full); } catch { return false; }
  if (!st.isSymbolicLink()) return false;
  const target = readlinkSync(full);
  const rel = relative(cwd, isAbsolute(target) ? target : resolve(dirname(full), target));
  return rel.startsWith('..') || isAbsolute(rel) || rel.split(sep)[0] === '.git';
}

/**
 * Bring a working copy to a safe point and push it, if what it holds may leave. Uncommitted changes inside the
 * owned areas are committed as a checkpoint; changes outside them are left uncommitted and reported. Nothing is
 * pushed when the branch's commits touch paths outside the areas, hold an escaping symlink, or hold a secret.
 * `secrets` are extra exact values to look for (the session's proxy token).
 * Returns { commit, pushed, held: [paths left out], refused?: { rule, items }, error? }.
 */
export async function checkpoint({ cwd, branch, base = 'main', role, reason, areas = [], secrets = [] }) {
  harden(cwd);
  if (!branch) return { commit: await git(cwd, 'rev-parse', 'HEAD'), pushed: false, held: [] };
  const changed = await dirty(cwd);
  const mine = changed.filter((p) => owns(areas, p) && !escapes(cwd, p));
  const held = changed.filter((p) => !mine.includes(p));
  const stop = (rule, items, error) => ({ commit: null, pushed: false, held, refused: { rule, items: items.slice(0, 20) }, error });
  if (mine.length) {
    await git(cwd, 'add', '-A', '--', ...mine);
    const hits = findSecrets({ files: mine.map((p) => ({ path: p, text: existsSync(join(cwd, p)) && lstatSync(join(cwd, p)).isFile() ? readFileSync(join(cwd, p), 'utf8') : '' })), values: secrets });
    if (hits.length) { await git(cwd, 'reset', '--quiet'); return stop('secret-scan', hits, `not committed: the changes look like they hold a secret (${hits.slice(0, 5).join(', ')})`); }
    if (await git(cwd, 'diff', '--cached', '--name-only')) await git(cwd, '-c', `user.name=${role}`, '-c', 'user.email=runner@agent-team.invalid', 'commit', '--quiet', '--no-verify', '-m', `checkpoint (${role}): ${reason}`);
  }
  const commit = await git(cwd, 'rev-parse', 'HEAD');
  // What the agent committed itself, from the shell, is checked the same way before anything is pushed.
  const range = `origin/${base}...HEAD`;
  const committed = (await git(cwd, 'diff', '--name-only', '--no-renames', range).catch(() => '')).split('\n').filter(Boolean);
  const outside = committed.filter((p) => !owns(areas, p));
  if (outside.length) return { ...stop('ownership', outside, `not pushed: the branch's commits change paths outside this role's owned areas (${outside.slice(0, 10).join(', ')})`), commit };
  const links = (await git(cwd, 'diff', '--raw', '--no-renames', range).catch(() => '')).split('\n').filter((l) => /^:\d+ 120000 /.test(l)).map((l) => l.split('\t')[1]).filter((p) => escapes(cwd, p));
  if (links.length) return { ...stop('symlink', links, `not pushed: symlinks point outside the working copy (${links.join(', ')})`), commit };
  const files = committed.filter((p) => existsSync(join(cwd, p)) && lstatSync(join(cwd, p)).isFile()).map((p) => ({ path: p, text: readFileSync(join(cwd, p), 'utf8') }));
  const hits = findSecrets({ files, values: secrets });
  if (hits.length) return { ...stop('secret-scan', hits, `not pushed: the branch looks like it holds a secret (${hits.slice(0, 5).join(', ')})`), commit };
  try {
    await git(cwd, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`);
    return { commit, pushed: true, held, ...(held.length ? { error: `left uncommitted, outside the owned areas: ${held.slice(0, 10).join(', ')}` } : {}) };
  } catch (e) {
    return { commit, pushed: false, held, error: String(e.stderr || e.message).trim().split('\n').pop() };
  }
}
