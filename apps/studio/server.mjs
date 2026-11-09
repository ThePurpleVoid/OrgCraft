#!/usr/bin/env node
// OrgCraft Studio, local mode: a visual editor for this repository's team. No dependencies; Node 18 or later.
//
//   agent-team studio [--dir <repo>] [--port 4848] [--host 127.0.0.1] [--open]
//
// The page edits a TeamSpec (packages/team-model) in the browser, where the kit's own checks run live. The server
// reads the team from .agent-team/, previews what a publish changes, and publishes: it writes the layer, runs sync
// and commits the result on a branch. The repository stays the source of truth (docs/adr/0001).
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_KIT_SPEC, KIT, VERSION } from '../../bin/agent-team.mjs';
import { resolveSpec, teamTargets, TEMPLATE_GROUPS, TEMPLATE_SCHEMA, templateCard, templateSpec, validate } from '../../packages/team-model/index.mjs';
import { parseBrief } from '../../tools/briefs.mjs';
import { graphFrom } from '../../tools/roster-graph.mjs';
import { hostGuard } from '../../tools/hosts.mjs';
import { ownershipFromMarkdown, suggestAreas, suggestChecks } from './suggest.mjs';
import { loadKit, loadTemplates } from '../../packages/team-model/node.mjs';
import * as core from './core.mjs';
import { liveSource } from './live.mjs';
import { chatSource } from './chat.mjs';
import { runRequest, RunRefused } from './runs.mjs';
import { openPullRequest, prSupport, pullRequestText } from './pr.mjs';
import { linkHash, resolveMeeting } from './public/links.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, 'public');
const MODEL = join(KIT, 'packages/team-model/index.mjs');
const PRICES = join(KIT, 'packages/model-prices/prices.json');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };
/** What a publish commits: the layer and everything sync generates from it. */
const PUBLISHED = ['.agent-team', 'docs/team', 'scripts/agent-team', '.claude', 'AGENTS.md'];

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (root, ...args) => { try { return git(root, ...args); } catch { return ''; } };

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

/** Whether the team on disk writes AGENTS.md (team.json "targets"). */
function writesAgentsMd(root) {
  try { return teamTargets(JSON.parse(readFileSync(join(root, '.agent-team/team.json'), 'utf8'))).includes('agents-md'); } catch { return false; }
}

/** The paths a publish writes. AGENTS.md is the repository's own file until the team writes it (on disk or in `spec`). */
function publishedPaths(root, spec) {
  const agentsMd = writesAgentsMd(root) || (spec && teamTargets(spec.options).includes('agents-md'));
  return agentsMd ? PUBLISHED : PUBLISHED.filter((p) => p !== 'AGENTS.md');
}

export function gitState(root, spec) {
  const branch = tryGit(root, 'branch', '--show-current');
  const dirty = tryGit(root, 'status', '--porcelain', '--', ...publishedPaths(root, spec)).split('\n').filter(Boolean);
  // The live version: the last commit that changed the team (change safety names versions by commit, D16).
  const [sha, at] = tryGit(root, 'log', '-1', '--format=%H%n%cI', '--', '.agent-team').split('\n');
  return { repo: !!tryGit(root, 'rev-parse', '--git-dir'), branch, dirty, head: sha ? { sha, at: at ?? null } : null };
}

/**
 * The team's read set as it is in this checkout (core.READ_SET): tracked and untracked files, never ignored ones (so
 * .agent-team/local.env and role memory stay out). Equal to HEAD's when the team's files are clean, which publish
 * requires; `base` is HEAD (null before the first commit).
 */
