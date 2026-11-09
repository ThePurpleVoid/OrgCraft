// Kit 0.22 change safety (team-json-0.22 §5.4, test 8) and the capability diff (ADR 0013 rule 2, architecture S2-09).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capabilityDiff, diffTeams, impact, importLayer, selfCapability } from '../packages/team-model/index.mjs';
import { loadKit } from '../packages/team-model/node.mjs';

const kit = loadKit();
const teamJson = (extra = {}) => JSON.stringify({ kit: 'github:ThePurpleVoid/OrgCraft#v0.22.0', preset: 'engineering', include: [], exclude: [], values: { PROJECT_NAME: 'Acme' }, ...extra }, null, 2) + '\n';
const member = (name, type = 'backend-dev', extra = []) => [`# ${name}`, '', `**Based on:** ${type}`, '**Reports to:** cto', ...extra, '', '## Owns (writes) (replace)', 'Nothing yet.'].join('\n') + '\n';
const team = (files = {}, extra = {}) => importLayer({ 'team.json': teamJson(extra), ...files }, kit);
const kinds = (changes) => changes.map((c) => [c.kind, c.role]);
const clone = (x) => JSON.parse(JSON.stringify(x));

test('diffTeams: a new teammate is member-added, a kit role switched on is still role-added', () => {
  const published = team();
  const draft = team({ 'roles/backend-dev-2.extend.md': member('Maya') });
  assert.deepEqual(kinds(diffTeams(published, draft, kit)), [['member-added', 'backend-dev-2']]);
  assert.equal(diffTeams(published, draft, kit)[0].type, 'backend-dev');
  const on = team({}, { include: ['cmo'] });
  assert.deepEqual(kinds(diffTeams(published, on, kit)), [['role-added', 'cmo']]);
});

test('diffTeams: a name change alone is member-renamed, and impact applies it at once', () => {
  const published = team({ 'roles/backend-dev-2.extend.md': member('Maya') });
  const draft = team({ 'roles/backend-dev-2.extend.md': member('Mia') });
  const changes = diffTeams(published, draft, kit);
  assert.deepEqual(changes.map((c) => [c.kind, c.role, c.from, c.to]), [['member-renamed', 'backend-dev-2', 'Maya', 'Mia']]);
  const [item] = impact(changes, { source: 'runner', roles: { 'backend-dev-2': { state: 'working', task: 'x' } } });
  assert.deepEqual([item.severity, item.recommended, item.choices], ['safe', 'apply-now', ['apply-now']]);
});

test('diffTeams: Based on changing is type-changed, treated as a brief change (and no separate brief item)', () => {
  const published = team({ 'roles/backend-dev-2.extend.md': member('Maya') });
  const draft = team({ 'roles/backend-dev-2.extend.md': member('Maya', 'web-dev') });
  const changes = diffTeams(published, draft, kit);
  const t = changes.find((c) => c.kind === 'type-changed');
  assert.deepEqual([t.from, t.to], ['backend-dev', 'web-dev']);
  assert.ok(!changes.some((c) => c.kind === 'brief'));
  const busy = impact([t], { source: 'runner', roles: { 'backend-dev-2': { state: 'working' } } })[0];
  assert.deepEqual([busy.severity, busy.recommended], ['choice', 'next-task']);
  assert.equal(impact([t])[0].severity, 'safe');
});

test('diffTeams: Pool is its own kind; shrinking lets the extra sessions finish first', () => {
  const published = team({ 'roles/backend-dev-2.extend.md': member('Maya', 'backend-dev', ['**Pool:** 3']) });
  const draft = team({ 'roles/backend-dev-2.extend.md': member('Maya', 'backend-dev', ['**Pool:** 2']) });
  const changes = diffTeams(published, draft, kit);
  assert.deepEqual(changes.map((c) => [c.kind, c.from, c.to]), [['pool', 3, 2]]);
  const [item] = impact(changes);
  assert.deepEqual([item.severity, item.note], ['safe', 'the extra sessions finish their task first']);
});

test('diffTeams: structured Hands to changes are hands-to, not a brief change; queued hand-offs to a dropped target offer reroute', () => {
  const hands = (lines) => member('Maya', 'backend-dev', []) + `\n## Hands to (replace)\n${lines.join('\n')}\n`;
  const published = team({ 'roles/backend-dev-2.extend.md': hands(['- qa-web: the change', '- security-reviewer: always']) });
  const draft = team({ 'roles/backend-dev-2.extend.md': hands(['- qa-web: the change', '- web-dev: the API change']) });
  const changes = diffTeams(published, draft, kit);
  assert.deepEqual(kinds(changes), [['hands-to', 'backend-dev-2']]);
  assert.deepEqual([changes[0].removed, changes[0].added], [['security-reviewer'], ['web-dev']]);
  assert.equal(impact(changes)[0].severity, 'safe');
  const [queued] = impact(changes, { source: 'runner', roles: { 'security-reviewer': { state: 'idle', queuedFrom: { 'backend-dev-2': 2 } } } });
  assert.deepEqual([queued.severity, queued.choices, queued.recommended], ['choice', ['reroute-queued', 'keep-queued'], 'reroute-queued']);
  // A prose line changing alongside is still a brief change.
  const prose = team({ 'roles/backend-dev-2.extend.md': hands(['- qa-web: the change', '- web-dev: the API change', 'Design threads, before launch']) });
  assert.deepEqual(kinds(diffTeams(published, prose, kit)).map(([k]) => k).sort(), ['brief', 'hands-to']);
});

