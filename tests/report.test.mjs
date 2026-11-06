import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeSettings } from '../bin/agent-team.mjs';
import { readLog, summarize } from '../tools/board.mjs';
import { fromHook, makeEvent, parseArgs, shellVars } from '../tools/report.mjs';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(KIT, 'bin/agent-team.mjs');
// Never post to a real board from a test.
const ENV = { ...process.env, TEAM_REPORT_URL: '', TEAM_REPORT_TOKEN: '', TEAM_REPORT_MIRROR_URL: '', TEAM_REPORT_MIRROR_TOKEN: '', AGENT_TEAM_HOME: '', AGENT_TEAM_ROLE: '', AGENT_TEAM_INSTANCE: '', AGENT_TEAM_SESSION: '' };
const NOW = new Date('2026-01-01T12:00:00Z');
const ago = (min) => ({ at: new Date(NOW - min * 60_000).toISOString() });

test('config.sh and team.env values are read without running them', () => {
  const v = shellVars('# c\nAGENT_TEAM_PROJECT="my app"\nexport TEAM_REPORT_URL=https://x/y # note\nB=\'it\'\n  # X=1\n');
  assert.deepEqual(v, { AGENT_TEAM_PROJECT: 'my app', TEAM_REPORT_URL: 'https://x/y', B: 'it' });
});

test('the Node reporter takes team-status.sh arguments', () => {
  const f = parseArgs(['backend-dev#2', 'handoff', 'waiting', '--to', 'backend-tester', '--pr', '57', '--task', 'API']);
  assert.deepEqual({ role: f.role, kind: f.kind, status: f.status, to: f.to, pr: f.pr }, { role: 'backend-dev#2', kind: 'handoff', status: 'waiting', to: 'backend-tester', pr: '57' });
  const e = makeEvent(f, NOW);
  assert.equal(e.role, 'backend-dev');
  assert.equal(e.instance, '2');
  assert.equal(e.at, '2026-01-01T12:00:00Z');
  assert.ok(e.id);
  assert.throws(() => parseArgs(['x', 'status']), /needs a status/);
  assert.throws(() => parseArgs(['x', 'bug', '-']), /needs --to/);
  assert.throws(() => parseArgs(['x', 'party', 'working']), /kind must be/);
});

test('hooks: a session that starts or gets a prompt is working, unless the role said it waits', () => {
  const env = { AGENT_TEAM_ROLE: 'backend-dev' };
  const start = fromHook({ hook_event_name: 'SessionStart', source: 'resume', session_id: 's' }, { env, now: NOW });
  assert.equal(start.status, 'working');
  assert.equal(start.source, 'hook');
  assert.equal(start.session, 's');
  const waiting = { event: { ...ago(1) }, status: { status: 'waiting', task: 'API', ...ago(1) } };
  assert.equal(fromHook({ hook_event_name: 'UserPromptSubmit' }, { env, last: () => waiting, now: NOW }), null, 'a fresh heartbeat is skipped');
  const old = { event: { ...ago(10) }, status: { status: 'waiting', ...ago(10) } };
  assert.equal(fromHook({ hook_event_name: 'UserPromptSubmit' }, { env, last: () => old, now: NOW }).kind, 'heartbeat');
  const idle = { event: { ...ago(1) }, status: { status: 'idle', task: 'API', ...ago(1) } };
  const back = fromHook({ hook_event_name: 'UserPromptSubmit' }, { env, last: () => idle, now: NOW });
  assert.equal(back.status, 'working');
  assert.equal(back.task, 'API');
});

test('hooks: the end of a turn makes a working role idle and keeps a waiting one', () => {
  const env = { AGENT_TEAM_ROLE: 'web-dev' };
  const working = { event: { ...ago(10) }, status: { status: 'working', ...ago(10) } };
  assert.equal(fromHook({ hook_event_name: 'Stop' }, { env, last: () => working, now: NOW }).status, 'idle');
  const waiting = { event: { ...ago(10) }, status: { status: 'waiting', ...ago(10) } };
  assert.equal(fromHook({ hook_event_name: 'Stop' }, { env, last: () => waiting, now: NOW }).kind, 'heartbeat');
  assert.equal(fromHook({ hook_event_name: 'SessionEnd' }, { env, last: () => waiting, now: NOW }), null);
  assert.equal(fromHook({ hook_event_name: 'SessionEnd', reason: 'clear' }, { env, last: () => working, now: NOW }).status, 'idle');
});