export function readWorktree(root) {
  const isRepo = !!tryGit(root, 'rev-parse', '--git-dir');
  let files;
  if (isRepo) {
    files = new Map();
    const listed = tryGit(root, 'ls-files', '-co', '--exclude-standard', '-z', '--', ...core.READ_SET.map((r) => r.replace(/\/$/, ''))).split('\0').filter(Boolean);
    for (const p of new Set(listed)) {
      const abs = join(root, p);
      if (!core.inReadSet(p) || !existsSync(abs) || !lstatSync(abs).isFile()) continue;
      files.set(p, { content: readFileSync(abs, 'utf8'), mode: statSync(abs).mode & 0o111 ? '100755' : '100644' });
    }
  } else files = core.readDir(root);
  return { files: [...files].map(([path, f]) => ({ path, ...f })), base: tryGit(root, 'rev-parse', '--verify', '--quiet', 'HEAD') || null };
}

/** Everything the page needs to start: the team as a TeamSpec, the kit's library, and where it lives. */
export function state(root) {
  const kit = loadKit(KIT);
  const s = core.state(readWorktree(root));
  // No team yet: the page opens the template gallery (templates story D32: a team that exists is never offered one).
  if (s.noTeam) return { root, ...s, git: gitState(root), templates: templateCards(kit), groups: TEMPLATE_GROUPS };
  return { root, ...s, git: gitState(root), templates: templateCards(kit) };
}

const hasTeam = (root) => existsSync(join(root, '.agent-team/team.json'));

/** "Start almost empty" (D32): a chief of staff only, as a template the gallery does not list. */
const ALMOST_EMPTY = { schema: TEMPLATE_SCHEMA, id: 'almost-empty', title: 'Almost empty', summary: 'A chief of staff only.', group: 'product', preset: 'minimal', roles: ['chief-of-staff'] };

/** The kit's templates as the gallery shows them (D31, D33), each with nothing written. */
export function templateCards(kit = loadKit(KIT)) {
  return Object.values(loadTemplates(KIT)).map((files) => templateCard(files, kit));
}

/**
 * The TeamSpec a template makes for the create form's answers (D31): the same spec `agent-team init --template`
 * compiles, so a publish writes the same files (criterion 9). Refused once the repository has a team (D32).
 */
export function fromTemplate(root, { id, project, owner, timezone } = {}) {
  if (hasTeam(root)) throw new HttpError(409, 'this repository already has a team; open it instead');
  const kit = loadKit(KIT);
  const files = id === ALMOST_EMPTY.id ? { 'template.json': JSON.stringify(ALMOST_EMPTY) } : loadTemplates(KIT)[id];
  if (!files) throw new HttpError(404, `no template "${id}"`);
  const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
  const spec = templateSpec(files, kit, { project: text(project, 80) ?? root.split('/').filter(Boolean).at(-1), owner: text(owner, 80) ?? 'the owner', timezone: text(timezone, 64) ?? 'UTC', kitVersion: VERSION, kitSpec: DEFAULT_KIT_SPEC });
  if (id === ALMOST_EMPTY.id) delete spec.options.from;
  return { spec, card: id === ALMOST_EMPTY.id ? null : templateCard(files, kit) };
}

/** The files a publish would write, compared with the repository as it is: [{ path, status, before, after }]. */
export function preview(root, spec) {
  return core.preview(readWorktree(root), spec);
}

/** Puts back what `apply` wrote: each file's old content, or no file, and removes folders that it left empty. */
function undo(root, changes) {
  tryGit(root, 'reset', '-q', '--', ...changes.map((c) => c.path));
  for (const c of changes) {
    const p = join(root, c.path);
    if (c.before === null) rmSync(p, { force: true }); else { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c.before); }
    for (let d = dirname(c.path); d && d !== '.'; d = dirname(d)) { try { if (readdirSync(join(root, d)).length) break; rmSync(join(root, d), { recursive: true }); } catch { break; } }
  }
}

/** Writes a plan's changes into the checkout, with their modes. */
function apply(root, changes) {
  for (const c of changes) {
    const p = join(root, c.path);
    if (c.content === null) { rmSync(p, { force: true }); continue; }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, c.content);
    chmodSync(p, c.mode === '100755' ? 0o755 : 0o644);
  }
}

