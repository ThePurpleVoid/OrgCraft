// Signing in, for tests: a stand-in GitHub, a browser with a cookie jar, and a control plane with the issuer on.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { fresh, key, ADMIN, verifier } from './helpers.mjs';
import * as store from '../store.mjs';
import { createControlPlane } from '../server.mjs';
import { createIdentity, githubUpstream } from '../identity.mjs';

export const ORIGIN = 'https://studio.example';
export const OWNER = '1001';

/** A stand-in GitHub: the user authorization flow with PKCE, /user and /user/emails. Tests set `as`. The conformance
 *  harness listens on another host and port, and names the URL the suite's browser reaches it by. */
export async function stubGitHub({ host = '127.0.0.1', port = 0, url = null } = {}) {
  const codes = new Map(), tokens = new Map();
  const gh = { as: null, issued: [], directory: [] };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/login/oauth/authorize') {
      if (url.searchParams.get('code_challenge_method') !== 'S256' || url.searchParams.get('client_id') !== 'Iv1.test') return json(400, { error: 'bad request' });
      const code = randomUUID();
      codes.set(code, { user: gh.as, challenge: url.searchParams.get('code_challenge'), redirect: url.searchParams.get('redirect_uri') });
      const back = new URL(url.searchParams.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, { location: back.href });
      return res.end();
    }
    if (url.pathname === '/login/oauth/access_token' && req.method === 'POST') {
      let raw = '';
      for await (const c of req) raw += c;
      const b = JSON.parse(raw);
      const c = codes.get(b.code);
      codes.delete(b.code);
      if (!c || b.client_secret !== 'gh-secret' || b.redirect_uri !== c.redirect || createHash('sha256').update(b.code_verifier).digest('base64url') !== c.challenge) return json(200, { error: 'bad_verification_code' });
      const token = `ghu_${randomBytes(18).toString('hex')}`;
      tokens.set(token, c.user);
      gh.issued.push(token);
      return json(200, { access_token: token, token_type: 'bearer' });
    }
    // Public user lookups, for invitations by login: everyone a test has signed in as, plus `gh.directory`.
    const lookup = /^\/users\/([^/]+)$/.exec(url.pathname)?.[1] ?? /^\/user\/([0-9]+)$/.exec(url.pathname)?.[1];
    if (lookup && req.method === 'GET') {
      const u = gh.directory.find((x) => x.login.toLowerCase() === decodeURIComponent(lookup).toLowerCase() || x.id === lookup);
      return u ? json(200, { id: Number(u.id), login: u.login }) : json(404, { message: 'Not Found' });
    }
    const user = tokens.get(/^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]);
    if (!user) return json(401, { message: 'Bad credentials' });
    if (url.pathname === '/user') return json(200, { id: Number(user.id), login: user.login, name: user.name ?? null });
    if (url.pathname === '/user/emails') return json(200, user.emails ?? []);
    return json(404, {});
  });
  await new Promise((r) => server.listen(port, host, r));
  gh.url = url ?? `http://${host}:${server.address().port}`;
  gh.close = () => { server.closeAllConnections(); server.close(); };
  return gh;
}

/** A browser: a cookie jar with paths, and manual redirects, with the deployment's origin mapped to the test server. */
export function browser(local, { ip = 'browser' } = {}) {
  const jar = new Map(); // name -> { value, path }
  const toLocal = (u) => (u.startsWith(ORIGIN) ? local + u.slice(ORIGIN.length) : u.startsWith('/') ? local + u : u);
  const keep = (res) => {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';').map((s) => s.trim());
      const at = pair.indexOf('=');
      const name = pair.slice(0, at), value = pair.slice(at + 1);
      const path = attrs.find((a) => /^path=/i.test(a))?.slice(5) ?? '/';
      const gone = attrs.some((a) => /^max-age=0$/i.test(a)) || attrs.some((a) => /^expires=/i.test(a) && new Date(a.slice(8)) < new Date());
      if (gone) jar.delete(name); else jar.set(name, { value, path, raw: line });
    }
  };
  const header = (u) => {
    const path = new URL(u).pathname;
    return [...jar].filter(([, c]) => path.startsWith(c.path)).map(([k, c]) => `${k}=${c.value}`).join('; ');
  };
  const b = {
    jar,
    async fetch(u, { method = 'GET', headers = {}, body } = {}) {
      const target = toLocal(u);
      const res = await fetch(target, { method, redirect: 'manual', headers: { 'x-test-ip': ip, ...(target.startsWith(local) && jar.size ? { cookie: header(target) } : {}), ...headers }, body });
      if (target.startsWith(local)) keep(res);
      return res;
    },
    /** Follows redirects until the Studio's /sign-in page, an app's redirect URI, or a non-redirect answer. */
    async go(u, opts) {
      let res = await b.fetch(u, opts);
      for (let i = 0; i < 15 && [302, 303].includes(res.status); i++) {
        const loc = res.headers.get('location');
        const abs = loc.startsWith('/') ? ORIGIN + loc : loc;
        if (abs.startsWith(`${ORIGIN}/sign-in`) || abs.startsWith(`${ORIGIN}/app/`) || abs.startsWith('http://127.0.0.1/callback') || (abs.startsWith(ORIGIN) && !new URL(abs).pathname.startsWith('/oauth/'))) return { at: abs, res };
        res = await b.fetch(abs);
      }
      return { at: null, res };
    },
    /** A whole web sign-in: the web start, the sign-in page's "Continue with GitHub", back to `return`. */
    async signIn(ret = '/') {
      const first = await b.go(`${ORIGIN}/oauth/authorize?client_id=agent-team-web&return=${encodeURIComponent(ret)}`);
      if (!first.at?.startsWith(`${ORIGIN}/sign-in?interaction=`)) return first.at;
      const uid = new URL(first.at).searchParams.get('interaction');
      return (await b.go(`${ORIGIN}/oauth/interaction/${uid}/github`)).at;
    },
    call: async (method, path, body, headers = {}) => {
      const res = await b.fetch(`${ORIGIN}/v1${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), origin: ORIGIN, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
  };
  return b;
}

export async function issuer(fn, { ownerGithub = OWNER, now, clientIp = (req) => req.headers['x-test-ip'] ?? '', cronSecret, clients, streamCheckMs } = {}) {
  const db = await fresh();
  await store.ensureTenant(db, 'acme');
  const gh = await stubGitHub();
  const upstream = githubUpstream({ clientId: 'Iv1.test', clientSecret: 'gh-secret', url: gh.url, apiUrl: gh.url });
  const identity = await createIdentity({ db, key, publicUrl: ORIGIN, tenant: 'acme', ownerGithub, upstream, ...(clientIp ? { clientIp } : {}), ...(now ? { now } : {}), ...(clients ? { clients } : {}) });
  const server = createControlPlane({ db, key, tenant: 'acme', adminToken: ADMIN, publicUrl: ORIGIN, identity, tickMs: 0, stepUpVerifier: verifier, ...(cronSecret ? { cronSecret } : {}), ...(now ? { now } : {}), ...(streamCheckMs ? { streamCheckMs } : {}) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const local = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ db, gh, local, identity, server, browser: (o) => browser(local, o) });
  } finally { server.runners?.closeAll(); server.closeAllConnections(); server.close(); gh.close(); await db.close(); }
}

export const owner = { id: OWNER, login: 'octo', name: 'Octo Cat' };
