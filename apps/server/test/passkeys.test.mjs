// Passkeys and step-up for signed-in people (docs/specs/m4-sign-in.md section 3, section 4a S5 to S7), with a
// software authenticator: registration, step-up as a single-use su_ token, and everything that must be refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, STEP_UP_SECRET } from './helpers.mjs';
import { ORIGIN, issuer, owner } from './sign-in-helpers.mjs';
import { authenticator } from './authenticator.mjs';

const RP = 'studio.example';

/** Signs in as the owner and adds a first passkey; returns the browser, the authenticator and the passkey. */
async function withPasskey(gh, browser, name = 'Octo\'s laptop') {
  gh.as = owner;
  const b = browser();
  await b.signIn();
  const key = authenticator({ origin: ORIGIN, rpId: RP });
  const options = (await b.call('GET', '/me/passkeys/options')).body;
  const added = await b.call('POST', '/me/passkeys', { name, credential: key.create(options) });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  return { b, key, passkey: added.body };
}

/** A fresh su_ token from a passkey assertion. */
async function stepUp(b, key, knobs) {
  const options = (await b.call('GET', '/auth/step-up/challenge')).body;
  return b.call('POST', '/auth/step-up', { webauthn: key.get(options, knobs) });
}

test('registration: options require user verification, the first passkey right after sign-in, audited in every workspace', () => issuer(async ({ db, gh, browser }) => {
  gh.as = owner;
  const b = browser();
  await b.signIn();
  const options = (await b.call('GET', '/me/passkeys/options')).body;
  assert.equal(options.rp.id, RP);
  assert.equal(options.authenticatorSelection.userVerification, 'required');
  assert.equal(options.attestation, 'none');
  const key = authenticator({ origin: ORIGIN, rpId: RP });
  const added = await b.call('POST', '/me/passkeys', { name: 'Octo\'s laptop', credential: key.create(options) });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.match(added.body.id, /^pk_/);
  assert.equal((await b.call('GET', '/me')).body.passkeys, 1);
  const list = (await b.call('GET', '/me/passkeys')).body.passkeys;
  assert.deepEqual(list.map((p) => p.name), ['Octo\'s laptop']);
  // S5: audited for the person, and in the workspace's own audit log.
  assert.equal((await db.system("select count(*)::int as n from identity_audit where action = 'passkey.added'"))[0].n, 1);
  assert.equal((await db.system("select count(*)::int as n from audit where action = 'passkey.added' and tenant = 'acme'"))[0].n, 1);
  // The same options cannot be used twice.
  const again = await b.call('POST', '/me/passkeys', { name: 'again', credential: authenticator({ origin: ORIGIN, rpId: RP }).create(options) });
  assert.equal(again.status, 401, 'a second passkey needs step-up first');
}));

test('a passkey without user verification, from another origin or for another rpId is refused', () => issuer(async ({ gh, browser }) => {
  gh.as = owner;
  const b = browser();
  await b.signIn();
  for (const knobs of [{ uv: false }, { from: 'https://evil.example' }, { rp: 'evil.example' }]) {
    const options = (await b.call('GET', '/me/passkeys/options')).body;
    const res = await b.call('POST', '/me/passkeys', { name: 'bad', credential: authenticator({ origin: ORIGIN, rpId: RP }).create(options, knobs) });
    assert.equal(res.status, 400, JSON.stringify(knobs));
    assert.equal(res.body.type, 'webauthn-failed');
  }
  assert.equal((await b.call('GET', '/me')).body.passkeys, 0);
}));

