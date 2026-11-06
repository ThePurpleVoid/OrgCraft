// The rollout view after a publish merges (demo step 17, CPO copy "Rollout view after a publish", D61 to D63): each
// report carries the team version its checkout runs, and rollout() says which roles have picked up a publish.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLog, summarize, toRow } from '../tools/board.mjs';
import { teamVersionAt } from '../tools/report.mjs';
import { fromKitRow, toKitRow } from '../packages/events/index.mjs';
import { rollout } from '../packages/team-model/index.mjs';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OLD = 'aaaaaaaaaaaa', NEW = 'bbbbbbbbbbbb1234';
const at = (m) => `2026-11-06T10:${String(m).padStart(2, '0')}:00.000Z`;
const row = (role, status, m, v, extra = {}) => toRow({ role, kind: 'status', status, at: at(m), task: `${role} task`, ...(v ? { team_version: v } : {}), ...extra });

test('a report keeps the team version it names; the board shows the latest per role', () => {
  assert.equal(toRow({ role: 'cto', kind: 'status', status: 'idle', team_version: 'abc1234' }).team_version, 'abc1234');
  assert.equal(toRow({ role: 'cto', kind: 'status', status: 'idle', team_version: 'not a sha' }).team_version, null);
  const board = summarize([row('cto', 'working', 1, OLD), toRow({ role: 'cto', kind: 'heartbeat', at: at(5), team_version: 'cccccccc' }), row('cto', 'idle', 6)], { now: new Date(at(7)) });
  assert.deepEqual([board.current[0].team_version, board.current[0].team_version_at], ['cccccccc', at(5)]);
  // Through the event log and back: the report's team_version is the envelope's teamVersion (events.md).
  const e = fromKitRow(row('cto', 'idle', 1, OLD), { tenant: 'acme', team: 'shop' });
  assert.equal(e.teamVersion, OLD);
  assert.equal(e.data.team_version, undefined);
  assert.equal(toKitRow(e).team_version, OLD);
});

test('rollout: moved only after a report since the merge names the new version; unknown roles stay outside n of m (D61, D62)', () => {
  const board = summarize([
    row('cto', 'idle', 1, OLD), row('cto', 'working', 20, NEW.slice(0, 7)),        // moved (prefix match)
    row('web-dev', 'idle', 15, OLD),                                               // next task
    row('backend-dev', 'working', 16, OLD, { task: 'Payments API' }),              // finishing, handing off
    row('qa-web', 'review', 17, OLD),                                              // finishing (default plan)
    row('designer', 'working', 18, OLD),                                           // switched off, finishing first
    row('ai-engineer', 'idle', 18, OLD),                                           // switched off
    row('cpo', 'working', 19),                                                     // no version: an older kit
    row('release-manager', 'idle', 2, OLD),                                        // no report since the publish
    row('cto2', 'working', 5, NEW),                                                // NEW but reported before the merge
    toRow({ role: 'code-reviewer', instance: '57', kind: 'status', status: 'working', at: at(19), team_version: OLD }),
  ], { now: new Date(at(21)) });
  const r = rollout({ version: NEW, publishedAt: at(10), roles: ['cto', 'web-dev', 'backend-dev', 'qa-web', 'cpo', 'release-manager', 'cto2', 'chief-of-staff'],
    off: ['designer', 'ai-engineer'], plan: { 'backend-dev': { choice: 'handoff', to: 'web-dev' } }, board });
  const by = Object.fromEntries(r.roles.map((x) => [x.role, x.state]));
  assert.deepEqual(by, {
    'ai-engineer': 'off', 'backend-dev': 'finishing', 'chief-of-staff': 'no-report', cpo: 'unknown', cto: 'moved', cto2: 'no-report',
    designer: 'off-finishing', 'qa-web': 'finishing', 'release-manager': 'no-report', 'web-dev': 'next-task',
  });
  assert.deepEqual(r.roles.find((x) => x.role === 'backend-dev').plan, { choice: 'handoff', to: 'web-dev' });
  assert.deepEqual(r.roles.find((x) => x.role === 'qa-web').plan, { choice: 'finish' });
  assert.equal(r.roles.find((x) => x.role === 'backend-dev').task, 'Payments API');
  assert.equal(r.roles.find((x) => x.role === 'release-manager').lastAt, at(2), 'for "last heard N h ago"');
  assert.ok(!r.roles.some((x) => x.role === 'code-reviewer'), 'per-PR instances are not roles');
  assert.deepEqual(r.summary, { moved: 1, of: 7, finishing: 2, offFinishing: 1, unknown: 1, noReport: 3, allMoved: false });
  assert.equal(r.name, 'bbbbbbb, published 6 Nov');
  // A later publish also counts as moved; once every counted role has moved, allMoved.
  const all = summarize([row('cto', 'idle', 30, 'dddddddd'), row('cpo', 'idle', 31)], { now: new Date(at(32)) });
  const r2 = rollout({ version: NEW, newer: ['dddddddd'], publishedAt: at(10), roles: ['cto', 'cpo'], board: all });
  assert.deepEqual([r2.summary.allMoved, r2.summary.of, r2.summary.unknown], [true, 1, 1]);
  // Nothing published yet.
  assert.deepEqual(rollout({ version: '' }), { version: null, name: null, roles: [], summary: null });
});

test('reports fill the team version from the checkout: the last commit that changed .agent-team', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-team-rollout-'));
  const g = (...a) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q');
  mkdirSync(join(dir, '.agent-team'));
  writeFileSync(join(dir, '.agent-team/team.json'), '{}');
  g('add', '.'); g('commit', '-qm', 'publish');
  const published = g('rev-parse', 'HEAD');
  writeFileSync(join(dir, 'other.txt'), 'x');
  g('add', '.'); g('commit', '-qm', 'unrelated');
  assert.equal(teamVersionAt(dir), published.slice(0, 12), 'later commits that do not touch the team do not change it');
  // team-status.sh fills it too (jq path when jq is installed, the Node reporter otherwise).
  const home = join(dir, '.state');
  const r = spawnSync('bash', [join(KIT, 'scripts/team-status.sh'), 'web-dev', 'status', 'working'], {
    cwd: dir, env: { ...process.env, AGENT_TEAM_HOME: home, AGENT_TEAM_PROJECT: 'rollout', AGENT_TEAM_KIT_DIR: KIT, TEAM_REPORT_URL: '', TEAM_REPORT_MIRROR_URL: '' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const rows = readLog(join(home, 'events.jsonl')).concat(readLog(join(home, 'rollout/events.jsonl')));
  assert.equal(rows.at(-1)?.team_version, published.slice(0, 12), r.stdout + r.stderr);
});
