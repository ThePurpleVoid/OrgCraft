// Roles on every route, members and invitations, and the admin token's retirement (docs/specs/m4-sign-in.md
// section 4): a viewer cannot answer an approval even with step-up, removing a member ends their access at once, and
// nobody removes the last owner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ADMIN } from './helpers.mjs';
import { ORIGIN, issuer, owner } from './sign-in-helpers.mjs';
import { authenticator } from './authenticator.mjs';
import { ROUTES, minRole, atLeast } from '../roles.mjs';
import { resetOwner } from '../members.mjs';

const RP = 'studio.example';
const dana = { id: '2002', login: 'dana', name: 'Dana' };
const eli = { id: '3003', login: 'eli', name: 'Eli' };

/** Signs `user` in and gives them a passkey; `su()` steps up for one su_ token. */
async function person(gh, browser, user) {
  gh.as = user;
  const b = browser({ ip: user.login });
  await b.signIn();
  const key = authenticator({ origin: ORIGIN, rpId: RP });
  const added = await b.call('POST', '/me/passkeys', { name: `${user.login}'s laptop`, credential: key.create((await b.call('GET', '/me/passkeys/options')).body) });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const su = async () => (await b.call('POST', '/auth/step-up', { webauthn: key.get((await b.call('GET', '/auth/step-up/challenge')).body) })).body.token;
  return { b, su };
}

/** The owner invites `user` with `role`, and `user` signs in and adds a passkey. */
async function join(gh, browser, boss, user, role) {
  const inv = await boss.b.call('POST', '/invitations', { github: user.login, role }, { 'x-step-up': await boss.su() });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  return person(gh, browser, user);
}

test('roles.mjs and api-v1.yaml agree on every route\'s minimum role, and an unlisted route is refused', () => {
  const yaml = readFileSync(new URL('../../../docs/contracts/api-v1.yaml', import.meta.url), 'utf8').split('\n');
  const stated = new Map();
  let path = null, method = null;
  for (const l of yaml) {
    let m;
    if ((m = /^  (\/\S*):/.exec(l))) { path = m[1]; method = null; }
    if ((m = /^    (get|post|put|patch|delete):/.exec(l))) method = m[1].toUpperCase();
    if (path && method && (m = /x-min-role: (\w+)/.exec(l))) stated.set(`${method} ${path}`, m[1]);
  }
  assert.deepEqual(Object.fromEntries([...stated].sort()), Object.fromEntries(ROUTES.map(([m, p, r]) => [`${m} ${p}`, r]).sort()));
  assert.equal(minRole('POST', '/runners/codes'), 'admin');
  assert.equal(minRole('DELETE', '/runners/rn_1'), 'admin');
  assert.equal(minRole('GET', '/teams/web/'), 'viewer');
  assert.equal(minRole('POST', '/teams/web/whatever'), null);
  assert.ok(atLeast('owner', 'admin') && atLeast('approver', 'editor') && !atLeast('editor', 'approver') && !atLeast(null, 'viewer') && !atLeast('root', 'viewer'));
});

test('a viewer reads but cannot write, and cannot answer an approval even with step-up', () => issuer(async ({ gh, browser, server }) => {
  gh.directory.push(dana);
  const boss = await person(gh, browser, owner);
  assert.equal((await boss.b.call('POST', '/teams', { id: 'web' })).status, 201);
  const viewer = await join(gh, browser, boss, dana, 'viewer');
  assert.equal((await viewer.b.call('GET', '/me')).body.workspaces[0].role, 'viewer');
  assert.equal((await viewer.b.call('GET', '/teams')).status, 200);
  assert.equal((await viewer.b.call('GET', '/members')).body.members.length, 2);
  const make = await viewer.b.call('POST', '/teams', { id: 'other' });
  assert.equal(make.status, 403);
  assert.equal(make.body.type, 'forbidden');
  assert.equal((await viewer.b.call('POST', '/teams/web/chat', { text: 'hi' })).status, 403);
  assert.equal((await viewer.b.call('GET', '/invitations')).status, 403);
  const { result: a } = await server.m3.tx('acme', (ctx) => server.m3.requestApproval(ctx, 'web', { action: 'deploy', call: { cmd: 'deploy web' }, why: 'Release day.', role: 'release-manager', risk: 'low' }));
  const tried = await viewer.b.call('POST', `/approvals/${a.approval}`, { decision: 'approved' }, { 'x-step-up': await viewer.su() });
  assert.equal(tried.status, 403);
  assert.match(tried.body.error, /approver role/);
  const doIt = await viewer.b.call('POST', '/approvals/do-it', { asks: [{ approval: a.approval, version: 1 }] }, { 'x-step-up': await viewer.su() });
  assert.equal(doIt.status, 403, '"Do it" is an approver\'s too (L39)');
  // An approver may.
  const up = await boss.b.call('PATCH', `/members/${(await viewer.b.call('GET', '/members')).body.members.find((m) => m.login === 'dana').id}`, { role: 'approver' }, { 'x-step-up': await boss.su() });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal((await viewer.b.call('POST', `/approvals/${a.approval}`, { decision: 'approved' }, { 'x-step-up': await viewer.su() })).status, 200);
}));

