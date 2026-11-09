// Deliveries are keyed per team (migration 013). An event id is unique only within its team (events: unique (team, id)),
// and some ids are deterministic (published-<sha>, and N2's fired-<trigger>-<slot>), so two teams, even in two tenants,
// can hold the same event id. Before 013 the delivery index had no team, and the second team's wake was dropped
// silently by `on conflict do nothing` (review-2 D1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../store.mjs';
import { plane } from './helpers.mjs';

const roster = { frontDoor: 'lead', roles: [{ slug: 'lead', reportsTo: 'owner' }, { slug: 'editor', reportsTo: 'lead' }] };
const handoff = (team, id) => ({ specversion: '1.0', id, source: `/tenants/${team === 'shop' ? 'acme' : 'globex'}/teams/${team}`, type: 'message.handoff', time: new Date().toISOString(), tenant: team === 'shop' ? 'acme' : 'globex', team, version: 1, actor: { kind: 'role', id: 'lead' }, data: { to: 'editor', text: 'Plan today\'s posts.' } });

test('two teams in two tenants with the same event id each get their delivery', async () => {
  await plane(async ({ db, m3 }) => {
    await store.ensureTenant(db, 'globex');
    for (const [tenant, team] of [['acme', 'shop'], ['globex', 'news']]) {
      await store.createTeam(db, tenant, { id: team });
      await db.system("insert into runs(id, tenant, team, state, roster, started_by) values ($1, $2, $3, 'running', $4, 'test')", [`run_${team}`, tenant, team, JSON.stringify(roster)]);
    }
    const same = 'fired-weekday-plan-2026-11-09T09:00:00Z';
    await m3.appendEvents('acme', 'shop', [handoff('shop', same)]);
    await m3.appendEvents('globex', 'news', [handoff('news', same)]);
    const rows = await db.system('select tenant, team, role from deliveries where event = $1 order by tenant', [same]);
    assert.deepEqual(rows.map((r) => [r.tenant, r.team, r.role]), [['acme', 'shop', 'editor'], ['globex', 'news', 'editor']], 'both teams wake their editor');
    // Retrying the same event in the same team still makes no second delivery.
    await m3.appendEvents('globex', 'news', [handoff('news', same)]);
    assert.equal((await db.system('select count(*)::int as n from deliveries where team = $1 and event = $2', ['news', same]))[0].n, 1);
  }, { tickMs: 0 });
});

test('/me/stream resume by an event id two teams share replays from the earlier one (never skips)', async () => {
  await plane(async ({ db }) => {
    await store.createTeam(db, 'acme', { id: 'shop' });
    await store.createTeam(db, 'acme', { id: 'blog' });
    const ev = (team, id) => ({ specversion: '1.0', id, source: `/tenants/acme/teams/${team}`, type: 'report.status', time: new Date().toISOString(), tenant: 'acme', team, version: 1, actor: { kind: 'role', id: 'lead' }, data: { status: 'idle' } });
    await store.append(db, 'acme', 'shop', [ev('shop', 'published-abc')]);
    await store.append(db, 'acme', 'blog', [ev('blog', 'between')]);
    await store.append(db, 'acme', 'blog', [ev('blog', 'published-abc')]);
    const seq = await store.tenantSeqOf(db, 'acme', 'published-abc');
    const after = (await store.tenantEvents(db, 'acme', { after: seq })).map((e) => `${e.event.team}/${e.event.id}`);
    assert.ok(after.includes('blog/between'), `nothing between the two is skipped: ${after}`);
  }, { tickMs: 0 });
});