/**
 * Publishes on a branch: the shared core's plan from this checkout's read set (the same files a publish through GitHub
 * writes), written and committed. Refuses when the team's files have uncommitted changes. With `pr: true` it then
 * pushes the branch and opens a pull request into the branch it started from (pr.mjs); the result's `pr` says how far
 * that got. The commit message's body (the change-safety plan) is the PR's body.
 */
export function publish(root, spec, { branch, message, pr = false } = {}, env = process.env) {
  const kit = loadKit(KIT);
  const errors = validate(spec, kit).filter((i) => i.level === 'error');
  if (errors.length) throw new HttpError(422, `fix ${errors.length} error${errors.length > 1 ? 's' : ''} first: ${errors[0].where}: ${errors[0].message}`);
  const g = gitState(root, spec);
  if (!g.repo) throw new HttpError(409, `${root} is not a git repository`);
  if (g.dirty.length) throw new HttpError(409, `the team's files have uncommitted changes (${g.dirty.slice(0, 3).join(', ')}); commit or stash them first`);
  if (branch && (!/^[A-Za-z0-9._/-]{1,100}$/.test(branch) || branch.includes('..'))) throw new HttpError(400, 'a branch name may use letters, digits, ".", "_", "/" and "-"');
  const from = g.branch;
  // Planned before anything moves: a spec sync refuses leaves the checkout as it was.
  let { changes } = core.plan(readWorktree(root), spec);
  // sync may add lines to .gitignore (a first team, or AGENTS.md's memory folder): commit them, unless the owner has
  // their own uncommitted changes there. An untracked .gitignore counts as clean on a first publish.
  const fresh = !tryGit(root, 'ls-files', '--', '.agent-team/team.json');
  const ignoreStatus = tryGit(root, 'status', '--porcelain', '--', '.gitignore');
  if (ignoreStatus && !(fresh && ignoreStatus.startsWith('??'))) changes = changes.filter((c) => c.path !== '.gitignore');
  if (branch && branch !== g.branch) {
    if (tryGit(root, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)) throw new HttpError(409, `branch ${branch} already exists`);
    git(root, 'checkout', '-q', '-b', branch);
  }
  if (!changes.length) return { branch: gitState(root).branch, commit: null, files: [], note: 'nothing changed' };
  const text = message?.trim() || 'Update the agent team (OrgCraft Studio)';
  try {
    apply(root, changes);
    git(root, 'add', '-A', '--', ...changes.map((c) => c.path));
    git(root, 'commit', '-q', '-m', text);
  } catch (e) {
    // A publish that fails leaves the files as it found them, so the retry starts clean (and a first one is still first).
    undo(root, changes);
    throw e;
  }
  const out = { branch: gitState(root).branch, commit: git(root, 'rev-parse', '--short', 'HEAD'), files: changes.map((c) => c.path), written: changes.map((c) => `${c.before === null ? 'wrote' : c.content === null ? 'removed' : 'updated'} ${c.path}`) };
  if (pr === true) {
    // Into the branch the publish started from; on the branch itself, the remote's default branch.
    const base = from && from !== out.branch ? from : prSupport(root, env).base;
    out.pr = openPullRequest(root, { branch: out.branch, base, ...pullRequestText(text, out.commit) }, env);
  }
  return out;
}

/** Who hands work to whom, for the Flow view: the dashboard's graph of the team as the spec resolves it. */
export function graph(spec) {
  const { roles } = resolveSpec(spec, loadKit(KIT));
  const g = graphFrom(roles.map((r) => parseBrief(r.slug, r.md)));
  return { edges: g.edges, unresolved: g.unresolved };
}

/** Owned areas and checks the repository suggests, and the rows of a hand-written ownership.md to start from. */
export function suggestions(root, spec) {
  const kit = loadKit(KIT);
  const { roles } = resolveSpec(spec, kit);
  const team = new Set(roles.map((r) => r.slug));
  const titles = new Map(roles.map((r) => [parseBrief(r.slug, r.md).title.toLowerCase(), r.slug]));
  return { areas: suggestAreas(root, spec.ownership?.rows ?? [], team), checks: suggestChecks(root), fromMarkdown: spec.ownership ? [] : ownershipFromMarkdown(root, titles) };
}