test('the first passkey needs a sign-in under 5 minutes old; later ones and removing one need step-up', async () => {
  let t = Date.now();
  await issuer(async ({ gh, browser }) => {
    const { b, key, passkey } = await withPasskey(gh, browser);
    const second = authenticator({ origin: ORIGIN, rpId: RP });
    const opts2 = (await b.call('GET', '/me/passkeys/options')).body;
    assert.equal(opts2.excludeCredentials.length, 1, 'the existing passkey is excluded');
    assert.equal((await b.call('POST', '/me/passkeys', { name: 'phone', credential: second.create(opts2) })).status, 401);
    const su = (await stepUp(b, key)).body.token;
    const opts3 = (await b.call('GET', '/me/passkeys/options')).body;
    assert.equal((await b.call('POST', '/me/passkeys', { name: 'phone', credential: second.create(opts3) }, { 'x-step-up': su })).status, 201);

    // Removing one: step-up, then it is gone.
    const del = await b.call('DELETE', `/me/passkeys/${passkey.id}`, {});
    assert.equal(del.status, 401);
    assert.equal(del.body.type, 'step-up-required');
    const su2 = (await stepUp(b, second)).body.token;
    assert.equal((await b.call('DELETE', `/me/passkeys/${passkey.id}`, {}, { 'x-step-up': su2 })).status, 200);
    assert.deepEqual((await b.call('GET', '/me/passkeys')).body.passkeys.map((p) => p.name), ['phone']);

    // A sign-in more than 5 minutes old cannot add a first passkey.
    gh.as = owner;
    const late = browser();
    await late.signIn();
    t += 6 * 60_000;
    const options = (await late.call('GET', '/me/passkeys/options')).body;
    const res = await late.call('POST', '/me/passkeys', { name: 'late', credential: authenticator({ origin: ORIGIN, rpId: RP }).create(options) });
    assert.equal(res.status, 401, JSON.stringify(res.body));
    assert.equal(res.body.type, 'step-up-required');

  }, { now: () => new Date(t) });
});

test('an approval with a passkey assertion passes, and one without step-up gets 401 step-up-required', () => issuer(async ({ gh, browser, server }) => {
  const { b, key } = await withPasskey(gh, browser);
  assert.equal((await b.call('POST', '/teams', { id: 'web' })).status, 201);
  const ask = () => server.m3.tx('acme', (ctx) => server.m3.requestApproval(ctx, 'web', { action: 'deploy', call: { cmd: 'deploy web' }, why: 'Release day.', role: 'release-manager', risk: 'low' }));
  const { result: a1 } = await ask();
  const bare = await b.call('POST', `/approvals/${a1.approval}`, { decision: 'approved' });
  assert.equal(bare.status, 401);
  assert.equal(bare.body.type, 'step-up-required');
  const su = await stepUp(b, key);
  assert.equal(su.status, 201, JSON.stringify(su.body));
  assert.match(su.body.token, /^su_/);
  const ok = await b.call('POST', `/approvals/${a1.approval}`, { decision: 'approved' }, { 'x-step-up': su.body.token });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  // Single use.
  const { result: a2 } = await ask();
  assert.equal((await b.call('POST', `/approvals/${a2.approval}`, { decision: 'approved' }, { 'x-step-up': su.body.token })).status, 401);
}));

test('step-up: a fresh sign-in alone is not step-up, the typed secret is refused on a hosted deployment, and assertions are checked', () => issuer(async ({ gh, browser }) => {
  const { b, key } = await withPasskey(gh, browser);
  // A brand-new sign-in, with a passkey: still no su_ without an assertion.
  assert.equal((await b.call('POST', '/runners/codes', {})).status, 401);
  // The secret: refused for the person, whatever it is. The admin token is retired once someone owns the deployment.
  const typed = await b.call('POST', '/auth/step-up', { secret: STEP_UP_SECRET });
  assert.equal(typed.status, 400);
  assert.equal(typed.body.type, 'step-up-method');
  const admin = await b.call('POST', '/auth/step-up', { secret: STEP_UP_SECRET }, { authorization: `Bearer ${ADMIN}`, origin: undefined });
  assert.equal(admin.status, 401);
  assert.equal(admin.body.type, 'admin-token-retired');
  // No user verification; another origin; a replayed challenge.
  assert.equal((await stepUp(b, key, { uv: false })).status, 401);
  assert.equal((await stepUp(b, key, { from: 'https://evil.example' })).status, 401);
  const options = (await b.call('GET', '/auth/step-up/challenge')).body;
  assert.deepEqual(options.allowCredentials.map((c) => c.id), [key.id]);
  assert.equal(options.userVerification, 'required');
  assert.equal((await b.call('POST', '/auth/step-up', { webauthn: key.get(options) })).status, 201);
  const replay = await b.call('POST', '/auth/step-up', { webauthn: key.get(options) });
  assert.equal(replay.status, 401);
  assert.match(replay.body.error, /unknown, used or expired/);
  // Another person's passkey does not step up this one.
  const stranger = authenticator({ origin: ORIGIN, rpId: RP });
  assert.equal((await b.call('POST', '/auth/step-up', { webauthn: stranger.get((await b.call('GET', '/auth/step-up/challenge')).body) })).status, 401);
}));