test('hooks: subagents and teammates report as their agent type, built-in agents not at all', () => {
  const isRole = (s) => ['code-reviewer', 'qa-web'].includes(s);
  const env = { AGENT_TEAM_ROLE: 'cto' };
  assert.equal(fromHook({ hook_event_name: 'SubagentStart', agent_type: 'code-reviewer' }, { env, isRole }).role, 'code-reviewer');
  assert.equal(fromHook({ hook_event_name: 'SubagentStart', agent_type: 'Explore' }, { env, isRole }), null);
  const stop = fromHook({ hook_event_name: 'SubagentStop', agent_type: 'my-plugin:code-reviewer', last_assistant_message: 'SIGNOFF  PR 57' }, { env, isRole });
  assert.equal(stop.status, 'done');
  assert.equal(stop.detail, 'SIGNOFF PR 57');
  const tool = fromHook({ hook_event_name: 'PostToolUse', agent_type: 'qa-web', tool_name: 'Bash' }, { env, isRole, now: NOW });
  assert.equal(tool.role, 'qa-web');
  assert.equal(tool.kind, 'heartbeat');
  assert.equal(fromHook({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }, { env, isRole }).role, 'cto', 'the main session is AGENT_TEAM_ROLE');
  assert.equal(fromHook({ hook_event_name: 'TeammateIdle', teammate_name: 'qa-web' }, { env, isRole }).status, 'idle');
  const done = fromHook({ hook_event_name: 'TaskCompleted', teammate_name: 'qa-web', task_subject: 'Check the invoice page' }, { env, isRole });
  assert.deepEqual([done.status, done.task], ['done', 'Check the invoice page']);
  assert.equal(fromHook({ hook_event_name: 'TeammateIdle', teammate_name: 'researcher' }, { env, isRole }), null);
  assert.equal(fromHook({ hook_event_name: 'Stop' }, {}), null, 'no role, no report');
  for (const e of [stop, tool, done]) makeEvent(e); // the board accepts every one
});

test('settings: the kit replaces its own hooks and keeps everything else', () => {
  const mine = { permissions: { allow: ['Bash(ls)'] }, env: { FOO: '1' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } };
  const once = mergeSettings(JSON.stringify(mine), { hooks: true });
  const twice = mergeSettings(once, { hooks: true });
  assert.equal(twice, once, 'merging again changes nothing');
  const s = JSON.parse(once);
  assert.deepEqual(s.permissions, mine.permissions);
  assert.equal(s.hooks.Stop.length, 2);
  assert.equal(s.hooks.Stop[0].hooks[0].command, 'echo hi');
  assert.match(s.hooks.SessionStart[0].hooks[0].command, /^node "\$\{CLAUDE_PROJECT_DIR\}\/scripts\/agent-team\/report\.mjs" hook$/);
  assert.equal(s.hooks.SessionStart[0].hooks[0].async, true);
  assert.equal(s.hooks.Stop[1].hooks[0].async, undefined, 'the end of a turn reports before Claude Code moves on');
  assert.equal(s.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, undefined);
  assert.equal(JSON.parse(mergeSettings(once, { agentTeams: true })).env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, '1');
  const off = JSON.parse(mergeSettings(once, { hooks: false }));
  assert.deepEqual(off.hooks, mine.hooks, 'turning hooks off removes only the kit\'s');
  assert.equal(mergeSettings(null, { hooks: false }), null, 'no settings file is made for nothing');
  assert.throws(() => mergeSettings('{nope', { hooks: true }), /not valid JSON/);
});

// ------------------------------------------------------------------------------------------------ scenario

function project(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-team-smoke-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const home = join(dir, '.state');
  const env = { ...ENV, AGENT_TEAM_HOME: home, AGENT_TEAM_KIT_DIR: KIT };
  execFileSync('node', [CLI, 'init', '--preset', 'engineering', '--project', 'Smoke'], { cwd: dir, env });
  if (Object.keys(extra).length) {
    const f = join(dir, '.agent-team/team.json');
    writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), ...extra }, null, 2));
    execFileSync('node', [CLI, 'sync'], { cwd: dir, env });
  }
  const hook = (input, more = {}) => spawnSync('node', ['scripts/agent-team/report.mjs', 'hook'], {
    cwd: dir, env: { ...env, CLAUDE_PROJECT_DIR: dir, ...more }, input: JSON.stringify({ session_id: 'smoke', cwd: dir, ...input }), encoding: 'utf8' });
  return { dir, env, home, hook, log: join(home, 'smoke/events.jsonl') };
}