test('invitations: by login, held as the numeric id, step-up first, only an owner invites an owner, and withdrawn means no way in', () => issuer(async ({ db, gh, browser }) => {
  gh.directory.push(dana, eli);
  const boss = await person(gh, browser, owner);
  assert.equal((await boss.b.call('POST', '/invitations', { github: 'dana', role: 'admin' })).status, 401, 'step-up first');
  assert.equal((await boss.b.call('POST', '/invitations', { github: 'nobody-here', role: 'viewer' }, { 'x-step-up': await boss.su() })).body.type, 'no-such-github-user');
  assert.equal((await boss.b.call('POST', '/invitations', { github: 'dana', role: 'root' }, { 'x-step-up': await boss.su() })).status, 400);
  const admin = await join(gh, browser, boss, dana, 'admin');
  const [row] = await db.system("select subject from invitations where role = 'admin'");
  assert.equal(row.subject, '2002');

  // An admin invites below owner, not an owner; an owner can.
  const asOwner = await admin.b.call('POST', '/invitations', { github: 'eli', role: 'owner' }, { 'x-step-up': await admin.su() });
  assert.equal(asOwner.status, 403);
  const inv = await admin.b.call('POST', '/invitations', { github: '@Eli', role: 'editor', days: 2 }, { 'x-step-up': await admin.su() });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  assert.equal(inv.body.github, '3003');
  assert.deepEqual((await admin.b.call('GET', '/invitations')).body.invitations.map((i) => [i.github, i.role]), [['3003', 'editor']]);
  assert.equal((await admin.b.call('POST', '/invitations', { github: 'dana', role: 'viewer' }, { 'x-step-up': await admin.su() })).body.type, 'already-member');

  // Withdrawn: Eli is told to ask an owner.
  assert.equal((await admin.b.call('DELETE', `/invitations/${inv.body.id}`, {})).status, 200);
  assert.equal((await admin.b.call('DELETE', `/invitations/${inv.body.id}`, {})).status, 404);
  gh.as = eli;
  assert.equal(await browser({ ip: 'eli' }).signIn(), `${ORIGIN}/sign-in?error=not-invited`);
  assert.equal((await db.system("select count(*)::int as n from audit where action in ('invitation.created', 'invitation.withdrawn')"))[0].n, 3);
}));

