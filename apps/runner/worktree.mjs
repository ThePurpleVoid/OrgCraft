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
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { owns } from './policy.mjs';
import { findSecrets } from './secrets.mjs';
import { grant, sharedDir } from './sandbox.mjs';

const run = promisify(execFile);
/**
 * Pinned for every runner-side git call; they override anything the repository's config says. `core.sshCommand` is
 * pinned too, since a command-line -c beats every config file: to plain `ssh`, or to the operator's own sshCommand
 * from the runner's git config (the deploy key, IdentitiesOnly, strict host key checking against the image's
 * known_hosts). A repository or a session can never choose it. (F-B1: pinning plain `ssh` over the operator's value
 * made every clone over SSH fail with "Host key verification failed".)
 */
let sshCommand = 'ssh';
const SAFE_BASE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never', '-c', 'core.pager=cat', '-c', 'credential.interactive=false'];
const gitSafe = () => [...SAFE_BASE, '-c', `core.sshCommand=${sshCommand}`];
let gitGlobal = '/dev/null';
/** A git config file the operator controls, for the runner's own push credential (a deploy key or a credential helper). */
export function useGitConfig(path) {
  gitGlobal = path && existsSync(path) ? path : '/dev/null';
  sshCommand = 'ssh';
  if (gitGlobal === '/dev/null') return;
  // It names the command every push runs, so only the runner (or root) may write it: 0600, owned by either
  // (security on LT-FB: a session under the runner's uid must not be able to plant one for the next start).
  const st = statSync(gitGlobal);
  const me = process.getuid?.() ?? 0;
  if ((st.mode & 0o077) !== 0 || (st.uid !== me && st.uid !== 0)) {
    gitGlobal = '/dev/null';
    throw new Error(`${path} must be mode 0600 and owned by the runner's user or root (it is ${(st.mode & 0o777).toString(8)}, uid ${st.uid}); fix it and start again`);
  }
  let own = '';
  try {
    own = execFileSync('git', ['config', '--file', gitGlobal, '--get', 'core.sshCommand'], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, encoding: 'utf8' }).trim();
  } catch { /* not set: plain ssh */ }
  if (own) sshCommand = own;
}
/** The ssh command every runner-side git call uses (for tests and the image check). */
export function effectiveSshCommand() { return sshCommand; }
const gitEnv = () => {
  const keep = ['PATH', 'HOME', 'SSH_AUTH_SOCK', 'LANG', 'TMPDIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'GIT_SSL_CAINFO', 'SSL_CERT_FILE'];
  return { ...Object.fromEntries(keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])), GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitGlobal };
};