test('five failed step-ups in 15 minutes lock the person out', () => issuer(async ({ db, gh, browser }) => {
  const { b, key } = await withPasskey(gh, browser);
  for (let i = 0; i < 5; i++) assert.equal((await stepUp(b, key, { uv: false })).status, 401, `try ${i + 1}`);
  assert.equal((await stepUp(b, key)).status, 429, 'even the right passkey waits out the lockout');
  assert.equal((await db.system("select count(*)::int as n from identity_audit where action = 'step-up.locked'"))[0].n, 1);
}));

test('a sign count that does not increase is flagged, not refused (S6)', () => issuer(async ({ db, gh, browser }) => {
  const { b, key } = await withPasskey(gh, browser);
  assert.equal((await stepUp(b, key)).status, 201);
  assert.equal((await stepUp(b, key, { bump: false })).status, 201);
  assert.equal((await db.system("select count(*)::int as n from identity_audit where action = 'passkey.sign-count-flagged'"))[0].n, 1);
}));

test('a step-up token is bound to its person and tenant: refused for the admin token and in another tenant (S7)', () => issuer(async ({ gh, browser, local, server }) => {
  const { b, key } = await withPasskey(gh, browser);
  const { token } = (await stepUp(b, key)).body;
  const asAdmin = await fetch(`${local}/v1/runners/codes`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'x-step-up': token, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(asAdmin.status, 401);
  const me = (await b.call('GET', '/me')).body.id;
  await assert.rejects(server.m3.requireStepUp('beta', me, token, 'test'), /step-up/);
  // Still good where it was minted: the refused tries did not use it up.
  assert.equal((await b.call('POST', '/runners/codes', {}, { 'x-step-up': token })).status, 201);
}));

test('passkeys belong to a signed-in person: the admin token cannot use them', () => issuer(async ({ local }) => {
  for (const [method, path] of [['GET', '/me/passkeys'], ['GET', '/me/passkeys/options'], ['GET', '/auth/step-up/challenge']]) {
    const res = await fetch(`${local}/v1${path}`, { method, headers: { authorization: `Bearer ${ADMIN}` } });
    assert.equal(res.status, 400, path);
  }
}));

test('the deploy smoke check: GET /v1/internal/caller names the caller and whether the edge sent it, behind CRON_SECRET', async () => {
  const CRON = 'c'.repeat(40);
  await issuer(async ({ local }) => {
    assert.equal((await fetch(`${local}/v1/internal/caller`)).status, 401);
    assert.equal((await fetch(`${local}/v1/internal/caller`, { headers: { authorization: `Bearer ${ADMIN}` } })).status, 401, 'not the admin token');
    const res = await fetch(`${local}/v1/internal/caller`, { headers: { authorization: `Bearer ${CRON}`, 'x-test-ip': '192.0.2.7' } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ip: '192.0.2.7', edge: false });
  }, { cronSecret: CRON });
});

test('a retry with the same Idempotency-Key replays a passkey write instead of failing on a used challenge', () => issuer(async ({ db, gh, browser }) => {
  gh.as = owner;
  const b = browser();
  await b.signIn();
  const key = authenticator({ origin: ORIGIN, rpId: RP });
  const body = { name: 'laptop', credential: key.create((await b.call('GET', '/me/passkeys/options')).body) };
  const first = await b.call('POST', '/me/passkeys', body, { 'idempotency-key': 'add-1' });
  assert.equal(first.status, 201);
  const again = await b.call('POST', '/me/passkeys', body, { 'idempotency-key': 'add-1' });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.equal(again.body.id, first.body.id);
  assert.equal((await b.call('GET', '/me')).body.passkeys, 1);

  // Step-up: the su_ token is shown once, so the replay says so, and it is not a failed try.
  const assertion = { webauthn: key.get((await b.call('GET', '/auth/step-up/challenge')).body) };
  assert.equal((await b.call('POST', '/auth/step-up', assertion, { 'idempotency-key': 'su-1' })).status, 201);
  const replay = await b.call('POST', '/auth/step-up', assertion, { 'idempotency-key': 'su-1' });
  assert.equal(replay.status, 409);
  assert.match(replay.body.error, /token was shown once/);
  assert.equal((await db.system("select count(*)::int as n from identity_audit where action = 'step-up.failed'"))[0].n, 0);
  assert.equal((await db.system("select count(*)::int as n from idempotency_keys where response ? 'token'"))[0].n, 0, 'the token is never kept');
}));
