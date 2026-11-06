// Publish as a pull request (issue #30, "PR through gh"). After a publish commits on its branch, the Studio server
// pushes that branch and opens a pull request with the GitHub CLI when gh is installed and signed in. Without gh it
// stops after the push and gives the branch and the compare link. Credentials are only ever the machine's own (git's
// credential helper, gh's sign-in): nothing from the browser is used, and nothing is ever force-pushed.
import { spawnSync } from 'node:child_process';

const ENV_QUIET = { GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };
const run = (cmd, args, { cwd, env, input, timeout = 60_000 } = {}) => {
  const r = spawnSync(cmd, args, { cwd, env: { ...env, ...ENV_QUIET }, input, encoding: 'utf8', timeout, stdio: ['pipe', 'pipe', 'pipe'] });
  return { ok: !r.error && r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() || r.error?.message || '' };
};
const ghBin = (env) => env.AGENT_TEAM_GH || 'gh';

/** The https page of a GitHub remote ("git@github.com:o/r.git", "https://github.com/o/r"), or null for any other host. */
export function githubRepo(remote) {
  const m = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/(?:[^@/]+@)?github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(String(remote ?? '').trim());
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

/** The page to open a pull request by hand, for a GitHub remote; null otherwise. */
export function compareUrl(remote, base, branch) {
  const page = githubRepo(remote);
  return page ? `${page}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?expand=1` : null;
}

/** The pull request a publish commit asks for: the commit's first line, and the rest (the change-safety plan) as the body. */
export function pullRequestText(message, commit) {
  const [title, ...rest] = String(message ?? '').trim().split('\n');
  const body = rest.join('\n').trim();
  return { title: title.trim() || 'Update the agent team (Agent Team Studio)', body: `${body ? `${body}\n\n` : ''}Published from Agent Team Studio${commit ? ` (commit ${commit})` : ''}.` };
}

/** What the Studio can do with a published branch on this machine: { remote, gh, base }. */
export function prSupport(root, env = process.env) {
  const remote = run('git', ['-C', root, 'remote', 'get-url', 'origin'], { env }).out || null;
  const gh = run(ghBin(env), ['auth', 'status'], { cwd: root, env, timeout: 10_000 }).ok;
  const head = run('git', ['-C', root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { env }).out;
  return { remote, gh, base: head ? head.replace(/^origin\//, '') : null };
}

/**
 * Pushes `branch` to origin (never forced) and opens a pull request into `base` with gh when it is signed in.
 * Returns { state, branch, base, url?, compareUrl?, error?, commands }: state is opened, exists, pushed (no gh, or
 * gh not signed in), not-pushed (the push failed), no-remote or same-branch. `commands` are what the owner can run.
 */
export function openPullRequest(root, { branch, base, title, body }, env = process.env) {
  const remote = run('git', ['-C', root, 'remote', 'get-url', 'origin'], { env }).out || null;
  const push = `git push -u origin ${branch}`;
  const result = (state, extra = {}) => ({ state, branch, base, compareUrl: remote ? compareUrl(remote, base, branch) : null, ...extra });
  if (!base || base === branch) return result('same-branch', { error: 'publish to a new branch to open a pull request', commands: [] });
  if (!remote) return result('no-remote', { error: 'this repository has no "origin" remote', commands: ['git remote add origin <url>', push] });
  const pushed = run('git', ['-C', root, 'push', '-u', 'origin', branch], { env });
  if (!pushed.ok) return result('not-pushed', { error: pushed.err.split('\n').slice(-3).join(' '), commands: [push] });
  const create = `gh pr create --base ${base} --head ${branch} --fill`;
  if (!run(ghBin(env), ['auth', 'status'], { cwd: root, env, timeout: 10_000 }).ok) return result('pushed', { reason: 'gh is not installed or not signed in', commands: [create] });
  const pr = run(ghBin(env), ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body-file', '-'], { cwd: root, env, input: body });
  const url = (text) => (/https?:\/\/\S+/.exec(text) ?? [])[0];
  if (pr.ok && url(pr.out)) return result('opened', { url: url(pr.out), commands: [] });
  if (/already exists/i.test(pr.err)) {
    const view = run(ghBin(env), ['pr', 'view', branch, '--json', 'url', '-q', '.url'], { cwd: root, env });
    return result('exists', { url: url(view.out) ?? url(pr.err) ?? null, commands: [] });
  }
  return result('pushed', { reason: `gh could not open the pull request: ${pr.err.split('\n').slice(-2).join(' ')}`, commands: [create] });
}
