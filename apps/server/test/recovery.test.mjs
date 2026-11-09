// L27 (architecture B15): a second way in (a passkey alone) and recovery owners, so losing one GitHub account never
// locks a workspace. The acceptance case: the owner's GitHub sign-in is gone, and the second owner gets them back in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ORIGIN, issuer, owner } from './sign-in-helpers.mjs';
import { authenticator } from './authenticator.mjs';

const RP = 'studio.example';
const dana = { id: '2002', login: 'dana', name: 'Dana' };
const eli = { id: '3003', login: 'eli', name: 'Eli' };

async function person(gh, browser, user) {
  gh.as = user;
  const b = browser({ ip: user.login });
  await b.signIn();
  const key = authenticator({ origin: ORIGIN, rpId: RP });
  const added = await b.call('POST', '/me/passkeys', { name: `${user.login}'s laptop`, credential: key.create((await b.call('GET', '/me/passkeys/options')).body) });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const su = async (scope) => (await b.call('POST', '/auth/step-up', { webauthn: key.get((await b.call('GET', '/auth/step-up/challenge')).body), ...(scope ? { scope } : {}) })).body.token;
  const me = (await b.call('GET', '/me')).body.id;
  return { b, key, su, me };
}
async function join(gh, browser, boss, user, role) {
  const inv = await boss.b.call('POST', '/invitations', { github: user.login, role }, { 'x-step-up': await boss.su() });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  return person(gh, browser, user);
}

/** Signs in with a passkey alone, in a fresh browser: the sign-in page's "Use a passkey". */
async function passkeySignIn(browser, key, { ip = 'pk', knobs, ret = '/' } = {}) {
  const b = browser({ ip });
  const first = await b.go(`${ORIGIN}/oauth/authorize?client_id=agent-team-web&return=${encodeURIComponent(ret)}`);
  assert.match(first.at, /\/sign-in\?interaction=/);
  const uid = new URL(first.at).searchParams.get('interaction');
  const options = await (await b.fetch(`${ORIGIN}/oauth/authorize/${uid}/passkey`)).json();
  const res = await b.fetch(`${ORIGIN}/oauth/authorize/${uid}/passkey`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ webauthn: key.get(options, knobs) }) });
  const body = await res.json();
  if (res.status !== 200) return { b, status: res.status, body, uid, options };
  const done = await b.go(body.location.startsWith('/') ? ORIGIN + body.location : body.location);
  return { b, status: 200, at: done.at, uid };
}

test('a passkey alone signs a member in, without GitHub; a wrong, reused or cross-site one does not', () => issuer(async ({ db, gh, browser }) => {
  const octo = await person(gh, browser, owner);
  options: {
    // Options carry no credential list (the authenticator offers its own) and require user verification.
    const bx = browser({ ip: 'x' });
    const first = await bx.go(`${ORIGIN}/oauth/authorize?client_id=agent-team-web&return=%2F`);
    const uid = new URL(first.at).searchParams.get('interaction');
    const o = await (await bx.fetch(`${ORIGIN}/oauth/authorize/${uid}/passkey`)).json();
    assert.equal(o.userVerification, 'required');
    assert.equal(o.rpId, RP);
    assert.deepEqual(o.allowCredentials ?? [], []);
  }
  gh.as = null; // GitHub is gone for this person
  const ok = await passkeySignIn(browser, octo.key, { ret: '/teams' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.at, `${ORIGIN}/teams`);
  const me = await ok.b.call('GET', '/me');
  assert.deepEqual([me.status, me.body.id, me.body.workspaces[0].role], [200, octo.me, 'owner']);
  const [s] = await db.system('select amr from person_sessions where person = $1 order by created_at desc limit 1', [octo.me]);
  assert.deepEqual(s.amr, ['hwk', 'user']);
  // A counter that went back on a counting authenticator may be a cloned key: refused (security review low 1).
  octo.key.counter = 0;
  assert.equal((await passkeySignIn(browser, octo.key, { ip: 'clone' })).status, 401);
  octo.key.counter = 100;

  // Refused: no user verification, another origin, a key nobody registered; each one generic and audited.
  for (const [knobs, key] of [[{ uv: false }, octo.key], [{ from: 'https://evil.example' }, octo.key], [undefined, authenticator({ origin: ORIGIN, rpId: RP })]]) {
    const r = await passkeySignIn(browser, key, { knobs, ip: `bad-${Math.random()}` });
    assert.deepEqual([r.status, r.body.type], [401, 'passkey-refused'], JSON.stringify(knobs));
  }
  assert.ok((await db.system("select count(*)::int as n from identity_audit where action = 'sign-in.refused' and detail->>'method' = 'passkey'"))[0].n >= 3);
  // A challenge works once, and only for its own sign-in.
  const b = browser({ ip: 'replay' });
  const first = await b.go(`${ORIGIN}/oauth/authorize?client_id=agent-team-web&return=%2F`);
  const uid = new URL(first.at).searchParams.get('interaction');
  const options = await (await b.fetch(`${ORIGIN}/oauth/authorize/${uid}/passkey`)).json();
  const assertion = octo.key.get(options);
  const post = (u, h = { origin: ORIGIN, 'content-type': 'application/json' }) => b.fetch(`${ORIGIN}/oauth/authorize/${u}/passkey`, { method: 'POST', headers: h, body: JSON.stringify({ webauthn: assertion }) });
  assert.equal((await post(uid, { origin: 'https://evil.example', 'content-type': 'application/json' })).status, 403, 'cross-site');
  // Bound to the browser that started the sign-in (security review sev 3): another browser presenting the uid, even
  // with a good assertion, gets nowhere, and cannot ask for options either.
  const thief = browser({ ip: 'thief' });
  assert.equal((await thief.fetch(`${ORIGIN}/oauth/authorize/${uid}/passkey`)).status, 410);
  const stolen = await thief.fetch(`${ORIGIN}/oauth/authorize/${uid}/passkey`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ webauthn: assertion }) });
  assert.equal(stolen.status, 410);
  const other = new URL((await browser({ ip: 'o' }).go(`${ORIGIN}/oauth/authorize?client_id=agent-team-web&return=%2F`)).at).searchParams.get('interaction');
  assert.equal((await post(other)).status, 410, 'another browser\'s sign-in');
  assert.equal((await post(uid)).status, 200, 'still good in its own browser');
  assert.equal((await post(uid)).status, 401, 'a challenge works once');
}));

