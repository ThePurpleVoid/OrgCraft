#!/usr/bin/env node
// The team dashboard: a local web page that draws the team from the role briefs (org chart and hand-off flow) and
// lights each role up from what its thread reports with team-status.sh. No dependencies; Node 18 or later.
//
//   node scripts/agent-team/dashboard.mjs [--port 4747] [--host 127.0.0.1] [--dir <repo>] [--demo] [--open]
//   npx github:ThePurpleVoid/OrgCraft#v0.21.1 dashboard   (the same, from the kit)
//   node scripts/agent-team/dashboard.mjs export --out <dir> [--board <url>] [--dir <repo>]
//     writes the page as static files with roster.json, for your own website (see docs/dashboard.md)
//
// Where the reports come from:
//   - the local event log, ~/.agent-team/<project>/events.jsonl, which team-status.sh appends to on this machine;
//     the page updates the moment a line is added;
//   - POST /api/report, for threads on other machines or in the cloud: point their TEAM_REPORT_URL at
//     http://<this machine>:<port>/api/report (set DASHBOARD_TOKEN here and TEAM_REPORT_TOKEN there to require a token);
//   - or a hosted board (board/supabase): set TEAM_BOARD_URL and TEAM_READ_TOKEN and the page reads from it instead.
//
// --demo plays a made-up day of reports through a scratch log so you can see the board work before your team reports.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readLog, summarize, toRow } from './board.mjs';
import { buildGraph } from './roster-graph.mjs';
import { hostGuard } from './hosts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, 'dashboard');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const git = (root, ...args) => { try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };

/** The repository root: --dir, else the git top level of the working directory, else the working directory. */
export function findRoot(dir) {
  const start = resolve(dir ?? process.cwd());
  return git(start, 'rev-parse', '--show-toplevel') || start;
}

/** The team docs: docs/team in a repository that uses the kit, team/ in the kit itself. */
export function findTeamDir(root) {
  for (const d of ['docs/team', 'team']) if (existsSync(join(root, d, 'roles'))) return join(root, d);
  throw new Error(`no role briefs under ${root}/docs/team/roles. Run "agent-team init" first, or pass --dir <repo>.`);
}

/** The per-project state folder, the same one the shell scripts use (lib.sh at_init). */
export function projectHome(root) {
  for (const lib of [join(HERE, 'lib.sh'), join(HERE, '..', 'scripts', 'lib.sh')]) {
    if (!existsSync(lib)) continue;
    try {
      const out = execFileSync('bash', ['-c', `. "$1"; at_init; printf '%s' "$AT_HOME"`, 'x', lib], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (out) return out;
    } catch { /* fall through */ }
  }
  let name = process.env.AGENT_TEAM_PROJECT;
  if (!name) {
    const common = git(root, 'rev-parse', '--git-common-dir');
    name = common ? basename(dirname(resolve(root, common))) : basename(root);
  }
  const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return join(process.env.AGENT_TEAM_HOME ?? join(homedir(), '.agent-team'), slug);
}

/** https://github.com/owner/repo for links to issues, PRs, branches and briefs, from the origin remote. */
export function repoUrl(root) {
  const url = git(root, 'remote', 'get-url', 'origin');
  const m = /github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url) ?? /\/git\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  return m ? `https://github.com/${m[1]}/${m[2]}` : '';
}

function teamJson(root) {
  try { return JSON.parse(readFileSync(join(root, '.agent-team', 'team.json'), 'utf8')); } catch { return {}; }
}
const projectName = (root) => teamJson(root).values?.PROJECT_NAME ?? '';
/** team.json's dashboard.staleMinutes, as the page and the board read it. */
const staleOf = (root) => { const m = teamJson(root).dashboard?.staleMinutes; return m ? { staleMinutes: m } : {}; };

const sameToken = (a, b) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
};

