// Routing a message's `to` to one teammate (team-json-0.22 section 5.3, local PR L17, test 7): id, name, a type with
// one member, then ownership, lane and Hands to for a type with several, else a refusal that lists them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { covers, laneOf, pathsIn, resolveTo } from '../routing.mjs';
import { fakeRunner, plane, registerRunner } from './helpers.mjs';

// Two support leads, each with one support agent of the same type, plus a lone reviewer.
const roster = {
  frontDoor: 'chief-of-staff',
  roles: [
    { slug: 'chief-of-staff', reportsTo: 'owner', areas: [] },
    { slug: 'support-lead-emea', reportsTo: 'chief-of-staff', areas: [], type: 'support-lead', name: 'Lea', handsTo: ['support-agent-2'] },
    { slug: 'support-lead-us', reportsTo: 'chief-of-staff', areas: [], type: 'support-lead', name: 'Sam' },
    { slug: 'support-agent-2', reportsTo: 'support-lead-emea', areas: ['help/emea/**'], type: 'support-agent', name: 'Maya' },
    { slug: 'support-agent-3', reportsTo: 'support-lead-us', areas: ['help/us/'], type: 'support-agent', name: 'Ana' },
    { slug: 'security-reviewer', reportsTo: 'chief-of-staff', areas: [] },
  ],
};

test('1-3: an id (with #n), a display name, or a type with one member', () => {
  assert.deepEqual(resolveTo(roster, 'support-agent-3', 'chief-of-staff'), { to: 'support-agent-3', how: 'id' });
  assert.deepEqual(resolveTo(roster, 'support-agent-3#2', 'chief-of-staff'), { to: 'support-agent-3#2', how: 'id' });
  assert.deepEqual(resolveTo(roster, 'maya', 'chief-of-staff'), { to: 'support-agent-2', how: 'name' });
  assert.deepEqual(resolveTo(roster, 'security-reviewer', 'support-agent-2').to, 'security-reviewer', 'every team from before 0.22 routes as it did');
  assert.deepEqual(resolveTo({ roles: [...roster.roles, { slug: 'qa-1', reportsTo: 'chief-of-staff', type: 'qa' }] }, 'qa', 'chief-of-staff'), { to: 'qa-1', how: 'type' });
});

test('4: a type with several goes to the one that owns a path the message names', () => {
  assert.deepEqual(resolveTo(roster, 'support-agent', 'security-reviewer', { where: 'help/us/refunds.md, step 2' }), { to: 'support-agent-3', how: 'ownership' });
  assert.deepEqual(resolveTo(roster, 'support-agent', 'security-reviewer', { changed: 'Edited ./help/emea/faq.md and README' }).to, 'support-agent-2');
});

test('5: else the one in the sender\'s lane; 6: else the one the sender\'s Hands to lists', () => {
  assert.equal(laneOf('support-agent-3', roster.roles), 'support-lead-us');
  assert.deepEqual(resolveTo(roster, 'support-agent', 'support-lead-us'), { to: 'support-agent-3', how: 'lane' });
  // The lead's own lane has one agent; and a sender outside both lanes falls to its Hands to.
  const wired = { roles: roster.roles.map((r) => (r.slug === 'security-reviewer' ? { ...r, handsTo: ['support-agent-3'] } : r)) };
  assert.deepEqual(resolveTo(wired, 'support-agent', 'security-reviewer'), { to: 'support-agent-3', how: 'hands-to' });
});

test('7: otherwise refused, listing every teammate of the type; it never picks silently', () => {
  const r = resolveTo(roster, 'support-agent', 'security-reviewer');
  assert.equal(r.problem, 'support-agent has 2 teammates: support-agent-2 (Maya, reports to support-lead-emea), support-agent-3 (Ana, reports to support-lead-us). Pick one.');
  assert.match(resolveTo(roster, 'nobody', 'chief-of-staff').problem, /not a teammate, a name or a role/);
  const twins = { roles: [...roster.roles, { slug: 'x-1', reportsTo: 'chief-of-staff', name: 'maya' }] };
  assert.match(resolveTo(twins, 'Maya', 'chief-of-staff').problem, /name of 2 teammates.*Pick one by id/);
});