test('a removed member\'s passkey signs nobody in', () => issuer(async ({ gh, browser }) => {
  gh.directory.push(dana);
  const octo = await person(gh, browser, owner);
  const d = await join(gh, browser, octo, dana, 'editor');
  const mem = (await octo.b.call('GET', '/members')).body.members.find((m) => m.login === 'dana');
  assert.equal((await octo.b.call('DELETE', `/members/${mem.id}`, {}, { 'x-step-up': await octo.su() })).status, 200);
  assert.equal((await passkeySignIn(browser, d.key)).status, 401);
}));

test('recovery owners: owners with a passkey, 24 hours before a new one counts, warnings under two', () => issuer(async ({ db, gh, browser }) => {
  gh.directory.push(dana, eli);
  const octo = await person(gh, browser, owner);
  const d = await join(gh, browser, octo, dana, 'owner');
  const e = await join(gh, browser, octo, eli, 'admin');
  const list = async () => (await octo.b.call('GET', '/recovery')).body;
  assert.deepEqual((await list()).warnings.map((w) => w.code), ['fewer-than-two']);
  assert.equal((await e.b.call('GET', '/recovery')).status, 200, 'an admin can see them');
  assert.equal((await e.b.call('POST', '/recovery', { person: e.me }, { 'x-step-up': await e.su(`recovery:acme_${e.me}`) })).status, 403, 'only an owner names one');
  assert.equal((await octo.b.call('POST', '/recovery', { person: octo.me })).status, 401, 'step-up first');
  assert.equal((await octo.b.call('POST', '/recovery', { person: octo.me }, { 'x-step-up': await octo.su() })).status, 401, 'the step-up names the change (recovery:<tenant>_<person>)');
  assert.equal((await octo.b.call('POST', '/recovery', { person: e.me }, { 'x-step-up': await octo.su(`recovery:acme_${e.me}`) })).body.type, 'not-owner');
  // The first one, an owner naming themselves, counts at once.
  const self = await octo.b.call('POST', '/recovery', { person: octo.me }, { 'x-step-up': await octo.su(`recovery:acme_${octo.me}`) });
  assert.deepEqual([self.status, self.body.pending], [201, false]);
  assert.equal((await octo.b.call('POST', '/recovery', { person: octo.me }, { 'x-step-up': await octo.su(`recovery:acme_${octo.me}`) })).body.type, 'already');
  // A second one widens access: 24 hours, and every owner is told.
  const second = await octo.b.call('POST', '/recovery', { person: d.me }, { 'x-step-up': await octo.su(`recovery:acme_${d.me}`) });
  assert.deepEqual([second.status, second.body.pending], [201, true]);
  assert.ok(Date.parse(second.body.effectiveAt) - Date.now() > 23.9 * 3600_000);
  let l = await list();
  assert.deepEqual(l.owners.map((o) => [o.login, o.counts, o.why ?? null, o.methods]), [['octo', true, null, ['github', 'passkey']], ['dana', false, 'pending', ['github', 'passkey']]]);
  assert.deepEqual(l.warnings.map((w) => w.code), ['fewer-than-two']);
  for (const who of [octo, d]) assert.ok((await who.b.call('GET', '/me')).body.notices.some((n) => n.action === 'recovery-owner.added' && n.person === d.me), 'told');
  await db.system("update recovery_owners set effective_at = now() - interval '1 minute' where person = $1", [d.me]);
  l = await list();
  assert.deepEqual([l.owners.every((o) => o.counts), l.warnings], [true, []]);
  // Demoted from owner: no longer counts, and the list says why.
  const dm = (await octo.b.call('GET', '/members')).body.members.find((m) => m.login === 'dana');
  assert.equal((await octo.b.call('PATCH', `/members/${dm.id}`, { role: 'admin' }, { 'x-step-up': await octo.su() })).status, 200);
  l = await list();
  assert.deepEqual(l.warnings.map((w) => w.code), ['fewer-than-two', 'not-owner']);
  // Removing is at once.
  assert.equal((await octo.b.call('DELETE', `/recovery/${d.me}`, {}, { 'x-step-up': await octo.su(`recovery:acme_${d.me}`) })).status, 200);
  assert.deepEqual((await list()).owners.map((o) => o.login), ['octo']);
  assert.equal((await octo.b.call('DELETE', `/recovery/${d.me}`, {}, { 'x-step-up': await octo.su(`recovery:acme_${d.me}`) })).status, 404);

  // The last one who counts: refused, unless confirmed with a step-up scoped to exactly this (CTO ruling on L27).
  const last = (body, scope) => octo.b.call('DELETE', `/recovery/${octo.me}`, body, scope === undefined ? {} : { 'x-step-up': scope });
  const refused = await last({}, await octo.su(`recovery:acme_${octo.me}`));
  assert.deepEqual([refused.status, refused.body.type], [409, 'last-owner']);
  assert.equal((await last({ confirm: 'no-recovery' })).status, 401, 'step-up first');
  const unscoped = await octo.su();
  assert.equal((await last({ confirm: 'no-recovery' }, unscoped)).status, 401, 'an unscoped step-up is refused');
  const wrong = await octo.su(`recovery:acme_${octo.me}`);
  assert.equal((await last({ confirm: 'no-recovery' }, wrong)).status, 401, 'the ordinary recovery scope is refused');
  assert.equal((await last({ confirm: 'no-recovery' }, await octo.su(`remove-last-recovery-owner:${d.me}`))).status, 401, 'another person\'s scope is refused');
  const spent = await db.system('select count(*)::int as n from step_up_tokens where id = any($1) and used_at is not null', [[unscoped, wrong].map((t) => t.split('.')[0])]);
  assert.equal(spent[0].n, 0, 'refused tokens are not spent');
  assert.equal((await octo.b.call('GET', '/recovery')).body.owners.length, 1, 'still there');
  const ok = await last({ confirm: 'no-recovery', words: 'Moving the workspace to a new account tonight.' }, await octo.su(`remove-last-recovery-owner:${octo.me}`));
  assert.deepEqual([ok.status, ok.body.last], [200, true]);
  assert.deepEqual((await list()).owners, []);
  const [row] = await db.system("select actor_id, target, detail from audit where tenant = 'acme' and action = 'recovery-owner.removed-last'");
  assert.deepEqual([row.actor_id, row.target, row.detail.words], [octo.me, octo.me, 'Moving the workspace to a new account tonight.']);
}));

