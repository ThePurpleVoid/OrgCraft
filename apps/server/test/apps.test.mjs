// The apps on /v1 (docs/specs/m4-sign-in.md section 2, S3): a device-bound access token with a DPoP proof per
// request (RFC 9449), and everything that must be refused: no proof, another key, method, URL or token, a replay,
// a stale proof, the plain Bearer scheme, and a token whose person left.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { SignJWT, exportJWK } from 'jose';
import { ORIGIN, issuer, owner } from './sign-in-helpers.mjs';

const dana = { id: '2002', login: 'dana', name: 'Dana' };
const ath = (t) => createHash('sha256').update(t).digest('base64url');

async function device() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { privateKey, jwk: await exportJWK(publicKey) };
}
function proof(d, htm, htu, claims = {}, iat) {
  const j = new SignJWT({ htm, htu, jti: randomUUID(), ...claims }).setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk: d.jwk });
  return (iat ? j.setIssuedAt(iat) : j.setIssuedAt()).sign(d.privateKey);
}

/** Signs `user` in from the iPhone app and returns { phone, token, call }. */
async function app(gh, browser, local, user) {
  gh.as = user;
  const redirect = `${ORIGIN}/app/ios/callback`;
  const verifier = randomBytes(32).toString('base64url');
  const b = browser({ ip: `app-${user.login}` });
  const first = await b.go(`${ORIGIN}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: 'agent-team-ios', redirect_uri: redirect, scope: 'openid profile', state: 's', nonce: 'n', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })}`);
  const uid = new URL(first.at).searchParams.get('interaction');
  const code = new URL((await b.go(`${ORIGIN}/oauth/interaction/${uid}/github`)).at).searchParams.get('code');
  const phone = await device();
  const res = await fetch(`${local}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-ip': 'phone', dpop: await proof(phone, 'POST', `${ORIGIN}/oauth/token`) },
    body: new URLSearchParams({ client_id: 'agent-team-ios', grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier }) });
  const { access_token: token } = await res.json();
  assert.ok(token);
  /** A /v1 call as the app; `p` overrides the proof (null: none), `scheme` the Authorization scheme. */
  const call = async (method, path, body, { p, scheme = 'DPoP', headers = {} } = {}) => {
    const dp = p === undefined ? await proof(phone, method, `${ORIGIN}/v1${path}`, { ath: ath(token) }) : p;
    const r = await fetch(`${local}/v1${path}`, { method, headers: { authorization: `${scheme} ${token}`, ...(dp ? { dpop: dp } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { phone, token, call };
}

test('an app calls /v1 with its device-bound token and a fresh DPoP proof each time', () => issuer(async ({ gh, browser, local }) => {
  const { call } = await app(gh, browser, local, owner);
  const me = await call('GET', '/me');
  assert.equal(me.status, 200, JSON.stringify(me.body));
  assert.equal(me.body.login, 'octo');
  assert.equal(me.body.workspaces[0].role, 'owner');
  assert.equal((await call('POST', '/teams', { id: 'web' })).status, 201, 'no Origin needed: a bearer credential is not ambient');
  assert.equal((await call('GET', '/teams')).body.teams.length, 1);
}));

test('refused: no proof, the Bearer scheme, another key, method, URL or token, a replay, and a stale proof', () => issuer(async ({ gh, browser, local }) => {
  const { token, call } = await app(gh, browser, local, owner);
  const other = await device();
  const url = `${ORIGIN}/v1/me`;
  const cases = {
    'no proof': { p: null },
    'Bearer scheme': { scheme: 'Bearer' },
    'another key': { p: await proof(other, 'GET', url, { ath: ath(token) }) },
    'another method': { p: await proof((await app(gh, browser, local, owner)).phone, 'POST', url, { ath: ath(token) }) },
    'another URL': { p: null },
    'no ath': { p: null },
    'a stale proof': { p: null },
  };
  // Proofs signed by the right key but wrong in one way each.
  const { phone, token: t2, call: c2 } = await app(gh, browser, local, owner);
  cases['another method'] = { p: await proof(phone, 'POST', url, { ath: ath(t2) }) };
  cases['another URL'] = { p: await proof(phone, 'GET', `${ORIGIN}/v1/teams`, { ath: ath(t2) }) };
  cases['another token'] = { p: await proof(phone, 'GET', url, { ath: ath(token) }) };
  cases['no ath'] = { p: await proof(phone, 'GET', url) };
  cases['a stale proof'] = { p: await proof(phone, 'GET', url, { ath: ath(t2) }, Math.floor(Date.now() / 1000) - 600) };
  const why = { 'no proof': /proof is required/, 'Bearer scheme': /sign in|Bearer/, 'another key': /another key/, 'another method': /another method/, 'another URL': /another URL/,
    'another token': /another token/, 'no ath': /another token/, 'a stale proof': /not fresh/ };
  for (const [what, opts] of Object.entries(cases)) {
    const via = ['no proof', 'Bearer scheme', 'another key'].includes(what) ? call : c2;
    const res = await via('GET', '/me', undefined, opts);
    assert.equal(res.status, 401, what);
    assert.match(res.body.error, why[what], what);
  }
  // A good proof works once.
  const once = await proof(phone, 'GET', url, { ath: ath(t2) });
  assert.equal((await c2('GET', '/me', undefined, { p: once })).status, 200);
  const replay = await c2('GET', '/me', undefined, { p: once });
  assert.equal(replay.status, 401);
  assert.match(replay.body.error, /used already/);
}));

test('roles apply to apps, passkeys are added on the web, and a removed member\'s app is refused at once', () => issuer(async ({ gh, browser, local }) => {
  gh.directory.push(dana);
  const boss = await app(gh, browser, local, owner);
  assert.equal((await boss.call('POST', '/teams', { id: 'web' })).status, 201);
  // The owner invites Dana from the web (step-up needs a passkey, added in the browser).
  gh.as = owner;
  const web = browser();
  await web.signIn();
  const { authenticator } = await import('./authenticator.mjs');
  const key = authenticator({ origin: ORIGIN, rpId: 'studio.example' });
  assert.equal((await web.call('POST', '/me/passkeys', { name: 'laptop', credential: key.create((await web.call('GET', '/me/passkeys/options')).body) })).status, 201);
  const su = async () => (await web.call('POST', '/auth/step-up', { webauthn: key.get((await web.call('GET', '/auth/step-up/challenge')).body) })).body.token;
  assert.equal((await web.call('POST', '/invitations', { github: 'dana', role: 'viewer' }, { 'x-step-up': await su() })).status, 201);

  const phone = await app(gh, browser, local, dana);
  assert.equal((await phone.call('GET', '/teams')).status, 200);
  assert.equal((await phone.call('POST', '/teams', { id: 'other' })).status, 403, 'a viewer, whatever the client');
  assert.equal((await phone.call('GET', '/me/passkeys/options')).status, 403, 'passkeys are added in the Studio');
  // An app may step up with a passkey it can assert (here: none yet, so 409).
  assert.equal((await phone.call('GET', '/auth/step-up/challenge')).status, 409);

  const id = (await web.call('GET', '/members')).body.members.find((m) => m.login === 'dana').id;
  assert.equal((await web.call('DELETE', `/members/${id}`, {}, { 'x-step-up': await su() })).status, 200);
  const after = await phone.call('GET', '/me');
  assert.equal(after.status, 401, 'signed out everywhere: the app token is revoked');
}));