const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };

/**
 * The Studio's own sign-in, Jupyter style: a launch token printed in the URL it opens. The first visit with ?t=<token>
 * sets an HttpOnly, SameSite=Strict cookie, and every other request must carry it. Without it, anything that can reach the
 * port (another process, a machine on the network, a rebinding page) could read the chat or answer as the owner, since
 * this server holds the control plane's token and, for a few minutes, a step-up token.
 */
const COOKIE = 'studio_session';
const same = (a, b) => { const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? '')); return x.length === y.length && timingSafeEqual(x, y); };
const cookieOf = (req) => (String(req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === COOKIE) ?? [])[1];

export function createStudio({ root, env = process.env, launchToken = randomBytes(24).toString('base64url') }) {
  const live = liveSource(root, env);
  const chat = chatSource(env);
  // The cookie holds a session id of its own, not the launch token: browsers send localhost cookies to every port, so
  // another local dev server could read it, and it should not be a link that signs in.
  const session = randomBytes(24).toString('base64url');
  /** Chat calls: the control plane's answer, or its error with its status (a stale card's 409 carries the card). */
  const relay = async (res, fn) => {
    if (!chat.connected) return send(res, 503, { connected: false, error: 'connect a control plane: set AGENT_TEAM_SERVER, AGENT_TEAM_SERVER_TOKEN and AGENT_TEAM_SERVER_TEAM' });
    try { return send(res, 200, await fn()); } catch (e) {
      if (e instanceof chat.Upstream) return send(res, e.status, { error: e.message, type: e.body?.type, ...(e.status === 409 && e.body?.id ? { card: e.body } : {}) });
      if (e instanceof RunRefused) return send(res, 409, { error: e.message, type: 'not-published' });
      return send(res, 502, { error: `the control plane did not answer: ${e.message}` });
    }
  };
  const server = createServer(async (req, res) => {
    // DNS rebinding: answer only the names this server is really reached by (tools/hosts.mjs), on every route,
    // before the launch link and the session cookie.
    if (!allowed(req)) return send(res, 403, { error: 'host not allowed (add it to STUDIO_ALLOWED_HOSTS)' });
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method === 'GET' && url.searchParams.has('t')) {
        if (!same(url.searchParams.get('t'), launchToken)) throw new HttpError(401, 'that link is out of date: open the one the Studio printed when it started');
        url.searchParams.delete('t');
        res.writeHead(302, { location: url.pathname + url.search, 'set-cookie': `${COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/`, 'cache-control': 'no-store' });
        return res.end();
      }
      if (!same(cookieOf(req), session)) {
        if (url.pathname.startsWith('/v1/')) throw new HttpError(401, 'open the Studio with the link it printed when it started (it ends in ?t=…)');
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end('<!doctype html><meta charset="utf-8"><title>OrgCraft Studio</title><p style="font:15px system-ui;margin:2em">Open the Studio with the link it printed when it started. It ends in <code>?t=…</code>.</p>');
      }
      // The Studio's API, versioned like the public API it will become (ADR 0005): additive changes only within /v1/.
      if (req.method === 'GET' && url.pathname === '/v1/team') return send(res, 200, state(root));
      // What Publish can do with the branch here: push it, and open a pull request with gh when it is signed in.
      if (req.method === 'GET' && url.pathname === '/v1/team/pr-support') return send(res, 200, prSupport(root, env));
      // The live board, and a stream that says when it changed (the page then fetches the board again).
      if (req.method === 'GET' && url.pathname === '/v1/team/board') {
        try { return send(res, 200, { source: live.kind, where: live.where, board: await live.board() }); } catch (e) { return send(res, 502, { source: live.kind, where: live.where, error: e.message }); }
      }
      // The chat with the chief of staff. The page refreshes it when the board stream says something changed.
      if (req.method === 'GET' && url.pathname === '/v1/team/chat') {
        if (!chat.connected) return send(res, 200, { connected: false, items: [] });
        return relay(res, async () => ({ connected: true, team: chat.team, ...(await chat.chat({ before: url.searchParams.get('before') ?? undefined })) }));
      }
      if (req.method === 'GET' && url.pathname === '/v1/team/run') {
        if (!chat.connected) return send(res, 200, { connected: false });
        return relay(res, async () => ({ connected: true, ...(await chat.run()) }));
      }
      // The caps a run needs (a daily one first), and what "Start" would send: the published team, or why it cannot.
      if (req.method === 'GET' && url.pathname === '/v1/team/budget') {
        if (!chat.connected) return send(res, 200, { connected: false });
        return relay(res, async () => ({ connected: true, ...(await chat.budget()) }));
      }
      if (req.method === 'GET' && url.pathname === '/v1/team/runners') {
        if (!chat.connected) return send(res, 200, { connected: false, runners: [] });
        return relay(res, async () => ({ connected: true, ...(await chat.runners()) }));
      }
      if (req.method === 'GET' && url.pathname === '/v1/team/run/plan') {
        try {
          const { team } = runRequest(root, { dirty: gitState(root).dirty });
          return send(res, 200, { ok: true, version: team.version, repo: team.repo ?? null, summary: team.summary, roles: team.roles.length, frontDoor: team.roles.find((r) => r.reportsTo === 'owner').slug });
        } catch (e) {
          if (e instanceof RunRefused) return send(res, 200, { ok: false, error: e.message });
          throw e;
        }
      }
      if (req.method === 'GET' && url.pathname === '/v1/team/board/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write('retry: 3000\n\n');
        let timer = null;
        // Bursts of reports (a hand-off is two) become one refresh.
        const stop = live.changes(() => { clearTimeout(timer); timer = setTimeout(() => res.write('event: changed\ndata: {}\n\n'), 300); });
        const beat = setInterval(() => res.write(': keep-alive\n\n'), 20_000);
        req.on('close', () => { stop(); clearTimeout(timer); clearInterval(beat); });
        return;
      }
      if (req.method === 'POST' && url.pathname.startsWith('/v1/')) {
        // Only this page may change the repository: same origin, JSON body (a cross-site form cannot send either).
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'cross-origin request refused');
        if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'send JSON');
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 5_000_000) throw new HttpError(413, 'too large'); }
        const input = JSON.parse(body || '{}');
        if (url.pathname === '/v1/team/preview') return send(res, 200, preview(root, input.spec));
        if (url.pathname === '/v1/team/from-template') return send(res, 200, fromTemplate(root, input));
        // Only spec, branch, message and pr are read: credentials are the machine's own, never the page's.
        if (url.pathname === '/v1/team/publish') return send(res, 200, publish(root, input.spec, { branch: input.branch, message: input.message, pr: input.pr === true }, env));
        if (url.pathname === '/v1/team/graph') return send(res, 200, graph(input.spec));
        if (url.pathname === '/v1/team/suggestions') return send(res, 200, suggestions(root, input.spec));
        if (url.pathname === '/v1/team/chat') {
          const text = typeof input.text === 'string' ? input.text : '';
          if (!text.trim()) throw new HttpError(400, 'say something');
          if (text.length > 20_000) throw new HttpError(413, 'a message is at most 20,000 characters');
          // Verbatim: the text goes on exactly as typed, untrimmed (the dilution rule).
          return relay(res, () => chat.say({ text, clientId: typeof input.clientId === 'string' ? input.clientId.slice(0, 80) : undefined, replyTo: input.replyTo }));
        }
        const card = /^\/v1\/team\/cards\/([^/]+)$/.exec(url.pathname);
        if (card) return relay(res, () => chat.answer({ card: decodeURIComponent(card[1]), kind: input.kind, subject: input.subject, option: input.option, version: input.version, key: input.key }));
        const action = /^\/v1\/team\/run\/(pause|resume|stop)$/.exec(url.pathname);
        if (action) return relay(res, () => chat.control(action[1], input.key, input.run));
        // Built here from the repository, never from the page: a run starts on what was published, not on the canvas.
        if (url.pathname === '/v1/team/run/start') return relay(res, () => chat.start(runRequest(root, { dirty: gitState(root).dirty }), typeof input.key === 'string' ? input.key.slice(0, 80) : undefined));
        if (url.pathname === '/v1/team/budget') {
          for (const k of ['perDay', 'perRun']) if (input[k] !== undefined && input[k] !== null && !(Number.isInteger(input[k]) && input[k] >= 0)) throw new HttpError(400, `${k} is a whole number of cents, or null`);
          return relay(res, () => chat.setBudget(input, typeof input.key === 'string' ? input.key.slice(0, 80) : undefined));
        }
        // A runner code: minted after step-up, passed to the page once, kept nowhere here.
        if (url.pathname === '/v1/team/runners/code') return relay(res, () => chat.runnerCode(input.name));
        if (url.pathname === '/v1/team/step-up') {
          if (typeof input.secret !== 'string' || !input.secret) throw new HttpError(400, 'send the secret');
          return relay(res, () => chat.stepUp(input.secret));
        }
        throw new HttpError(404, 'no such endpoint');
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        // A link from an email or Slack message (kit #101): to the right page of the Studio.
        // A held meeting's link opens the meeting it was held from, read from the control plane when one is connected.
        const link = linkHash(url.pathname, url.search);
        if (link) {
          const to = await resolveMeeting(link, (id) => (chat.connected ? chat.meeting(id) : null));
          res.writeHead(302, { location: to, 'cache-control': 'no-store' });
          return res.end();
        }
        // The kit's model and its price table (meeting estimates) are served next to the page.
        const file = url.pathname === '/team-model.mjs' ? MODEL : url.pathname === '/model-prices.json' ? PRICES : join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
        if (!file.startsWith(PUBLIC) && file !== MODEL && file !== PRICES) throw new HttpError(404, 'not found');
        if (!existsSync(file)) throw new HttpError(404, 'not found');
        res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
        return res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
      }
      throw new HttpError(405, 'method not allowed');
    } catch (e) {
      const status = e instanceof HttpError || e instanceof core.CoreError ? e.status : e instanceof SyntaxError ? 400 : 500;
      return send(res, status, { error: e.message });
    }
  });
  const allowed = hostGuard(server, env.STUDIO_ALLOWED_HOSTS ?? '');
  server.launchToken = launchToken;
  return server;
}

