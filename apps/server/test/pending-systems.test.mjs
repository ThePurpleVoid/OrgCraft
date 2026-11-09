// L40b: in PR mode a team's systems change waits on its pull request. The admin's confirmation is stored bound to the
// commit and to the version it was confirmed against, and applies only when team.published for that commit arrives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plane } from './helpers.mjs';
import { canonicalSystemsHash } from '../../../packages/team-model/node.mjs';

const SHA = 'a'.repeat(40), OTHER = 'b'.repeat(40), NEWER = 'c'.repeat(40);
const slack = (perm = 'read') => ({
  resources: [{ id: 'slack', type: 'slack', secrets: ['SLACK_BOT_TOKEN'], tools: { command: 'slack-mcp' } }],
  bindings: [{ role: 'chief-of-staff', resource: 'slack', permission: perm }],
});
async function setup({ call }) {
  await call('POST', '/teams', { id: 'shop' });
  await call('POST', '/teams', { id: 'cafe' });
  const { token } = (await call('POST', '/teams/shop/report-tokens')).body;
  const publish = async (version, extra = {}) => {
    const r = await call('POST', '/teams/shop/reports', { kind: 'published', version, pr: 7, ...extra }, { 'x-team-token': token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  };
  return { publish };
}
const systems = async (call) => (await call('GET', '/teams/shop/systems')).body;

test('a published commit never switches a pending set on by itself: not a report-token publish, not a posted event', async () => {
  await plane(async ({ call, su, db }) => {
    const { publish } = await setup({ call });
    assert.equal((await call('PUT', '/teams/shop/systems', { ...slack(), pending: { sha: SHA, pr: 7 } }, await su('systems:shop'))).status, 400, 'a pending change names the version it was confirmed against');
    assert.equal((await call('PUT', '/teams/shop/systems', { ...slack(), expect: 0, pending: { sha: 'abc' } }, await su('systems:shop'))).status, 400);
    const put = await call('PUT', '/teams/shop/systems', { ...slack(), expect: 0, pending: { sha: SHA, pr: 7 } }, await su('systems:shop'));
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.deepEqual([put.body.version, put.body.pending, put.body.added], [0, { sha: SHA, pr: 7, contentHash: canonicalSystemsHash(slack()) }, ['slack']]);
    const now = await systems(call);
    assert.deepEqual([now.version, now.resources, now.pending.sha, now.pending.expect], [0, [], SHA, 0], 'nothing applies before the merge');
    // Security sev2: the report token (every teammate and CI hold it) and a posted event can both say "published".
    await publish(SHA);
    assert.equal((await systems(call)).pending.ready, null, 'no systemsHash (an older kit): neither a match nor a drop');
    // A merge commit has another sha: the CI's systemsHash matches by content, and only marks it ready.
    await publish(NEWER, { systemsHash: canonicalSystemsHash({ bindings: slack().bindings, resources: slack().resources }) });
    const ready = (await systems(call)).pending;
    assert.deepEqual([ready.sha, ready.ready.sha, ready.ready.by], [SHA, NEWER, 'ci']);
    const said = await db.system("select envelope from events where team = 'shop' and type = 'systems.pending.ready'");
    assert.deepEqual(said.map((e) => [e.envelope.data.sha, e.envelope.data.publishedSha, e.envelope.data.by]), [[SHA, NEWER, 'ci']]);
    assert.equal((await call('GET', '/teams/shop/chat')).body.items.filter((e) => e.type === 'systems.pending.ready').length, 1, 'shown in Chat');
    const forged = { specversion: '1.0', id: `published-${SHA}`, source: '/tenants/acme/teams/shop', type: 'team.published', time: new Date().toISOString(), tenant: 'acme', team: 'shop', version: 1, actor: { kind: 'system', id: 'repository' }, data: { version: SHA, via: 'managed' } };
    await call('POST', '/teams/shop/events', { events: [{ ...forged, id: 'published-x' }] });
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual([(await systems(call)).version, (await systems(call)).pending.sha], [0, SHA], 'still pending');

    // "Switch on now": an admin says the pull request merged, with a fresh step-up for the team.
    assert.equal((await call('POST', '/teams/shop/systems/pending/apply', { sha: OTHER }, await su('systems:shop'))).status, 409, 'another commit');
    assert.equal((await call('POST', '/teams/shop/systems/pending/apply', { sha: SHA })).status, 401);
    assert.equal((await call('POST', '/teams/shop/systems/pending/apply', { sha: SHA }, await su('systems:cafe'))).status, 401);
    const on = await call('POST', '/teams/shop/systems/pending/apply', { sha: SHA }, await su('systems:shop'));
    assert.deepEqual([on.status, on.body.applied, on.body.version, on.body.added], [200, true, 1, ['slack']]);
    assert.deepEqual([(await systems(call)).resources.map((r) => r.id), (await systems(call)).pending], [['slack'], null]);
    const rows = await db.system("select action, actor_id, detail from audit where action in ('team.systems', 'team.systems.pending') order by at");
    assert.deepEqual(rows.map((r) => r.action), ['team.systems.pending', 'team.systems']);
    assert.deepEqual([rows[1].detail.sha, rows[1].detail.via, rows[1].detail.switchedOnBy, rows[1].detail.ciReported], [SHA, 'switched-on', rows[0].actor_id, true]);
  });
});

test('a step-up for another team is refused, a superseded set never applies, and a moved base drops it and tells the owner', async () => {
  await plane(async ({ call, su, db }) => {
    await setup({ call });
    const r = await call('PUT', '/teams/shop/systems', { ...slack(), expect: 0, pending: { sha: SHA } }, await su('systems:cafe'));
    assert.deepEqual([r.status, r.body.scope], [401, 'systems:shop']);

    assert.equal((await call('PUT', '/teams/shop/systems', { ...slack('read'), expect: 0, pending: { sha: SHA } }, await su('systems:shop'))).status, 200);
    assert.equal((await call('PUT', '/teams/shop/systems', { ...slack('write'), expect: 0, pending: { sha: NEWER } }, await su('systems:shop'))).status, 200);
    assert.equal((await systems(call)).pending.sha, NEWER, 'the newer set replaced the older one');
    assert.equal((await call('POST', '/teams/shop/systems/pending/apply', { sha: SHA }, await su('systems:shop'))).status, 409, 'the superseded set never applies');
    const [replaced] = await db.system("select detail from audit where action = 'team.systems.pending' order by at desc limit 1");
    assert.equal(replaced.detail.replaced, SHA);

    // A direct change in between moves the base: the pending set is dropped, never applied over it.
    assert.equal((await call('PUT', '/teams/shop/systems', { resources: [], bindings: [], expect: 0 }, await su('systems:shop'))).status, 200);
    assert.equal((await systems(call)).pending, null, 'a direct change drops the pending set');
    assert.equal((await call('PUT', '/teams/shop/systems', { ...slack('write'), expect: 1, pending: { sha: NEWER } }, await su('systems:shop'))).status, 200);
    // Security: the person's dialog showed other content (another admin re-PUT the same sha): 409, nothing spent.
    const seen = await su('systems:shop');
    const stale = await call('POST', '/teams/shop/systems/pending/apply', { sha: NEWER, contentHash: canonicalSystemsHash({ resources: slack().resources, bindings: slack().bindings }) }, seen);
    assert.deepEqual([stale.status, stale.body.type], [409, 'pending-changed']);
    assert.equal((await call('POST', '/teams/shop/systems/pending/apply', { sha: NEWER, contentHash: 'X' }, seen)).status, 400);
    assert.equal((await systems(call)).pending.sha, NEWER, 'kept for the person to look again');
    assert.equal((await systems(call)).pending.contentHash, canonicalSystemsHash({ resources: slack('write').resources, bindings: slack('write').bindings }));
    await db.system("update team_systems set version = 5 where team = 'shop'");
    const token = await su('systems:shop');
    const late = await call('POST', '/teams/shop/systems/pending/apply', { sha: NEWER }, token);
    assert.deepEqual([late.status, late.body.type], [409, 'pending-dropped']);
    assert.equal((await db.system('select count(*)::int as n from step_up_tokens where used_at is null and id = $1', [token['x-step-up'].split('.')[0]]))[0].n, 1, 'the step-up was not spent');
    assert.deepEqual([(await systems(call)).version, (await systems(call)).pending], [5, null]);
    // Code review sev4: the owner is told, not only the audit.
    const dropped = await db.system("select envelope from events where team = 'shop' and type = 'systems.pending.dropped'");
    assert.deepEqual(dropped.map((e) => [e.envelope.data.sha, e.envelope.data.reason]), [[NEWER, 'base-moved']]);
  });
});

test('closing the pull request drops the pending set; an expired one is dropped at the next run start', async () => {
  await plane(async ({ call, su, db }) => {
    await setup({ call });
    assert.equal((await call('PUT', '/teams/shop/systems', { ...slack(), expect: 0, pending: { sha: SHA, pr: 7 } }, await su('systems:shop'))).status, 200);
    assert.deepEqual((await call('DELETE', `/teams/shop/systems/pending?sha=${OTHER}`)).body, { dropped: null }, 'only the named commit');
    assert.deepEqual((await call('DELETE', `/teams/shop/systems/pending?sha=${SHA}`)).body, { dropped: SHA });
    assert.equal((await call('POST', '/teams/shop/systems/pending/apply', { sha: SHA }, await su('systems:shop'))).status, 409);
    const events = await db.system("select envelope from events where team = 'shop' and type = 'systems.pending.dropped'");
    assert.deepEqual(events.map((e) => e.envelope.data.reason), ['withdrawn']);

    assert.equal((await call('PUT', '/teams/shop/systems', { ...slack(), expect: 0, pending: { sha: SHA } }, await su('systems:shop'))).status, 200);
    await db.system("update team_systems_pending set expires_at = now() - interval '1 minute' where team = 'shop'");
    assert.equal((await call('PUT', '/teams/shop/budget', { perDay: 1000 }, await su())).status, 200);
    await call('POST', '/teams/shop/runs', { team: { version: 'abc123', roles: [{ slug: 'chief-of-staff', reportsTo: 'owner', areas: [] }] } });
    assert.equal((await systems(call)).pending, null);
    assert.deepEqual((await db.system("select envelope from events where team = 'shop' and type = 'systems.pending.dropped'")).map((e) => e.envelope.data.reason), ['withdrawn', 'expired']);
  });
});

test('the same pull request published with another hash drops the set; apply without the CI\'s mark is allowed and says so', async () => {
  await plane(async ({ call, su, db }) => {
    const { publish } = await setup({ call });
    assert.equal((await call('PUT', '/teams/shop/systems', { ...slack(), expect: 0, pending: { sha: SHA, pr: 7 } }, await su('systems:shop'))).status, 200);
    await publish(OTHER, { pr: 8, systemsHash: canonicalSystemsHash({}) });
    assert.equal((await systems(call)).pending.sha, SHA, 'another pull request with another hash: nothing');
    await publish(NEWER, { pr: 7, systemsHash: canonicalSystemsHash({}) });
    assert.equal((await systems(call)).pending, null, 'pull request 7 merged without these systems');
    const dropped = await db.system("select envelope from events where team = 'shop' and type = 'systems.pending.dropped'");
    assert.deepEqual(dropped.map((e) => e.envelope.data.reason), ['merged-different']);

    assert.equal((await call('PUT', '/teams/shop/systems', { ...slack(), expect: 0, pending: { sha: SHA } }, await su('systems:shop'))).status, 200);
    const on = await call('POST', '/teams/shop/systems/pending/apply', { sha: SHA }, await su('systems:shop'));
    assert.equal(on.status, 200, 'by design: an admin with a step-up can set systems directly anyway');
    const [row] = await db.system("select detail from audit where action = 'team.systems' order by at desc limit 1");
    assert.equal(row.detail.ciReported, false);
  });
});
