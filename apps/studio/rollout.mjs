// The rollout view's data for the local Studio (demo step 17, CPO copy "Rollout view after a publish", D61 to D63):
// which roles have picked up the team version that last reached the default branch, from the board.
//
// Connected to a control plane, the Studio asks it instead (GET /v1/teams/{team}/rollout reads the team.published
// event). Here, with no control plane, the repository says what was published: the last commit on the default
// branch's first-parent line that changed .agent-team/ (the version a role's reports name, tools/report.mjs
// teamVersionAt), with the plan the Studio wrote into its message. Read-only, like the view.
import { execFileSync } from 'node:child_process';
import { rollout, versionName } from '../../packages/team-model/index.mjs';
import { publishedBody } from '../../tools/report.mjs';

const git = (cwd, args) => {
  try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
};
const lastTeamCommit = (root, ref) => git(root, ['log', '-1', '--first-parent', '--format=%H', ref, '--', '.agent-team']);

/** The branch publishes merge into: the remote's default (origin/HEAD), else origin/main or origin/master, else null. */
export function defaultBranch(root) {
  const head = git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (head) return head;
  for (const b of ['origin/main', 'origin/master']) if (git(root, ['rev-parse', '--verify', '--quiet', `${b}^{commit}`])) return b;
  return null;
}

/**
 * Where a person sees the published change: the pull request (or the commit) on GitHub, from this checkout's origin.
 * Null for another host or no origin. Credentials in the remote URL are never carried over.
 */
export function changeUrl(root, { version, pr } = {}) {
  const raw = git(root, ['remote', 'get-url', 'origin']);
  const m = /^(?:https:\/\/(?:[^@/]+@)?|git@|ssh:\/\/git@)github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(raw);
  if (!m) return null;
  const base = `https://github.com/${m[1]}/${m[2]}`;
  if (Number.isInteger(pr) && pr > 0) return `${base}/pull/${pr}`;
  return /^[0-9a-f]{7,40}$/.test(String(version ?? '')) ? `${base}/commit/${version}` : null;
}

/**
 * { version, name, publishedAt, pr, roles, summary, asOf, pending } for the view. `version` is null when nothing has
 * reached the default branch yet (the empty state). `pending` is { version, name } when this checkout has a team
 * change that is not on the default branch yet (published, waiting for its merge).
 */
export function localRollout(root, board = { current: [] }) {
  const base = defaultBranch(root);
  const merged = lastTeamCommit(root, base ?? 'HEAD');
  const pending = pendingOf(root, base, merged);
  if (!merged) return { version: null, name: null, roles: [], summary: null, pr: null, asOf: board?.asOf ?? null, pending };
  const p = publishedBody(root, { sha: merged });
  return { ...rollout({ version: p.version, publishedAt: p.publishedAt, roles: p.roles, off: p.off, plan: p.plan, board }), pr: p.pr, changeUrl: changeUrl(root, { version: p.version, pr: p.pr }), asOf: board?.asOf ?? null, pending };
}

/**
 * { version, name } when this checkout has a team change the default branch does not have yet, else null. Reads the
 * remote-tracking refs, so it is as of the last git fetch. Never throws (every git call fails soft).
 */
export function pendingOf(root, base = defaultBranch(root), merged = lastTeamCommit(root, base ?? 'HEAD')) {
  const mine = lastTeamCommit(root, 'HEAD');
  const waiting = !!base && !!mine && mine !== merged && !isAncestor(root, mine, base);
  return waiting ? { version: mine, name: versionName(mine) } : null;
}

function isAncestor(root, a, b) {
  try { execFileSync('git', ['-C', root, 'merge-base', '--is-ancestor', a, b], { stdio: 'ignore' }); return true; } catch { return false; }
}
