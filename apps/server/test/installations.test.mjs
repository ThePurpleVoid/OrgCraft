// GitHub App installations a workspace has proven it owns (docs/specs/studio-embed.md S9; issues #123, #139): the
// signed install callback, every proof GitHub must give, unbinding, the webhook, the team's repository, and runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { ORIGIN, issuer, owner } from './sign-in-helpers.mjs';
import { authenticator } from './authenticator.mjs';
import { repoSlug } from '../github.mjs';
import * as store from '../store.mjs';

const RP = 'studio.example';
const APP = { slug: 'agent-team-test', webhookSecret: 'whsec-test-0123456789abcdef' };
const ROSTER = (url) => ({ version: 'v1', repo: { url, ref: 'main' }, roles: [{ slug: 'lead', reportsTo: 'owner', areas: [] }] });

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

/** Starts a connect (step-up), then comes back the way GitHub sends the person: code, installation id, our state. */
async function connect({ b, su, gh }, id, { as = owner, code, action = 'install', state } = {}) {
  const st = await b.call('POST', '/github/installations', {}, { 'x-step-up': await su() });
  assert.equal(st.status, 201, JSON.stringify(st.body));
  const s = state ?? new URL(st.body.url).searchParams.get('state');
  const q = new URLSearchParams({ installation_id: String(id), setup_action: action, state: s, ...(code === null ? {} : { code: code ?? gh.installCode(as) }) });
  const res = await b.fetch(`${ORIGIN}/oauth/callback/github?${q}`);
  return { status: res.status, html: await res.text(), state: s, start: st.body };
}

const mine = (id, extra = {}) => ({ id, app_slug: APP.slug, account: { login: 'octo', id: Number(owner.id), type: 'User' }, repos: [{ full_name: 'octo/shop', permissions: { admin: true, push: true } }], ...extra });

test('repoSlug: github.com repositories only', () => {
  assert.equal(repoSlug('https://github.com/octo/shop.git'), 'octo/shop');
  assert.equal(repoSlug('https://github.com/octo/shop'), 'octo/shop');
  assert.equal(repoSlug('git@github.com:octo/shop.git'), 'octo/shop');
  assert.equal(repoSlug('ssh://git@github.com/octo/shop.git'), 'octo/shop');
  for (const u of ['https://gitlab.com/octo/shop', 'https://github.com.evil.example/octo/shop', 'https://github.com/octo', 'file:///repo', '/srv/repo', null]) assert.equal(repoSlug(u), null, String(u));
});

test('off without GITHUB_APP_SLUG: the routes are not there, runs are not gated', () => issuer(async ({ gh, browser }) => {
  const { b } = await ownerWithPasskey(gh, browser);
  assert.equal((await b.call('GET', '/github/installations')).status, 404);
  assert.equal((await b.call('POST', '/github/installations', {})).status, 404);
  assert.equal((await b.call('POST', '/teams', { id: 'shop' })).status, 201);
  const run = await b.call('POST', '/teams/shop/runs', { team: ROSTER('https://github.com/someone/else') });
  assert.notEqual(run.body?.type, 'installation');
}));

