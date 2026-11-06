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
  assert.equal(decide({ tool: 'Read', input: { file_path: '/anything' }, cwd, areas: [] }).decision, 'allowed');
});

test('the owner-steps-in list becomes approvals', () => {
  const needs = (command) => decide({ tool: 'Bash', input: { command }, cwd }).rule;
  assert.equal(needs('psql "$DB" -c "DROP TABLE users"'), 'destructive-data');
  assert.equal(needs('psql -c "delete from orders where 1=1"'), 'destructive-data');
  assert.equal(needs('psql -c "alter table a rename column b to c"'), 'destructive-data');
  assert.equal(needs('gh pr merge 12 --squash'), 'accept');
  assert.equal(needs('git push origin main'), 'accept');
  assert.equal(needs('git push origin HEAD:main'), 'accept');
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
  assert.equal(call('mcp__github__merge_pull_request'), 'accept');
  assert.equal(call('mcp__gmail__send_email'), 'outbound-message');
  assert.equal(call('mcp__github__get_file_contents'), null);
  assert.equal(call('mcp__team__handoff'), 'team-tool');
});

test('a team can bring its own rules', () => {
  const rules = [{ action: 'payment', why: 'refunds', command: [/\brefund\b/] }];
  assert.equal(decide({ tool: 'Bash', input: { command: './bin/refund 42' }, cwd, rules }).rule, 'payment');
  assert.equal(decide({ tool: 'Bash', input: { command: 'gh pr merge 1' }, cwd, rules }).decision, 'allowed');
});
