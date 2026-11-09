// The Studio, mounted in a host app (docs/specs/studio-embed.md section 3, ADR 0008): one Fetch API handler that a
// host's server mounts behind its own admin sign-in. The same routes as the local Studio, through the `github`
// backend and the shared core, so a publish here writes the same files as one from a laptop and opens a pull request.
//
//   import { createStudioHandler } from 'orgcraft/studio/handler';
//   export const handler = createStudioHandler({ repo, basePath, allowedOrigins, authorize, getInstallationToken });
//
// Needs a Node runtime (node:fs and a writable temp dir). Security: E1 to E10 and S1 to S7 of the spec.
import { createHash, createPrivateKey, createPublicKey, randomUUID, sign as signWith } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from './core.mjs';
import { blobCache, githubBackend } from './github.mjs';
import { validate } from '../../packages/team-model/index.mjs';
import { loadKit } from '../../packages/team-model/node.mjs';
import { KIT } from '../../bin/agent-team.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 5 * 1024 * 1024;
const PERMISSIONS = { contents: 'write', pull_requests: 'write', metadata: 'read' };
const LEVEL = { read: 0, write: 1, admin: 2 };
const ACTIONS = new Set(['read', 'publish', 'publish-code']);

class HttpError extends Error { constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); } }

/** The asset manifest written at package time (tools/studio-assets.mjs): served name → kit path. Looked up, never joined (S2). */
export function loadAssets() {
  const m = JSON.parse(readFileSync(join(HERE, 'assets.json'), 'utf8'));
  return new Map(Object.entries(m.files).map(([name, f]) => [name, { file: join(KIT, f.path), type: f.type }]));
}

const json = (status, body, extra = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra },
});

/** A display name and id from `authorize`, cleaned for the trailer (S5). */
const userOf = (u) => (u && typeof u === 'object' && u.id !== undefined && u.id !== null
  ? { id: core.cleanName(u.id), name: core.cleanName(u.name ?? u.id), ...(u.via && typeof u.via === 'object' ? { via: core.cleanVia(u.via) } : {}) } : null);

/** A request path that could reach outside the manifest, or confuse a router: encoded dots or slashes, backslashes, doubled slashes, dot segments (S2). */
const unsafePath = (raw) => {
  let decoded;
  try { decoded = decodeURIComponent(raw); } catch { return true; }
  for (const p of [raw, decoded]) if (/%2e|%2f|%5c|\\|\/\/|(^|\/)\.\.?(\/|$)/i.test(p)) return true;
  return false;
};

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,100}$/;

/**
 * Options:
 *   repo                 "owner/name", the repository the team lives in
 *   basePath             where the host mounts the handler, e.g. "/api/agent-team/studio"
 *   allowedOrigins       the host's page origin(s), exact (required, E2)
 *   authorize(request, action) → { id, name, via? } or null; action is 'read', 'publish' or 'publish-code' (E1, S1).
 *                        via: { host, user }, a deployment publishing for another site (studio-embed.md section 6):
 *                        named in the PR body and the publish log, never in the commit trailer
 *   getInstallationToken({ repo, permissions }) → { token, permissions, repositories } as GitHub minted it (E3, S7)
 *   branchPrefix         every Studio branch starts with it (default "agent-team/", E4)
 *   limiter(key, { limit, windowSeconds }) → true to allow (optional; a shared store, S6, E8)
 *   logger(entry)        the host's logger for the audit line (E9); default console.info
 *   tmpRoot              the folder publishes are planned in (default the system temp folder)
 *   cache                a blobCache() to share across handlers of one customer (default: one per handler)
 *   api, fetch           GitHub's API and fetch (tests use a fake)
 *   controlPlane         { url, team, hostToken, dpopKey, fetch? }: the deployment does the GitHub work instead
 *                        (studio-embed.md section 6). repo and getInstallationToken are then not used. url is the
 *                        deployment's origin; hostToken is this site's access token from signing in through it (a
 *                        string, or ({ user, request }) → string for one that refreshes); dpopKey the private key
 *                        (KeyObject or JWK, P-256 or Ed25519) the token is bound to. Publishes that change commands
 *                        are never made through a host: the page says to use the deployment's Studio instead.
 */
