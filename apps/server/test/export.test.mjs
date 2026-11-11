// L9d (spec L9 section 5.1): a managed team's export. A zip of main's files, history.bundle and a README; the bundle
// clones with real git and matches main. Admin, signed in on the web, with a passkey step-up scoped export:<team>;
// never through an app token; 10 a day; audited, team.exported, and a security notice to every owner and admin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { SignJWT, exportJWK } from 'jose';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ORIGIN, issuer, owner } from './sign-in-helpers.mjs';
import { authenticator } from './authenticator.mjs';
import { pgObjects, pgRefs } from '../managed-db.mjs';
import { managedBackend } from '../../studio/managed.mjs';
import { readZip } from '../../../packages/git-store/zip.mjs';

const RP = 'studio.example';

/** The owner signed in from the iPhone app (a DPoP-bound token, as apps.test.mjs does): a person, but not the web. */
async function appOf(gh, browser, local) {
  gh.as = owner;
  const proof = (d, htm, htu, claims = {}) => new SignJWT({ htm, htu, jti: randomUUID(), ...claims }).setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk: d.jwk }).setIssuedAt().sign(d.privateKey);
  const redirect = `${ORIGIN}/app/ios/callback`;
  const verifier = randomBytes(32).toString('base64url');
  const b = browser({ ip: 'app' });
  const first = await b.go(`${ORIGIN}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: 'agent-team-ios', redirect_uri: redirect, scope: 'openid profile', state: 's', nonce: 'n', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })}`);
  const uid = new URL(first.at).searchParams.get('interaction');
  const code = new URL((await b.go(`${ORIGIN}/oauth/authorize/${uid}/github`)).at).searchParams.get('code');
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const phone = { privateKey, jwk: await exportJWK(publicKey) };
  const res = await fetch(`${local}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-ip': 'phone', dpop: await proof(phone, 'POST', `${ORIGIN}/oauth/token`) },
    body: new URLSearchParams({ client_id: 'agent-team-ios', grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier }) });
  const { access_token: token } = await res.json();
  return async (path, headers = {}) => fetch(`${local}/v1${path}`, { headers: { authorization: `DPoP ${token}`, dpop: await proof(phone, 'GET', `${ORIGIN}/v1${path}`, { ath: createHash('sha256').update(token).digest('base64url') }), ...headers } });
}

async function signedIn(gh, browser) {
  gh.as = owner;
  const b = browser({ ip: owner.login });
  await b.signIn();
  const key = authenticator({ origin: ORIGIN, rpId: RP });
  assert.equal((await b.call('POST', '/me/passkeys', { name: 'laptop', credential: key.create((await b.call('GET', '/me/passkeys/options')).body) })).status, 201);
  const su = async (scope) => (await b.call('POST', '/auth/step-up', { webauthn: key.get((await b.call('GET', `/auth/step-up/challenge${scope ? `?scope=${encodeURIComponent(scope)}` : ''}`)).body), ...(scope ? { scope } : {}) })).body.token;
  return { b, su };
}

/** Two versions on main, written straight into the store (what accepted changes leave behind). */
async function twoVersions(db) {
  const b = managedBackend({ store: pgObjects(db, 'acme', 'shop'), refs: pgRefs(db, 'acme', 'shop'), autoAccept: true });
  const one = await b.publish({ base: null, changes: [{ path: '.agent-team/team.json', content: '{"preset":"minimal"}\n' }, { path: 'docs/team/a.md', content: '# A\n' }], message: 'One', branch: 'x', pr: { title: 'One' } });
  const sha1 = one.merged ?? (await pgRefs(db, 'acme', 'shop').getRef('main')).sha;
  await b.publish({ base: sha1, changes: [{ path: 'docs/team/a.md', content: '# A, again\n' }, { path: 'scripts/agent-team/x.sh', content: '#!/bin/sh\n', mode: '100755' }], message: 'Two', branch: 'y', pr: { title: 'Two' } });
  return (await pgRefs(db, 'acme', 'shop').getRef('main')).sha;
}

const download = (b, headers = {}) => b.fetch(`${ORIGIN}/v1/teams/shop/export`, { headers: { origin: ORIGIN, ...headers } });

test('export: the zip has main\'s files, a bundle real git clones to main, and a README; refused without the scoped passkey', () => issuer(async ({ db, gh, browser }) => {
  const o = await signedIn(gh, browser);
  assert.equal((await o.b.call('POST', '/teams', { id: 'shop' }, { 'x-step-up': await o.su() })).status < 300, true);
  await db.system("update teams set backend = 'managed' where id = 'shop'");
  const main = await twoVersions(db);

  const bare = await download(o.b);
  assert.equal(bare.status, 401);
  assert.equal((await bare.json()).type, 'step-up-required');
  assert.equal((await download(o.b, { 'x-step-up': await o.su() })).status, 401, 'a step-up for nothing in particular does not count');
  assert.equal((await download(o.b, { 'x-step-up': await o.su('export:other') })).status, 401, 'nor one for another team');

  const res = await download(o.b, { 'x-step-up': await o.su('export:shop') });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="shop-v2-\d{4}-\d{2}-\d{2}\.zip"$/);
  assert.equal(res.headers.get('x-team-version'), main);
  const entries = readZip(Buffer.from(await res.arrayBuffer()));
  const at = (n) => entries.find((e) => e.name === n);
  assert.deepEqual(entries.map((e) => e.name).sort(), ['README.txt', 'files/.agent-team/team.json', 'files/docs/team/a.md', 'files/scripts/agent-team/x.sh', 'history.bundle']);
  assert.equal(at('files/docs/team/a.md').data.toString(), '# A, again\n');
  assert.equal(at('files/scripts/agent-team/x.sh').mode, '100755');
  assert.match(at('README.txt').data.toString(), /git clone history\.bundle shop/);
  // Real git: verify, clone, and main is the same commit with the same files.
  const dir = mkdtempSync(join(tmpdir(), 'export-'));
  writeFileSync(join(dir, 'h.bundle'), at('history.bundle').data);
  execFileSync('git', ['bundle', 'verify', join(dir, 'h.bundle')], { stdio: 'ignore' });
  execFileSync('git', ['clone', '-q', '--branch', 'main', join(dir, 'h.bundle'), join(dir, 'c')]);
  assert.equal(execFileSync('git', ['-C', join(dir, 'c'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), main);
  assert.equal(execFileSync('git', ['-C', join(dir, 'c'), 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim(), '2');
  assert.equal(readFileSync(join(dir, 'c/docs/team/a.md'), 'utf8'), '# A, again\n');
  assert.deepEqual(execFileSync('git', ['-C', join(dir, 'c'), 'ls-remote', '--refs', join(dir, 'h.bundle')], { encoding: 'utf8' }).trim().split('\n').map((l) => l.split('\t')[1]), ['refs/heads/main'], 'only main is in the bundle (no change-request refs)');

  // Audited, appended, and a notice for the owner.
  const [a] = await db.system("select actor_id, decision, detail from audit where action = 'team.export'");
  assert.deepEqual([a.decision, a.detail.sha, a.detail.kind], ['allowed', main, 'download']);
  const [e] = await db.system("select envelope from events where team = 'shop' and type = 'team.exported'");
  assert.deepEqual([e.envelope.data.sha, e.envelope.data.kind, e.envelope.data.by], [main, 'download', a.actor_id]);
  const me = (await o.b.call('GET', '/me')).body;
  assert.ok(me.notices.some((n) => n.action === 'team.exported' && n.team === 'shop'), JSON.stringify(me.notices));
}));

test('export: at most 10 a day per team, and never through an app token or for a managed team with nothing published', () => issuer(async ({ db, gh, browser, local }) => {
  const o = await signedIn(gh, browser);
  await o.b.call('POST', '/teams', { id: 'shop' }, { 'x-step-up': await o.su() });
  await db.system("update teams set backend = 'managed' where id = 'shop'");
  const empty = await download(o.b, { 'x-step-up': await o.su('export:shop') });
  assert.equal(empty.status, 409);
  assert.equal((await empty.json()).type, 'empty');
  await twoVersions(db);
  // The standing export's own writes never use up the download quota (code review L9d sev3).
  for (let i = 0; i < 12; i++) await db.system("insert into audit(tenant, team, actor_kind, actor_id, action, target, decision, detail) values ('acme', 'shop', 'system', 'control-plane', 'team.export.standing', 'shop', 'allowed', '{\"kind\":\"standing\"}')");
  assert.equal((await download(o.b, { 'x-step-up': await o.su('export:shop') })).status, 200, 'twelve standing writes today, and the admin can still download');
  for (let i = 0; i < 9; i++) await db.system("insert into audit(tenant, team, actor_kind, actor_id, action, target, decision, detail) values ('acme', 'shop', 'person', 'x', 'team.export', 'shop', 'allowed', '{\"kind\":\"download\"}')");
  const many = await download(o.b, { 'x-step-up': await o.su('export:shop') });
  assert.equal(many.status, 429);
  assert.equal((await many.json()).type, 'rate-limited');
  await db.system("update audit set at = now() - interval '25 hours' where action = 'team.export'");
  assert.equal((await download(o.b, { 'x-step-up': await o.su('export:shop') })).status, 200, 'a day later it works again');
  // The same owner from the iPhone app (a person's token, not the web) is refused, even with a scoped step-up.
  const viaApp = await appOf(gh, browser, local);
  const before = (await db.system("select count(*)::int as n from audit where action = 'team.export' and decision = 'allowed'"))[0].n;
  const app = await viaApp('/teams/shop/export', { 'x-step-up': await o.su('export:shop') });
  assert.equal(app.status, 403);
  assert.match((await app.json()).error, /signed in on the web, with your passkey/);
  assert.equal((await db.system("select count(*)::int as n from audit where action = 'team.export' and decision = 'allowed'"))[0].n, before, 'nothing exported');
}));
