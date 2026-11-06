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
 * { version, name, publishedAt, pr, roles, summary, asOf, pending } for the view. `version` is null when nothing has
 * reached the default branch yet (the empty state). `pending` is { version, name } when this checkout has a team
 * change that is not on the default branch yet (published, waiting for its merge).
 */
export function localRollout(root, board = { current: [] }) {
  const base = defaultBranch(root);
  const merged = lastTeamCommit(root, base ?? 'HEAD');
  const mine = lastTeamCommit(root, 'HEAD');
  const waiting = !!base && !!mine && mine !== merged && !isAncestor(root, mine, base);
  const pending = waiting ? { version: mine, name: versionName(mine) } : null;
  if (!merged) return { version: null, name: null, roles: [], summary: null, pr: null, asOf: board?.asOf ?? null, pending };
  const p = publishedBody(root, { sha: merged });
  return { ...rollout({ version: p.version, publishedAt: p.publishedAt, roles: p.roles, off: p.off, plan: p.plan, board }), pr: p.pr, asOf: board?.asOf ?? null, pending };
}

function isAncestor(root, a, b) {
  try { execFileSync('git', ['-C', root, 'merge-base', '--is-ancestor', a, b], { stdio: 'ignore' }); return true; } catch { return false; }
}
