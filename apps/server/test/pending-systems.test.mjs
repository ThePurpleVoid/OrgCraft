// L40b: in PR mode a team's systems change waits on its pull request. The admin's confirmation is stored bound to the
// commit and to the version it was confirmed against, and applies only when team.published for that commit arrives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plane } from './helpers.mjs';

const SHA = 'a'.repeat(40), OTHER = 'b'.repeat(40), NEWER = 'c'.repeat(40);
const slack = (perm = 'read') => ({
  resources: [{ id: 'slack', type: 'slack', secrets: ['SLACK_BOT_TOKEN'], tools: { command: 'slack-mcp' } }],
  bindings: [{ role: 'chief-of-staff', resource: 'slack', permission: perm }],
});
async function setup({ call }) {
  await call('POST', '/teams', { id: 'shop' });
  await call('POST', '/teams', { id: 'cafe' });
  const { token } = (await call('POST', '/teams/shop/report-tokens')).body;
  const publish = async (version) => {
    const r = await call('POST', '/teams/shop/reports', { kind: 'published', version, pr: 7 }, { 'x-team-token': token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  };
  return { publish };
}
const systems = async (call) => (await call('GET', '/teams/shop/systems')).body;
/** The publish hook runs after the write commits; wait for it. */
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('not in time'); await new Promise((r) => setTimeout(r, 20)); }
}

test('a pending set applies only when team.published for its exact commit arrives, with an audit row naming the commit', async () => {
  await plane(async ({ call, su, db }) => {
    const { publish } = await setup({ call });
    assert.equal((await call('PUT', '/teams/shop/systems', { ...slack(), pending: { sha: SHA, pr: 7 } }, await su('systems:shop'))).status, 400, 'a pending change names the version it was confirmed against');
    assert.equal((await call('PUT', '/teams/shop/systems', { ...slack(), expect: 0, pending: { sha: 'abc' } }, await su('systems:shop'))).status, 400);
    const put = await call('PUT', '/teams/shop/systems', { ...slack(), expect: 0, pending: { sha: SHA, pr: 7 } }, await su('systems:shop'));
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.deepEqual([put.body.version, put.body.pending, put.body.added], [0, { sha: SHA, pr: 7 }, ['slack']]);
    let now = await systems(call);
    assert.deepEqual([now.version, now.resources, now.pending.sha, now.pending.expect], [0, [], SHA, 0], 'nothing applies before the merge');

    await publish(OTHER);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await systems(call)).version, 0, 'another commit applies nothing');

    await publish(SHA);
    await until(async () => (await systems(call)).version === 1);
    now = await systems(call);
    assert.deepEqual([now.resources.map((r) => r.id), now.pending], [['slack'], null]);
    const rows = await db.system("select action, decision, actor_id, detail from audit where action in ('team.systems', 'team.systems.pending') order by at");
    assert.deepEqual(rows.map((r) => [r.action, r.decision]), [['team.systems.pending', 'allowed'], ['team.systems', 'allowed']]);
    assert.deepEqual([rows[1].detail.sha, rows[1].detail.via, rows[1].detail.added], [SHA, 'published', ['slack']]);
    assert.equal(rows[1].actor_id, rows[0].actor_id, 'recorded as the admin who confirmed it');
  });
});

test('a step-up for another team is refused, a superseded set never applies, and a moved base drops it', async () => {
  await plane(async ({ call, su, db }) => {
    const { publish } = await setup({ call });
    const r = await call('PUT', '/teams/shop/systems', { ...slack(), expect: 0, pending: { sha: SHA } }, await su('systems:cafe'));
    assert.deepEqual([r.status, r.body.scope], [401, 'systems:shop']);

    assert.equal((await call('PUT', '/teams/shop/systems', { ...slack('read'), expect: 0, pending: { sha: SHA } }, await su('systems:shop'))).status, 200);
    assert.equal((await call('PUT', '/teams/shop/systems', { ...slack('write'), expect: 0, pending: { sha: NEWER } }, await su('systems:shop'))).status, 200);
    assert.equal((await systems(call)).pending.sha, NEWER, 'the newer set replaced the older one');
    await publish(SHA);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await systems(call)).version, 0, 'the superseded set never applies');
    const [replaced] = await db.system("select detail from audit where action = 'team.systems.pending' order by at desc limit 1");
    assert.equal(replaced.detail.replaced, SHA);

    // A direct change in between moves the base: the pending set is dropped, never applied over it.
    assert.equal((await call('PUT', '/teams/shop/systems', { resources: [], bindings: [], expect: 0 }, await su('systems:shop'))).status, 200);
    assert.equal((await systems(call)).pending, null, 'a direct change drops the pending set');
    assert.equal((await call('PUT', '/teams/shop/systems', { ...slack('write'), expect: 1, pending: { sha: NEWER } }, await su('systems:shop'))).status, 200);
    await db.system("update team_systems set version = 5 where team = 'shop'");
    await publish(NEWER);
    await until(async () => (await db.system("select count(*)::int as n from audit where action = 'team.systems.pending' and rule = 'base-moved'"))[0].n === 1);
    assert.deepEqual([(await systems(call)).version, (await systems(call)).pending], [5, null]);
  });
});

test('closing the pull request drops the pending set; a set whose commit is already published applies at once', async () => {
  await plane(async ({ call, su }) => {
    const { publish } = await setup({ call });
    assert.equal((await call('PUT', '/teams/shop/systems', { ...slack(), expect: 0, pending: { sha: SHA, pr: 7 } }, await su('systems:shop'))).status, 200);
    assert.deepEqual((await call('DELETE', `/teams/shop/systems/pending?sha=${OTHER}`)).body, { dropped: null }, 'only the named commit');
    assert.deepEqual((await call('DELETE', `/teams/shop/systems/pending?sha=${SHA}`)).body, { dropped: SHA });
    await publish(SHA);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await systems(call)).version, 0);
    // The merge came first: the confirmation applies at once.
    const late = await call('PUT', '/teams/shop/systems', { ...slack(), expect: 0, pending: { sha: SHA } }, await su('systems:shop'));
    assert.deepEqual([late.body.applied, late.body.version], [true, 1]);
  });
});
