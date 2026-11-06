// Signing in (docs/specs/m4-sign-in.md sections 2, 4 and 4a): the issuer on /oauth/*, the GitHub upstream (a stub
// here), the web cookie session and CSRF, invitations, and the apps' code flow with DPoP-bound refresh tokens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { SignJWT, exportJWK } from 'jose';
import { fresh, key, ADMIN, STEP_UP_SECRET, verifier } from './helpers.mjs';
import * as store from '../store.mjs';
import { createControlPlane } from '../server.mjs';
import { createIdentity } from '../identity.mjs';
import { REFUSED } from '../../../tests/fixtures/return-paths.mjs';

const ORIGIN = 'https://studio.example';
const OWNER = '1001';

/** A stand-in GitHub: the user authorization flow with PKCE, /user and /user/emails. Tests set `as`. */
async function stubGitHub() {
  const codes = new Map(), tokens = new Map();
  const gh = { as: null, issued: [] };
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
    const user = tokens.get(/^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]);
    if (!user) return json(401, { message: 'Bad credentials' });
    if (url.pathname === '/user') return json(200, { id: Number(user.id), login: user.login, name: user.name ?? null });
    if (url.pathname === '/user/emails') return json(200, user.emails ?? []);
    return json(404, {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  gh.url = `http://127.0.0.1:${server.address().port}`;
  gh.close = () => { server.closeAllConnections(); server.close(); };
  return gh;
}

/** A browser: a cookie jar with paths, and manual redirects, with the deployment's origin mapped to the test server. */
function browser(local, { ip = 'browser' } = {}) {
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

async function issuer(fn, { ownerGithub = OWNER, now, clientIp = (req) => req.headers['x-test-ip'] ?? '', globalPerMinute } = {}) {
  const db = await fresh();
  await store.ensureTenant(db, 'acme');
  const gh = await stubGitHub();
  const upstream = (await import('../identity.mjs')).githubUpstream({ clientId: 'Iv1.test', clientSecret: 'gh-secret', url: gh.url, apiUrl: gh.url });
  const identity = await createIdentity({ db, key, publicUrl: ORIGIN, tenant: 'acme', ownerGithub, upstream, ...(clientIp ? { clientIp } : {}), ...(globalPerMinute ? { globalPerMinute } : {}), ...(now ? { now } : {}) });
  const server = createControlPlane({ db, key, tenant: 'acme', adminToken: ADMIN, publicUrl: ORIGIN, identity, tickMs: 0, stepUpVerifier: verifier, ...(now ? { now } : {}) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const local = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ db, gh, local, identity, server, browser: (o) => browser(local, o) });
  } finally { server.runners?.closeAll(); server.closeAllConnections(); server.close(); gh.close(); await db.close(); }
}

const owner = { id: OWNER, login: 'octo', name: 'Octo Cat' };

test('discovery names this deployment as the issuer, with the /oauth endpoints', () => issuer(async ({ local }) => {
  const d = await (await fetch(`${local}/.well-known/openid-configuration`)).json();
  assert.equal(d.issuer, ORIGIN);
  assert.equal(d.authorization_endpoint, `${ORIGIN}/oauth/authorize`);
  assert.equal(d.token_endpoint, `${ORIGIN}/oauth/token`);
  assert.equal(d.revocation_endpoint, `${ORIGIN}/oauth/revoke`);
  assert.deepEqual(d.code_challenge_methods_supported, ['S256']);
  const jwks = await (await fetch(`${local}/oauth/jwks`)).json();
  assert.equal(jwks.keys[0].kty, 'EC');
  assert.equal(jwks.keys[0].d, undefined, 'the public JWKS has no private part');
}));

test('a person who is not a member or invitee cannot create an account', () => issuer(async ({ db, gh, browser }) => {
  gh.as = { id: '777', login: 'stranger' };
  const stranger = browser();
  assert.equal(await stranger.signIn('/#chat'), `${ORIGIN}/sign-in?error=not-invited`);
  // Any GitHub account is not enough: no cookie, so no tenant data at all.
  assert.equal(stranger.jar.has('__Host-agent-team'), false);
  for (const path of ['/me', '/teams', '/me/summary', '/me/inbox', '/runners', '/secrets']) assert.equal((await stranger.call('GET', path)).status, 401, path);
  assert.equal((await db.system('select count(*)::int as n from people'))[0].n, 0);
  assert.equal((await db.system('select count(*)::int as n from members'))[0].n, 0);
  assert.equal((await db.system("select count(*)::int as n from identity_audit where action = 'sign-in.refused'"))[0].n, 1);
}));

test('the first sign-in of AGENT_TEAM_OWNER_GITHUB creates the owner, and a second person cannot', () => issuer(async ({ db, gh, browser }) => {
  gh.as = owner;
  const b = browser();
  assert.equal(await b.signIn('/#chat'), `${ORIGIN}/#chat`);
  const me = await b.call('GET', '/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.login, 'octo');
  assert.deepEqual(me.body.workspaces, [{ tenant: 'acme', role: 'owner' }]);
  assert.equal(me.body.passkeys, 0);
  // Removed from the workspace: the cookie still names them, but nothing of the tenant is theirs any more.
  await db.system("update members set removed_at = now()");
  assert.deepEqual((await b.call('GET', '/me')).body.workspaces, []);
  for (const path of ['/teams', '/me/summary', '/me/inbox', '/runners']) assert.equal((await b.call('GET', path)).status, 404, path);
  await db.system("update members set removed_at = null");
  assert.ok(Date.now() - Date.parse(me.body.authTime) < 60_000);
  // The cookie is the spec's: __Host-, HttpOnly, Secure, SameSite=Lax, Path=/.
  assert.match(b.jar.get('__Host-agent-team').raw, /^__Host-agent-team=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=604800$/);

  gh.as = { id: '1002', login: 'second' };
  assert.equal(await browser().signIn(), `${ORIGIN}/sign-in?error=not-invited`);
  assert.equal((await db.system('select count(*)::int as n from people'))[0].n, 1);
  // A login named like the owner's, with another user id, is someone else.
  gh.as = { id: '1003', login: 'octo' };
  assert.equal(await browser().signIn(), `${ORIGIN}/sign-in?error=not-invited`);
}));

test('the web callback redirects only to a path on the deployment\'s host: the same refused forms as the page', () => issuer(async ({ gh, browser }) => {
  gh.as = owner;
  const b = browser();
  // Refused at the end of a real sign-in...
  assert.equal(await b.signIn('//evil.example'), `${ORIGIN}/`);
  // ...and at the web start of a signed-in browser, for every form the page's own check refuses.
  let n = 0;
  for (const bad of REFUSED) {
    if (typeof bad !== 'string') continue;
    const res = await b.fetch(`${ORIGIN}/oauth/authorize?client_id=agent-team-web&return=${encodeURIComponent(bad)}`, { headers: { 'x-test-ip': `ip${n}` } });
    assert.equal(res.status, 303, JSON.stringify(bad));
    assert.equal(res.headers.get('location'), '/', JSON.stringify(bad));
    n++;
  }
  assert.ok(n >= 24, `checked ${n} refused forms`);
  const ok = await b.fetch(`${ORIGIN}/oauth/authorize?client_id=agent-team-web&return=${encodeURIComponent('/t/acme/cards/card_1?x=1#a')}`);
  assert.equal(ok.headers.get('location'), '/t/acme/cards/card_1?x=1#a');
}));

test('a cookie request from another origin, or not JSON, is refused; a revoked session\'s cookie is refused at once', () => issuer(async ({ gh, browser }) => {
  gh.as = owner;
  const b = browser();
  await b.signIn();
  assert.equal((await b.call('POST', '/teams', { id: 'web' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await b.call('POST', '/teams', { id: 'web' }, { origin: undefined })).status, 403);
  const form = await b.fetch(`${ORIGIN}/v1/teams`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: 'id=web' });
  assert.equal(form.status, 403);
  assert.equal((await b.call('POST', '/teams', { id: 'web' })).status, 201);

  // Sign out: a cross-site sign-out is refused too; the real one ends the session for this cookie at once.
  const cookie = b.jar.get('__Host-agent-team').value;
  assert.equal((await b.fetch(`${ORIGIN}/oauth/revoke`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })).status, 403);
  const out = await b.fetch(`${ORIGIN}/oauth/revoke`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(out.status, 200);
  assert.equal(b.jar.has('__Host-agent-team'), false);
  const again = await b.fetch(`${ORIGIN}/v1/me`, { headers: { cookie: `__Host-agent-team=${cookie}` } });
  assert.equal(again.status, 401);
  // And signing in again goes through GitHub, not a silent session at the issuer.
  const before = gh.issued.length;
  assert.equal(await b.signIn(), `${ORIGIN}/`);
  assert.equal(gh.issued.length, before + 1);
}));

test('sessions expire after 12 idle hours and 7 days in all', async () => {
  let t = Date.now();
  await issuer(async ({ gh, browser }) => {
    gh.as = owner;
    const b = browser();
    await b.signIn();
    assert.equal((await b.call('GET', '/me')).status, 200);
    t += 11 * 3600_000;
    assert.equal((await b.call('GET', '/me')).status, 200);
    t += 11 * 3600_000;
    assert.equal((await b.call('GET', '/me')).status, 200, 'used within 12 hours keeps it');
    t += 13 * 3600_000;
    assert.equal((await b.call('GET', '/me')).status, 401, '13 idle hours end it');
    await b.signIn();
    for (let i = 0; i < 15; i++) { t += 11 * 3600_000; assert.equal((await b.call('GET', '/me')).status, 200); }
    t += 11 * 3600_000;
    assert.equal((await b.call('GET', '/me')).status, 401, 'past 7 days it ends however busy');
  }, { now: () => new Date(t) });
});

test('the person\'s GitHub token is not stored anywhere', () => issuer(async ({ db, gh, browser }) => {
  gh.as = { ...owner, emails: [{ email: 'Octo@Example.com', primary: true, verified: true }] };
  await browser().signIn();
  assert.equal(gh.issued.length, 1);
  const tables = (await db.system("select table_name from information_schema.tables where table_schema = current_schema() and table_type = 'BASE TABLE'")).map((r) => r.table_name);
  for (const t of tables) {
    const rows = await db.system(`select t::text as row from ${t} t`);
    for (const { row } of rows) assert.ok(!row.includes(gh.issued[0]), `${t} holds the GitHub token`);
  }
  const [p] = await db.system('select subject, login, email from people');
  assert.deepEqual(p, { subject: OWNER, login: 'octo', email: 'octo@example.com' });
}));

test('invitations bind to the numeric user id or a verified primary email; a renamed login or unverified email does not match', () => issuer(async ({ db, gh, browser }) => {
  await store.ensureTenant(db, 'beta');
  const invite = (tenant, x) => db.tenant(tenant, ({ q }) => q("insert into invitations(id, tenant, provider, subject, email, role, invited_by, expires_at) values ($1, $2, 'github', $3, $4, $5, 'per_owner', now() + interval '7 days')", [`inv_${randomUUID()}`, tenant, x.subject ?? null, x.email ?? null, x.role ?? 'editor']));
  await invite('acme', { subject: '300', role: 'viewer' });
  await invite('beta', { email: 'dana@example.com', role: 'approver' });

  // Someone else who took the invitee's old login: another user id, so not invited.
  gh.as = { id: '301', login: 'carol' };
  assert.equal(await browser().signIn(), `${ORIGIN}/sign-in?error=not-invited`);
  // The invitee, under a new login: their user id matches.
  gh.as = { id: '300', login: 'carol-renamed' };
  const carol = browser();
  assert.equal(await carol.signIn(), `${ORIGIN}/`);
  assert.deepEqual((await carol.call('GET', '/me')).body.workspaces, [{ tenant: 'acme', role: 'viewer' }]);
  // The invitation is used up.
  gh.as = { id: '300', login: 'carol' };
  assert.equal((await db.system("select count(*)::int as n from invitations where accepted_at is not null and subject = '300'"))[0].n, 1);

  // The invited email, but not verified (or not primary): no.
  gh.as = { id: '400', login: 'dana', emails: [{ email: 'dana@example.com', primary: true, verified: false }] };
  assert.equal(await browser().signIn(), `${ORIGIN}/sign-in?error=not-invited`);
  gh.as = { id: '400', login: 'dana', emails: [{ email: 'other@example.com', primary: true, verified: true }, { email: 'dana@example.com', primary: false, verified: true }] };
  assert.equal(await browser().signIn(), `${ORIGIN}/sign-in?error=not-invited`);
  gh.as = { id: '400', login: 'dana', emails: [{ email: 'Dana@Example.com', primary: true, verified: true }] };
  const dana = browser();
  assert.equal(await dana.signIn(), `${ORIGIN}/`);
  const me = (await dana.call('GET', '/me')).body;
  assert.deepEqual(me.workspaces, [{ tenant: 'beta', role: 'approver' }]);
  // A member of another workspace only: this server's teams are not there for them (404, not 403), /me still is.
  assert.equal((await dana.call('GET', '/teams')).status, 404);
  // A viewer reads, and cannot change anything yet.
  assert.equal((await carol.call('GET', '/teams')).status, 200);
  assert.equal((await carol.call('POST', '/teams', { id: 'nope' })).status, 403);
}));

test('agent_team_app cannot read identity, and tenants cannot see each other\'s members or invitations', () => issuer(async ({ db, gh, browser }) => {
  gh.as = owner;
  await browser().signIn();
  await store.ensureTenant(db, 'beta');
  await db.tenant('beta', ({ q }) => q("insert into invitations(id, tenant, subject, role, invited_by, expires_at) values ('inv_b', 'beta', '555', 'viewer', 'x', now() + interval '1 day')"));
  for (const t of ['people', 'person_sessions', 'oauth_tokens', 'passkeys', 'oidc_store', 'issuer_keys', 'identity_audit']) {
    await assert.rejects(db.tenant('acme', ({ q }) => q(`select * from ${t}`)), /permission denied/, t);
  }
  assert.equal((await db.tenant('acme', ({ q }) => q('select * from members'))).length, 1);
  assert.equal((await db.tenant('beta', ({ q }) => q('select * from members'))).length, 0);
  assert.equal((await db.tenant('acme', ({ q }) => q('select * from invitations'))).length, 0);
  assert.equal((await db.tenant('beta', ({ q }) => q('select * from invitations'))).length, 1);
  await assert.rejects(db.tenant('acme', ({ q }) => q("insert into invitations(id, tenant, subject, role, invited_by, expires_at) values ('inv_x', 'beta', '1', 'owner', 'x', now())")), /row-level security/);
}));

test('a signed-in person\'s fresh GitHub sign-in is not step-up, and the typed secret is refused for them', () => issuer(async ({ gh, browser }) => {
  gh.as = owner;
  const b = browser();
  await b.signIn();
  const code = await b.call('POST', '/runners/codes', {});
  assert.equal(code.status, 401);
  assert.equal(code.body.type, 'step-up-required');
  const su = await b.call('POST', '/auth/step-up', { secret: 'anything' });
  assert.equal(su.status, 400);
  assert.equal(su.body.type, 'step-up-method');
}));

/** A DPoP proof for one request, signed by the device's key. */
async function dpop(device, htm, htu) {
  return new SignJWT({ htm, htu, jti: randomUUID() }).setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk: device.jwk }).setIssuedAt().sign(device.privateKey);
}
async function device() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { privateKey, jwk: await exportJWK(publicKey) };
}

