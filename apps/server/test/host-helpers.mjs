// A host's server signing its user in to a deployment (docs/specs/studio-embed.md section 6), for the tests that need
// one: the owner with a passkey, the host registered, and the authorization-code flow with DPoP.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { SignJWT, exportJWK } from 'jose';
import { ORIGIN, owner } from './sign-in-helpers.mjs';
import { authenticator } from './authenticator.mjs';

export const RP = 'studio.example';
export const SHOP = 'https://shop.example';
export const CALLBACK = `${SHOP}/admin/agent-team/callback`;
export const ath = (t) => createHash('sha256').update(t).digest('base64url');

export async function dpopKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { privateKey, jwk: await exportJWK(publicKey) };
}
export const proof = (k, htm, htu, claims = {}) => new SignJWT({ htm, htu, jti: randomUUID(), ...claims }).setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk: k.jwk }).setIssuedAt().sign(k.privateKey);

/** The owner signed in on the web with a passkey; `su()` steps up once. */
export async function ownerWithPasskey(gh, browser) {
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
export async function hostAuthorize(b, host, { decision = 'allow', prompt, challenge } = {}) {
  let res = await b.fetch(`${ORIGIN}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: host.clientId, redirect_uri: CALLBACK, scope: 'openid profile', state: 's', nonce: 'n', code_challenge: challenge, code_challenge_method: 'S256', ...(prompt ? { prompt } : {}) })}`);
  const seen = { consent: null };
  for (let i = 0; i < 15 && [302, 303].includes(res.status); i++) {
    const loc = res.headers.get('location');
    const abs = loc.startsWith('/') ? ORIGIN + loc : loc;
    if (abs.startsWith(CALLBACK)) return { callback: new URL(abs), ...seen };
    if (abs.startsWith(`${ORIGIN}/sign-in?interaction=`)) res = await b.fetch(`${ORIGIN}/oauth/authorize/${new URL(abs).searchParams.get('interaction')}/github`);
    else if (/\/oauth\/interaction\/[^/]+\/consent$/.test(abs)) {
      const page = await b.fetch(abs);
      seen.consent = { status: page.status, html: await page.text(), url: abs };
      if (!decision) return seen;
      res = await b.fetch(abs, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: `decision=${decision}` });
    } else res = await b.fetch(abs);
  }
  return { callback: null, ...seen, last: res };
}

export async function hostSignIn({ local, browser }, host, { secret = host.clientSecret, b = browser({ ip: 'host-user' }) } = {}) {
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
  return { status: 200, token, refresh: body.refresh_token, call, key: k.privateKey };
}

export const HOST = { name: 'Admin at shop.example', origins: [SHOP], redirectUris: [CALLBACK] };
