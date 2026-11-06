// team.published from the repository (report.mjs published, run by the team's CI on main): through the report route
// and its token, once per commit, so the Studio's fast path and CI collapse into one event.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plane } from './helpers.mjs';
import { publishedId } from '../store.mjs';

const SHA = 'b'.repeat(40);
const body = { kind: 'published', version: SHA, publishedAt: '2026-11-06T10:10:00Z', pr: 12, roles: ['cto', 'web-dev'], off: ['designer'], plan: { 'web-dev': { choice: 'pause' } }, changes: ['.agent-team/team.json'], by: 'octo', source: 'report.mjs' };

test('a publish from CI is stored once per commit and the rollout reads it', async () => {
  await plane(async ({ call }) => {
    await call('POST', '/teams', { id: 'shop' });
    const { token } = (await call('POST', '/teams/shop/report-tokens')).body;
    const post = (b) => call('POST', '/teams/shop/reports', b, { 'x-team-token': token });
    assert.equal((await call('POST', '/teams/shop/reports', body)).status, 401, 'the report token is required');
    let r = await post(body);
    assert.deepEqual([r.status, r.body], [200, { ok: true, id: `published-${SHA}`, duplicate: false }]);
    // The Studio's fast path posts the same publish with the same id: it collapses.
    const studio = { specversion: '1.0', id: publishedId(SHA.toUpperCase()), type: 'team.published', version: 1, source: '/tenants/acme/teams/shop', tenant: 'acme', team: 'shop', time: '2026-11-06T10:10:05Z', actor: { kind: 'person', id: 'admin' }, data: { version: SHA } };
    assert.ok((await call('POST', '/teams/shop/events', { events: [studio] })).status < 300);
    r = await post(body);
    assert.deepEqual([r.status, r.body.duplicate], [200, true]);
    const events = (await call('GET', '/teams/shop/events?type=team.published')).body.events;
    assert.equal(events.length, 1);
    assert.deepEqual([events[0].actor, events[0].time, events[0].data.via, events[0].data.by], [{ kind: 'system', id: 'repository' }, '2026-11-06T10:10:00.000Z', 'repository', 'octo']);
    r = await call('GET', '/teams/shop/rollout');
    assert.deepEqual([r.body.version, r.body.pr, r.body.publishedAt, r.body.roles.map((x) => [x.role, x.state])], [SHA, 12, '2026-11-06T10:10:00.000Z', [['cto', 'no-report'], ['designer', 'off'], ['web-dev', 'no-report']]]);
  });
});

test('a publish that is not well formed is refused, and nothing is stored', async () => {
  await plane(async ({ call }) => {
    await call('POST', '/teams', { id: 'shop' });
    const { token } = (await call('POST', '/teams/shop/report-tokens')).body;
    const post = (b) => call('POST', '/teams/shop/reports', { ...body, ...b }, { 'x-team-token': token });
    for (const [b, why] of [
      [{ version: SHA.slice(0, 12) }, /40 hex/], [{ publishedAt: 'soon' }, /ISO/], [{ pr: '12' }, /pull request number/],
      [{ roles: ['Not A Slug'] }, /roles is a list/], [{ off: 'designer' }, /off is a list/], [{ plan: { cto: { choice: 'explode' } } }, /plan for cto/],
      [{ plan: { cto: { choice: 'handoff', to: '../x' } } }, /plan for cto/], [{ changes: Array(201).fill('a') }, /200 paths/],
    ]) {
      const r = await post(b);
      assert.equal(r.status, 400, JSON.stringify(b));
      assert.match(r.body.error ?? r.body.detail ?? JSON.stringify(r.body), why);
    }
    assert.equal((await call('GET', '/teams/shop/events?type=team.published')).body.events.length, 0);
  });
});