export async function git(cwd, ...args) {
  const { stdout } = await run('git', [...gitSafe(), ...args], { cwd, env: gitEnv(), maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

/** Whether `sha` (a commit id) is HEAD or behind it in this working copy: a resume found its checkpoint. */
export async function onBranch(cwd, sha) {
  if (!/^[0-9a-f]{7,64}$/.test(String(sha ?? ''))) return false;
  return git(cwd, 'merge-base', '--is-ancestor', `${sha}^{commit}`, 'HEAD').then(() => true, () => false);
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
const meta = new Map(); // cwd -> { url, branch, base, cache, bases: [sha] }: runner memory, never read back from the working copy

/** Reset what the agent could have planted in .git: the config (from the runner's template) and the hooks. */
export function harden(cwd) {
  const m = meta.get(cwd);
  if (!m) throw new Error(`not a working copy this runner made: ${cwd}`);
  const dot = join(cwd, '.git');
  const st = lstatSync(dot);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('.git is not the runner\'s own directory');
  // With sessions as another user, a .git the agent replaced is the agent's, not the runner's (F3).
  if (m.sandbox && process.getuid && st.uid !== process.getuid()) throw new Error('.git was replaced by the session; not running git in it');
  // Nothing in .git may be a link (it could point the runner's git, or its writes, at the runner's own files).
  const link = readdirSync(dot, { withFileTypes: true }).find((e) => e.isSymbolicLink());
  if (link) throw new Error(`.git/${link.name} is a link; not running git in this copy`);
  const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  rmSync(join(dot, 'config'), { force: true });
  writeFileSync(join(dot, 'config'), [
    '[core]', '\trepositoryformatversion = 0', '\tfilemode = true', '\tbare = false', '\tlogallrefupdates = true',
    '[remote "origin"]', `\turl = "${esc(m.url)}"`, '\tfetch = +refs/heads/*:refs/remotes/origin/*',
    ...(m.branch ? [`[branch "${esc(m.branch)}"]`, '\tremote = origin', `\tmerge = refs/heads/${m.branch}`] : []), '',
  ].join('\n'), { flag: 'wx', mode: 0o640 });
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
/**
 * Where the working copy for this repository and branch (or, read-only, this session) lives under `work`.
 * Before a runner serves more than one customer, this path and the repository cache must include the tenant and team.
 */
export function copyPath({ work, repo, worktree, session }) {
  const branch = typeof worktree === 'string' ? worktree : worktree?.branch ?? null;
  return join(work, 'worktrees', short(repo?.url ?? ''), branch ? `${safe(branch)}-${short(branch)}` : `read-${safe(session)}-${short(session)}`);
}

export async function prepare({ root, work = root, repo, worktree, session, sandbox = null }) {
  if (!repo?.url) throw new Error('session.start needs repo.url');
  const ref = repo.ref || 'main';
  const branch = typeof worktree === 'string' ? worktree : worktree?.branch ?? null;
  const base = (typeof worktree === 'object' && worktree?.base) || ref;
  if (branch && !BRANCH.test(branch)) throw new Error(`"${branch}" is not a branch name the runner will create`);
  if (!BRANCH.test(base)) throw new Error(`"${base}" is not a branch name`);
  const repoKey = short(repo.url);
  const cache = join(root, 'repos', `${repoKey}.git`); // keyed by tenant and team too before a runner serves more than one customer
  const cwd = copyPath({ work, repo, worktree, session });
  const holder = holders.get(cwd);
  if (holder && holder !== session) throw new Error(`the working copy for ${branch ?? 'that checkout'} is in use by session ${holder}`);
  return locked(cache, async () => {
    if (!existsSync(cache)) {
      mkdirSync(dirname(cache), { recursive: true });
      await git(root, 'clone', '--bare', '--quiet', repo.url, cache);
    } else {
      await git(cache, 'fetch', '--quiet', '--prune', repo.url, '+refs/heads/*:refs/heads/*');
    }
    // The base commit comes from the runner's cache, not from the clone, and stays in runner memory: what is
    // checked at a checkpoint is everything between it and HEAD, so the agent cannot shrink the range by moving a
    // ref in its own clone (security review F1).
    const baseSha = await git(cache, 'rev-parse', '--verify', `refs/heads/${base}^{commit}`);
    meta.set(cwd, { url: repo.url, branch, base, cache, bases: [baseSha], sandbox });
    if (existsSync(cwd)) {
      // Resume: keep the copy and whatever the last session left in it, once it is checked to be the same
      // repository and the same branch. A parked copy opens to this session's user only (#28).
      if (sandbox) grant(cwd, sandbox);
      harden(cwd);
      const on = await git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
      if (branch ? on !== branch : on !== 'HEAD') throw new Error(`the working copy at ${cwd} holds ${on}, not ${branch ?? 'a detached checkout'}; not resuming into it`);
      await git(cwd, 'fetch', '--quiet', cache, '+refs/heads/*:refs/remotes/origin/*');
      holders.set(cwd, session);
      return { cwd, branch, base, baseSha, head: await git(cwd, 'rev-parse', 'HEAD'), resumed: true };
    }
    for (const d of [work, join(work, 'worktrees'), dirname(cwd)]) sharedDir(d, sandbox);
    // The clone itself (made by git below, with the runner's umask) is the leaf the agent works in.
    // A full copy, with no hard links or alternates into the cache: the session can change only its own files.
    await git(root, 'clone', '--quiet', '--no-hardlinks', '--no-checkout', cache, cwd);
    if (sandbox) grant(cwd, sandbox);
    harden(cwd);
    await git(cwd, 'fetch', '--quiet', cache, '+refs/heads/*:refs/remotes/origin/*');
    const remote = branch ? await git(cwd, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`).catch(() => '') : '';
    if (branch) await git(cwd, 'checkout', '--quiet', '-B', branch, remote ? `origin/${branch}` : baseSha);
    else await git(cwd, 'checkout', '--quiet', '--detach', baseSha);
    holders.set(cwd, session);
    return { cwd, branch, base, baseSha, head: await git(cwd, 'rev-parse', 'HEAD'), resumed: false };
  });
}

/** Paths changed in the working copy and not yet committed (renames counted on both sides). */
async function dirty(cwd) {
  const out = (await run('git', [...gitSafe(), 'status', '--porcelain', '-z', '--untracked-files=all'], { cwd, env: gitEnv() })).stdout;
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

export async function outOfArea({ cwd, areas }) {
  harden(cwd);
  const committed = (await history(cwd)).names.filter((p) => !owns(areas, p));
  const uncommitted = (await dirty(cwd)).filter((p) => !owns(areas, p));
  return { committed, uncommitted };
}

/**
 * Everything the branch would push: each commit since the recorded base, not just the final tree (F2). Returns
 * { names: every path any commit touched, added: [{ path, text }] lines each commit added, messages, links:
 * [{ path, target }] symlinks in the result }. Throws when git fails, so callers fail closed.
 */
/**
 * Fetch the base branch again, in the runner's own cache (with the runner's credential, outside the session), and
 * add its head to the bases this copy is checked against. So when the base moves during a session, or the agent
 * merges it in, what landed there is not counted as this branch's change. Only shas the runner read itself are
 * used; no ref in the clone is trusted.
 */
async function refreshBase(cwd) {
  const m = meta.get(cwd);
  const sha = await locked(m.cache, async () => {
    await git(m.cache, 'fetch', '--quiet', '--prune', m.url, '+refs/heads/*:refs/heads/*');
    return git(m.cache, 'rev-parse', '--verify', `refs/heads/${m.base}^{commit}`);
  });
  if (!m.bases.includes(sha)) {
    await git(cwd, 'fetch', '--quiet', m.cache, `+refs/heads/${m.base}:refs/remotes/origin/${m.base}`);
    await git(cwd, 'cat-file', '-e', `${sha}^{commit}`);
    m.bases.push(sha);
  }
}

/**
 * After the branch was merged (squashed) into its base: start the working copy again from the new base, so later work
 * does not carry commits the base already has in another form (they would conflict with their own squash). Only when
 * everything here was merged (`merged` is the head that was, and the copy's HEAD must be in it) and nothing is left
 * uncommitted. Returns the new HEAD, or null when it left the copy as it was.
 */
export async function restart(cwd, merged) {
  const m = meta.get(cwd);
  if (!m) throw new Error('no recorded base for this working copy');
  try { await git(cwd, 'merge-base', '--is-ancestor', 'HEAD', merged); } catch { return null; }
  // Files left uncommitted (outside the role's areas, waiting on their owner) are the agent's work: never reset them away.
  if (await git(cwd, 'status', '--porcelain', '--untracked-files=all')) return null;
  await refreshBase(cwd);
  await git(cwd, 'reset', '--quiet', '--hard', `refs/remotes/origin/${m.base}`);
  return git(cwd, 'rev-parse', 'HEAD');
}

/**
 * The checks every commit leaving through the runner passes, from `head` back to the bases the runner fetched itself:
 * ownership, symlinks, large files and the secret scan. Returns { h } (the history) or { problem: { rule, items, text } }.
 * `lead` starts the text ("not pushed", "not asked"). Any git failure is a problem (F1: fail closed).
 */
async function checkRange(cwd, head, areas, secrets, lead) {
  let h;
  try { h = await history(cwd, head); } catch (e) {
    const why = String(e.stderr || e.message).trim().split('\n').pop();
    const text = e.refresh
      ? `${lead}: the runner could not reach the remote to check the branch against ${meta.get(cwd).base} (${why}). Do not push another way; report BLOCKED if it persists`
      : `${lead}: the runner could not read the branch's history (${why})`;
    return { problem: { rule: e.refresh ? 'remote-unreachable' : 'history', items: [], text } };
  }
  const outside = h.names.filter((p) => !owns(areas, p));
  if (outside.length) return { problem: { rule: 'ownership', items: outside.slice(0, 20), text: `${lead}: the branch's commits change paths outside this role's owned areas (${outside.slice(0, 10).join(', ')})` } };
  const links = h.links.filter((l) => leaves(cwd, l.path, l.target)).map((l) => l.path);
  if (links.length) return { problem: { rule: 'symlink', items: links, text: `${lead}: symlinks point outside the working copy (${links.join(', ')})` } };
  if (h.large.length) return { problem: { rule: 'large-file', items: h.large, text: `${lead}: files over 20 MB are not pushed from a session (${h.large.slice(0, 5).join(', ')})` } };
  const hits = [...new Set(findSecrets({ files: [...h.names.map((path) => ({ path, text: '' })), ...h.added, ...h.binaries, { path: 'commit message', text: h.messages }], values: secrets }))];
  if (hits.length) return { problem: { rule: 'secret-scan', items: hits.slice(0, 20), text: `${lead}: the branch's commits look like they hold a secret (${hits.slice(0, 5).join(', ')})` } };
  return { h };
}

/**
 * A head on the remote that the runner did not push (someone pushed to the pull request after an approval): fetched
 * by the runner from the URL it holds, then put through the same checks as a checkpoint, over every commit from it
 * back to the bases. Returns { ok: true } or { ok: false, moved?, problem }. Nothing is checked out.
 */
export async function checkHead(cwd, { branch, sha, areas = [], secrets = [] }) {
  const m = meta.get(cwd);
  if (!m) return { ok: false, problem: { rule: 'history', items: [], text: 'not asked: no recorded base for this working copy' } };
  const ref = 'refs/agent-team/incoming';
  try {
    await git(cwd, 'fetch', '--quiet', '--no-tags', m.url, `+refs/heads/${branch}:${ref}`);
  } catch (e) {
    return { ok: false, problem: { rule: 'remote-unreachable', items: [], text: `not asked: the runner could not fetch ${branch} (${String(e.stderr || e.message).trim().split('\n').pop()})` } };
  }
  try {
    const got = await git(cwd, 'rev-parse', '--verify', `${ref}^{commit}`);
    if (got !== sha) return { ok: false, moved: got, problem: { rule: 'head-moved', items: [got], text: `not asked: ${branch} moved again, to ${got}` } };
    const { problem } = await checkRange(cwd, sha, areas, secrets, 'not asked');
    return problem ? { ok: false, problem } : { ok: true };
  } finally {
    await git(cwd, 'update-ref', '-d', ref).catch(() => {});
  }
}

/** The lines a patch adds, per file. */
function addedLines(patch) {
  const added = new Map();
  // File headers come only between a `diff --` line and its first hunk; inside a hunk, a line starting with
  // `+++ ` or `--- ` is content (an added `++ x` line), so it is scanned like any other.
  let file = null, cols = 1, header = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --')) { file = null; header = true; continue; }
    const hunk = /^(@{2,}) /.exec(line);
    if (hunk && (header || file)) { header = false; cols = hunk[1].length - 1; continue; }
    if (header) { if (line.startsWith('+++ ')) file = line.slice(4).replace(/^b\//, ''); continue; }
    if (!file) continue;
    const pre = line.slice(0, cols);
    if (pre.includes('+') && !pre.includes('-')) added.set(file, (added.get(file) ?? '') + line.slice(cols) + '\n');
  }
  return [...added].map(([path, text]) => ({ path, text }));
}

async function history(cwd, head = 'HEAD') {
  const { bases } = meta.get(cwd) ?? {};
  if (!bases?.length) throw new Error('no recorded base for this working copy');
  await refreshBase(cwd).catch((e) => { e.refresh = true; throw e; });
  const range = [head, '--not', ...bases];
  const names = new Set([
    ...(await git(cwd, 'log', '--format=', '--name-only', '--no-renames', '--cc', ...range)).split('\n'),
    ...(await git(cwd, 'diff', '--name-only', '--no-renames', `${bases.at(-1)}...${head}`)).split('\n'),
  ].filter(Boolean));
  const patch = await git(cwd, 'log', '--format=', '-p', '--cc', '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv', ...range);
  const added = addedLines(patch);
  const messages = await git(cwd, 'log', '--format=%B%x00', ...range);
  const links = [];
  for (const l of (await git(cwd, 'diff', '--raw', '--no-renames', '--no-abbrev', `${bases.at(-1)}...${head}`)).split('\n')) {
    const m = /^:\d+ 120000 \S+ (\S+) \S+\t(.+)$/.exec(l);
    if (m) links.push({ path: m[2], target: await git(cwd, 'cat-file', 'blob', m[1]) });
  }
  return { names: [...names], added, messages, links, ...(await binaries(cwd, range)) };
}

const MAX_BLOB = 20 * 1024 * 1024;
/**
 * The binary files the branch would push, every version of them (their lines are not in the patch, so the line
 * scan never sees them). Returns { binaries: [{ path, text }] (latin1, for the secret scan), large: [paths] }.
 */
async function binaries(cwd, range) {
  const objects = (await git(cwd, 'rev-list', '--objects', '--no-object-names', ...range)).split('\n').filter(Boolean);
  const named = new Map((await git(cwd, 'rev-list', '--objects', ...range)).split('\n').map((l) => [l.slice(0, l.indexOf(' ') >>> 0), l.slice(l.indexOf(' ') + 1)]));
  if (!objects.length) return { binaries: [], large: [] };
  const p = run('git', [...gitSafe(), 'cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { cwd, env: gitEnv(), maxBuffer: 64 * 1024 * 1024 });
  p.child.stdin.end(objects.join('\n') + '\n');
  const out = [], large = [], wanted = [];
  for (const line of (await p).stdout.trim().split('\n')) {
    const [sha, type, size] = line.split(' ');
    if (type !== 'blob') continue;
    if (Number(size) > MAX_BLOB) large.push(named.get(sha) || sha); else wanted.push(sha);
  }
  if (wanted.length) {
    // One `cat-file --batch` for every blob: "<sha> blob <size>\n<content>\n" each.
    const q = run('git', [...gitSafe(), 'cat-file', '--batch'], { cwd, env: gitEnv(), encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 });
    q.child.stdin.end(wanted.join('\n') + '\n');
    const buf = (await q).stdout;
    let at = 0;
    while (at < buf.length) {
      const nl = buf.indexOf(10, at);
      const [sha, , size] = buf.subarray(at, nl).toString().split(' ');
      const body = buf.subarray(nl + 1, nl + 1 + Number(size));
      at = nl + 1 + Number(size) + 1;
      if (body.subarray(0, 8000).includes(0)) out.push({ path: named.get(sha) || sha, text: body.toString('latin1') });
    }
  }
  return { binaries: out, large };
}

/** Whether a link at `path` pointing at `target` leaves the working copy (or reaches into .git). */
function leaves(cwd, path, target) {
  const rel = relative(cwd, isAbsolute(target) ? target : resolve(dirname(join(cwd, path)), target));
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel.split(sep)[0] === '.git';
}

/** A symlink whose target leaves the working copy. */
function escapes(cwd, path) {
  const full = join(cwd, path);
  let st;
  try { st = lstatSync(full); } catch { return false; }
  return st.isSymbolicLink() && leaves(cwd, path, readlinkSync(full));
}

/**
 * Bring a working copy to a safe point and push it, if what it holds may leave. Uncommitted changes inside the
 * owned areas are committed as a checkpoint; changes outside them are left uncommitted and reported. Nothing is
 * pushed when the branch's commits touch paths outside the areas, hold an escaping symlink, or hold a secret.
 * `secrets` are extra exact values to look for (the session's proxy token).
 * `beforePush` (optional) runs after the commit and its checks, just before the push: a string it returns refuses
 * the push only (the commit stays, locally), for example the GitHub installation check (#28).
 * Returns { commit, pushed, held: [paths left out], refused?: { rule, items }, error? }.
 */
export async function checkpoint({ cwd, branch, role, reason, areas = [], secrets = [], beforePush = null }) {
  harden(cwd);
  if (!branch) return { commit: await git(cwd, 'rev-parse', 'HEAD'), pushed: false, held: [] };
  const changed = await dirty(cwd);
  const mine = changed.filter((p) => owns(areas, p) && !escapes(cwd, p));
  const held = changed.filter((p) => !mine.includes(p));
  const stop = (rule, items, error) => ({ commit: null, pushed: false, held, refused: { rule, items: items.slice(0, 20) }, error });
  if (mine.length) {
    await git(cwd, 'add', '-A', '--', ...mine);
    // Scanned from what git staged, never by reading the working copy (which could hold links).
    const staged = addedLines(await git(cwd, 'diff', '--cached', '-p', '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv'));
    const hits = findSecrets({ files: [...mine.map((p) => ({ path: p, text: '' })), ...staged], values: secrets });
    if (hits.length) { await git(cwd, 'reset', '--quiet'); return stop('secret-scan', hits, `not committed: the changes look like they hold a secret (${hits.slice(0, 5).join(', ')})`); }
    if (await git(cwd, 'diff', '--cached', '--name-only')) await git(cwd, '-c', `user.name=${role}`, '-c', 'user.email=runner@agent-team.invalid', 'commit', '--quiet', '--no-verify', '-m', `checkpoint (${role}): ${reason}`);
  }
  const commit = await git(cwd, 'rev-parse', 'HEAD');
  // What the agent committed itself, from the shell, is checked the same way, commit by commit, before anything
  // is pushed. Any git failure here refuses the push (F1: fail closed).
  const { h, problem } = await checkRange(cwd, 'HEAD', areas, secrets, 'not pushed');
  if (problem) return { ...stop(problem.rule, problem.items, problem.text), commit };
  const no = beforePush ? await beforePush().catch((e) => `not pushed: ${e.message}`) : null;
  if (no) return { commit, pushed: false, held, error: no };
  try {
    await git(cwd, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`);
    // `changes`: the paths the branch changes against its base (none: there is nothing to propose yet).
    return { commit, pushed: true, changes: h.names.length, held, ...(held.length ? { error: `left uncommitted, outside the owned areas: ${held.slice(0, 10).join(', ')}` } : {}) };
  } catch (e) {
    return { commit, pushed: false, held, error: pushError(e) };
  }
}

/**
 * Why git refused a push, in a line people can act on (F-B5): the remote's own ERROR or rejection lines (a read-only
 * deploy key, a protected branch, host key verification) first, then git's last line. At most 400 characters.
 */
export function pushError(e) {
  const lines = String(e?.stderr || e?.message || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const telling = lines.filter((l) => /^(remote:\s*)?(error|fatal)\b|rejected|read.only|denied|verification failed|protected/i.test(l) && !/^error: failed to push some refs/i.test(l));
  const last = lines.at(-1) ?? 'git push failed';
  return [...new Set([...telling.slice(0, 3), last])].join(' ').slice(0, 400);
}