export function run(argv) {
  const opt = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
  const start = resolve(opt('--dir', process.cwd()));
  const root = tryGit(start, 'rev-parse', '--show-toplevel') || start;
  const port = Number(opt('--port', process.env.STUDIO_PORT ?? 4848));
  const host = opt('--host', '127.0.0.1');
  const server = createStudio({ root });
  return new Promise((done) => {
    server.listen(port, host, () => {
      const p = server.address().port, t = `/?t=${server.launchToken}`;
      const where = `http://${host === '0.0.0.0' || host === '::' ? 'localhost' : host}:${p}${t}`;
      // On every interface, also print this machine's network addresses: that is the link to type on a phone.
      const lan = host === '0.0.0.0' || host === '::'
        ? Object.values(networkInterfaces()).flat().filter((i) => i && !i.internal && i.family === 'IPv4').map((i) => `http://${i.address}:${p}${t}`)
        : [];
      console.log(`OrgCraft Studio for ${root}\n  ${where}${lan.map((u) => `\n  ${u}   (from a phone on this network; plain HTTP, so trusted networks only)`).join('')}\nOpen a link to sign in to this Studio. Ctrl-C stops it.`);
      if (argv.includes('--open')) { try { execFileSync(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open', [where], { stdio: 'ignore' }); } catch { /* no browser */ } }
    });
    server.on('close', () => done(0));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run(process.argv.slice(2));