test('impact: switching off a teammate with hand-offs addressed to its role offers reroute-queued', () => {
  const published = team({ 'roles/backend-dev-2.extend.md': member('Maya') });
  const draft = team({ 'roles/backend-dev-2.extend.md': member('Maya') }, { exclude: ['backend-dev-2'] });
  const changes = diffTeams(published, draft, kit);
  assert.deepEqual(kinds(changes), [['role-off', 'backend-dev-2']]);
  const idle = impact(changes, { source: 'runner', roles: { 'backend-dev-2': { state: 'idle', queuedByType: 3 } } })[0];
  assert.deepEqual([idle.severity, idle.choices, idle.recommended], ['choice', ['reroute-queued', 'off-at-merge'], 'reroute-queued']);
  const working = impact(changes, { source: 'runner', roles: { 'backend-dev-2': { state: 'working', queuedByType: 1 } } })[0];
  assert.ok(working.choices.includes('reroute-queued'));
  assert.deepEqual(impact(changes, { source: 'runner', roles: {} })[0].choices, ['off-at-merge'], 'nothing queued: as before');
});

test('capabilityDiff: a team with no changes widens nothing, and narrowing is not listed', () => {
  const spec = team();
  assert.deepEqual(capabilityDiff(spec, clone(spec), kit), []);
  const published = team({ 'roles/backend-dev-2.extend.md': member('Maya', 'backend-dev', ['**Pool:** 3']) });
  const draft = team({ 'roles/backend-dev-2.extend.md': member('Maya', 'backend-dev', ['**Pool:** 1']) }, { exclude: ['cmo'] });
  assert.deepEqual(capabilityDiff(published, draft, kit), []);
});

test('capabilityDiff: seats, Based on, bindings, areas, model, Pool, reviewers, checks and systems', () => {
  const published = team({ 'roles/backend-dev-2.extend.md': member('Maya') + '\n## Hands to (replace)\n- security-reviewer: always\n- web-dev: the API\n' });
  published.resources = { resources: [{ id: 'db', type: 'postgres', secrets: ['DB_URL'] }], bindings: [{ role: 'backend-dev', resource: 'db', permission: 'read' }, { role: 'backend-dev-2', resource: 'db', permission: 'read' }] };
  published.gates = { all: ['npm test'], targets: { web: [{ name: 'lint', run: 'npm run lint' }, { name: 'e2e', run: 'npm run e2e' }] } };
  published.ownership = { rows: [{ path: 'api/', writer: 'backend-dev' }] };
  const draft = team({
    'roles/backend-dev-2.extend.md': member('Maya', 'backend-dev', ['**Pool:** 2', '**Model:** deep']) + '\n## Hands to (replace)\n- web-dev: the API\n',
    'roles/backend-dev-3.extend.md': member('Leo'),
  });
  draft.resources = { resources: [{ id: 'db', type: 'postgres', secrets: ['DB_URL', 'DB_ADMIN_URL'] }], bindings: [{ role: 'backend-dev', resource: 'db', permission: 'write' }, { role: 'backend-dev-2', resource: 'db', permission: 'read' }, { role: 'backend-dev-3', resource: 'db', permission: 'read' }] };
  draft.gates = { all: ['npm test'], targets: { web: [{ name: 'lint', run: 'true' }] } };
  draft.ownership = { rows: [{ path: 'api/', writer: 'backend-dev-2' }, { path: 'jobs/', writer: 'backend-dev-3' }] };
  const items = capabilityDiff(published, draft, kit);
  const got = items.map((x) => [x.kind, x.subject]).sort((a, b) => `${a[0]} ${a[1]}`.localeCompare(`${b[0]} ${b[1]}`));
  assert.deepEqual(got, [
    ['binding-added', 'backend-dev-3'],
    ['binding-widened', 'backend-dev'],
    ['cap-raised', 'backend-dev-2'],
    ['check-changed', '*'],
    ['check-removed', '*'],
    ['model-changed', 'backend-dev-2'],
    ['owns-added', 'backend-dev-2'],
    ['owns-added', 'backend-dev-3'],
    ['resource-widened', null],
    ['review-removed', 'backend-dev-2'],
    ['seat-added', 'backend-dev-3'],
  ]);
  assert.deepEqual(items.find((x) => x.kind === 'resource-widened').subjects, ['backend-dev', 'backend-dev-2', 'backend-dev-3']);
  assert.deepEqual(items.find((x) => x.kind === 'review-removed').reviewer, 'security-reviewer');
  assert.ok(!items.some((x) => x.kind === 'review-removed' && x.reviewer === 'web-dev'), 'web-dev is not a quality role');
});

test('selfCapability: a seat may not widen itself or weaken a check, and another seat may propose the same change', () => {
  const items = [
    { kind: 'binding-widened', subject: 'backend-dev-2' },
    { kind: 'check-removed', subject: '*' },
    { kind: 'resource-widened', subject: null, subjects: ['backend-dev-2', 'web-dev'] },
    { kind: 'seat-added', subject: 'backend-dev-3' },
  ];
  assert.deepEqual(selfCapability(items, 'backend-dev-2').map((x) => x.kind), ['binding-widened', 'check-removed', 'resource-widened']);
  assert.deepEqual(selfCapability(items, 'cto').map((x) => x.kind), ['check-removed']);
  assert.deepEqual(selfCapability(items, 'web-dev').map((x) => x.kind), ['check-removed', 'resource-widened']);
  assert.deepEqual(selfCapability(items, null), [], 'a person is not a seat');
  assert.deepEqual(selfCapability([{ kind: 'seat-added', subject: 'backend-dev-3' }], 'cto'), []);
});
