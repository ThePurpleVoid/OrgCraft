// Change requests on a managed team (ADR 0012 and 0013, spec L9 sections 4.4 and 4.5, step L9c): checks and the
// capability diff run again at accept; red checks, self-widening and a widening change without step-up are refused;
// rollback is a change request diffed against the current main; team.published is appended once per commit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plane, ADMIN } from './helpers.mjs';
import * as store from '../store.mjs';
import { pgObjects, pgRefs } from '../managed-db.mjs';
import { managedBackend } from '../../studio/managed.mjs';
import * as core from '../../studio/core.mjs';
import { setField } from '../../../packages/team-model/index.mjs';

const ORIGIN = 'https://cp.example';
const studio = (extra = {}) => ({ authorization: `Bearer ${ADMIN}`, 'x-agent-team-studio': '1', origin: ORIGIN, 'content-type': 'application/json', ...extra });
const clone = (x) => JSON.parse(JSON.stringify(x));

/** A managed team with its first version accepted; returns helpers around it. */
async function managedTeam({ call, db, su }) {
  await call('POST', '/teams', { id: 'shop' });
  await db.system("update teams set backend = 'managed' where id = 'shop'");
  const empty = await call('GET', '/teams/shop/studio/v1/team', undefined, studio());
  const tpl = empty.body.templates.find((x) => x.id !== 'almost-empty') ?? empty.body.templates[0];
  const draft = await call('POST', '/teams/shop/studio/v1/team/from-template', { id: tpl.id, project: 'Shop', owner: 'Sam', timezone: 'UTC' }, studio());
  const first = await call('POST', '/teams/shop/studio/v1/team/publish', { spec: draft.body.spec, base: null, message: 'Start the team' }, studio({ 'idempotency-key': 'start' }));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const ok = await call('POST', '/teams/shop/changes/1/accept', { words: 'Start it' }, await su('accept-change:shop_1'));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const backend = managedBackend({ store: pgObjects(db, 'acme', 'shop'), refs: pgRefs(db, 'acme', 'shop') });
  /** Publishes `edit(spec)` from main through the Studio, as a person; returns the change number. */
  const publish = async (edit, message, key) => {
    const { spec, git } = (await call('GET', '/teams/shop/studio/v1/team', undefined, studio())).body;
    const next = clone(spec);
    edit(next);
    const r = await call('POST', '/teams/shop/studio/v1/team/publish', { spec: next, base: git.head.sha, message }, studio({ 'idempotency-key': key }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.pr.number;
  };
  return { backend, publish, first: first.body.commit };
}

test('the first version: accepting it needs step-up (every seat is new access), then main moves and team.published is appended once', async () => {
  await plane(async ({ call, db, su }) => {
    await call('POST', '/teams', { id: 'shop' });
    await db.system("update teams set backend = 'managed' where id = 'shop'");
    const empty = await call('GET', '/teams/shop/studio/v1/team', undefined, studio());
    const draft = await call('POST', '/teams/shop/studio/v1/team/from-template', { id: empty.body.templates[0].id, project: 'Shop', owner: 'Sam', timezone: 'UTC' }, studio());
    const pub = await call('POST', '/teams/shop/studio/v1/team/publish', { spec: draft.body.spec, base: null, message: 'Start the team' }, studio({ 'idempotency-key': 'one' }));
    const list = await call('GET', '/teams/shop/changes?state=open');
    assert.deepEqual(list.body.changes.map((c) => [c.number, c.state, c.branch]), [[1, 'open', 'cr/1']]);
    const one = await call('GET', '/teams/shop/changes/1');
    assert.ok(one.body.capability.some((x) => x.kind === 'seat-added'), 'Widens access lists the new seats');
    assert.ok(one.body.files.some((f) => f.path === '.agent-team/team.json' && f.status === 'added'));
    const refused = await call('POST', '/teams/shop/changes/1/accept', {});
    assert.equal(refused.status, 401, JSON.stringify(refused.body));
    assert.equal(refused.body.type, 'step-up-required');
    assert.equal((await db.system("select count(*)::int as n from managed_refs where team = 'shop' and name = 'main'"))[0].n, 0, 'nothing moved');
    assert.equal(refused.body.scope ?? refused.body.body?.scope, 'accept-change:shop_1', 'names the scope to step up for');
    // A step-up without the scope, or for another change, is refused and stays unspent.
    assert.equal((await call('POST', '/teams/shop/changes/1/accept', {}, await su())).status, 401);
    assert.equal((await call('POST', '/teams/shop/changes/1/accept', {}, await su('accept-change:shop_2'))).status, 401);
    assert.equal((await call('POST', '/teams/shop/changes/1/accept', {}, await su('resume:run_1'))).status, 401);
    const ok = await call('POST', '/teams/shop/changes/1/accept', { words: 'Yes, start it' }, await su('accept-change:shop_1'));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual([ok.body.state, ok.body.acceptedSha], ['accepted', pub.body.commit]);
    const rows = await db.system("select decision, actor_id, target, rule, detail from audit where action = 'change-accept' order by seq");
    assert.deepEqual(rows.map((r) => r.decision), ['pending', 'allowed'], 'the pending row is written before main moves');
    assert.equal(rows[0].detail.sha, pub.body.commit);
    const audit = rows[1];
    assert.deepEqual([audit.actor_id, audit.target, audit.rule, audit.detail.words, audit.detail.sha], ['admin', 'cr/1', 'widens-access', 'Yes, start it', pub.body.commit]);
    assert.match(audit.detail.diffHash, /^[0-9a-f]{64}$/);
    const events = await db.system("select type, id, envelope from events where team = 'shop' and type in ('proposal.accepted', 'team.published') order by seq");
    assert.deepEqual(events.map((e) => e.type), ['proposal.accepted', 'team.published']);
    assert.equal(events[1].id, `published-${pub.body.commit}`);
    assert.deepEqual([events[1].envelope.data.via, events[1].envelope.data.version], ['managed', pub.body.commit]);
    // The same commit reported again (say, by a CI that also runs) collapses into the one event.
    const again = await store.appendPublished(db, 'acme', 'shop', { version: pub.body.commit });
    assert.equal(again.duplicate, true);
    assert.equal((await call('POST', '/teams/shop/changes/1/accept', {}, await su())).status, 409, 'accepted once');
  }, { publicUrl: ORIGIN });
});

test('a change that widens nothing is accepted without step-up; a stale one is refused and says to make it again', async () => {
  await plane(async (ctx) => {
    const { call, db } = ctx;
    const { publish } = await managedTeam(ctx);
    const a = await publish((s) => { s.values = { ...s.values, PROJECT_NAME: 'Shop online' }; }, 'Rename', 'a');
    const b = await publish((s) => { s.values = { ...s.values, PROJECT_NAME: 'Shop two' }; }, 'Rename again', 'b');
    assert.deepEqual((await call('GET', `/teams/shop/changes/${a}`)).body.capability, []);
    const ok = await call('POST', `/teams/shop/changes/${a}/accept`, {});
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const stale = await call('POST', `/teams/shop/changes/${b}/accept`, {});
    assert.deepEqual([stale.status, stale.body.type], [409, 'stale']);
    const failed = await db.system("select envelope from events where team = 'shop' and type = 'proposal.failed'");
    assert.deepEqual(failed.map((e) => [e.envelope.data.ref, e.envelope.data.reason]), [[b, 'head-moved']]);
    const closed = await call('POST', `/teams/shop/changes/${b}/close`, {});
    assert.deepEqual([closed.status, closed.body.state], [200, 'closed']);
  }, { publicUrl: ORIGIN });
});

test('red checks refuse: a committed file that is not what sync writes', async () => {
  await plane(async (ctx) => {
    const { call, db } = ctx;
    const { backend } = await managedTeam(ctx);
    const main = (await backend.info()).head.sha;
    const read = await backend.readTeam(main);
    const readme = read.files.find((f) => f.path === 'docs/team/README.md');
    const out = await backend.publish({ base: main, message: 'Hand edit', changes: [{ path: 'docs/team/README.md', content: `${readme.content}\nEdited by hand.\n`, mode: '100644' }] });
    const r = await call('POST', `/teams/shop/changes/${out.pr.number}/accept`, {});
    assert.deepEqual([r.status, r.body.type], [409, 'checks'], JSON.stringify(r.body));
    assert.match(r.body.error, /docs\/team\/README\.md is not what sync writes/);
    const [row] = await db.system('select checks from change_requests where team = $1 and number = $2', ['shop', out.pr.number]);
    assert.deepEqual([row.checks.ok, row.checks.drift], [false, ['docs/team/README.md']]);
  }, { publicUrl: ORIGIN });
});

test('a teammate may not widen itself: its own change is refused, the same change from a person goes through with step-up', async () => {
  await plane(async (ctx) => {
    const { call, su } = ctx;
    const { backend } = await managedTeam(ctx);
    const main = (await backend.info()).head.sha;
    const read = await backend.readTeam(main);
    const { spec } = core.state(read);
    const who = Object.keys(spec.roles).find((s) => spec.roles[s].enabled && !/\*\*Model:\*\* deep/.test(spec.roles[s].brief ?? ''));
    const next = clone(spec);
    setField(next, who, 'Model', 'deep');
    const p = core.plan(read, next);
    const changes = p.changes.map(({ path, content, mode }) => ({ path, content, mode }));
    const mine = await backend.publish({ base: main, message: 'A deeper model for me', changes, authorMember: who, capability: p.capability });
    const r = await call('POST', `/teams/shop/changes/${mine.pr.number}/accept`, {}, await su());
    assert.deepEqual([r.status, r.body.type], [403, 'self-widening'], JSON.stringify(r.body));
    await call('POST', `/teams/shop/changes/${mine.pr.number}/close`, {});
    const theirs = await backend.publish({ base: main, message: 'A deeper model for them', changes, authorMember: null });
    assert.equal((await call('POST', `/teams/shop/changes/${theirs.pr.number}/accept`, {})).status, 401, 'widening needs step-up');
    assert.equal((await call('POST', `/teams/shop/changes/${theirs.pr.number}/accept`, {}, await su(`accept-change:shop_${theirs.pr.number}`))).status, 200);
  }, { publicUrl: ORIGIN });
});

test('rollback opens a change against the current main, so the access it puts back needs step-up again', async () => {
  await plane(async (ctx) => {
    const { call, su, db } = ctx;
    const { publish, first } = await managedTeam(ctx);
    const { spec } = (await call('GET', '/teams/shop/studio/v1/team', undefined, studio())).body;
    const who = Object.keys(spec.roles).find((s) => spec.roles[s].enabled);
    const n = await publish((s) => setField(s, who, 'Model', 'light'), `A lighter model for ${who}`, 'light');
    assert.equal((await call('POST', `/teams/shop/changes/${n}/accept`, {}, await su(`accept-change:shop_${n}`))).status, 200);
    assert.equal((await call('POST', '/teams/shop/rollback', { to: '0'.repeat(40) })).status, 404);
    const rb = await call('POST', '/teams/shop/rollback', { to: first });
    assert.equal(rb.status, 201, JSON.stringify(rb.body));
    assert.deepEqual(rb.body.capability.map((x) => [x.kind, x.subject]), [['model-changed', who]]);
    assert.equal((await call('POST', `/teams/shop/changes/${rb.body.number}/accept`, {})).status, 401);
    const ok = await call('POST', `/teams/shop/changes/${rb.body.number}/accept`, {}, await su(`accept-change:shop_${rb.body.number}`));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    // A new commit with the old tree, on top of main: history only moves forward.
    const [main] = await db.system("select sha, version from managed_refs where team = 'shop' and name = 'main'");
    assert.notEqual(main.sha, first);
    assert.equal(Number(main.version), 3);
    const opened = await db.system("select envelope from events where team = 'shop' and type = 'proposal.opened'");
    assert.equal(opened.length, 1);
  }, { publicUrl: ORIGIN });
});

test('rollback to a version an older kit generated: the old team, synced with today\'s kit, so accept passes (code review L9c)', async () => {
  await plane(async (ctx) => {
    const { call, su } = ctx;
    const { backend, publish } = await managedTeam(ctx);
    // A version whose generated files are not what today's sync writes (as if a 0.21 kit had written them), put on
    // main directly, the way history from before an upgrade is.
    const main1 = (await backend.info()).head.sha;
    const path = 'docs/team/protocols.md';
    const before = (await backend.diff(null, main1)).find((f) => f.path === path).after;
    assert.ok(before.length > 100);
    const teamJson = (await backend.diff(null, main1)).find((f) => f.path === '.agent-team/team.json').after;
    const oldPin = JSON.stringify({ ...JSON.parse(teamJson), kit: 'github:ThePurpleVoid/OrgCraft#v0.20.0' }, null, 2) + '\n';
    const old = await backend.publish({ base: main1, message: 'Written by an older kit', changes: [{ path, mode: '100644', content: `${before}\nA line an older kit wrote.\n` }, { path: '.agent-team/team.json', mode: '100644', content: oldPin }] });
    await backend.accept(old.pr.number, {});
    // Then the team upgraded its pin.
    const up = await backend.publish({ base: old.commit, message: 'Upgrade the kit pin', changes: [{ path: '.agent-team/team.json', mode: '100644', content: teamJson }] });
    await backend.accept(up.pr.number, {});
    const { spec } = (await call('GET', '/teams/shop/studio/v1/team', undefined, studio())).body;
    const who = Object.keys(spec.roles).find((x) => spec.roles[x].enabled);
    const m = await publish((x) => setField(x, who, 'Model', 'light'), 'lighter', 'lighter');
    assert.equal((await call('POST', `/teams/shop/changes/${m}/accept`, {}, await su(`accept-change:shop_${m}`))).status, 200);
    const rb = await call('POST', '/teams/shop/rollback', { to: old.commit });
    assert.equal(rb.status, 201, JSON.stringify(rb.body));
    assert.ok(!rb.body.files?.some((f) => f.path === path), 'the old generated text is not brought back');
    // The old version pinned another kit; the rollback keeps main's pin, since its files come from today's kit.
    assert.ok(!rb.body.files.some((f) => f.path === '.agent-team/team.json'), JSON.stringify(rb.body.files.map((f) => f.path)));
    const ok = await call('POST', `/teams/shop/changes/${rb.body.number}/accept`, {}, await su(`accept-change:shop_${rb.body.number}`));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    // Rolling back to where the team already is changes nothing.
    const head = (await backend.info()).head.sha;
    assert.deepEqual([(await call('POST', '/teams/shop/rollback', { to: head })).status], [409]);
  }, { publicUrl: ORIGIN });
});

test('a team in a code host has no change requests here, and a host never reaches accept', async () => {
  await plane(async ({ call }) => {
    await call('POST', '/teams', { id: 'blog' });
    const r = await call('GET', '/teams/blog/changes');
    assert.deepEqual([r.status, r.body.type], [409, 'not-managed']);
  }, { publicUrl: ORIGIN });
});

test('L40b: a systems change pending on a managed change switches on when the server accepts that change', async () => {
  await plane(async (ctx) => {
    const { call, su } = ctx;
    const { publish } = await managedTeam(ctx);
    const n = await publish((s) => { s.values = { ...s.values, PROJECT_NAME: 'Shop online' }; }, 'Rename', 'l40b');
    const head = (await call('GET', `/teams/shop/changes/${n}`)).body.head;
    const set = { resources: [{ id: 'slack', type: 'slack', secrets: ['SLACK_BOT_TOKEN'] }], bindings: [], expect: 0, pending: { sha: head, pr: n } };
    assert.equal((await call('PUT', '/teams/shop/systems', set, await su('systems:shop'))).status, 200);
    assert.equal((await call('GET', '/teams/shop/systems')).body.version, 0);
    assert.equal((await call('POST', `/teams/shop/changes/${n}/accept`, {})).status, 200);
    const now = (await call('GET', '/teams/shop/systems')).body;
    assert.deepEqual([now.version, now.resources.map((r) => r.id), now.pending], [1, ['slack'], null]);
  }, { publicUrl: ORIGIN });
});

test('a team can be created managed (ADR 0012): POST /teams { backend: "managed" }; github stays the default; anything else is refused', async () => {
  await plane(async ({ call, db }) => {
    const made = await call('POST', '/teams', { id: 'cafe', backend: 'managed' });
    assert.deepEqual([made.status, made.body.backend], [201, 'managed']);
    assert.equal((await call('POST', '/teams', { id: 'shop' })).body.backend, 'github');
    assert.equal((await call('POST', '/teams', { id: 'deli', backend: 'gitlab' })).status, 400);
    assert.deepEqual((await db.system("select id, backend from teams order by id")).map((r) => [r.id, r.backend]), [['cafe', 'managed'], ['shop', 'github']]);
    const read = await call('GET', '/teams/cafe/studio/v1/team', undefined, studio());
    assert.equal(read.body.managed, true, JSON.stringify(read.body).slice(0, 300));
  }, { publicUrl: ORIGIN });
});

test('a managed team runs on its accepted version: the request names only where work lands; roles or briefs in it are refused, never merged', async () => {
  await plane(async ({ call, db, su }) => {
    const repo = { url: 'file:///tmp/work.git', ref: 'main' };
    await call('POST', '/teams', { id: 'cafe', backend: 'managed' });
    await call('POST', '/teams', { id: 'deli' });
    // Nothing accepted yet: no plan, no run.
    assert.deepEqual([(await call('GET', '/teams/cafe/run-plan')).body.ok, (await call('GET', '/teams/cafe/run-plan')).body.type], [false, 'not-published']);
    assert.deepEqual([(await call('POST', '/teams/cafe/runs', { team: { from: 'managed', repo } })).status], [409]);
    // Only managed teams, and only from and repo.
    assert.equal((await call('POST', '/teams/deli/runs', { team: { from: 'managed', repo } })).body.type, 'not-managed');
    for (const extra of [{ roles: [{ slug: 'x', reportsTo: 'owner' }] }, { meetings: [] }, { version: 'a'.repeat(40) }, { summary: 'mine' }, { triggers: [] }]) {
      const r = await call('POST', '/teams/cafe/runs', { team: { from: 'managed', repo, ...extra } });
      assert.deepEqual([r.status, r.body.type], [400, 'managed-roster'], Object.keys(extra)[0]);
    }
    // Accept a first version (the same steps as the Studio), then the plan and the run are that version.
    const empty = await call('GET', '/teams/cafe/studio/v1/team', undefined, studio());
    const tpl = empty.body.templates.find((x) => x.id !== 'almost-empty') ?? empty.body.templates[0];
    const draft = await call('POST', '/teams/cafe/studio/v1/team/from-template', { id: tpl.id, project: 'Cafe', owner: 'Sam', timezone: 'UTC' }, studio());
    const first = await call('POST', '/teams/cafe/studio/v1/team/publish', { spec: draft.body.spec, base: null, message: 'Start' }, studio({ 'idempotency-key': 'c1' }));
    assert.equal((await call('POST', '/teams/cafe/changes/1/accept', {}, await su('accept-change:cafe_1'))).status, 200);
    const plan = (await call('GET', '/teams/cafe/run-plan')).body;
    assert.deepEqual([plan.ok, plan.version], [true, first.body.commit]);
    await call('PUT', '/teams/cafe/budget', { perDay: 100 }, await su());
    const run = await call('POST', '/teams/cafe/runs', { team: { from: 'managed', repo } });
    assert.equal(run.status, 201, JSON.stringify(run.body));
    const [row] = await db.system("select roster from runs where team = 'cafe'");
    assert.deepEqual([row.roster.version, row.roster.repo, row.roster.frontDoor], [first.body.commit, repo, plan.frontDoor]);
    assert.equal(row.roster.roles.length, plan.roles);
  }, { publicUrl: ORIGIN });
});
