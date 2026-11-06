// agent-team doctor: a smoke test for one repository's team. Checks the tools the scripts need, that the generated
// files match .agent-team/, the roster, the Claude Code hooks, and that a report goes all the way to a board.
// Prints one line per check (ok, warn, FAIL) and exits 1 when anything fails.
//
//   agent-team doctor [--dir path] [--ping]     --ping also posts a note to TEAM_REPORT_URL (a real report)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, findProblems, loadProject, UsageError } from '../bin/agent-team.mjs';
import { parseBrief } from './briefs.mjs';
import { readLog, summarize } from './board.mjs';
import { context, fromHook, makeEvent, send } from './report.mjs';
import { graphFrom } from './roster-graph.mjs';

const has = (cmd, args = ['--version']) => {
  try { execFileSync(cmd, args, { stdio: 'ignore' }); return true; } catch { return false; }
};

export async function doctor(root, { ping = false, print = console.log } = {}) {
  const results = [];
  const say = (level, text) => { results.push({ level, text }); print(`${level.padEnd(4)} ${text}`); };

  const major = Number(process.versions.node.split('.')[0]);
  say(major >= 18 ? 'ok' : 'FAIL', `Node ${process.versions.node}${major >= 18 ? '' : ' (the kit needs 18 or later)'}`);
  say(has('git') ? 'ok' : 'FAIL', has('git') ? 'git' : 'git is not installed');
  const bash = has('bash');
  say(bash ? 'ok' : 'warn', bash ? 'bash' : 'bash is not installed: merge-gate.sh, with-lock.sh, team-board.sh and janitor.sh need it (Git Bash or WSL on Windows); reporting, hooks, sync.mjs and the dashboard do not');
  if (bash) {
    say(has('jq') ? 'ok' : 'warn', has('jq') ? 'jq' : 'jq is not installed: team-status.sh hands over to report.mjs, but team-board.sh and merge-gate.sh need jq');
    say(has('curl') ? 'ok' : 'warn', has('curl') ? 'curl' : 'curl is not installed: team-status.sh hands over to report.mjs for posting');
  }

  let project;
  try { project = loadProject(root); say('ok', `.agent-team/team.json (preset ${project.preset}, kit ${project.kit})`); } catch (e) {
    say('FAIL', e instanceof UsageError ? e.message : `.agent-team/team.json: ${e.message}`);
    return finish(results, print);
  }

  let built;
  try { built = build(root); } catch (e) { say('FAIL', `the team does not build: ${e.message}`); return finish(results, print); }
  for (const w of built.warnings) say('warn', w);
  const problems = findProblems(root);
  if (problems.length) for (const p of problems) say('FAIL', p);
  else say('ok', `${built.roles.length} roles and ${built.files.size} generated files are in sync`);

  const values = { PROJECT_NAME: 'the product', OWNER: 'the owner', ...project.values };
  const fill = (t) => t.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k) => (k in values ? String(values[k]) : m));
  const briefs = built.roles.map((r) => parseBrief(r.slug, fill(r.md)));
  const graph = graphFrom(briefs);
  // A hand-off target that reads like a slug ("backend-tester") but is not installed is likely a typo or a missing role.
  const missing = graph.unresolved.filter((u) => /^[a-z0-9]+(-[a-z0-9]+)+$/.test(u.phrase));
  if (missing.length) say('warn', `hand-offs to roles that are not installed: ${missing.map((u) => `${u.role} → ${u.phrase}`).join(', ')}`);
  else say('ok', 'hand-offs name installed roles');
  const orphans = graph.roles.filter((r) => !r.reportsToDeclared && r.reportsTo !== 'owner');
  if (orphans.length) say('warn', `reporting line filled in for ${orphans.map((r) => r.slug).join(', ')}`);

  if (project.hooks || project.agentTeams) {
    const file = join(root, '.claude/settings.json');
    const ok = existsSync(file) && readFileSync(file, 'utf8').includes('scripts/agent-team/report.mjs');
    say(ok ? 'ok' : 'FAIL', ok ? 'Claude Code hooks report to the board' : '.claude/settings.json has no agent-team hooks: run sync');
    if (ok) print('     subagents and teammates report as their agent type; a session reports as AGENT_TEAM_ROLE (environment or .agent-team/local.env)');
  } else say('warn', 'hooks are off: a role that forgets to report goes quiet on the board ("hooks": true in .agent-team/team.json turns them on)');
  if (project.agentTeams && !existsSync(join(root, '.claude/agents'))) say('FAIL', 'agentTeams is on but .claude/agents/ is missing: run sync');

  // The report pipeline end to end, in a scratch state folder: a hook event becomes a report, the board reads it back.
  const scratch = mkdtempSync(join(tmpdir(), 'agent-team-doctor-'));
  try {
    const ctx = { ...context({ ...process.env, AGENT_TEAM_HOME: scratch, TEAM_REPORT_URL: '', TEAM_REPORT_TOKEN: '' }, root), url: '', token: '' };
    const role = built.roles[0]?.slug ?? 'chief-of-staff';
    const fields = fromHook({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'doctor' }, { env: { AGENT_TEAM_ROLE: role } });
    await send(makeEvent(fields), ctx);
    const board = summarize(readLog(ctx.log));
    const row = board.current.find((c) => c.role === role);
    say(row?.status === 'working' ? 'ok' : 'FAIL', row?.status === 'working' ? 'a hook event reaches the local board' : 'a hook event did not reach the local board');
  } catch (e) { say('FAIL', `report pipeline: ${e.message}`); } finally { rmSync(scratch, { recursive: true, force: true }); }

  const ctx = context(process.env, root);
  if (ctx.role) say(built.roles.some((r) => r.slug === ctx.role.split('#')[0]) ? 'ok' : 'FAIL', `this checkout reports as ${ctx.role}${built.roles.some((r) => r.slug === ctx.role.split('#')[0]) ? '' : ', which is not a role on this team'}`);
  if (existsSync(join(root, '.agent-team/local.env'))) {
    let tracked = false;
    try { execFileSync('git', ['-C', root, 'ls-files', '--error-unmatch', '.agent-team/local.env'], { stdio: 'ignore' }); tracked = true; } catch { /* not tracked */ }
    if (tracked) say('FAIL', '.agent-team/local.env is committed: it is this checkout\'s own; git rm --cached it');
  }
  if (!ctx.url) say('ok', `reports go to ${ctx.log} (no TEAM_REPORT_URL)`);
  else if (!ping) say('ok', `reports also go to ${ctx.url.replace(/\?.*/, '')} (--ping posts a test note)`);
  else {
    const failed = await send(makeEvent({ role: built.roles.find((r) => r.slug === 'chief-of-staff')?.slug ?? built.roles[0].slug, kind: 'note', detail: 'agent-team doctor --ping', source: 'doctor' }), ctx, { timeoutMs: 10_000 });
    say(failed.length ? 'FAIL' : 'ok', failed.length ? failed.join('; ') : `${ctx.url.replace(/\?.*/, '')} accepted a note`);
  }
  return finish(results, print);
}

function finish(results, print) {
  const fails = results.filter((r) => r.level === 'FAIL').length;
  const warns = results.filter((r) => r.level === 'warn').length;
  print(fails ? `${fails} failed, ${warns} warnings` : `healthy${warns ? ` (${warns} warnings)` : ''}`);
  return fails ? 1 : 0;
}