test('apps: exact redirect URIs, PKCE, refresh tokens bound to the device key, and a reused one revokes the family', () => issuer(async ({ db, gh, local, browser }) => {
  gh.as = owner;
  const redirect = `${ORIGIN}/app/ios/callback`;
  const verifier = randomBytes(32).toString('base64url');
  const authorize = (r, extra = {}) => `${ORIGIN}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: 'agent-team-ios', redirect_uri: r, scope: 'openid profile', state: 'st1', nonce: 'n1', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', ...extra })}`;

  // A redirect_uri one character off is refused, and nothing is redirected to it.
  for (const r of [`${redirect}x`, `${ORIGIN}/app/ios/callbacK`, 'https://studio.example.evil/app/ios/callback']) {
    const res = await browser().fetch(authorize(r));
    assert.equal(res.status, 400, r);
    assert.equal(res.headers.get('location'), null);
  }
  // Without PKCE: refused.
  const noPkce = await browser().fetch(authorize(redirect, { code_challenge: '', code_challenge_method: '' }).replace(/&code_challenge=&code_challenge_method=/, ''));
  assert.equal(noPkce.status, 303);
  assert.match(noPkce.headers.get('location'), /error=invalid_request/);

  const b = browser();
  const first = await b.go(authorize(redirect));
  const uid = new URL(first.at).searchParams.get('interaction');
  const back = new URL((await b.go(`${ORIGIN}/oauth/interaction/${uid}/github`)).at);
  assert.equal(back.origin + back.pathname, redirect);
  assert.equal(back.searchParams.get('state'), 'st1');
  const code = back.searchParams.get('code');

  const phone = await device();
  const token = async (params, d = phone) => {
    const res = await fetch(`${local}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-ip': 'phone', ...(d ? { dpop: await dpop(d, 'POST', `${ORIGIN}/oauth/token`) } : {}) }, body: new URLSearchParams({ client_id: 'agent-team-ios', ...params }) });
    return { status: res.status, body: await res.json() };
  };
  // The DPoP key is required for this client.
  assert.equal((await token({ grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier }, null)).status, 400);
  const got = await token({ grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier });
  assert.equal(got.status, 200, JSON.stringify(got.body));
  assert.equal(got.body.token_type, 'DPoP');
  assert.equal(got.body.expires_in, 900);
  assert.ok(got.body.refresh_token && got.body.id_token);
  // The ID token: ES256, sub is the person, nonce echoed, auth_time present.
  const [h, p] = got.body.id_token.split('.').slice(0, 2).map((x) => JSON.parse(Buffer.from(x, 'base64url')));
  assert.equal(h.alg, 'ES256');
  assert.equal(p.nonce, 'n1');
  assert.match(p.sub, /^per_/);
  assert.ok(p.auth_time);

  // A stolen refresh token without the device key is refused.
  const thief = await device();
  assert.equal((await token({ grant_type: 'refresh_token', refresh_token: got.body.refresh_token }, thief)).status, 400);
  assert.equal((await token({ grant_type: 'refresh_token', refresh_token: got.body.refresh_token }, null)).status, 400);
  // With it: a new pair, rotated.
  const r1 = await token({ grant_type: 'refresh_token', refresh_token: got.body.refresh_token });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.notEqual(r1.body.refresh_token, got.body.refresh_token);
  // Reusing the old one revokes the whole family (the new one too) and writes an audit row.
  const reuse = await token({ grant_type: 'refresh_token', refresh_token: got.body.refresh_token });
  assert.equal(reuse.status, 400);
  assert.equal(reuse.body.error, 'invalid_grant');
  assert.equal((await token({ grant_type: 'refresh_token', refresh_token: r1.body.refresh_token })).status, 400);
  assert.equal((await db.system("select count(*)::int as n from identity_audit where action = 'refresh-token.reused'"))[0].n, 1);
  assert.equal((await db.system("select count(*)::int as n from oauth_tokens where revoked_at is null and kind = 'refresh'"))[0].n, 0);
  // The code worked once.
  assert.equal((await token({ grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier })).status, 400);
  // Tokens are kept only as hashes.
  const raw = (await db.system('select hash from oauth_tokens')).map((r) => r.hash);
  assert.ok(!raw.includes(r1.body.refresh_token) && raw.every((x) => /^[0-9a-f]{64}$/.test(x)));
}));

test('the 21st authorize call in a minute from one IP gets 429', () => issuer(async ({ browser }) => {
  const b = browser({ ip: '203.0.113.9' });
  for (let i = 0; i < 20; i++) assert.notEqual((await b.fetch(`${ORIGIN}/oauth/authorize?client_id=agent-team-web&return=/`)).status, 429, `call ${i + 1}`);
  const res = await b.fetch(`${ORIGIN}/oauth/authorize?client_id=agent-team-web&return=/`);
  assert.equal(res.status, 429);
  // Another IP is not slowed.
  assert.equal((await browser({ ip: '203.0.113.10' }).fetch(`${ORIGIN}/oauth/authorize?client_id=agent-team-web&return=/`)).status, 303);
}));

test('behind the edge, each caller has their own bucket by the forwarded IP, and all of /oauth has a global cap', () => issuer(async ({ local }) => {
  const hit = (headers) => fetch(`${local}/oauth/authorize?client_id=agent-team-web&return=/`, { redirect: 'manual', headers });
  // Every request comes from the same socket (the edge); the forwarded client IP tells callers apart.
  for (let i = 0; i < 20; i++) await hit({ 'x-vercel-forwarded-for': '198.51.100.1' });
  assert.equal((await hit({ 'x-vercel-forwarded-for': '198.51.100.1' })).status, 429);
  assert.equal((await hit({ 'x-vercel-forwarded-for': '198.51.100.2' })).status, 303, 'one flooding caller does not lock out another');
  assert.equal((await hit({ 'x-forwarded-for': '198.51.100.3, 10.0.0.1' })).status, 303);
  // The backstop: 30 in all here (600 by default), whoever sends them.
  let last;
  for (let i = 0; i < 10; i++) last = await hit({ 'x-vercel-forwarded-for': `203.0.113.${i}` });
  assert.equal(last.status, 429);
}, { clientIp: null, globalPerMinute: 30 }));

test('the signing key rotates from the tick after 90 days, and the old one stays in the JWKS for a day', async () => {
  let t = Date.now();
  await issuer(async ({ local, identity }) => {
    const kids = async () => (await (await fetch(`${local}/oauth/jwks`)).json()).keys.map((k) => k.kid);
    const [first] = await kids();
    await identity.sweep();
    assert.deepEqual(await kids(), [first], 'nothing to rotate yet');
    const before = identity.provider;
    t += 91 * 86400_000;
    await identity.sweep();
    const both = await kids();
    assert.equal(both.length, 2);
    assert.equal(both[1], first);
    // The library was rebuilt around the new key, so new ID tokens are signed with it.
    assert.notEqual(identity.provider, before);
    t += 2 * 86400_000;
    await identity.sweep();
    assert.deepEqual(await kids(), [both[0]]);
  }, { now: () => new Date(t) });
});

test('a step-up token minted for the admin token is refused for a signed-in person', () => issuer(async ({ local, gh, browser }) => {
  gh.as = owner;
  const b = browser();
  await b.signIn();
  const mint = await fetch(`${local}/v1/auth/step-up`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: JSON.stringify({ secret: STEP_UP_SECRET }) });
  const { token } = await mint.json();
  assert.match(token, /^su_/);
  const theirs = await b.call('POST', '/runners/codes', {}, { 'x-step-up': token });
  assert.equal(theirs.status, 401);
  assert.equal(theirs.body.type, 'step-up-required');
  // Still good for the principal it was minted for: the refused try did not use it up.
  const admins = await fetch(`${local}/v1/runners/codes`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'x-step-up': token, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(admins.status, 201);
}));

test('a state from another browser, or used twice, does not finish a sign-in', () => issuer(async ({ gh, browser }) => {
  gh.as = owner;
  const victim = browser(), attacker = browser();
  const first = await attacker.go(`${ORIGIN}/oauth/authorize?client_id=agent-team-web&return=/`);
  const uid = new URL(first.at).searchParams.get('interaction');
  const toGitHub = await attacker.fetch(`${ORIGIN}/oauth/interaction/${uid}/github`);
  const gitHubBack = await fetch(toGitHub.headers.get('location'), { redirect: 'manual' });
  const callback = gitHubBack.headers.get('location');
  // The victim's browser opens the attacker's callback: it has no matching upstream cookie.
  assert.equal((await victim.go(callback)).at, `${ORIGIN}/sign-in?error=expired`);
  assert.equal(victim.jar.has('__Host-agent-team'), false);
  // The attacker's own browser can finish it once, not twice.
  assert.equal((await attacker.go(callback)).at, `${ORIGIN}/`);
  attacker.jar.set('__Host-agent-team-upstream', { value: new URL(callback).searchParams.get('state'), path: '/' });
  assert.equal((await attacker.go(callback)).at, `${ORIGIN}/sign-in?error=expired`);
  // An unknown interaction goes back to the page as expired.
  assert.equal((await victim.go(`${ORIGIN}/oauth/interaction/nope/github`)).at, `${ORIGIN}/sign-in?error=expired`);
}));

test('local mode is unchanged: without sign-in configured, /oauth is not there and the admin token still works', async () => {
  const db = await fresh();
  await store.ensureTenant(db, 'acme');
  const server = createControlPlane({ db, key, tenant: 'acme', adminToken: ADMIN, tickMs: 0 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const local = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${local}/oauth/authorize?client_id=agent-team-web`)).status, 404);
    assert.equal((await fetch(`${local}/.well-known/openid-configuration`)).status, 404);
    assert.equal((await fetch(`${local}/v1/me`)).status, 401);
    const me = await (await fetch(`${local}/v1/me`, { headers: { authorization: `Bearer ${ADMIN}` } })).json();
    assert.deepEqual(me.workspaces, [{ tenant: 'acme', role: 'owner' }]);
    assert.equal((await fetch(`${local}/v1/teams`, { headers: { authorization: `Bearer ${ADMIN}` } })).status, 200);
  } finally { server.closeAllConnections(); server.close(); await db.close(); }
});

test('the issuer refuses a non-https public URL and a login in place of the owner\'s user id', async () => {
  const db = await fresh();
  const upstream = { authorizeUrl: () => '', identify: async () => ({}) };
  await assert.rejects(createIdentity({ db, key, publicUrl: 'http://studio.example', tenant: 'acme', upstream }), /https/);
  await assert.rejects(createIdentity({ db, key, publicUrl: 'https://studio.example/app', tenant: 'acme', upstream }), /no path/);
  await assert.rejects(createIdentity({ db, key, publicUrl: ORIGIN, tenant: 'acme', ownerGithub: 'octo', upstream }), /numeric/);
  await db.close();
});