test('members: removing one ends their access at once, and nobody removes or demotes the last owner', () => issuer(async ({ db, gh, browser }) => {
  gh.directory.push(dana, eli);
  const boss = await person(gh, browser, owner);
  const admin = await join(gh, browser, boss, dana, 'admin');
  const editor = await join(gh, browser, boss, eli, 'editor');
  const ids = Object.fromEntries((await boss.b.call('GET', '/members')).body.members.map((m) => [m.login, m.id]));

  // The last owner: neither demoted nor removed, even by themselves.
  const demote = await boss.b.call('PATCH', `/members/${ids.octo}`, { role: 'admin' }, { 'x-step-up': await boss.su() });
  assert.equal(demote.status, 409);
  assert.equal(demote.body.type, 'last-owner');
  assert.equal((await boss.b.call('DELETE', `/members/${ids.octo}`, {}, { 'x-step-up': await boss.su() })).body.type, 'last-owner');
  // An admin cannot touch an owner, or make one.
  assert.equal((await admin.b.call('DELETE', `/members/${ids.octo}`, {}, { 'x-step-up': await admin.su() })).status, 403);
  assert.equal((await admin.b.call('PATCH', `/members/${ids.eli}`, { role: 'owner' }, { 'x-step-up': await admin.su() })).status, 403);
  assert.equal((await admin.b.call('PATCH', `/members/${ids.eli}`, { role: 'viewer' })).status, 401, 'step-up first');

  // Eli gets team emails (a verified address with a kind on) and Slack DMs: removing Eli removes those too (security review).
  assert.equal((await boss.b.call('POST', '/teams', { id: 'web' })).status, 201);
  await db.system(`insert into email_subscriptions(id, tenant, team, principal, email, kinds, verified_at)
    select 'eml_eli', tenant, 'web', person, 'eli@example.com', '{approval}', now() from members where person = (select id from people where subject = '3003')`);
  await db.system(`insert into slack_links(id, tenant, team, principal, slack_user, slack_workspace, kinds)
    select 'slk_eli', tenant, 'web', person, 'U0ELI', 'T0WEB', '{approval}' from members where person = (select id from people where subject = '3003')`);
  // Removing Eli: the very next request is refused, and Eli is signed out everywhere (no other workspace).
  assert.equal((await editor.b.call('GET', '/teams')).status, 200);
  assert.equal((await admin.b.call('DELETE', `/members/${ids.eli}`, {}, { 'x-step-up': await admin.su() })).status, 200);
  assert.equal((await editor.b.call('GET', '/teams')).status, 401);
  assert.equal((await editor.b.call('GET', '/me')).status, 401);
  assert.equal((await db.system("select count(*)::int as n from person_sessions where person = (select id from people where subject = '3003') and revoked_at is null"))[0].n, 0);
  assert.equal((await db.system("select count(*)::int as n from email_subscriptions where id = 'eml_eli'"))[0].n, 0);
  assert.equal((await db.system("select count(*)::int as n from slack_links where id = 'slk_eli'"))[0].n, 0, 'and their Slack link');
  assert.deepEqual((await boss.b.call('GET', '/members')).body.members.map((m) => m.login).sort(), ['dana', 'octo']);

  // With a second owner, the first can step down.
  assert.equal((await boss.b.call('PATCH', `/members/${ids.dana}`, { role: 'owner' }, { 'x-step-up': await boss.su() })).status, 200);
  assert.equal((await boss.b.call('PATCH', `/members/${ids.octo}`, { role: 'admin' }, { 'x-step-up': await boss.su() })).status, 200);
  assert.equal((await boss.b.call('GET', '/me')).body.workspaces[0].role, 'admin');
  assert.equal((await db.system("select count(*)::int as n from audit where action in ('member.role-changed', 'member.removed')"))[0].n, 3);
}));

test('the admin token is retired once someone owns the deployment; reset-owner on the host is the way back in', () => issuer(async ({ db, gh, local, browser }) => {
  const asAdmin = () => fetch(`${local}/v1/teams`, { headers: { authorization: `Bearer ${ADMIN}` } });
  assert.equal((await asAdmin()).status, 200, 'before the first owner signs in, the token still works');
  gh.as = owner;
  await browser().signIn();
  const res = await asAdmin();
  assert.equal(res.status, 401);
  assert.equal((await res.json()).type, 'admin-token-retired');

  // The owner lost their GitHub account: the host invites another as owner.
  await assert.rejects(resetOwner(db, 'acme', 'eli'), /numeric GitHub user id/);
  await resetOwner(db, 'acme', eli.id);
  gh.as = eli;
  const b = browser({ ip: 'eli' });
  assert.equal(await b.signIn(), `${ORIGIN}/`);
  assert.equal((await b.call('GET', '/me')).body.workspaces[0].role, 'owner');
}));

test('each card kind has a least role: an approver answers a decision but not a budget card', () => issuer(async ({ gh, browser, server }) => {
  gh.directory.push(dana);
  const boss = await person(gh, browser, owner);
  assert.equal((await boss.b.call('POST', '/teams', { id: 'web' })).status, 201);
  const approver = await join(gh, browser, boss, dana, 'approver');
  const card = (kind) => server.m3.tx('acme', (ctx) => server.m3.createCard(ctx, 'web', { kind, subject: `${kind}/1`, title: 'Choose', options: [{ id: 'a', label: 'A', style: 'primary', stepUp: false }, { id: 'b', label: 'B', style: 'secondary', stepUp: false }] }));
  const { result: budget } = await card('budget');
  const { result: decision } = await card('decision');
  const refused = await approver.b.call('POST', `/cards/${budget.id}`, { option: 'a', version: 1 });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /budget card needs the admin role/);
  assert.equal((await approver.b.call('POST', `/cards/${decision.id}`, { option: 'a', version: 1 })).status, 200);
  assert.equal((await boss.b.call('POST', `/cards/${budget.id}`, { option: 'a', version: 1 })).status, 200);
}));

test('GET /v1/me lists the person\'s own security changes (S5, until notifications deliver them)', () => issuer(async ({ gh, browser }) => {
  const boss = await person(gh, browser, owner);
  const notices = (await boss.b.call('GET', '/me')).body.notices;
  assert.equal(notices[0].action, 'passkey.added');
  assert.equal(notices[0].name, 'octo\'s laptop');
  assert.match(notices[0].passkey, /^pk_/);
}));
