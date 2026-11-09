// Signing in (docs/specs/m4-sign-in.md sections 2, 4 and 4a): the issuer on /oauth/*, the GitHub upstream (a stub
// here), the web cookie session and CSRF, invitations, and the apps' code flow with DPoP-bound refresh tokens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { SignJWT, exportJWK } from 'jose';
import { fresh, key, ADMIN } from './helpers.mjs';
import { ORIGIN, OWNER, issuer, owner } from './sign-in-helpers.mjs';
import * as store from '../store.mjs';
import { createControlPlane } from '../server.mjs';
import { createIdentity, issuerKeys } from '../identity.mjs';
import { REFUSED } from '../../../tests/fixtures/return-paths.mjs';


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
  const back = new URL((await b.go(`${ORIGIN}/oauth/authorize/${uid}/github`)).at);
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
  // The library's grant.revoked event is not awaited, so the audit row can land just after the answer (seen on Postgres in CI).
  const reused = async () => (await db.system("select count(*)::int as n from identity_audit where action = 'refresh-token.reused'"))[0].n;
  for (let i = 0; i < 50 && (await reused()) === 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(await reused(), 1);
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

test('rate limits read the caller from our own proxies, from the right; a forged x-forwarded-for dodges nothing', async () => {
  const EDGE = 'e'.repeat(40);
  const { callerIp } = await import('../identity.mjs');
  await issuer(async ({ local }) => {
    const hit = (headers) => fetch(`${local}/oauth/authorize?client_id=agent-team-web&return=/`, { redirect: 'manual', headers });
    // Straight to the host (Fly appends the real peer, 192.0.2.1): 700 forged left-hand entries are all that peer.
    let refused = 0;
    for (let i = 0; i < 700; i++) if ((await hit({ 'x-forwarded-for': `10.${i >> 8}.${i & 255}.1, 192.0.2.1` })).status === 429) refused++;
    assert.equal(refused, 680);
    // A fresh real caller still gets in: there is no shared bucket to fill.
    assert.equal((await hit({ 'x-forwarded-for': '192.0.2.2' })).status, 303);
    // Through the edge (secret present): Vercel's entry names the caller, Fly's names Vercel.
    for (let i = 0; i < 20; i++) await hit({ 'x-forwarded-for': '198.51.100.1, 76.76.21.1', 'x-agent-team-edge': EDGE });
    assert.equal((await hit({ 'x-forwarded-for': '198.51.100.1, 76.76.21.1', 'x-agent-team-edge': EDGE })).status, 429);
    assert.equal((await hit({ 'x-forwarded-for': '198.51.100.2, 76.76.21.1', 'x-agent-team-edge': EDGE })).status, 303, 'another caller behind the same edge IP');
  }, { clientIp: (req) => callerIp(req, { hops: 1, edgeSecret: EDGE }) });
  // Without the secret, the edge's entry is not believed: the caller is the peer Fly saw.
  const req = (xff, edge) => ({ headers: { 'x-forwarded-for': xff, ...(edge ? { 'x-agent-team-edge': edge } : {}) }, socket: { remoteAddress: '127.0.0.1' } });
  assert.equal(callerIp(req('6.6.6.6, 198.51.100.1, 76.76.21.1'), { hops: 1, edgeSecret: EDGE }), '76.76.21.1');
  assert.equal(callerIp(req('6.6.6.6, 198.51.100.1, 76.76.21.1', 'wrong'), { hops: 1, edgeSecret: EDGE }), '76.76.21.1');
  assert.equal(callerIp(req('6.6.6.6, 198.51.100.1, 76.76.21.1', EDGE), { hops: 1, edgeSecret: EDGE }), '198.51.100.1');
  assert.equal(callerIp(req('6.6.6.6'), {}), '127.0.0.1', 'no hops configured: the socket, whatever the header says');
});

test('the signing key rotates from the tick after 90 days, and the old one stays in the JWKS for a day', async () => {
  let t = Date.now();
  await issuer(async ({ local, identity }) => {
    const kids = async () => (await (await fetch(`${local}/oauth/jwks`)).json()).keys.map((k) => k.kid);
    const first = await kids();
    assert.equal(first.length, 2, 'a P-256 key and an RSA key');
    await identity.sweep();
    assert.deepEqual(await kids(), first, 'nothing to rotate yet');
    const before = identity.provider;
    t += 91 * 86400_000;
    await identity.sweep();
    const all = await kids();
    assert.equal(all.length, 4, 'both rotate together');
    assert.deepEqual(all.filter((k) => first.includes(k)).sort(), [...first].sort());
    // The library was rebuilt around the new key, so new ID tokens are signed with it.
    assert.notEqual(identity.provider, before);
    t += 2 * 86400_000;
    await identity.sweep();
    assert.deepEqual((await kids()).sort(), all.filter((k) => !first.includes(k)).sort());
  }, { now: () => new Date(t) });
});

test('a state from another browser, or used twice, does not finish a sign-in', () => issuer(async ({ gh, browser }) => {
  gh.as = owner;
  const victim = browser(), attacker = browser();
  const first = await attacker.go(`${ORIGIN}/oauth/authorize?client_id=agent-team-web&return=/`);
  const uid = new URL(first.at).searchParams.get('interaction');
  const toGitHub = await attacker.fetch(`${ORIGIN}/oauth/authorize/${uid}/github`);
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

test('Continue with GitHub is bound to the browser that started the sign-in (security review of L27)', () => issuer(async ({ gh, browser }) => {
  gh.as = owner;
  const victim = browser(), attacker = browser();
  const first = await victim.go(`${ORIGIN}/oauth/authorize?client_id=agent-team-web&return=/`);
  const uid = new URL(first.at).searchParams.get('interaction');
  // The attacker learns the victim's uid and tries to finish that sign-in with their own GitHub account.
  const stolen = await attacker.fetch(`${ORIGIN}/oauth/authorize/${uid}/github`);
  assert.equal(stolen.headers.get('location'), '/sign-in?error=expired');
  assert.equal((await attacker.go(`${ORIGIN}/oauth/interaction/${uid}/github`)).at, `${ORIGIN}/sign-in?error=expired`, 'the old path too');
  // The browser that started it goes on to GitHub, by the new path or the old one.
  assert.match((await victim.fetch(`${ORIGIN}/oauth/authorize/${uid}/github`)).headers.get('location'), /\/login\/oauth\/authorize\?/);
  const viaOld = await victim.fetch(`${ORIGIN}/oauth/interaction/${uid}/github`);
  assert.equal(viaOld.headers.get('location'), `/oauth/authorize/${uid}/github`);
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

// The conformance harness (conformance/op.mjs) loosens the issuer through `configure`; nothing else may (security
// review of #113). Without it: no client registration, and PKCE for every client, confidential ones too.
test('the deployment issuer: registration off, and PKCE required for every client', () => issuer(async ({ local, gh, browser }) => {
  const meta = await (await fetch(`${local}/.well-known/openid-configuration`)).json();
  assert.equal(meta.registration_endpoint, undefined);
  const reg = await fetch(`${local}/oauth/reg`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://evil.example/cb'] }) });
  assert.equal(reg.status, 404);
  gh.as = owner;
  const redirect = 'https://partner.example/cb';
  for (const client of ['agent-team-ios', 'agent-team-android', 'partner']) {
    const uri = client === 'partner' ? redirect : `${ORIGIN}/app/${client.slice(11)}/callback`;
    const q = new URLSearchParams({ response_type: 'code', client_id: client, redirect_uri: uri, scope: 'openid', state: 's', nonce: 'n' });
    const r = await browser().fetch(`${ORIGIN}/oauth/authorize?${q}`);
    const at = new URL(r.headers.get('location') ?? 'x:', ORIGIN);
    assert.equal(at.searchParams.get('error'), 'invalid_request', client);
    assert.match(at.searchParams.get('error_description') ?? '', /requires PKCE/, client);
  }
}, { clients: [
  { client_id: 'agent-team-ios', redirect_uris: [`${ORIGIN}/app/ios/callback`] },
  { client_id: 'agent-team-android', redirect_uris: [`${ORIGIN}/app/android/callback`] },
  { client_id: 'partner', client_secret: 'a-long-enough-client-secret-for-the-test', token_endpoint_auth_method: 'client_secret_basic', application_type: 'web', redirect_uris: ['https://partner.example/cb'], dpop_bound_access_tokens: false },
] }));

// RS256 is offered because OpenID Connect requires it (conformance, security review of #113); our own clients stay on
// ES256, and the RSA key is a separate key of its own.
test('the JWKS has a P-256 and an RSA-2048 key; a first-party ID token is ES256', () => issuer(async ({ local, gh, browser }) => {
  const { keys } = await (await fetch(`${local}/oauth/jwks`)).json();
  assert.deepEqual(keys.map((k) => `${k.kty}:${k.alg}:${k.use}`).sort(), ['EC:ES256:sig', 'RSA:RS256:sig']);
  assert.notEqual(keys[0].kid, keys[1].kid);
  const rsa = keys.find((k) => k.kty === 'RSA');
  assert.ok(Buffer.from(rsa.n, 'base64url').length * 8 >= 2048);
  assert.ok(keys.every((k) => !('d' in k)), 'public keys only');
  const meta = await (await fetch(`${local}/.well-known/openid-configuration`)).json();
  assert.deepEqual(meta.id_token_signing_alg_values_supported, ['ES256', 'RS256']);
  // The iPhone app signs in: its ID token is ES256, under the EC key.
  gh.as = owner;
  const redirect = `${ORIGIN}/app/ios/callback`;
  const verifier = randomBytes(32).toString('base64url');
  const b = browser({ ip: 'alg' });
  const first = await b.go(`${ORIGIN}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: 'agent-team-ios', redirect_uri: redirect, scope: 'openid', state: 's', nonce: 'n', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })}`);
  const uid = new URL(first.at).searchParams.get('interaction');
  const code = new URL((await b.go(`${ORIGIN}/oauth/authorize/${uid}/github`)).at).searchParams.get('code');
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const dpop = await new SignJWT({ htm: 'POST', htu: `${ORIGIN}/oauth/token`, jti: randomUUID() }).setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk: await exportJWK(publicKey) }).setIssuedAt().sign(privateKey);
  const tok = await (await fetch(`${local}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', dpop }, body: new URLSearchParams({ client_id: 'agent-team-ios', grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier }) })).json();
  const header = JSON.parse(Buffer.from(tok.id_token.split('.')[0], 'base64url'));
  assert.equal(header.alg, 'ES256');
  assert.equal(header.kid, keys.find((k) => k.kty === 'EC').kid);
}));

test('a deployment from before RS256 keeps its P-256 key and gains an RSA key', async () => {
  const db = await fresh();
  try {
    const [ec] = (await issuerKeys(db, key)).filter((k) => k.kty === 'EC');
    await db.system("delete from issuer_keys where kid <> $1", [ec.kid]);
    const after = await issuerKeys(db, key);
    assert.deepEqual(after.map((k) => k.kty), ['EC', 'RSA']);
    assert.equal(after[0].kid, ec.kid, 'not rotated');
    assert.deepEqual((await issuerKeys(db, key)).map((k) => k.kid), after.map((k) => k.kid), 'and stable from then on');
  } finally { await db.close(); }
});

// prompt=consent from a signed-in person's client: no page, no second trip to GitHub (every client is ours).
test('prompt=consent for a signed-in person finishes without a page or GitHub', () => issuer(async ({ gh, browser }) => {
  gh.as = owner;
  const b = browser({ ip: 'consent' });
  const redirect = `${ORIGIN}/app/ios/callback`;
  const ask = (extra) => {
    const verifier = randomBytes(32).toString('base64url');
    return `${ORIGIN}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: 'agent-team-ios', redirect_uri: redirect, scope: 'openid offline_access', state: 's', nonce: 'n', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', ...extra })}`;
  };
  const first = await b.go(ask({}));
  const uid = new URL(first.at).searchParams.get('interaction');
  assert.ok(new URL((await b.go(`${ORIGIN}/oauth/authorize/${uid}/github`)).at).searchParams.get('code'));
  const signIns = gh.issued.length;

  // The consent step, taken one redirect at a time: another browser presenting the same uid is refused.
  const start = await b.fetch(ask({ prompt: 'consent' }));
  const step = start.headers.get('location');
  const cuid = /\/oauth\/interaction\/([^/]+)\/consent$/.exec(new URL(step, ORIGIN).pathname)?.[1];
  assert.ok(cuid, step);
  const stranger = await browser({ ip: 'other' }).fetch(`${ORIGIN}/oauth/interaction/${cuid}/consent`);
  assert.match(stranger.headers.get('location') ?? '', /sign-in\?error=expired/);
  // A uid other than the cookie's, in the right browser, is refused too.
  const wrong = await b.fetch(`${ORIGIN}/oauth/interaction/${cuid.slice(1)}x/consent`);
  assert.match(wrong.headers.get('location') ?? '', /sign-in\?error=expired/);

  const again = await b.go(`${ORIGIN}/oauth/interaction/${cuid}/consent`);
  assert.ok(again.at?.startsWith(redirect), again.at);
  assert.ok(new URL(again.at).searchParams.get('code'));
  assert.equal(gh.issued.length, signIns, 'no second GitHub sign-in');
}));