test('smoke: a new project reports through its hooks and the board reads it back', () => {
  const p = project();
  const settings = JSON.parse(readFileSync(join(p.dir, '.claude/settings.json'), 'utf8'));
  assert.ok(settings.hooks.SubagentStop, 'init turns the hooks on');
  const lead = { AGENT_TEAM_ROLE: 'cto' };
  for (const [input, env] of [
    [{ hook_event_name: 'SessionStart', source: 'startup' }, lead],
    [{ hook_event_name: 'SubagentStart', agent_type: 'code-reviewer' }, lead],
    [{ hook_event_name: 'SubagentStart', agent_type: 'Explore' }, lead],
    [{ hook_event_name: 'SubagentStop', agent_type: 'code-reviewer', last_assistant_message: 'SIGNOFF' }, lead],
    [{ hook_event_name: 'Stop' }, lead],
    [{ hook_event_name: 'not json' }, {}],
  ]) {
    const r = p.hook(input, env);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', 'a hook prints nothing: SessionStart and UserPromptSubmit output would reach the model');
  }
  const bad = spawnSync('node', ['scripts/agent-team/report.mjs', 'hook'], { cwd: p.dir, env: { ...p.env, CLAUDE_PROJECT_DIR: p.dir }, input: '{oops' });
  assert.equal(bad.status, 0, 'a broken event never fails Claude Code');
  const board = summarize(readLog(p.log));
  const by = Object.fromEntries(board.current.map((c) => [c.role, c.status]));
  assert.deepEqual(by, { cto: 'idle', 'code-reviewer': 'done' });
  assert.ok(readLog(p.log).every((r) => r.source === 'hook'));
});

test('smoke: team-status.sh without jq hands over to the Node reporter', { skip: process.platform === 'win32' }, () => {
  const p = project();
  const bin = join(p.dir, '.bin');
  mkdirSync(bin);
  for (const tool of ['bash', 'dirname', 'git']) {
    const found = execFileSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim();
    symlinkSync(found, join(bin, tool));
  }
  symlinkSync(process.execPath, join(bin, 'node'));
  const r = spawnSync(join(bin, 'bash'), ['scripts/agent-team/team-status.sh', 'web-dev', 'status', 'working', '--task', 'Page'], {
    cwd: p.dir, env: { ...p.env, PATH: bin }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /team-status: web-dev status working · Page/);
  const rows = readLog(p.log);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].role, rows[0].status, rows[0].task, rows[0].source], ['web-dev', 'working', 'Page', 'team-status.sh']);
});

