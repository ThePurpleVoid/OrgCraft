import { test } from 'node:test';
import assert from 'node:assert/strict';
import { areasOf, decide, matchArea } from '../policy.mjs';

const cwd = '/work/wt';

test('owned areas use the ownership table\'s path patterns', () => {
  assert.deepEqual(areasOf(['apps/runner/, evals/', 'scripts/*.sh']), ['apps/runner/', 'evals/', 'scripts/*.sh']);
  assert.ok(matchArea('apps/runner/', 'apps/runner/session.mjs'));
  assert.ok(!matchArea('apps/runner/', 'apps/runner-old/x'));
  assert.ok(matchArea('scripts/*.sh', 'scripts/sync.sh'));
  assert.ok(!matchArea('scripts/*.sh', 'scripts/agent-team/sync.sh'));
  assert.ok(matchArea('docs/**/x.md', 'docs/a/b/x.md'));
  assert.ok(matchArea('team/ (role library, protocols)', 'team/roles/cto.md'), 'notes in brackets are ignored');
  assert.ok(matchArea('README.md', 'README.md'));
});

test('writes: inside owned areas only, never outside the worktree or into .git', () => {
  const areas = ['apps/web/'];
  assert.equal(decide({ tool: 'Write', input: { file_path: 'apps/web/a.ts' }, cwd, areas }).decision, 'allowed');
  assert.equal(decide({ tool: 'Edit', input: { file_path: '/work/wt/apps/web/a.ts' }, cwd, areas }).decision, 'allowed');
  assert.equal(decide({ tool: 'Edit', input: { file_path: 'apps/server/a.ts' }, cwd, areas }).rule, 'ownership');
  assert.equal(decide({ tool: 'Write', input: { file_path: '../other/x' }, cwd, areas }).rule, 'outside-worktree');
  assert.equal(decide({ tool: 'Write', input: { file_path: '/etc/passwd' }, cwd, areas }).rule, 'outside-worktree');
  assert.equal(decide({ tool: 'Write', input: { file_path: '.git/hooks/pre-commit' }, cwd, areas: ['.'] }).rule, 'git-internals');
  assert.match(decide({ tool: 'Write', input: { file_path: 'a' }, cwd, areas: [] }).why, /owns no paths/);
  // Settings that steer agents or CI are written only by a role that owns them by name (R3).
  for (const p of ['.claude/settings.json', '.mcp.json', '.github/workflows/ci.yml', '.gitattributes']) assert.equal(decide({ tool: 'Write', input: { file_path: p }, cwd, areas: ['**'] }).rule, 'guarded', p);
  assert.equal(decide({ tool: 'Write', input: { file_path: '.github/workflows/ci.yml' }, cwd, areas: ['.github/workflows/'] }).decision, 'allowed');
  assert.equal(decide({ tool: 'Read', input: { file_path: '/anything' }, cwd, areas: [] }).decision, 'allowed');
});

