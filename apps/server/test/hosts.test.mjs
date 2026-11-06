// One Studio inside your own app, step 2 (docs/specs/studio-embed.md section 6, S4 and S8): a host registered as a
// confidential OIDC client, its DPoP-bound tokens on /v1, what a host may never do, and stream tickets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { SignJWT, exportJWK } from 'jose';
import { ORIGIN, issuer, owner } from './sign-in-helpers.mjs';
import { authenticator } from './authenticator.mjs';
import { checkHost } from '../hosts.mjs';

const RP = 'studio.example';
const SHOP = 'https://shop.example';
const CALLBACK = `${SHOP}/admin/agent-team/callback`;
const ath = (t) => createHash('sha256').update(t).digest('base64url');

async function dpopKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { privateKey, jwk: await exportJWK(publicKey) };
}
const proof = (k, htm, htu, claims = {}) => new SignJWT({ htm, htu, jti: randomUUID(), ...claims }).setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk: k.jwk }).setIssuedAt().sign(k.privateKey);

/** The owner signed in on the web with a passkey; `su()` steps up once. */
async function ownerWithPasskey(gh, browser) {
  gh.as = owner;
  const b = browser();
  await b.signIn();
  const key = authenticator({ origin: ORIGIN, rpId: RP });
  const options = (await b.call('GET', '/me/passkeys/options')).body;
  assert.equal((await b.call('POST', '/me/passkeys', { name: 'laptop', credential: key.create(options) })).status, 201);
  const su = async () => {
    const o = (await b.call('GET', '/auth/step-up/challenge')).body;
    return (await b.call('POST', '/auth/step-up', { webauthn: key.get(o) })).body.token;
  };
  return { b, su };
}

/** The host's server signs its user in (authorization code, PKCE, client_secret_basic, DPoP) and calls /v1. */
/** The browser leg up to the host's callback: GitHub sign-in, then the consent page (`decision`: allow, deny, or null to stop there). */
async function hostAuthorize(b, host, { decision = 'allow', prompt, challenge } = {}) {
  let res = await b.fetch(`${ORIGIN}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: host.clientId, redirect_uri: CALLBACK, scope: 'openid profile', state: 's', nonce: 'n', code_challenge: challenge, code_challenge_method: 'S256', ...(prompt ? { prompt } : {}) })}`);
  const seen = { consent: null };
  for (let i = 0; i < 15 && [302, 303].includes(res.status); i++) {
    const loc = res.headers.get('location');
    const abs = loc.startsWith('/') ? ORIGIN + loc : loc;
    if (abs.startsWith(CALLBACK)) return { callback: new URL(abs), ...seen };
    if (abs.startsWith(`${ORIGIN}/sign-in?interaction=`)) res = await b.fetch(`${ORIGIN}/oauth/interaction/${new URL(abs).searchParams.get('interaction')}/github`);
    else if (/\/oauth\/interaction\/[^/]+\/consent$/.test(abs)) {
      const page = await b.fetch(abs);
      seen.consent = { status: page.status, html: await page.text(), url: abs };
      if (!decision) return seen;
      res = await b.fetch(abs, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: `decision=${decision}` });
    } else res = await b.fetch(abs);
  }
  return { callback: null, ...seen, last: res };
}