/**
 * An error message as it may reach the host's log: anything shaped like a GitHub token, a JWT, a bearer header or a
 * PEM key is replaced, and it is cut to 300 characters (E3).
 */
export const redact = (m) => String(m ?? '')
  .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?(-----END [A-Z ]+-----|$)/g, '[key]')
  .replace(/\b(gh[a-z]_|github_pat_)[A-Za-z0-9_]+/g, '[token]')
  .replace(/\beyJ[\w-]*\.[\w-]+\.[\w-]*/g, '[jwt]')
  .replace(/\b(Bearer|token)\s+[\w.~+/=-]{8,}/gi, '$1 [token]')
  .slice(0, 300);

const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The deployment's side of control-plane mode: each call carries this site's DPoP-bound token and a fresh proof
 * (RFC 9449) signed with node:crypto, the host's user in x-agent-team-host-user, and never a cookie of the host's.
 */
function controlPlaneClient(c) {
  let origin;
  try { origin = new URL(c.url); } catch { origin = null; }
  if (!origin || origin.href !== `${origin.origin}/` || !(origin.protocol === 'https:' || (origin.protocol === 'http:' && LOCAL.has(origin.hostname)))) {
    throw new TypeError('createStudioHandler: controlPlane.url is the deployment\'s origin, like "https://teams.example.com"');
  }
  origin = origin.origin;
  const team = String(c.team ?? '');
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(team) || /^\.\.?$/.test(team)) throw new TypeError('createStudioHandler: controlPlane.team is the team\'s name on the deployment');
  if (typeof c.hostToken !== 'string' && typeof c.hostToken !== 'function') throw new TypeError('createStudioHandler: controlPlane.hostToken is this site\'s access token, or a function that returns it');
  let key;
  try { key = c.dpopKey?.type === 'private' ? c.dpopKey : createPrivateKey({ key: c.dpopKey, format: 'jwk' }); } catch { key = null; }
  const kind = key?.asymmetricKeyType;
  if (!key || !(kind === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1') && kind !== 'ed25519') {
    throw new TypeError('createStudioHandler: controlPlane.dpopKey is the private key (P-256 or Ed25519) the token is bound to');
  }
  const alg = kind === 'ec' ? 'ES256' : 'EdDSA';
  const { kty, crv, x, y } = createPublicKey(key).export({ format: 'jwk' });
  const jwk = kind === 'ec' ? { kty, crv, x, y } : { kty, crv, x };
  const fetchImpl = c.fetch ?? globalThis.fetch;
  const prefix = `/v1/teams/${encodeURIComponent(team)}/studio`;

  const proof = (htm, htu, token) => {
    const input = `${b64({ typ: 'dpop+jwt', alg, jwk })}.${b64({ htm, htu, iat: Math.floor(Date.now() / 1000), jti: randomUUID(), ath: createHash('sha256').update(token).digest('base64url') })}`;
    const sig = alg === 'ES256' ? signWith('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }) : signWith(null, Buffer.from(input), key);
    return `${input}.${sig.toString('base64url')}`;
  };

  return {
    studio: `${origin}/teams/${encodeURIComponent(team)}`,
    async call(request, path, input, user) {
      let token;
      try { token = typeof c.hostToken === 'function' ? await c.hostToken({ user, request }) : c.hostToken; } catch { token = null; }
      if (typeof token !== 'string' || !/^[A-Za-z0-9._~+/-]+=*$/.test(token)) throw new HttpError(503, 'this site is not signed in to the team\'s deployment yet');
      const target = prefix + path;
      const search = path === '/v1/team/pr' ? `?branch=${encodeURIComponent(new URL(request.url).searchParams.get('branch') ?? '')}` : '';
      const headers = {
        authorization: `DPoP ${token}`, dpop: proof(request.method, origin + target, token),
        'x-agent-team-studio': '1', 'x-agent-team-host-user': user.name === user.id ? user.id : `${user.name} (${user.id})`, accept: 'application/json',
        ...(input ? { 'content-type': 'application/json' } : {}),
      };
      let res;
      try {
        res = await fetchImpl(origin + target + search, { method: request.method, headers, body: input ? JSON.stringify(input) : undefined, redirect: 'error' });
      } catch { throw new HttpError(502, 'the team\'s deployment did not answer; try again'); }
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      return { status: res.status, data, retryAfter: /^\d{1,6}$/.test(res.headers.get('retry-after') ?? '') ? res.headers.get('retry-after') : null };
    },
  };
}

export function createStudioHandler(opts = {}) {
  const { repo, authorize, getInstallationToken, limiter = null, logger = (e) => console.info(JSON.stringify(e)), api = 'https://api.github.com', fetch: fetchImpl = globalThis.fetch } = opts;
  const basePath = String(opts.basePath ?? '').replace(/\/+$/, '');
  const branchPrefix = opts.branchPrefix ?? 'agent-team/';
  // Where publishes are planned: the system temp folder, or one of the host's own (hosted mode: one per customer, S3).
  const tmpRoot = opts.tmpRoot ?? null;
  const allowedOrigins = new Set(opts.allowedOrigins ?? []);
  const cp = opts.controlPlane ? controlPlaneClient(opts.controlPlane) : null;
  if (!cp && !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repo ?? '')) throw new TypeError('createStudioHandler: repo is "owner/name"');
  if (!basePath.startsWith('/')) throw new TypeError('createStudioHandler: basePath is the path the host mounts it at, e.g. "/api/agent-team/studio"');
  if (!allowedOrigins.size || [...allowedOrigins].some((o) => { try { return new URL(o).origin !== o; } catch { return true; } })) throw new TypeError('createStudioHandler: allowedOrigins lists the host page origin(s), exactly, like "https://admin.example.com"');
  if (typeof authorize !== 'function') throw new TypeError('createStudioHandler: authorize(request, action) is required');
  if (!cp && typeof getInstallationToken !== 'function') throw new TypeError('createStudioHandler: getInstallationToken({ repo, permissions }) is required');
  if (!/^[A-Za-z0-9._-][A-Za-z0-9._/-]{0,40}\/$/.test(branchPrefix) || branchPrefix.includes('..')) throw new TypeError('createStudioHandler: branchPrefix is like "agent-team/"');
  if (!limiter && !cp) console.warn('agent-team studio: no limiter given, so publish limits (10 per user per hour, one at a time per repository) are not enforced across instances; GitHub\'s create-only refs are the only serialisation');

  const assets = loadAssets();
  const version = core.VERSION;
  const cache = opts.cache ?? blobCache();
  // Tokens whose reach was checked (S7), by token value, until they expire; in memory only.
  const checked = new Map();

  /** A token for this repository only, with exactly the three permissions; a token that reaches more is refused (S7). */
  async function token() {
    let got;
    try { got = await getInstallationToken({ repo, permissions: { ...PERMISSIONS } }); } catch (e) {
      // The host's minter may throw anything; only "not connected yet" reaches the page as is (the page says so).
      if (/not connected yet/.test(String(e?.message))) throw new HttpError(503, 'the GitHub App is not connected yet');
      try { logger({ event: 'agent-team-studio.error', error: redact(e?.message ?? e) }); } catch { /* the host's logger */ }
      throw new HttpError(502, 'the GitHub App could not get a token; the server log says why');
    }
    // The token comes with what GitHub said it reaches, as githubAppToken and @octokit/auth-app give it: a bare string
    // would skip the permission check, so it is refused (S7, review V2).
    const t = got?.token;
    if (typeof got === 'string' || !got || typeof got !== 'object') throw new HttpError(503, 'getInstallationToken must return { token, permissions, repositories } as GitHub minted it; the Studio checks what the token reaches');
    if (typeof t !== 'string' || !t) throw new HttpError(503, 'the GitHub App is not connected yet');
    if (checked.has(t)) return t;
    if (!got.permissions || typeof got.permissions !== 'object' || !Array.isArray(got.repositories)) throw new HttpError(503, 'getInstallationToken must return { token, permissions, repositories } as GitHub minted it; the Studio checks what the token reaches');
    for (const [k, v] of Object.entries(got.permissions)) {
      if (!(k in PERMISSIONS) || (LEVEL[v] ?? 3) > LEVEL[PERMISSIONS[k]]) throw new HttpError(503, `the GitHub App's token has more access than the Studio needs (${k}: ${v}); give the app only contents, pull requests and metadata`);
    }
    const names = got.repositories.map((r) => r?.full_name ?? r);
    if (names.length !== 1 || String(names[0]).toLowerCase() !== repo.toLowerCase()) throw new HttpError(503, `the GitHub App's token reaches ${names.length} repositories; scope it to ${repo} only`);
    checked.set(t, Date.now());
    if (checked.size > 100) checked.delete(checked.keys().next().value);
    return t;
  }

  const backend = cp ? null : githubBackend({ repo, token, installation: opts.installationId ?? 'default', api, fetch: fetchImpl, cache });

  async function allowed(request, action) {
    if (!ACTIONS.has(action)) throw new HttpError(500, 'unknown action');
    let user;
    try { user = userOf(await authorize(request, action)); } catch { user = null; }
    return user;
  }

  async function gate(request, action) {
    const user = await allowed(request, 'read');
    if (!user) throw new HttpError(401, 'sign in to the admin site first');
    if (action === 'read') return user;
    const u2 = await allowed(request, action);
    if (!u2) throw new HttpError(403, action === 'publish-code' ? 'this change adds or changes commands the team runs, and you are not allowed to publish those; ask an admin who is' : 'you can view the team, but not publish it', action === 'publish-code' ? { type: 'publish-code' } : {});
    return u2;
  }

  async function body(request) {
    const len = Number(request.headers.get('content-length') ?? 0);
    if (len > MAX_BODY) throw new HttpError(413, 'too large');
    const reader = request.body?.getReader();
    let size = 0; const chunks = [];
    if (reader) for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BODY) { reader.cancel().catch(() => {}); throw new HttpError(413, 'too large'); }
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new HttpError(400, 'send JSON'); }
  }

  const baseOf = (v) => { if (typeof v !== 'string' || !SHA.test(v)) throw new HttpError(400, 'base is the commit sha the page read (40 or 64 hex characters)'); return v; };
  const specOf = (spec) => { if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new HttpError(400, 'send the team as spec'); return spec; };

  function branchFor(given, message) {
    let b = typeof given === 'string' && given.trim() ? given.trim() : '';
    if (!b) {
      const slug = String(message ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'update';
      b = `${slug}-${Date.now().toString(36)}`;
    }
    if (!b.startsWith(branchPrefix)) b = branchPrefix + b;
    if (!BRANCH.test(b) || b.includes('..') || b.endsWith('/') || b.endsWith('.lock')) throw new HttpError(400, 'a branch name may use letters, digits, ".", "_", "/" and "-", up to 100 characters');
    return b;
  }

  async function route(request, path) {
    const method = request.method;
    if (method === 'GET' && path === '/v1/team') {
      await gate(request, 'read');
      const info = await backend.info();
      const read = await backend.readTeam(info.head.sha);
      const s = core.state(read);
      return json(200, { ...s, repo: info.repo, git: { repo: true, branch: info.defaultBranch, dirty: [], head: info.head }, features: { publish: true, chat: false, runs: false, live: false }, ...(s.noTeam ? { templates: core.templateCards(), groups: (await import('../../packages/team-model/index.mjs')).TEMPLATE_GROUPS } : { templates: core.templateCards() }) });
    }
    if (method === 'GET' && path === '/v1/team/pr') {
      await gate(request, 'read');
      const branch = new URL(request.url).searchParams.get('branch') ?? '';
      if (!branch.startsWith(branchPrefix) || !BRANCH.test(branch) || branch.includes('..')) throw new HttpError(400, `the branch is one the Studio made (${branchPrefix}…)`);
      return json(200, await backend.prStatus(branch));
    }
    if (method === 'POST' && path.startsWith('/v1/team/')) {
      const input = await body(request);
      if (path === '/v1/team/preview') {
        await gate(request, 'read');
        const read = await backend.readTeam(baseOf(input.base));
        return json(200, core.preview(read, specOf(input.spec), { tmpRoot }));
      }
      if (path === '/v1/team/graph') { await gate(request, 'read'); return json(200, core.graph(specOf(input.spec))); }
      if (path === '/v1/team/suggestions') {
        await gate(request, 'read');
        const base = baseOf(input.base);
        const [paths, read] = await Promise.all([backend.listPaths(base), backend.readTeam(base)]);
        const pkg = paths.includes('package.json') ? await backend.readRootFile(base, 'package.json') : null;
        return json(200, core.suggestionsFrom(specOf(input.spec), { paths, read: (p) => (p === 'package.json' ? pkg : null), team: core.filesOf(read) }));
      }
      if (path === '/v1/team/from-template') {
        await gate(request, 'read');
        const info = await backend.info();
        const read = await backend.readTeam(info.head.sha);
        return json(200, core.templateDraft(input, { hasTeam: read.files.some((f) => f.path === '.agent-team/team.json'), fallbackProject: repo.split('/')[1] }));
      }
      if (path === '/v1/team/publish') return publish(request, input);
    }
    throw new HttpError(404, 'no such endpoint');
  }

  // Control-plane mode (studio-embed.md section 6): the host's own sign-in and E2 checks stand here, as in every mode;
  // the deployment reads the repository and opens the pull request, for this site's token and the host's user.
  const PROXIED = new Set(['GET /v1/team', 'GET /v1/team/pr', 'POST /v1/team/preview', 'POST /v1/team/graph', 'POST /v1/team/suggestions', 'POST /v1/team/from-template', 'POST /v1/team/publish']);
  async function proxy(request, path) {
    if (!PROXIED.has(`${request.method} ${path}`)) throw new HttpError(404, 'no such endpoint');
    const user = await gate(request, path === '/v1/team/publish' ? 'publish' : 'read');
    const input = request.method === 'POST' ? await body(request) : null;
    const r = await cp.call(request, path, input, user);
    if (r.status === 403 && r.data?.type !== 'consent' && /commands the team runs/.test(r.data?.error ?? '')) {
      // Never through a host (section 6): the person publishes a change to what runs from the deployment's own Studio.
      return json(403, { error: `this change adds or changes commands the team runs, so it is published from the team's own Studio, not through this site: ${cp.studio}`, type: 'publish-code', studio: cp.studio });
    }
    const data = r.data;
    // The page hides publishing a change to commands, and links the deployment's Studio in its place.
    if (r.status === 200 && path === '/v1/team' && data && typeof data === 'object') return json(200, { ...data, features: { ...(data.features ?? {}), publishCode: false, studio: cp.studio } });
    if (r.status === 200) return json(200, data);
    if (r.status === 401) throw new HttpError(502, 'the team\'s deployment did not accept this site\'s sign-in; sign in through it again', { type: 'host-sign-in' });
    const message = typeof data?.error === 'string' ? redact(data.error) : `the team's deployment answered ${r.status}`;
    const extra = r.retryAfter ? { 'retry-after': r.retryAfter } : {};
    return json(r.status >= 400 && r.status < 600 ? r.status : 502, { error: message, ...(typeof data?.type === 'string' ? { type: data.type } : {}) }, extra);
  }

  async function publish(request, input) {
    let user = await gate(request, 'publish');
    const spec = specOf(input.spec);
    const base = baseOf(input.base);
    const errors = validate(spec, loadKit(KIT)).filter((i) => i.level === 'error');
    if (errors.length) throw new HttpError(422, `fix ${errors.length} error${errors.length > 1 ? 's' : ''} first: ${errors[0].where}: ${errors[0].message}`);
    const message = typeof input.message === 'string' ? input.message.slice(0, 20_000) : '';
    const branch = branchFor(input.branch, message.split('\n')[0]);
    if (limiter) {
      if (!(await limiter(`agent-team-studio:publish:user:${user.id}`, { limit: 10, windowSeconds: 3600 }))) throw new HttpError(429, 'at most 10 publishes an hour; try again later');
      if (!(await limiter(`agent-team-studio:publish:repo:${repo}`, { limit: 1, windowSeconds: 10 }))) throw new HttpError(429, 'another publish to this repository is running; try again in a few seconds');
    }
    const info = await backend.info();
    const read = await backend.readTeam(base);
    const p = core.plan(read, spec, { tmpRoot });
    if (p.changes.some((c) => !core.inReadSet(c.path))) throw new HttpError(500, 'a change outside the team\'s files was refused');
    if (!p.changes.length) return json(200, { branch: null, commit: null, files: [], note: 'nothing changed', pr: null });
    // S1: a plan that changes what runs needs the narrower permission too.
    if (p.needsCode) user = await gate(request, 'publish-code');
    if (info.head.sha !== base) throw new HttpError(409, 'the team changed on GitHub since you opened it; reload', { type: 'stale' });
    const kitUpgrade = core.kitVersionOf(core.filesOf(read)).upgrade;
    const out = await backend.publish({
      base, into: info.defaultBranch, branch, message: core.commitMessage(message, user),
      changes: p.changes.map(({ path, content, mode }) => ({ path, content, mode })),
      pr: core.pullRequestBody(message, { commands: p.commands, kitUpgrade, via: user.via ?? null, capability: p.capability }),
    });
    try { logger({ event: 'agent-team-studio.publish', user: user.id, branch: out.branch, commit: out.commit, pr: out.pr?.url ?? null, files: out.files.length, ...(user.via ? { via: user.via } : {}) }); } catch { /* the host's logger */ }
    return json(200, { branch: out.branch, commit: out.commit, files: out.files, pr: out.pr, commands: p.commands });
  }

  function asset(request, path) {
    const raw = new URL(request.url).pathname;
    if (unsafePath(raw.slice(basePath.length))) return json(404, { error: 'not found' });
    const m = /^\/assets\/([^/]+)\/([^/]+)$/.exec(path);
    const a = m && m[1] === version ? assets.get(m[2]) : null;
    if (!a || (request.method !== 'GET' && request.method !== 'HEAD')) return json(404, { error: 'not found' });
    return new Response(request.method === 'HEAD' ? null : readFileSync(a.file), { status: 200, headers: { 'content-type': a.type, 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' } });
  }

  return async function handler(request) {
    try {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(basePath + '/')) return json(404, { error: 'not found' });
      const path = url.pathname.slice(basePath.length);
      if (path.startsWith('/assets/')) return asset(request, path);
      if (!path.startsWith('/v1/')) return json(404, { error: 'not found' });
      // E2: cross-site requests are refused before any work, in this order. No preflight is answered and no
      // Access-Control-Allow-* header is ever sent.
      const site = request.headers.get('sec-fetch-site');
      if (site && site !== 'same-origin') return json(403, { error: 'cross-site request refused' });
      const hasBody = !['GET', 'HEAD'].includes(request.method);
      if (request.method === 'OPTIONS') return json(405, { error: 'method not allowed' });
      if (hasBody && !allowedOrigins.has(request.headers.get('origin') ?? '')) return json(403, { error: 'cross-origin request refused' });
      if (request.headers.get('x-agent-team-studio') !== '1') return json(403, { error: 'missing the x-agent-team-studio header' });
      if (hasBody && !String(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return json(415, { error: 'send JSON' });
      if (unsafePath(path)) return json(404, { error: 'not found' });
      return await (cp ? proxy(request, path) : route(request, path));
    } catch (e) {
      const status = e instanceof HttpError || e instanceof core.CoreError ? e.status : 500;
      // The host's own log gets the reason for an unexpected failure, with anything token-shaped taken out (E3, E9).
      if (status === 500) { try { logger({ event: 'agent-team-studio.error', error: redact(e?.message ?? e) }); } catch { /* the host's logger */ } }
      // Never a stack, a header or a token: our own sentences only (E3).
      const message = status === 500 && !(e instanceof core.CoreError) ? 'the Studio could not do that; the host\'s server log has no more detail by design' : e.message;
      return json(status, { error: message, ...(e.type ? { type: e.type } : {}) });
    }
  };
}

/**
 * A node:http adapter: `createServer(toNodeListener(handler))`, or `app.use(basePath, toNodeListener(handler))` in
 * Express (it reads `req.originalUrl`, so the handler sees the whole path even where Express strips the mount path).
 */
export function toNodeListener(handler, { origin = null } = {}) {
  return async (req, res) => {
    try {
      const host = origin ?? `http://${req.headers.host ?? 'localhost'}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
      const hasBody = !['GET', 'HEAD'].includes(req.method);
      const request = new Request(new URL(req.originalUrl ?? req.url ?? '/', host), { method: req.method, headers, body: hasBody ? req : undefined, duplex: hasBody ? 'half' : undefined });
      const response = await handler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
    } catch {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"the Studio could not do that"}');
    }
  };
}
