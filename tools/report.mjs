#!/usr/bin/env node
// Reports to the team board without bash or jq, and turns Claude Code hook events into reports, so a role that
// forgets to report still shows what it is doing.
//
//   node report.mjs <role>[#instance] <kind> [<status>|-] [--task "..."] [--issue N] [--pr N] [--branch b]
//                   [--commit sha] [--platform p] [--to role] [--severity 1-4] [--evidence a,b] [--detail "..."]
//                   [--session id]
//       The same arguments and the same event as team-status.sh (which hands over to this when jq is missing).
//
//   node report.mjs hook
//       Reads one Claude Code hook event on stdin and reports it. .claude/settings.json runs this for you when
//       .agent-team/team.json sets "hooks": true. It never prints anything and always exits 0.
//
// Where reports go: ~/.agent-team/<project>/events.jsonl, and TEAM_REPORT_URL when set (environment,
// .agent-team/config.sh or ~/.agent-team/<project>/team.env), with TEAM_REPORT_TOKEN as x-team-token, and
// TEAM_REPORT_MIRROR_URL (with TEAM_REPORT_MIRROR_TOKEN) when set.
import { execFileSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { KINDS, STATUSES, toRow } from './board.mjs';

const MESSAGES = ['handoff', 'bug', 'signoff', 'blocked'];
const HEARTBEAT_MS = 5 * 60_000;

const git = (cwd, args) => {
  try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
};
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');

/** KEY=value lines of a shell file (config.sh, team.env), without running it. Later lines win. */
export function shellVars(text) {
  const vars = {};
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (/^"/.test(v)) v = (/^"((?:[^"\\]|\\.)*)"/.exec(v)?.[1] ?? '').replace(/\\(.)/g, '$1');
    else if (/^'/.test(v)) v = /^'([^']*)'/.exec(v)?.[1] ?? '';
    else v = v.replace(/\s+#.*$/, '');
    vars[m[1]] = v;
  }
  return vars;
}

/** The same settings lib.sh's at_init works out: the repository root, the project slug, its state folder and report URL. */
export function context(env = process.env, cwd = process.cwd()) {
  const root = env.AGENT_TEAM_ROOT || env.CLAUDE_PROJECT_DIR || git(cwd, ['rev-parse', '--show-toplevel']) || cwd;
  const configFile = env.AGENT_TEAM_CONFIG || join(root, '.agent-team/config.sh');
  const config = existsSync(configFile) ? shellVars(readFileSync(configFile, 'utf8')) : {};
  let project = env.AGENT_TEAM_PROJECT || config.AGENT_TEAM_PROJECT || '';
  if (!project) {
    let common = git(root, ['rev-parse', '--git-common-dir']);
    if (common && !isAbsolute(common)) common = join(root, common);
    project = common ? basename(dirname(common)) : basename(root);
  }
  const slug = slugify(project);
  const home = join(env.AGENT_TEAM_HOME || join(homedir(), '.agent-team'), slug);
  const teamEnv = join(home, 'team.env');
  // Like lib.sh: the environment beats config.sh, and team.env (sourced last by team-status.sh) beats both.
  const extra = existsSync(teamEnv) ? shellVars(readFileSync(teamEnv, 'utf8')) : {};
  return {
    root,
    project: slug,
    home,
    log: join(home, 'events.jsonl'),
    url: extra.TEAM_REPORT_URL || env.TEAM_REPORT_URL || config.TEAM_REPORT_URL || '',
    token: extra.TEAM_REPORT_TOKEN || env.TEAM_REPORT_TOKEN || '',
    mirrorUrl: extra.TEAM_REPORT_MIRROR_URL || env.TEAM_REPORT_MIRROR_URL || config.TEAM_REPORT_MIRROR_URL || '',
    mirrorToken: extra.TEAM_REPORT_MIRROR_TOKEN || env.TEAM_REPORT_MIRROR_TOKEN || '',
  };
}

/** A report in the event-log shape team-status.sh writes: empty fields left out. Throws when the board would refuse it. */
export function makeEvent(fields, now = new Date()) {
  const [role, instance = ''] = String(fields.role ?? '').split('#');
  const id = `${now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const evidence = Array.isArray(fields.evidence) ? fields.evidence : String(fields.evidence ?? '').split(',').filter(Boolean);
  const e = { id, at: now.toISOString().replace(/\.\d{3}Z$/, 'Z'), ...fields, role, instance: fields.instance ?? instance, evidence, source: fields.source ?? 'report.mjs' };
  for (const [k, v] of Object.entries(e)) if (v === '' || v === null || v === undefined || (Array.isArray(v) && !v.length)) delete e[k];
  toRow(e, now);
  return e;
}

/** Appends to the local log and posts to TEAM_REPORT_URL. Resolves to a list of problems (empty when all went well). */
export async function send(event, ctx, { timeoutMs = 15_000 } = {}) {
  const problems = [];
  try {
    mkdirSync(ctx.home, { recursive: true });
    appendFileSync(ctx.log, JSON.stringify(event) + '\n');
  } catch (e) { problems.push(`could not write ${ctx.log}: ${e.message}`); }
  // The mirror gets the same report with the same id (TEAM_REPORT_MIRROR_URL), for a second board.
  for (const [url, token, label] of [[ctx.url, ctx.token, 'hosted board'], [ctx.mirrorUrl, ctx.mirrorToken, 'mirror board']]) {
    if (!url) continue;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { 'x-team-token': token } : {}) },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status !== 200) {
        const body = await res.text().catch(() => '');
        let error = body; try { error = JSON.parse(body).error ?? body; } catch { /* not JSON */ }
        problems.push(`${label} refused (HTTP ${res.status}): ${String(error).slice(0, 200)}`);
      }
    } catch (e) { problems.push(`${label} not reached (network): ${String(e.message).slice(0, 200)}`); }
  }
  return problems;
}

/** The newest event and the newest status for a role in the log's last 256 KB. */
export function lastFor(file, role, instance = '') {
  const found = { event: null, status: null };
  if (!existsSync(file)) return found;
  const fd = openSync(file, 'r');
  let text;
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - 256 * 1024);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    text = buf.toString('utf8');
  } finally { closeSync(fd); }
  for (const line of text.split('\n').reverse()) {
    if (!line.includes(`"${role}"`)) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.role !== role || (e.instance ?? '') !== instance) continue;
    found.event ??= e;
    if (e.status) { found.status = e; break; }
  }
  return found;
}

const BUSY = ['waiting', 'blocked', 'review'];

/**
 * The report a Claude Code hook event stands for, or null when it stands for none.
 *   input     the hook's stdin JSON
 *   env       AGENT_TEAM_ROLE names the role a session plays (a subagent or teammate is named by its agent type)
 *   isRole    whether a slug is one of the team's roles (a built-in subagent such as Explore is not)
 *   last      (role, instance) => lastFor(...), so the hook keeps a status the role set itself
 */
export function fromHook(input, { env = {}, isRole = () => true, last = () => ({}), now = new Date() } = {}) {
  const ev = input?.hook_event_name;
  if (!ev) return null;
  const typed = (s) => (s ? slugify(String(s).split(':').at(-1)) : '');
  const sub = ['SubagentStart', 'SubagentStop'].includes(ev);
  const mate = ['TeammateIdle', 'TaskCreated', 'TaskCompleted'].includes(ev);
  let role = typed(input.agent_type) || (mate ? typed(input.teammate_name) : '');
  let instance = '';
  if (!role || !isRole(role)) {
    if (sub || mate || !env.AGENT_TEAM_ROLE) return null;
    [role, instance = ''] = String(env.AGENT_TEAM_ROLE).split('#');
    role = slugify(role);
  } else if (!sub && !mate && !input.agent_type && env.AGENT_TEAM_INSTANCE) instance = env.AGENT_TEAM_INSTANCE;
  if (!role) return null;
  const base = { role, instance, session: input.session_id, source: 'hook' };
  const { event: lastEvent, status: lastStatus } = last(role, instance) ?? {};
  const was = lastStatus?.status;
  const beat = () => (lastEvent && now - Date.parse(lastEvent.at) < HEARTBEAT_MS ? null : { ...base, kind: 'heartbeat' });
  const clip = (s, n) => (s ? String(s).replace(/\s+/g, ' ').trim().slice(0, n) : undefined);
  switch (ev) {
    case 'SessionStart':
    case 'UserPromptSubmit':
      // Starting or resuming work: working, unless the role said it waits on someone, which stays true until it says otherwise.
      if (BUSY.includes(was)) return beat();
      if (was === 'working' && ev === 'UserPromptSubmit') return beat();
      return { ...base, kind: 'status', status: 'working', task: lastStatus?.task ?? clip(input.session_title, 300), detail: ev === 'SessionStart' ? `session ${input.source ?? 'started'}` : undefined };
    case 'PostToolUse':
    case 'PreCompact':
      return beat();
    case 'Stop':
    case 'SessionEnd':
      // The turn or session ended. A role that was working is now idle; one that waits keeps its status.
      if (was === 'working' || (!was && ev === 'Stop')) return { ...base, kind: 'status', status: 'idle', task: lastStatus?.task, detail: ev === 'SessionEnd' ? `session ended (${input.reason ?? 'other'})` : undefined };
      return ev === 'Stop' ? beat() : null;
    case 'SubagentStart':
      return { ...base, kind: 'status', status: 'working', detail: 'started as a subagent' };
    case 'SubagentStop':
      return { ...base, kind: 'status', status: 'done', task: lastStatus?.task, detail: clip(input.last_assistant_message, 2000) };
    case 'TeammateIdle':
      return { ...base, kind: 'status', status: 'idle', task: lastStatus?.task, detail: 'teammate idle' };
    case 'TaskCreated':
      return null;
    case 'TaskCompleted':
      return { ...base, kind: 'status', status: 'done', task: clip(input.task_subject, 300), detail: clip(input.task_description, 2000) };
    default:
      return null;
  }
}

/** Runs one hook event end to end. Never throws. */
export async function hook(input, env = process.env) {
  try {
    const ctx = context(env, input?.cwd || process.cwd());
    const rolesDir = join(ctx.root, 'docs/team/roles');
    const isRole = (s) => existsSync(join(rolesDir, `${s}.md`));
    const fields = fromHook(input, { env, isRole, last: (r, i) => lastFor(ctx.log, r, i) });
    if (!fields) return null;
    if (!fields.branch) {
      const branch = git(input?.cwd || ctx.root, ['rev-parse', '--abbrev-ref', 'HEAD']);
      if (branch && branch !== 'HEAD') fields.branch = branch;
    }
    const event = makeEvent(fields);
    await send(event, ctx, { timeoutMs: 5_000 });
    return event;
  } catch { return null; }
}

/** team-status.sh's arguments as event fields. Throws an Error saying why it will not report. */
export function parseArgs(argv) {
  const args = [...argv];
  if (args.length < 2) throw new Error('usage');
  const agent = args.shift();
  const kind = args.shift();
  let status = '';
  if (args[0] === '-') args.shift();
  else if (args[0] !== undefined && !args[0].startsWith('--')) status = args.shift();
  if (!KINDS.includes(kind)) throw new Error(`kind must be ${KINDS.slice(0, -1).join(', ')} or ${KINDS.at(-1)}`);
  if (status && !STATUSES.includes(status)) throw new Error(`status must be ${STATUSES.slice(0, -1).join(', ')} or ${STATUSES.at(-1)}`);
  if (kind === 'status' && !status) throw new Error('a status report needs a status');
  const f = { role: agent, kind, status, session: process.env.AGENT_TEAM_SESSION ?? '' };
  const names = ['task', 'issue', 'pr', 'branch', 'commit', 'platform', 'to', 'severity', 'evidence', 'detail', 'session'];
  while (args.length) {
    const a = args.shift();
    const name = a.replace(/^--/, '');
    if (a.startsWith('--') && names.includes(name)) f[name] = args.shift() ?? '';
    else process.stderr.write(`team-status: unknown option ${a}\n`);
  }
  if (MESSAGES.includes(kind) && !f.to) throw new Error(`${kind} needs --to <role>`);
  return f;
}

async function cli(argv) {
  if (argv[0] === 'hook') {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    let input = null; try { input = JSON.parse(raw); } catch { /* not a hook event */ }
    await hook(input);
    return;
  }
  if (!argv.length || argv.includes('-h') || argv.includes('--help')) {
    const lines = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1);
    process.stderr.write(lines.slice(0, lines.findIndex((l) => !l.startsWith('//'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n') + '\n');
    return;
  }
  let fields;
  try { fields = parseArgs(argv); } catch (e) { process.stderr.write(`team-status: not reported (${e.message})\n`); return; }
  const ctx = context();
  if (!fields.branch) { const b = git(process.cwd(), ['rev-parse', '--abbrev-ref', 'HEAD']); if (b !== 'HEAD') fields.branch = b; }
  if (!fields.commit) fields.commit = git(process.cwd(), ['rev-parse', '--short=12', 'HEAD']);
  let event;
  try { event = makeEvent({ ...fields, source: 'team-status.sh' }); } catch (e) { process.stderr.write(`team-status: not reported (${e.message})\n`); return; }
  for (const p of await send(event, ctx)) process.stderr.write(`team-status: ${p}\n`);
  console.log(`team-status: ${argv[0]} ${fields.kind}${fields.status ? ` ${fields.status}` : ''}${fields.task ? ` · ${fields.task}` : ''}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) cli(process.argv.slice(2)).finally(() => { process.exitCode = 0; });