test('acceptance: the owner\'s GitHub sign-in is gone, and the second recovery owner gets them back in', () => issuer(async ({ db, gh, browser }) => {
  gh.directory.push(dana);
  const octo = await person(gh, browser, owner);
  const d = await join(gh, browser, octo, dana, 'owner');
  await octo.b.call('POST', '/recovery', { person: octo.me }, { 'x-step-up': await octo.su(`recovery:acme_${octo.me}`) });
  await octo.b.call('POST', '/recovery', { person: d.me }, { 'x-step-up': await octo.su(`recovery:acme_${d.me}`) });
  await db.system("update recovery_owners set effective_at = now() - interval '1 minute'");
  assert.deepEqual((await (await d.b.call('GET', '/recovery')).body).warnings, []);

  // GitHub is gone for octo, and octo's laptop (passkey) is lost too.
  gh.as = null;
  const fresh = browser({ ip: 'octo-again' });
  assert.match(String(await fresh.signIn()), /\/sign-in\?error=denied/);

  // Dana, on a new device with her passkey and without GitHub, signs in and invites octo's new GitHub account as owner.
  const dk = await passkeySignIn(browser, d.key, { ip: 'dana-new' });
  assert.equal(dk.status, 200, JSON.stringify(dk.body));
  const su = (await dk.b.call('POST', '/auth/step-up', { webauthn: d.key.get((await dk.b.call('GET', '/auth/step-up/challenge')).body) })).body.token;
  const octo2 = { id: '4004', login: 'octo-new', name: 'Octo Cat' };
  gh.directory.push(octo2);
  assert.equal((await dk.b.call('POST', '/invitations', { github: 'octo-new', role: 'owner' }, { 'x-step-up': su })).status, 201);
  gh.as = octo2;
  const back = browser({ ip: 'octo-new' });
  await back.signIn();
  assert.equal((await back.call('GET', '/me')).body.workspaces[0].role, 'owner', 'back in as an owner');
}));