test('the install callback binds an installation the person administers; the state is signed and single use', () => issuer(async ({ db, gh, browser, identity }) => {
  const { b, su } = await ownerWithPasskey(gh, browser);
  assert.equal((await b.call('POST', '/github/installations', {})).status, 401, 'connecting needs step-up');
  gh.installs.push(mine(42));
  const r = await connect({ b, su, gh }, 42);
  assert.match(r.start.url, new RegExp(`^${gh.url}/apps/${APP.slug}/installations/new\\?state=`));
  assert.equal(r.start.expiresIn, 600);
  assert.equal(r.status, 200, r.html);
  assert.match(r.html, /GitHub connected/);
  assert.equal(gh.dropped.length, 1, 'the user token is revoked once read');
  const list = (await b.call('GET', '/github/installations')).body.installations;
  assert.deepEqual(list.map((i) => [i.id, i.account, i.accountType, i.githubLogin, i.method]), [[42, 'octo', 'User', 'octo', 'install-callback']]);
  const [a] = await db.system("select detail from identity_audit where action = 'github.installation.bound'");
  assert.equal(a.detail.installation, 42);

  // The same state again, or one that was tampered with, binds nothing.
  const again = await b.fetch(`${ORIGIN}/oauth/callback/github?${new URLSearchParams({ installation_id: '42', setup_action: 'install', state: r.state, code: gh.installCode(owner) })}`);
  assert.equal(again.status, 400);
  assert.match(await again.text(), /expired or was already used/);
  const st = (await b.call('POST', '/github/installations', {}, { 'x-step-up': await su() })).body;
  const [nonce] = new URL(st.url).searchParams.get('state').split('.');
  const forged = await b.fetch(`${ORIGIN}/oauth/callback/github?${new URLSearchParams({ installation_id: '42', setup_action: 'install', state: `${nonce}.${'A'.repeat(43)}`, code: gh.installCode(owner) })}`);
  assert.equal(forged.status, 400);

  // The team's repository: the hosted Studio gets it only when its owner is a proven account.
  assert.equal((await b.call('POST', '/teams', { id: 'shop' })).status, 201);
  assert.equal((await b.call('PUT', '/teams/shop', { repo: 'not a repo' })).status, 400);
  assert.equal((await b.call('PUT', '/teams/shop', { repo: 'octo/shop' })).body.repo, 'octo/shop');
  assert.equal((await b.call('GET', '/teams/shop')).body.repo, 'octo/shop');
  assert.equal(await identity.installations.teamRepo('acme', 'shop'), 'octo/shop');
  assert.deepEqual(await identity.installations.bound('acme'), [42]);
  await b.call('PUT', '/teams/shop', { repo: 'someone/else' });
  assert.equal(await identity.installations.teamRepo('acme', 'shop'), null, 'an account nobody proved');

  // Runs: a GitHub repository needs its account proven; other repositories are not GitHub's business.
  const refused = await b.call('POST', '/teams/shop/runs', { team: ROSTER('https://github.com/someone/else.git') });
  assert.deepEqual([refused.status, refused.body.type], [409, 'installation']);
  for (const url of ['https://github.com/OCTO/shop.git', 'https://gitlab.example/x/y.git']) {
    const ok = await b.call('POST', '/teams/shop/runs', { team: ROSTER(url) });
    assert.notEqual(ok.body?.type, 'installation', url);
  }
  assert.deepEqual(await identity.installations.forRepo('acme', 'git@github.com:octo/shop.git'), [42]);

  // Unbinding: an admin's, with step-up.
  assert.equal((await b.call('DELETE', '/github/installations/42', {})).status, 401);
  assert.equal((await b.call('DELETE', '/github/installations/42', {}, { 'x-step-up': await su() })).status, 200);
  assert.deepEqual((await b.call('GET', '/github/installations')).body.installations, []);
  assert.deepEqual(await identity.installations.forRepo('acme', 'https://github.com/octo/shop'), []);
}, { githubApp: APP }));

