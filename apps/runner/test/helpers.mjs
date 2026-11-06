import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
export const sh = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: ENV }).trim();

/** A bare origin with one commit on main, the way a team repository looks to the runner, and a runner folder. */
export function origin() {
  const dir = mkdtempSync(join(tmpdir(), 'runner-'));
  const bare = join(dir, 'team.git'), seed = join(dir, 'seed');
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['init', '--quiet', '-b', 'main', seed]);
  writeFileSync(join(seed, 'README.md'), '# team repo\n');
  sh(seed, 'add', '-A'); sh(seed, 'commit', '--quiet', '-m', 'seed'); sh(seed, 'push', '--quiet', bare, 'main');
  return { bare, root: join(dir, 'root') };
}

/** Assertions inside a stub script run in a session turn; a failed one shows up as a failed turn. */
export const noFailedTurns = (cp) => assert.deepEqual(cp.events.filter((e) => e.type === 'session.idle' && /turn failed/.test(e.data.detail ?? '')).map((e) => e.data.detail), []);

export const brief = (tier, reportsTo = 'cto') => `# Role\n\n**Model:** ${tier}\n**Reports to:** ${reportsTo}\n\n## Identity\nA role.`;
