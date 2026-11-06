#!/usr/bin/env node
// Agent Team Studio, local mode: a visual editor for this repository's team. No dependencies; Node 18 or later.
//
//   agent-team studio [--dir <repo>] [--port 4848] [--host 127.0.0.1] [--open]
//
// The page edits a TeamSpec (packages/team-model) in the browser, where the kit's own checks run live. The server
// reads the team from .agent-team/, previews what a publish changes, and publishes: it writes the layer, runs sync
// and commits the result on a branch. The repository stays the source of truth (docs/adr/0001).
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, KIT, sync, VERSION } from '../../bin/agent-team.mjs';
import { compileLayer, importLayer, resolveSpec, validate } from '../../packages/team-model/index.mjs';
import { parseBrief } from '../../tools/briefs.mjs';
import { graphFrom } from '../../tools/roster-graph.mjs';
import { ownershipFromMarkdown, suggestAreas, suggestChecks } from './suggest.mjs';
import { loadKit, readLayer, writeLayer } from '../../packages/team-model/node.mjs';
import { liveSource } from './live.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, 'public');
const MODEL = join(KIT, 'packages/team-model/index.mjs');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
/** What a publish commits: the layer and everything sync generates from it. */
const PUBLISHED = ['.agent-team', 'docs/team', 'scripts/agent-team', '.claude'];

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (root, ...args) => { try { return git(root, ...args); } catch { return ''; } };

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

export function gitState(root) {
  const branch = tryGit(root, 'branch', '--show-current');
  const dirty = tryGit(root, 'status', '--porcelain', '--', ...PUBLISHED).split('\n').filter(Boolean);
  return { repo: !!tryGit(root, 'rev-parse', '--git-dir'), branch, dirty };
}

/** Everything the page needs to start: the team as a TeamSpec, the kit's library, and where it lives. */
export function state(root) {
  if (!existsSync(join(root, '.agent-team/team.json'))) throw new HttpError(404, `no .agent-team/team.json in ${root}. Run "agent-team init" first.`);
  const kit = loadKit(KIT);
  return { root, kitVersion: VERSION, spec: importLayer(readLayer(root), kit), kit, git: gitState(root) };
}

/** The files a publish would write, compared with the repository as it is: [{ path, status, before, after }]. */
export function preview(root, spec) {
  const kit = loadKit(KIT);
  const issues = validate(spec, kit);
  const layer = compileLayer(spec, kit);
  const scratch = mkdtempSync(join(tmpdir(), 'agent-team-studio-'));
  try {
    cpSync(join(root, '.agent-team'), join(scratch, '.agent-team'), { recursive: true });
    for (const keep of ['docs/team/ownership.md', 'docs/team/lanes']) if (existsSync(join(root, keep))) cpSync(join(root, keep), join(scratch, keep), { recursive: true });
    writeLayer(scratch, layer);
    const before = build(root).files;
    const after = build(scratch).files;
    const changes = [];
    const read = (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : null);
    const oldLayer = readLayer(root);
    for (const p of new Set([...Object.keys(oldLayer), ...Object.keys(layer)])) {
      if (oldLayer[p] !== layer[p]) changes.push({ path: `.agent-team/${p}`, status: !(p in oldLayer) ? 'added' : !(p in layer) ? 'removed' : 'changed', before: oldLayer[p] ?? null, after: layer[p] ?? null });
    }
    for (const p of new Set([...before.keys(), ...after.keys()])) {
      const now = read(p);
      const next = after.get(p) ?? null;
      if (now !== next) changes.push({ path: p, status: now === null ? 'added' : next === null ? 'removed' : 'changed', before: now, after: next });
    }
    changes.sort((a, b) => a.path.localeCompare(b.path));
    return { changes, issues };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Writes the layer, syncs, and commits on a branch. Refuses when the team's files have uncommitted changes. */
export function publish(root, spec, { branch, message } = {}) {
  const kit = loadKit(KIT);
  const errors = validate(spec, kit).filter((i) => i.level === 'error');
  if (errors.length) throw new HttpError(422, `fix ${errors.length} error${errors.length > 1 ? 's' : ''} first: ${errors[0].where}: ${errors[0].message}`);
  const g = gitState(root);
  if (!g.repo) throw new HttpError(409, `${root} is not a git repository`);
  if (g.dirty.length) throw new HttpError(409, `the team's files have uncommitted changes (${g.dirty.slice(0, 3).join(', ')}); commit or stash them first`);
  if (branch && !/^[A-Za-z0-9._/-]+$/.test(branch)) throw new HttpError(400, 'a branch name may use letters, digits, ".", "_", "/" and "-"');
  if (branch && branch !== g.branch) {
    if (tryGit(root, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)) throw new HttpError(409, `branch ${branch} already exists`);
    git(root, 'checkout', '-q', '-b', branch);
  }
  const written = writeLayer(root, compileLayer(spec, kit));
  const code = sync(root, { quiet: true });
  if (code !== 0) throw new HttpError(500, 'sync reported roster errors; nothing was committed');
  git(root, 'add', '-A', '--', ...PUBLISHED.filter((p) => existsSync(join(root, p))));
  const staged = tryGit(root, 'diff', '--cached', '--name-only').split('\n').filter(Boolean);
  if (!staged.length) return { branch: gitState(root).branch, commit: null, files: [], note: 'nothing changed' };
  git(root, 'commit', '-q', '-m', message?.trim() || 'Update the agent team (Agent Team Studio)');
  return { branch: gitState(root).branch, commit: git(root, 'rev-parse', '--short', 'HEAD'), files: staged, written };
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

export function createStudio({ root, env = process.env }) {
  const live = liveSource(root, env);
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      // The Studio's API, versioned like the public API it will become (ADR 0005): additive changes only within /v1/.
      if (req.method === 'GET' && url.pathname === '/v1/team') return send(res, 200, state(root));
      // The live board, and a stream that says when it changed (the page then fetches the board again).
      if (req.method === 'GET' && url.pathname === '/v1/team/board') {
        try { return send(res, 200, { source: live.kind, where: live.where, board: await live.board() }); } catch (e) { return send(res, 502, { source: live.kind, where: live.where, error: e.message }); }
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
        if (url.pathname === '/v1/team/publish') return send(res, 200, publish(root, input.spec, input));
        if (url.pathname === '/v1/team/graph') return send(res, 200, graph(input.spec));
        if (url.pathname === '/v1/team/suggestions') return send(res, 200, suggestions(root, input.spec));
        throw new HttpError(404, 'no such endpoint');
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const file = url.pathname === '/team-model.mjs' ? MODEL : join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
        if (!file.startsWith(PUBLIC) && file !== MODEL) throw new HttpError(404, 'not found');
        if (!existsSync(file)) throw new HttpError(404, 'not found');
        res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
        return res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
      }
      throw new HttpError(405, 'method not allowed');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : e instanceof SyntaxError ? 400 : 500;
      return send(res, status, { error: e.message });
    }
  });
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
      const where = `http://${host === '0.0.0.0' ? 'localhost' : host}:${server.address().port}`;
      console.log(`Agent Team Studio for ${root}\n  ${where}\nCtrl-C stops it.`);
      if (argv.includes('--open')) { try { execFileSync(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open', [where], { stdio: 'ignore' }); } catch { /* no browser */ } }
    });
    server.on('close', () => done(0));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run(process.argv.slice(2));