test('smoke: agent teams export teammate types, the flag and the lead prompts; doctor and sync.mjs agree', () => {
  const p = project({ agentTeams: true });
  assert.ok(existsSync(join(p.dir, '.claude/agents/backend-dev.md')));
  const settings = JSON.parse(readFileSync(join(p.dir, '.claude/settings.json'), 'utf8'));
  assert.equal(settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, '1');
  assert.ok(settings.hooks.TeammateIdle && settings.hooks.TaskCompleted);
  const guide = readFileSync(join(p.dir, 'docs/team/agent-teams.md'), 'utf8');
  assert.match(guide, /### CTO \(`cto`\)[\s\S]*backend-dev/);
  const doctor = spawnSync('node', [CLI, 'doctor'], { cwd: p.dir, env: p.env, encoding: 'utf8' });
  assert.equal(doctor.status, 0, doctor.stdout);
  assert.match(doctor.stdout, /a hook event reaches the local board/);
  assert.ok(!existsSync(p.log), 'doctor writes its test report to a scratch folder');
  const check = spawnSync('node', ['scripts/agent-team/sync.mjs', 'check'], { cwd: p.dir, env: p.env, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  writeFileSync(join(p.dir, '.claude/settings.json'), JSON.stringify({ permissions: {} }));
  const drift = spawnSync('node', [CLI, 'doctor'], { cwd: p.dir, env: p.env, encoding: 'utf8' });
  assert.equal(drift.status, 1);
  assert.match(drift.stdout, /FAIL out of date: \.claude\/settings\.json/);
});

// ------------------------------------------------------------------------------------------------ threads (issue #29)

/** A project whose threads share one board folder: AGENT_TEAM_HOME only in team.env, the role only in local.env. */
function threadProject({ homeIn = 'team.env' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-team-thread-'));
  const home = join(dir, '.home'); // this thread's $HOME
  const shared = join(dir, 'shared-board'); // the folder every thread mounts
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const env = { ...ENV, HOME: home, AGENT_TEAM_KIT_DIR: KIT };
  delete env.AGENT_TEAM_HOME;
  delete env.AGENT_TEAM_ROLE;
  execFileSync('node', [CLI, 'init', '--preset', 'minimal', '--project', 'Threads'], { cwd: dir, env });
  if (homeIn === 'team.env') {
    mkdirSync(join(home, '.agent-team/threads'), { recursive: true });
    writeFileSync(join(home, '.agent-team/threads/team.env'), `AGENT_TEAM_HOME=${shared}\n`);
  } else {
    const f = join(dir, '.agent-team/config.sh');
    writeFileSync(f, `${readFileSync(f, 'utf8')}\nAGENT_TEAM_HOME="${shared}"\n`);
  }
  writeFileSync(join(dir, '.agent-team/local.env'), 'AGENT_TEAM_ROLE=backend-dev\n');
  return { dir, env, log: join(shared, 'threads/events.jsonl') };
}

for (const homeIn of ['team.env', 'config.sh']) {
  test(`threads: AGENT_TEAM_HOME from ${homeIn} and the role from local.env reach the shared board`, () => {
    const p = threadProject({ homeIn });
    const sh = spawnSync('bash', ['scripts/agent-team/team-status.sh', 'status', 'working', '--task', 'Invoices API'], { cwd: p.dir, env: p.env, encoding: 'utf8' });
    assert.equal(sh.status, 0, sh.stderr);
    assert.match(sh.stdout, /team-status: backend-dev status working · Invoices API/);
    const js = spawnSync('node', ['scripts/agent-team/report.mjs', 'heartbeat'], { cwd: p.dir, env: p.env, encoding: 'utf8' });
    assert.equal(js.status, 0, js.stderr);
    const hk = spawnSync('node', ['scripts/agent-team/report.mjs', 'hook'], {
      cwd: p.dir, env: { ...p.env, CLAUDE_PROJECT_DIR: p.dir }, input: JSON.stringify({ hook_event_name: 'Stop', session_id: 't', cwd: p.dir }), encoding: 'utf8' });
    assert.equal(hk.status, 0, hk.stderr);
    const rows = readLog(p.log);
    assert.deepEqual(rows.map((r) => [r.role, r.kind, r.source]), [
      ['backend-dev', 'status', 'team-status.sh'], ['backend-dev', 'heartbeat', 'team-status.sh'], ['backend-dev', 'status', 'hook']]);
    assert.equal(rows[2].status, 'idle');
    assert.ok(!existsSync(join(p.env.HOME, '.agent-team/threads/events.jsonl')), 'nothing lands in the private default folder');
    assert.match(readFileSync(join(p.dir, '.gitignore'), 'utf8'), /^\.agent-team\/local\.env$/m, 'local.env is never committed');
    const doctor = spawnSync('node', [CLI, 'doctor'], { cwd: p.dir, env: p.env, encoding: 'utf8' });
    assert.match(doctor.stdout, /this checkout reports as backend-dev/);
    assert.match(doctor.stdout, new RegExp(`reports go to ${p.log.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });
}

test('threads: the environment still wins, and a missing role is said, not guessed', () => {
  const p = threadProject();
  const other = join(p.dir, 'elsewhere');
  const r = spawnSync('bash', ['scripts/agent-team/team-status.sh', 'status', 'working'], {
    cwd: p.dir, env: { ...p.env, AGENT_TEAM_HOME: other, AGENT_TEAM_ROLE: 'web-dev' }, encoding: 'utf8' });
  assert.match(r.stdout, /web-dev status working/);
  assert.equal(readLog(join(other, 'threads/events.jsonl'))[0].role, 'web-dev');
  rmSync(join(p.dir, '.agent-team/local.env'));
  for (const cmd of [['bash', 'scripts/agent-team/team-status.sh'], ['node', 'scripts/agent-team/report.mjs']]) {
    const none = spawnSync(cmd[0], [cmd[1], 'status', 'working'], { cwd: p.dir, env: p.env, encoding: 'utf8' });
    assert.equal(none.status, 0);
    assert.match(none.stderr, /not reported \(no role/);
  }
});