/** The demo: a made-up stream of reports that follows the hand-off edges of this team. */
function startDemo(graph, log) {
  const roles = graph.roles.filter((r) => !r.dormant);
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const tasks = ['Sign-up flow', 'Billing page', 'Search results', 'Release 1.4', 'Onboarding emails', 'Weekly digest', 'Crash on save', 'Pricing test'];
  const write = (e) => appendFileSync(log, JSON.stringify({ id: `demo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: new Date().toISOString(), source: 'demo', ...e }) + '\n');
  for (const r of roles.slice(0, Math.min(roles.length, 14))) write({ role: r.slug, kind: 'status', status: pick(['working', 'working', 'waiting', 'review', 'idle', 'done']), task: pick(tasks) });
  return setInterval(() => {
    const r = pick(roles);
    const to = r.handsTo.length ? pick(r.handsTo) : null;
    const roll = Math.random();
    if (to && to !== 'owner' && roll < 0.35) {
      const kind = pick(['handoff', 'handoff', 'bug', 'signoff']);
      write({ role: r.slug, kind, status: kind === 'handoff' ? 'waiting' : undefined, to, task: pick(tasks), pr: Math.floor(Math.random() * 90) + 10 });
      write({ role: to, kind: 'status', status: 'working', task: pick(tasks) });
    } else if (roll < 0.42) {
      write({ role: r.slug, kind: 'blocked', status: 'blocked', to: r.reportsTo === 'owner' ? graph.ownerReports[0] : r.reportsTo, task: pick(tasks), detail: 'Waiting for a decision.' });
    } else {
      write({ role: r.slug, kind: 'status', status: pick(['working', 'working', 'review', 'done', 'idle']), task: pick(tasks) });
    }
  }, 2500);
}

export function createDashboard({ root, teamDir, home, token = process.env.DASHBOARD_TOKEN ?? '', hosted = process.env.TEAM_BOARD_URL ?? '', readToken = process.env.TEAM_READ_TOKEN ?? '', hosts = process.env.DASHBOARD_ALLOWED_HOSTS ?? '' } = {}) {
  const log = join(home, 'events.jsonl');
  const clients = new Set();
  let graph = null, graphStamp = '';
  const roster = () => {
    // Rebuilt when a brief or ownership.md changes, so a sync shows up without a restart.
    let stamp = '';
    try {
      const roles = join(teamDir, 'roles');
      stamp = readdirSync(roles).map((f) => `${f}:${statSync(join(roles, f)).mtimeMs}`).join('|');
      if (existsSync(join(teamDir, 'ownership.md'))) stamp += `|${statSync(join(teamDir, 'ownership.md')).mtimeMs}`;
    } catch { stamp = ''; }
    if (!graph || stamp !== graphStamp) { graph = buildGraph(teamDir); graphStamp = stamp; }
    return graph;
  };
  const meta = { project: projectName(root) || basename(root), repo: repoUrl(root), hosted: !!hosted, briefsPath: join(relative(root, teamDir), 'roles').split('\\').join('/'), ...staleOf(root) };

  // Tell every open page when the log changes. Polling the file's size is portable and cheap.
  let lastSize = -1;
  const tick = setInterval(() => {
    const size = existsSync(log) ? statSync(log).size : 0;
    if (size !== lastSize) {
      if (lastSize !== -1) for (const res of clients) res.write(`event: board\ndata: ${size}\n\n`);
      lastSize = size;
    }
    for (const res of clients) res.write(': ping\n\n');
  }, hosted ? 15_000 : 750);
  tick.unref?.();

  async function board(params) {
    const days = Math.min(Math.max(parseInt(params.get('days') ?? '7', 10) || 7, 1), 90);
    const role = params.get('role') ?? '';
    if (hosted) {
      const url = new URL(hosted);
      url.searchParams.set('days', String(days));
      if (role) url.searchParams.set('role', role);
      const r = await fetch(url, { headers: { 'x-team-read-token': readToken } });
      if (!r.ok) throw new Error(`hosted board answered HTTP ${r.status}`);
      return r.json();
    }
    return summarize(readLog(log), { days, role, staleMinutes: meta.staleMinutes });
  }

  const send = (res, code, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    // DNS rebinding: answer only the names this server is really reached by (tools/hosts.mjs), on every route.
    if (!allowed(req)) return send(res, 403, { error: 'host not allowed (add it to DASHBOARD_ALLOWED_HOSTS)' });
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/api/roster') return send(res, 200, { ...meta, ...roster() });
      if (req.method === 'GET' && url.pathname === '/api/board') return send(res, 200, await board(url.searchParams));
      if (req.method === 'GET' && url.pathname === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write('retry: 2000\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/report') {
        if (hosted) return send(res, 409, { error: 'this dashboard reads a hosted board; report to the hosted board instead' });
        if (token && !sameToken(token, String(req.headers['x-team-token'] ?? ''))) return send(res, 403, { error: 'forbidden' });
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 20_000) return send(res, 413, { error: 'report too large' }); }
        let row;
        try { row = toRow(JSON.parse(body)); } catch (e) { return send(res, 400, { error: e.message }); }
        // The same report can arrive twice (written locally and posted); keep one.
        if (!(existsSync(log) && readFileSync(log, 'utf8').includes(`"id":"${row.id}"`))) {
          mkdirSync(home, { recursive: true });
          appendFileSync(log, JSON.stringify(row) + '\n');
        }
        return send(res, 200, { ok: true, id: row.id });
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const file = url.pathname === '/' || !extname(url.pathname) ? 'index.html' : url.pathname.slice(1);
        const path = resolve(PUBLIC, file);
        if (!path.startsWith(PUBLIC) || !existsSync(path)) return send(res, 404, { error: 'not found' });
        return send(res, 200, readFileSync(path), TYPES[extname(path)] ?? 'application/octet-stream');
      }
      return send(res, 405, { error: 'method not allowed' });
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  });
  const allowed = hostGuard(server, hosts);
  server.on('close', () => { clearInterval(tick); for (const res of clients) res.end(); });
  return { server, log, roster };
}

/**
 * The page as static files for a website: index.html, app.js, app.css, roster.json and a config.js that reads the
 * roster from roster.json and the board from `board` (a hosted board URL; the page then polls instead of streaming).
 * Run it in your site's build so the chart follows the briefs.
 */
export function exportSite({ root, teamDir, out, board }) {
  if (!out) { console.error('dashboard: export needs --out <dir>'); return 64; }
  mkdirSync(out, { recursive: true });
  for (const f of ['index.html', 'app.js', 'app.css']) writeFileSync(join(out, f), readFileSync(join(PUBLIC, f)));
  const graph = buildGraph(teamDir);
  const roster = { project: projectName(root) || basename(root), repo: repoUrl(root), hosted: true, briefsPath: join(relative(root, teamDir), 'roles').split('\\').join('/'), ...staleOf(root), ...graph };
  writeFileSync(join(out, 'roster.json'), JSON.stringify(roster) + '\n');
  const settings = { roster: 'roster.json', stream: null, poll: 15000, ...(board ? { board } : {}) };
  writeFileSync(join(out, 'config.js'), `// Written by "agent-team dashboard export". Add headers (for example a read token) or a fetchBoard function here,\n`
    + `// or mount the dashboard from your own app instead: AgentTeamDashboard.mount(element, options).\n`
    + `window.AGENT_TEAM = Object.assign(${JSON.stringify(settings, null, 2)}, window.AGENT_TEAM || {});\n`);
  console.log(`dashboard: wrote ${out} (${graph.roles.length} roles${board ? `, board ${board}` : ', set "board" in config.js'})`);
  return 0;
}

function parse(argv) {
  const o = { export: argv[0] === 'export' };
  if (o.export) argv = argv.slice(1);
  Object.assign(o, { port: Number(process.env.DASHBOARD_PORT ?? 4747), host: process.env.DASHBOARD_HOST ?? '127.0.0.1' });
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') o.port = Number(argv[++i]);
    else if (a === '--host') o.host = argv[++i];
    else if (a === '--dir') o.dir = argv[++i];
    else if (a === '--demo') o.demo = true;
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--board') o.board = argv[++i];
    else if (a === '--open') o.open = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

export function run(argv) {
  let o;
  try { o = parse(argv); } catch (e) { console.error(`dashboard: ${e.message}`); return Promise.resolve(64); }
  if (o.help) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1).filter((l, i, a) => a.slice(0, i + 1).every((x) => x.startsWith('//'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); return Promise.resolve(0); }
  const root = findRoot(o.dir);
  let teamDir;
  try { teamDir = findTeamDir(root); } catch (e) { console.error(`dashboard: ${e.message}`); return Promise.resolve(66); }
  if (o.export) return Promise.resolve(exportSite({ root, teamDir, out: o.out, board: o.board }));
  const home = o.demo ? mkdtempSync(join(tmpdir(), 'agent-team-demo-')) : projectHome(root);
  const { server, log, roster } = createDashboard({ root, teamDir, home, hosted: o.demo ? '' : undefined });
  if (o.demo) startDemo(roster(), log);
  return new Promise((done) => {
    server.on('error', (e) => { console.error(`dashboard: ${e.code === 'EADDRINUSE' ? `port ${o.port} is in use; pass --port` : e.message}`); done(69); });
    server.listen(o.port, o.host, () => {
      const url = `http://${o.host === '0.0.0.0' ? 'localhost' : o.host}:${o.port}`;
      console.log(`Team dashboard: ${url}`);
      console.log(`  briefs  ${teamDir}`);
      console.log(process.env.TEAM_BOARD_URL && !o.demo ? `  reports ${process.env.TEAM_BOARD_URL} (hosted)` : `  reports ${log}${o.demo ? ' (demo)' : ''}`);
      if (o.host === '127.0.0.1') console.log('  Threads on other machines can report here if you start it with --host 0.0.0.0 (set DASHBOARD_TOKEN).');
      if (o.open) {
        const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        try { execFileSync(cmd, [url], { stdio: 'ignore' }); } catch { /* no browser */ }
      }
    });
    const stop = () => { server.close(); done(0); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) run(process.argv.slice(2)).then((c) => { process.exitCode = c; });
