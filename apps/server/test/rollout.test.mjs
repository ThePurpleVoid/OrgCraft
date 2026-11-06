// GET /teams/{team}/rollout (demo step 17): the latest team.published event, joined with the board's team versions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plane } from './helpers.mjs';
import { fromKitRow } from '../../../packages/events/index.mjs';
import { toRow } from '../../../tools/board.mjs';

const NEW = 'bbbbbbbbbbbb', OLD = 'aaaaaaaaaaaa';
const report = (role, status, time, v) => fromKitRow(toRow({ role, kind: 'status', status, at: time, task: `${role} task`, ...(v ? { team_version: v } : {}) }), { tenant: 'acme', team: 'shop' });

test('the rollout reads the latest publish and the versions roles report', async () => {
  let clock = new Date('2026-11-06T11:00:00Z');
  await plane(async ({ call }) => {
    await call('POST', '/teams', { id: 'shop', name: 'Shop' });
    let r = await call('GET', '/teams/shop/rollout');
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.version, r.body.summary], [null, null], 'nothing published yet');
    const published = { specversion: '1.0', id: 'ev_pub', type: 'team.published', version: 1, source: '/tenants/acme/teams/shop', tenant: 'acme', team: 'shop', time: '2026-11-06T10:10:00.000Z',
      actor: { kind: 'person', id: 'admin' }, subject: 'team', data: { version: NEW, pr: 42, changes: ['.agent-team/team.json'], by: 'admin', roles: ['cto', 'web-dev', 'cpo'], off: ['designer'], plan: { 'web-dev': { choice: 'pause' } } } };
    const add = await call('POST', '/teams/shop/events', { events: [published, report('cto', 'idle', '2026-11-06T10:20:00.000Z', NEW), report('web-dev', 'working', '2026-11-06T10:21:00.000Z', OLD),
      report('cpo', 'idle', '2026-11-06T10:22:00.000Z'), report('designer', 'idle', '2026-11-06T10:05:00.000Z', OLD)] });
    assert.ok(add.status < 300, JSON.stringify(add.body));
    r = await call('GET', '/teams/shop/rollout');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.roles.map((x) => [x.role, x.state]), [['cpo', 'unknown'], ['cto', 'moved'], ['designer', 'off'], ['web-dev', 'finishing']]);
    assert.deepEqual(r.body.roles.find((x) => x.role === 'web-dev').plan, { choice: 'pause' });
    assert.deepEqual([r.body.name, r.body.pr, r.body.summary.moved, r.body.summary.of], ['bbbbbbb, published 6 Nov', 42, 1, 2]);
    // Naming a version: every role that reports, measured against it.
    r = await call('GET', `/teams/shop/rollout?version=${OLD}&publishedAt=2026-11-06T10:00:00Z`);
    assert.deepEqual(r.body.roles.map((x) => [x.role, x.state]), [['cpo', 'unknown'], ['cto', 'next-task'], ['designer', 'moved'], ['web-dev', 'moved']]);
    assert.equal((await call('GET', '/teams/shop/rollout?version=nope')).status, 400);
  }, { now: () => clock });
});