async function hostSignIn({ local, browser }, host, { secret = host.clientSecret, b = browser({ ip: 'host-user' }) } = {}) {
  const verifier = randomBytes(32).toString('base64url');
  const got = await hostAuthorize(b, host, { challenge: createHash('sha256').update(verifier).digest('base64url') });
  const code = got.callback?.searchParams.get('code');
  assert.ok(code, 'the host gets a code on its own callback');
  const k = await dpopKey();
  const basic = Buffer.from(`${encodeURIComponent(host.clientId)}:${encodeURIComponent(secret)}`).toString('base64');
  const tok = await fetch(`${local}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${basic}`, 'x-test-ip': 'host', dpop: await proof(k, 'POST', `${ORIGIN}/oauth/token`) },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: CALLBACK, code_verifier: verifier }) });
  const body = await tok.json();
  if (tok.status !== 200) return { status: tok.status, body };
  const token = body.access_token;
  const call = async (method, path, data, headers = {}) => {
    const r = await fetch(`${local}/v1${path}`, { method, headers: { authorization: `DPoP ${token}`, dpop: await proof(k, method, `${ORIGIN}/v1${path}`, { ath: ath(token) }), ...(data === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { status: 200, token, refresh: body.refresh_token, call };
}

const HOST = { name: 'Admin at shop.example', origins: [SHOP], redirectUris: [CALLBACK] };

test('checkHost: https origins only, redirect URIs on those origins, no fragments, no userinfo', () => {
  assert.deepEqual(checkHost(HOST), HOST);
  const bad = (b) => assert.throws(() => checkHost({ ...HOST, ...b }), JSON.stringify(b));
  bad({ origins: ['http://shop.example'] });
  bad({ origins: ['https://shop.example/admin'] });
  bad({ origins: [] });
  bad({ redirectUris: ['https://evil.example/cb'] });
  bad({ redirectUris: [`${CALLBACK}#x`] });
  bad({ redirectUris: ['https://u:p@shop.example/cb'] });
  bad({ name: '' });
  assert.throws(() => checkHost({ ...HOST, origins: [ORIGIN], redirectUris: [`${ORIGIN}/cb`] }, { self: ORIGIN }), /own origin/);
  assert.equal(checkHost({ ...HOST, name: 'a\nPublished-by: x' }).name, 'a Published-by: x', 'control characters are stripped');
});

test('a host registers with step-up, signs its user in as a confidential client, and calls /v1 with DPoP', () => issuer(async (p) => {
  const { db, gh, browser } = p;
  const { b, su } = await ownerWithPasskey(gh, browser);
  assert.equal((await b.call('POST', '/hosts', HOST)).status, 401, 'registering a host needs step-up');
  const reg = await b.call('POST', '/hosts', HOST, { 'x-step-up': await su() });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const host = reg.body;
  assert.match(host.clientId, /^host_/);
  assert.match(host.clientSecret, /^hs_/);
  const listed = (await b.call('GET', '/hosts')).body.hosts;
  assert.deepEqual(listed.map((h) => [h.id, h.name, h.clientSecret]), [[host.id, HOST.name, undefined]], 'the secret is shown once');
  const [row] = await db.system('select secret_sealed from host_clients where id = $1', [host.id]);
  assert.ok(!row.secret_sealed.includes(host.clientSecret), 'kept sealed');

  assert.equal((await hostSignIn(p, host, { secret: 'hs_wrong' })).status, 401, 'a wrong secret gets no token');
  const h = await hostSignIn(p, host);
  assert.equal(h.status, 200, JSON.stringify(h.body));
  assert.ok(h.refresh, 'a refresh token, for the host to keep server-side');
  const me = await h.call('GET', '/me');
  assert.deepEqual([me.status, me.body.login], [200, 'octo']);
  assert.equal((await h.call('POST', '/teams', { id: 'shop' })).status, 403, 'making a team is the deployment\'s, not a host\'s');
  assert.equal((await b.call('POST', '/teams', { id: 'shop' })).status, 201);
  assert.equal((await h.call('GET', '/teams/shop')).status, 200, 'the Studio\'s own routes work through the host');

  // Never through a host: step-up, passkeys, the host registry, and anything that carries a step-up token.
  for (const [m, path, body, hd] of [['GET', '/auth/step-up/challenge'], ['GET', '/me/passkeys'], ['GET', '/hosts'], ['POST', '/hosts', HOST], ['PUT', '/teams/shop/budget', { perDay: 100 }, { 'x-step-up': 'su_x' }]]) {
    const r = await h.call(m, path, body, hd);
    assert.equal(r.status, 403, `${m} ${path}: ${JSON.stringify(r.body)}`);
  }

  // Revoking the host ends its tokens at once.
  assert.equal((await b.call('DELETE', `/hosts/${host.id}`, {})).status, 200);
  assert.equal((await h.call('GET', '/me')).status, 401, 'revoked: the access token is dead');
  await assert.rejects(hostSignIn(p, host), /code/, 'and it cannot sign anyone in again');
}));

test('stream tickets: single use, 60 seconds, one team, the minting host\'s origins only, no credentials, ends on removal', () => issuer(async (p) => {
  const { db, gh, browser, local } = p;
  const { b, su } = await ownerWithPasskey(gh, browser);
  const host = (await b.call('POST', '/hosts', HOST, { 'x-step-up': await su() })).body;
  const h = await hostSignIn(p, host);
  assert.equal((await b.call('POST', '/teams', { id: 'shop' })).status, 201);
  assert.equal((await b.call('POST', '/teams', { id: 'other' })).status, 201);

  const mint = await h.call('POST', '/teams/shop/stream-tickets');
  assert.equal(mint.status, 201, JSON.stringify(mint.body));
  assert.match(mint.body.ticket, /^stk_/);
  assert.equal(mint.body.expiresIn, 60);
  assert.equal(mint.body.url, `${ORIGIN}/v1/teams/shop/events/stream?ticket=${mint.body.ticket}`);
  const [t] = await db.system('select hash, client from stream_tickets');
  assert.ok(!t.hash.includes(mint.body.ticket.slice(4)), 'only a hash is kept');
  assert.equal(t.client, host.id);

  const open = (ticket, team = 'shop', origin = SHOP) => {
    const ac = new AbortController();
    return fetch(`${local}/v1/teams/${team}/events/stream?ticket=${ticket}`, { headers: origin ? { origin } : {}, signal: ac.signal }).then((r) => ({ r, close: () => ac.abort() }));
  };
  // Another origin is refused before the ticket is spent; then the host's own origin opens it.
  assert.equal((await open(mint.body.ticket, 'shop', 'https://evil.example')).r.status, 403);
  const s = await open(mint.body.ticket);
  assert.equal(s.r.status, 200);
  assert.equal(s.r.headers.get('access-control-allow-origin'), SHOP);
  assert.equal(s.r.headers.get('access-control-allow-credentials'), null, 'the ticket is the only credential');
  assert.match(s.r.headers.get('content-type'), /text\/event-stream/);
  s.close();
  assert.equal((await open(mint.body.ticket)).r.status, 401, 'single use');

  const other = (await h.call('POST', '/teams/shop/stream-tickets')).body.ticket;
  assert.equal((await open(other, 'other')).r.status, 403, 'one team only');
  const late = (await h.call('POST', '/teams/shop/stream-tickets')).body.ticket;
  await db.system("update stream_tickets set expires_at = now() - interval '1 second'");
  assert.equal((await open(late)).r.status, 401, 'expired after 60 seconds');
  assert.equal((await fetch(`${local}/v1/teams/shop/events/stream?ticket=nope`)).status, 401);

  // A web user's own ticket (no host) streams without CORS, and refuses any cross-origin page.
  const mine = (await b.call('POST', '/teams/shop/stream-tickets', {})).body.ticket;
  assert.equal((await open(mine, 'shop', SHOP)).r.status, 403, 'a ticket not minted by a host answers no other origin');
  const mine2 = (await b.call('POST', '/teams/shop/stream-tickets', {})).body.ticket;
  const direct = await open(mine2, 'shop', null);
  assert.equal(direct.r.status, 200);
  assert.equal(direct.r.headers.get('access-control-allow-origin'), null);
  direct.close();

  // Revoking the host ends a stream it opened (checked with each beat).
  const live = await open((await h.call('POST', '/teams/shop/stream-tickets')).body.ticket);
  assert.equal(live.r.status, 200);
  assert.equal((await b.call('DELETE', `/hosts/${host.id}`, {})).status, 200);
  const reader = live.r.body.getReader();
  const ended = await Promise.race([(async () => { for (;;) { const { done } = await reader.read(); if (done) return true; } })(), new Promise((r) => setTimeout(() => r(false), 3000))]);
  assert.equal(ended, true, 'the stream ends once the host is revoked');
}, { streamCheckMs: 100 }));

test('H1: a host may use only the allowlisted routes; every other route in roles.mjs is refused for it', () => issuer(async (p) => {
  const { gh, browser } = p;
  const { ROUTES, HOST_ROUTES } = await import('../roles.mjs');
  const { b, su } = await ownerWithPasskey(gh, browser);
  const host = (await b.call('POST', '/hosts', HOST, { 'x-step-up': await su() })).body;
  const h = await hostSignIn(p, host);
  for (const [method, path] of ROUTES) {
    if (HOST_ROUTES.has(`${method} ${path}`)) continue;
    const concrete = path.replace(/\{[^}]+\}/g, 'x');
    const r = await h.call(method, concrete, ['GET', 'DELETE'].includes(method) ? undefined : {});
    assert.equal(r.status, 403, `${method} ${path}: ${r.status} ${JSON.stringify(r.body)}`);
  }
  // And allowlisted ones work: a team the owner made, its chat.
  assert.equal((await b.call('POST', '/teams', { id: 'shop' })).status, 201);
  assert.equal((await h.call('GET', '/teams/shop/chat')).status, 200);
}));

test('H2: a host gets a real consent page; prompt=none before it, deny, and unlinking all refuse', () => issuer(async (p) => {
  const { gh, browser } = p;
  const { b, su } = await ownerWithPasskey(gh, browser);
  const host = (await b.call('POST', '/hosts', HOST, { 'x-step-up': await su() })).body;
  const challenge = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');

  // Signing in for the host stops at a consent page: no silent grant for a first-party-looking client.
  const page = await hostAuthorize(b, host, { decision: null, challenge });
  assert.equal(page.consent.status, 200);
  assert.match(page.consent.html, /Allow Admin at shop\.example to use Agent Team for you\?/);
  assert.match(page.consent.html, /https:\/\/shop\.example/);
  assert.match(page.consent.html, /cannot approve anything/);
  assert.match(page.consent.html, /open pull requests that change your team/, 'consent v2 says the host can publish (security C2)');
  // Signed in now, but not linked: prompt=none is refused.
  const none = await hostAuthorize(b, host, { prompt: 'none', challenge });
  assert.equal(none.callback?.searchParams.get('error'), 'consent_required', JSON.stringify(none));
  // A POST from another origin is refused; so is one without the form type.
  const evil = await b.fetch(page.consent.url, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, body: 'decision=allow' });
  assert.match(evil.headers.get('location') ?? '', /sign-in\?error=expired/);
  const denied = await hostAuthorize(b, host, { decision: 'deny', challenge });
  assert.equal(denied.callback?.searchParams.get('error'), 'access_denied');
  assert.deepEqual((await b.call('GET', '/me/hosts')).body.hosts, []);

  // Allow once: linked, listed, and the next sign-in is silent.
  const h = await hostSignIn(p, host, { b });
  assert.equal((await h.call('GET', '/me')).status, 200);
  const links = (await b.call('GET', '/me/hosts')).body.hosts;
  assert.deepEqual(links.map((l) => [l.id, l.name]), [[host.id, HOST.name]]);
  const again = await hostAuthorize(b, host, { prompt: 'none', challenge });
  assert.ok(again.callback?.searchParams.get('code'), 'linked: prompt=none now works');
  // A link agreed to the older consent text (before publishing): the host keeps its token for reads, but asks again.
  await p.db.system('update host_links set consent_version = 1 where host = $1', [host.id]);
  assert.equal((await h.call('GET', '/me')).status, 200, 'reads keep working');
  assert.equal(await p.identity.hosts.linked(host.id, (await p.db.system('select person from host_links where host = $1', [host.id]))[0].person), false, 'publishing waits for the new consent');
  const stale = await hostAuthorize(b, host, { prompt: 'none', challenge });
  assert.equal(stale.callback?.searchParams.get('error'), 'consent_required', 'an older consent shows the page again');
  const re = await hostAuthorize(b, host, { decision: 'allow', challenge });
  assert.ok(re.callback?.searchParams.get('code'));
  assert.equal((await p.db.system('select consent_version from host_links where host = $1', [host.id]))[0].consent_version, 2);

  // Unlink: the host's tokens for this person stop at once, and it must ask again.
  assert.equal((await b.call('DELETE', `/me/hosts/${host.id}`, {})).status, 200);
  assert.equal((await h.call('GET', '/me')).status, 401);
  const after = await hostAuthorize(b, host, { prompt: 'none', challenge });
  assert.equal(after.callback?.searchParams.get('error'), 'consent_required');
}));