test('every proof GitHub must give: same user, listed, not suspended, account admin, push on every repository, one workspace', () => issuer(async ({ db, gh, browser }) => {
  const { b, su } = await ownerWithPasskey(gh, browser);
  const p = { b, su, gh };
  const refused = async (id, why, opts) => {
    const r = await connect(p, id, opts);
    assert.equal(r.status, 400, `${why}: ${r.html}`);
    const [a] = await db.system("select detail from identity_audit where action = 'github.installation.refused' order by id desc limit 1");
    assert.equal(a.detail.why, why);
    return r;
  };
  const other = { id: '2002', login: 'mallory' };
  gh.installs.push(mine(1, { visibleTo: [owner.id, other.id] }));
  await refused(1, 'other-user', { as: other });
  await refused(1, 'no-code', { code: null });
  await refused(999, 'not-listed');
  gh.installs.push(mine(2, { app_slug: 'some-other-app' }));
  await refused(2, 'not-listed');
  gh.installs.push(mine(3, { suspended_at: '2026-11-01T00:00:00Z' }));
  await refused(3, 'suspended');
  // Installed on someone else's user account that the person can see: not theirs.
  gh.installs.push(mine(4, { account: { login: 'friend', id: 3003, type: 'User' }, visibleTo: [owner.id] }));
  await refused(4, 'not-account-admin');
  // An organization: an active admin only.
  gh.installs.push(mine(5, { account: { login: 'shop-org', id: 4004, type: 'Organization' }, visibleTo: [owner.id], repos: [{ full_name: 'shop-org/site', permissions: { admin: true, push: true } }] }));
  gh.memberships[`${owner.id}/shop-org`] = { state: 'active', role: 'member' };
  await refused(5, 'not-account-admin');
  gh.memberships[`${owner.id}/shop-org`] = { state: 'pending', role: 'admin' };
  await refused(5, 'not-account-admin');
  gh.memberships[`${owner.id}/shop-org`] = { state: 'active', role: 'admin' };
  // Push on every repository, checked across pages.
  const many = Array.from({ length: 150 }, (_, i) => ({ full_name: `shop-org/r${i}`, permissions: { push: true } }));
  many[120].permissions = { pull: true };
  gh.installs[gh.installs.length - 1].repos = many;
  const r = await refused(5, 'no-push');
  assert.match(r.html, /write access to every repository/);
  many[120].permissions = { push: true };
  assert.equal((await connect(p, 5)).status, 200);

  // One workspace per installation: another tenant's is refused, and theirs stays theirs.
  await store.ensureTenant(db, 'other');
  const [me] = await db.system('select id from people where subject = $1', [owner.id]);
  await db.system("insert into github_installations(installation_id, tenant, account_login, account_id, account_type, proven_by, github_login, method) values (77, 'other', 'octo', 1001, 'User', $1, 'octo', 'install-callback')", [me.id]);
  gh.installs.push(mine(77));
  await refused(77, 'taken');
  const [row] = await db.system('select tenant from github_installations where installation_id = 77');
  assert.equal(row.tenant, 'other');
  assert.equal(gh.dropped.length, gh.issued.length - 1, 'every user token is revoked, whatever the answer (the sign-in one is not a user token here)');
}, { githubApp: APP }));

test('the webhook: signed, and an uninstalled or suspended installation is unbound at once; a rename follows', () => issuer(async ({ db, gh, browser, local }) => {
  const { b, su } = await ownerWithPasskey(gh, browser);
  gh.installs.push(mine(42), mine(43));
  assert.equal((await connect({ b, su, gh }, 42)).status, 200);
  assert.equal((await connect({ b, su, gh }, 43)).status, 200);
  const hook = async (event, payload, secret = APP.webhookSecret) => {
    const raw = JSON.stringify(payload);
    const r = await fetch(`${local}/v1/github/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` }, body: raw });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  assert.equal((await hook('installation', { action: 'deleted', installation: { id: 42 } }, 'wrong-secret-0123456789')).status, 401);
  assert.equal((await b.call('GET', '/github/installations')).body.installations.length, 2);
  assert.deepEqual((await hook('installation', { action: 'deleted', installation: { id: 42 } })).body, { ok: true, unbound: 1 });
  assert.equal((await hook('installation_target', { action: 'renamed', installation: { id: 43 }, account: { login: 'octo-renamed' } })).status, 200);
  assert.deepEqual((await b.call('GET', '/github/installations')).body.installations.map((i) => [i.id, i.account]), [[43, 'octo-renamed']]);
  assert.deepEqual((await hook('installation', { action: 'suspend', installation: { id: 43 } })).body, { ok: true, unbound: 1 });
  assert.deepEqual((await b.call('GET', '/github/installations')).body.installations, []);
  const why = (await db.system("select detail from identity_audit where action = 'github.installation.unbound' order by id")).map((a) => a.detail.why);
  assert.deepEqual(why, ['uninstalled', 'suspended']);
  // An unsuspend does not bring it back: a reinstall or unsuspend must be proven again.
  await hook('installation', { action: 'unsuspend', installation: { id: 43 } });
  assert.deepEqual((await b.call('GET', '/github/installations')).body.installations, []);
}, { githubApp: APP }));