test('the owner-steps-in list becomes approvals', () => {
  const needs = (command) => decide({ tool: 'Bash', input: { command }, cwd }).rule;
  assert.equal(needs('psql "$DB" -c "DROP TABLE users"'), 'destructive-data');
  assert.equal(needs('psql -c "delete from orders where 1=1"'), 'destructive-data');
  assert.equal(needs('psql -c "alter table a rename column b to c"'), 'destructive-data');
  const H = '0123456789abcdef0123456789abcdef01234567';
  assert.equal(needs(`gh pr merge 12 --squash --match-head-commit ${H}`), 'accept');
  assert.equal(needs(`gh pr merge 12 --match-head-commit=${H} --delete-branch`), 'accept');
  assert.equal(needs('gh pr merge 12 --squash'), 'match-head-commit', 'a merge must pin the head commit it was approved for (R5)');
  assert.equal(needs('git push origin main'), 'match-head-commit', 'the main line is never pushed to directly');
  assert.equal(needs('git push origin HEAD:main'), 'match-head-commit');
  // Security V1 / code review: only one simple gh pr merge with its own full-sha pin counts as pinned.
  for (const c of [
    'gh pr merge 12 --squash --match-head-commit abc1234', // an abbreviation
    `gh pr merge --squash --match-head-commit ${H}`, // no PR number
    `gh pr merge 12 # --match-head-commit ${H}`, // the pin is a comment
    `gh pr merge 12 --match-head-commit ${H} && gh pr merge 13`, // a second, unpinned merge
    `gh pr merge 12 && echo sha=${H}`,
    `gh pr merge 12 --match-head-commit ${H}; gh pr merge 13`,
    `gh pr merge 12 13 --match-head-commit ${H}`, // two PRs
    `gh pr merge 12 --match-head-commit ${H} --match-head-commit ${H}`,
    `gh pr merge 12 --admin --match-head-commit ${H}`, // bypasses protection
    `gh pr merge 12 --repo o/other --match-head-commit ${H}`, // another repository
    `gh pr merge 12 --match-head-commit "${H}"`, // quotes
    `gh pr merge 12 --match-head-commit $(git rev-parse HEAD)`,
    `GH_REPO=o/other gh pr merge 12 --match-head-commit ${H}`,
    `gh api -X PUT repos/o/r/pulls/12/merge -f sha=${H}`, // REST merges are not the grammar
    `curl -X PUT https://api.github.com/repos/o/r/pulls/12/merge -d '{"sha":"${H}"}'`,
    `glab mr merge 12 --sha ${H}`,
  ]) assert.equal(needs(c), 'match-head-commit', c);
  // D1: the approval carries the pull request and the head commit.
  const d = decide({ tool: 'Bash', input: { command: `gh pr merge 12 --squash --match-head-commit ${H}` }, cwd });
  assert.deepEqual([d.pr, d.headSha], [12, H]);
  assert.equal(needs('git push -u origin feature/main-menu'), null, 'a branch that mentions main is not main');
  assert.equal(needs('git push --force origin web/1'), 'force-push');
  assert.equal(needs('git push --force-with-lease origin web/1'), null);
  assert.equal(needs('gh secret set API_KEY'), 'secret-write');
  assert.equal(needs('vercel deploy --prod'), 'deploy-production');
  assert.equal(needs('npm publish'), 'deploy-production');
  assert.equal(needs('sendmail someone@example.com < note'), 'outbound-message');
  assert.equal(needs('npm test && git push -u origin web/12-login'), null);
  assert.equal(needs('rm -rf node_modules'), null);
  const call = (tool) => decide({ tool, input: {}, cwd }).rule;
  assert.equal(call('mcp__github__merge_pull_request'), 'match-head-commit');
  const m = decide({ tool: 'mcp__github__merge_pull_request', input: { pullNumber: 7, expectedHeadSha: H }, cwd });
  assert.deepEqual([m.rule, m.pr, m.headSha], ['accept', 7, H]);
  assert.equal(decide({ tool: 'mcp__github__merge_pull_request', input: { pullNumber: 7, expectedHeadSha: 'deadbeef' }, cwd }).rule, 'match-head-commit', 'a full sha');
  assert.equal(decide({ tool: 'mcp__github__merge_pull_request', input: { pullNumber: 7, sha: H }, cwd }).rule, 'match-head-commit', 'only the known field');
  assert.equal(call('mcp__gmail__send_email'), 'outbound-message');
  assert.equal(call('mcp__github__get_file_contents'), null);
  assert.equal(call('mcp__team__handoff'), 'team-tool');
});

test('a team can bring its own rules', () => {
  const rules = [{ action: 'payment', why: 'refunds', command: [/\brefund\b/] }];
  assert.equal(decide({ tool: 'Bash', input: { command: './bin/refund 42' }, cwd, rules }).rule, 'payment');
  assert.equal(decide({ tool: 'Bash', input: { command: 'gh pr merge 1' }, cwd, rules }).decision, 'allowed');
});