test('off the wiring: delivered, and noted', () => {
  assert.deepEqual(resolveTo(roster, 'support-agent-3', 'support-lead-emea'), { to: 'support-agent-3', how: 'id', offWiring: true });
  assert.equal(resolveTo(roster, 'support-agent-2', 'support-lead-emea').offWiring, undefined);
});

test('paths and areas', () => {
  assert.deepEqual(pathsIn('see apps/web/cart.tsx: and https://x.com/a, then ./docs/a.md.'), ['apps/web/cart.tsx', 'docs/a.md']);
  assert.ok(covers('apps/web/', 'apps/web/cart.tsx') && covers('apps/web', 'apps/web') && !covers('apps/web', 'apps/webby/x'));
  assert.ok(covers('apps/**/*.tsx', 'apps/web/cart.tsx') && !covers('apps/*.tsx', 'apps/web/cart.tsx'));
});

test('through the team tool: a handoff by type is stamped with the member, a name works, and an ambiguous one is refused', async () => {
  await plane(async ({ call, base, su }) => {
    await call('POST', '/teams', { id: 'desk' });
    await call('PUT', '/teams/desk/budget', { perDay: 1000, sessions: 5 }, await su());
    const r = await registerRunner(call);
    const runner = await fakeRunner(base, r.key, { runner: r.id, maxSessions: 8 });
    const team = { version: 'v1', roles: roster.roles.map((x, i) => (i === 0 ? { ...x, brief: 'You are the front door.' } : x)) };
    assert.equal((await call('POST', '/teams/desk/runs', { team })).status, 201);
    await call('POST', '/teams/desk/chat', { text: 'go' });
    const front = (await runner.next((f) => f.op === 'session.start' && f.body.role === 'chief-of-staff')).body;
    const tool = (name, input) => call('POST', `/sessions/${front.session}/tools/${name}`, input, { authorization: `Bearer ${front.token}` });
    const handoff = { task: 'Refund', changed: 'nothing yet', verify: 'check help/us/refunds.md', doneWhen: 'refunded' };
    const amb = await tool('handoff', { ...handoff, to: 'support-agent', verify: 'look' });
    assert.equal(amb.status, 422);
    assert.match(JSON.stringify(amb.body), /support-agent has 2 teammates: .*Pick one/);
    const byPath = await tool('handoff', { ...handoff, to: 'support-agent', changed: 'help/us/refunds.md needs a line' });
    assert.equal(byPath.status, 200, JSON.stringify(byPath.body));
    assert.deepEqual([byPath.body.to, byPath.body.routedBy], ['support-agent-3', 'ownership']);
    const start = (await runner.next((f) => f.op === 'session.start' && f.body.role === 'support-agent-3')).body;
    assert.deepEqual([start.type, start.name], ['support-agent', 'Ana'], 'the session knows its type and name');
    const [ev] = (await call('GET', '/teams/desk/events?type=message.handoff')).body.events;
    assert.deepEqual([ev.data.to, ev.data.toAsked, ev.data.routedBy], ['support-agent-3', 'support-agent', 'ownership']);
    const byName = await tool('handoff', { ...handoff, to: 'Maya' });
    assert.deepEqual([byName.status, byName.body.to, byName.body.routedBy], [200, 'support-agent-2', 'name']);
    await runner.next((f) => f.op === 'session.start' && f.body.role === 'support-agent-2');
    // A run's roster checks the new fields.
    const bad = await call('POST', '/teams/desk/runs', { team: { roles: [{ slug: 'a', reportsTo: 'owner', handsTo: ['Not An Id'] }] } });
    assert.equal(bad.status, 400);
  });
});
