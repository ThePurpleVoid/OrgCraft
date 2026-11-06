// Kit 0.10: sign-off evidence and structured wakes, role packs, renames and upgrade shadowing, and change safety
// (diffTeams and impact).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KIT } from '../bin/agent-team.mjs';
import {
  addAgent, checkPack, checkUpgrade, diffTeams, draftRole, impact, importLayer, inventoryFromBoard, readPack, renameRole, rolePack,
  scheduleProblem, setEnabled, setSection, versionName, setField, setSignoffEvidence, setWakesOn, signoffEvidence, validate, wakesOn,
} from '../packages/team-model/index.mjs';
import { loadKit, readLayer } from '../packages/team-model/node.mjs';

const kit = loadKit();
const cli = join(KIT, 'bin/agent-team.mjs');
function team(preset = 'engineering') {
  const root = mkdtempSync(join(tmpdir(), 'safety-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync(process.execPath, [cli, 'init', '--preset', preset, '--project', 'Safety', '--dir', root], { stdio: 'ignore' });
  return { root, spec: importLayer(readLayer(root), kit) };
}
const clone = (x) => JSON.parse(JSON.stringify(x));

const BRIEF = `# Accessibility auditor

**Model:** standard
**Group:** quality
**Reports to:** head-of-quality
**Status:** active

## Identity
You audit every changed screen for accessibility.

## Owns (writes)
- \`tests/a11y/\`

## Wakes on
- handoff
- pr-paths: apps/web/**,  tests/a11y/
- label: a11y
- schedule: mon-fri 09:30
- When the CTO asks

## Hands to
- web-dev (BUG), head-of-quality (SIGNOFF)

## Sign-off evidence
- axe report for each changed page
- screenshot at 200% zoom
`;

test('sign-off evidence: bullets are the list, prose is not, and set writes it back', () => {
  assert.deepEqual(signoffEvidence(BRIEF), ['axe report for each changed page', 'screenshot at 200% zoom']);
  assert.deepEqual(signoffEvidence('# X\n\n## Sign-off evidence\nOnly for roles that sign off.\n'), []);
  const md = setSignoffEvidence(BRIEF, ['test log']);
  assert.deepEqual(signoffEvidence(md), ['test log']);
  assert.equal(signoffEvidence(setSignoffEvidence(BRIEF, [])).length, 0);
  assert.doesNotMatch(setSignoffEvidence(BRIEF, []), /## Sign-off evidence/);
});

test('wakes on: structured lines are parsed and checked, free text is kept, and set round-trips', () => {
  const w = wakesOn(BRIEF);
  assert.deepEqual(w.triggers, [{ type: 'handoff' }, { type: 'pr-paths', value: 'apps/web/**, tests/a11y/' }, { type: 'label', value: 'a11y' }, { type: 'schedule', value: 'mon-fri 09:30' }]);
  assert.deepEqual(w.text, ['- When the CTO asks']);
  assert.deepEqual(w.problems, []);
  assert.deepEqual(wakesOn(setWakesOn(BRIEF, w)), w);
  for (const ok of ['daily 08:00', 'weekdays 17:45', 'tue,thu 14:00', 'sat 9:05']) assert.equal(scheduleProblem(ok), '', ok);
  for (const bad of ['mon 25:00', 'someday 09:00', 'mon-fri', 'mon-tue-wed 10:00']) assert.notEqual(scheduleProblem(bad), '', bad);
  const broken = wakesOn('# X\n\n## Wakes on\n- schedule: fri 2pm\n- label:\n- handoff: from the CTO\n');
  assert.equal(broken.problems.length, 2);
  assert.deepEqual(broken.text, ['- handoff: from the CTO'], '"handoff: ..." reads as prose');
  // Kit briefs are free text today and stay valid.
  for (const md of Object.values(kit.roles)) assert.deepEqual(wakesOn(md).problems, []);
});

test('validate: malformed wake lines warn for every role; custom agents also hear about lines the runner skips', () => {
  const { spec } = team();
  addAgent(spec, 'accessibility-auditor', BRIEF.replace('mon-fri 09:30', 'mon-fri 9.30'));
  const issues = validate(spec, kit).filter((i) => i.where === 'roles/accessibility-auditor');
  assert.ok(issues.some((i) => /schedule: mon-fri 9\.30/.test(i.message)), JSON.stringify(issues));
  assert.ok(issues.some((i) => /a line the runner does not read \("When the CTO asks"\)/.test(i.message)), JSON.stringify(issues));
  assert.ok(!issues.some((i) => /sign-off evidence/.test(i.message)));
  const noEvidence = clone(spec);
  noEvidence.roles['accessibility-auditor'].brief = setSignoffEvidence(BRIEF, []);
  assert.ok(validate(noEvidence, kit).some((i) => i.where === 'roles/accessibility-auditor' && /no sign-off evidence/.test(i.message)));
  // A team made only of kit roles gets none of these warnings.
  assert.ok(!validate(team().spec, kit).some((i) => /Wakes on|sign-off evidence/.test(i.message)));
});

test('role packs carry the wakes and the kit version, and checkPack speaks validate', () => {
  const { spec } = team();
  addAgent(spec, 'accessibility-auditor', BRIEF);
  const files = rolePack(spec, 'accessibility-auditor', { kit: '0.10.0' });
  const pack = JSON.parse(files['pack.json']);
  assert.equal(pack.schema, 'agent-team/role-pack@1');
  assert.equal(pack.kit, '0.10.0');
  assert.deepEqual(pack.needs.paths, ['tests/a11y/']);
  assert.equal(pack.needs.wakes.length, 4);
  assert.deepEqual(readPack(files)[0].slug, 'accessibility-auditor');
  // Into the team it came from: a clash. Into a fresh team: fine (one warning, the free-text wake line).
  assert.ok(checkPack(files, spec, kit).some((i) => i.level === 'error' && i.where === 'roles/accessibility-auditor' && /already has an agent/.test(i.message)));
  const fresh = checkPack(files, team().spec, kit);
  assert.deepEqual(fresh.map((i) => i.level), ['warning']);
  assert.ok(fresh.every((i) => 'level' in i && 'where' in i && 'message' in i));
  // Shadowing a kit role, an unknown needs key, a bad schema, a secret.
  const kitClash = { 'qa-web.md': '# QA\n', 'pack.json': JSON.stringify({ schema: 'agent-team/role-pack@1', roles: ['qa-web'], needs: { pets: [] } }) };
  const k = checkPack(kitClash, team().spec, kit);
  assert.ok(k.some((i) => i.level === 'warning' && /replaces the kit role/.test(i.message)));
  assert.ok(k.some((i) => /needs\.pets/.test(i.message)));
  assert.ok(checkPack({ 'x.md': '# X\n', 'pack.json': '{"schema":"other@2"}' }, null, kit).some((i) => i.level === 'error' && /schema/.test(i.message)));
  assert.ok(checkPack({ 'x.md': '# X\n\nkey sk-ant-abcdefghijklmnop\n' }, null, kit).some((i) => /secret/.test(i.message)));
  assert.ok(checkPack({ 'pack.json': '{' }, null, kit)[0].level === 'error');
});

test('renameRole moves the agent, its own references and everything that points at it', () => {
  const { spec } = team();
  const md = draftRole(spec, kit, { start: 'copy', from: 'qa-web', title: 'Web QA', slug: 'qa-web', reportsTo: 'head-of-quality' });
  addAgent(spec, 'qa-web', md);
  addAgent(spec, 'helper', '# Helper\n\n**Model:** light\n**Reports to:** qa-web\n**Status:** active\n\n## Identity\nHelps.\n');
  spec.resources = { resources: [{ id: 'db', type: 'postgres', name: 'DB' }], bindings: [{ role: 'qa-web', resource: 'db', permission: 'read' }] };
  spec.ownership = { rows: [{ path: 'tests/e2e/', writer: 'qa-web' }] };
  renameRole(spec, 'qa-web', 'web-qa', kit);
  assert.equal(spec.roles['web-qa'].source, 'project');
  assert.match(spec.roles['web-qa'].brief, /team-status\.sh web-qa /);
  assert.doesNotMatch(spec.roles['web-qa'].brief, /team-status\.sh qa-web /);
  assert.deepEqual(spec.roles['qa-web'], { source: 'kit', enabled: false }, 'the kit role of that name comes back, off');
  assert.equal(spec.resources.bindings[0].role, 'web-qa');
  assert.equal(spec.ownership.rows[0].writer, 'web-qa');
  assert.match(spec.roles.helper.brief, /\*\*Reports to:\*\* web-qa/);
  assert.throws(() => renameRole(spec, 'helper', 'web-qa'), /already has an agent/);
  assert.throws(() => renameRole(spec, 'cto', 'boss'), /not a custom agent/);
});

test('checkUpgrade flags a custom agent a new kit shadows, and leaves deliberate replacements alone', () => {
  const { spec } = team();
  addAgent(spec, 'pricing-analyst', BRIEF);
  addAgent(spec, 'qa-web', BRIEF);
  const newKit = { ...kit, roles: { ...kit.roles, 'pricing-analyst': '# Pricing analyst\n' } };
  const old = Object.keys(kit.roles);
  assert.deepEqual(checkUpgrade(spec, newKit, old).map((c) => [c.slug, c.fixes]), [['pricing-analyst', ['rename', 'use-kit']]]);
  assert.deepEqual(checkUpgrade(spec, newKit, undefined), [], 'no record of the old kit: nothing to compare');
});

test('sync stops on a custom agent the kit now ships, check reports it, and "replaces" accepts it', () => {
  const { root } = team('minimal');
  writeFileSync(join(root, '.agent-team/roles/qa-web.md'), BRIEF.replace('# Accessibility auditor', '# Our QA'));
  const lockPath = join(root, '.agent-team/kit.lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  assert.ok(lock.kitRoles.includes('qa-web'), 'sync records the kit roles');
  // Pretend the team last synced with a kit that had no qa-web.
  writeFileSync(lockPath, JSON.stringify({ ...lock, kitRoles: lock.kitRoles.filter((s) => s !== 'qa-web') }));
  const run = (cmd) => spawnSync(process.execPath, [cli, cmd, '--dir', root], { encoding: 'utf8' });
  const s = run('sync');
  assert.equal(s.status, 1);
  assert.match(s.stderr, /adds a role called qa-web, the same name as your custom agent/);
  assert.match(s.stderr, /nothing was written/);
  assert.match(run('check').stdout, /shadowed: .*qa-web/);
  const teamFile = join(root, '.agent-team/team.json');
  writeFileSync(teamFile, JSON.stringify({ ...JSON.parse(readFileSync(teamFile, 'utf8')), replaces: ['qa-web'] }, null, 2));
  assert.equal(run('sync').status, 0);
  assert.equal(run('check').status, 0);
  // A lock from before 0.10 has no kitRoles: nothing to compare, sync goes ahead (existing teams sync cleanly).
  const { root: older } = team('minimal');
  const l = JSON.parse(readFileSync(join(older, '.agent-team/kit.lock.json'), 'utf8'));
  delete l.kitRoles;
  writeFileSync(join(older, '.agent-team/kit.lock.json'), JSON.stringify(l));
  writeFileSync(join(older, '.agent-team/roles/qa-web.md'), BRIEF);
  assert.equal(spawnSync(process.execPath, [cli, 'sync', '--dir', older]).status, 0);
});

test('diffTeams names each change; a draft equal to the published team has none', () => {
  const { spec } = team();
  assert.deepEqual(diffTeams(spec, clone(spec), kit), []);
  const draft = clone(spec);
  setEnabled(draft, 'web-dev', false);
  setEnabled(draft, 'cmo', true);
  setField(draft, 'backend-dev', 'Model', 'deep');
  setField(draft, 'qa-web', 'Status', 'dormant until asked');
  setField(draft, 'code-reviewer', 'Reports to', 'head-of-quality');
  spec.ownership = { rows: [{ path: 'apps/api/', writer: 'backend-dev' }, { path: 'docs/', writer: 'docs-keeper' }] };
  draft.ownership = { rows: [{ path: 'apps/api/', writer: 'architect' }, { path: 'apps/web/', writer: 'architect' }] };
  spec.resources = { resources: [{ id: 'db', type: 'postgres' }], bindings: [{ role: 'backend-dev', resource: 'db', permission: 'write' }, { role: 'architect', resource: 'db', permission: 'read' }] };
  draft.resources = { resources: [{ id: 'db', type: 'postgres' }], bindings: [{ role: 'backend-dev', resource: 'db', permission: 'read' }] };
  spec.gates = { targets: { web: [{ name: 'lint', run: 'npm run lint' }] } };
  draft.gates = { targets: { web: [{ name: 'lint', run: 'npm run lint' }, { name: 'test', run: 'npm test' }] } };
  const kinds = diffTeams(spec, draft, kit).map((c) => `${c.kind}:${c.role ?? c.target ?? ''}${c.path ? `:${c.path}` : ''}`);
  for (const k of ['role-off:web-dev', 'role-added:cmo', 'tier:backend-dev', 'role-dormant:qa-web', 'reports-to:code-reviewer',
    'path-moved:backend-dev:apps/api/', 'path-removed:docs-keeper:docs/', 'path-added:architect:apps/web/', 'binding-narrowed:backend-dev', 'binding-removed:architect', 'gate:web']) {
    assert.ok(kinds.includes(k), `${k} in ${kinds.join(', ')}`);
  }
  assert.ok(!kinds.some((k) => k.startsWith('brief:')), `no brief noise from fitted reporting lists: ${kinds.join(', ')}`);
  const text = clone(spec);
  setSection(text, 'qa-web', 'Rules', '- Test with a screen reader.');
  assert.deepEqual(diffTeams(spec, text, kit).map((c) => [c.kind, c.role, c.sections]), [['brief', 'qa-web', ['Rules']]]);
});

test('impact: busy roles get choices with a recommendation, idle ones are safe, board data is marked stale', () => {
  const { spec } = team();
  const draft = clone(spec);
  setEnabled(draft, 'web-dev', false);
  setEnabled(draft, 'qa-web', false);
  setField(draft, 'backend-dev', 'Model', 'deep');
  setField(draft, 'docs-keeper', 'Model', 'deep');
  spec.ownership = { rows: [{ path: 'apps/api/', writer: 'backend-dev' }] };
  draft.ownership = { rows: [{ path: 'apps/api/', writer: 'architect' }] };
  const changes = diffTeams(spec, draft, kit);
  const board = { current: [
    { role: 'web-dev', status: 'working', task: 'Checkout page', branch: 'web/checkout' },
    { role: 'qa-web', status: 'review', task: 'Sign off checkout', pr: 57 },
    { role: 'backend-dev', status: 'working', task: 'Invoices API', branch: 'api/invoices' },
    { role: 'code-reviewer', instance: '57', status: 'review' },
  ] };
  const inv = inventoryFromBoard(board);
  assert.equal(inv.source, 'board');
  assert.equal(inv.roles['code-reviewer'], undefined, 'per-PR instances are not the role');
  const items = impact(changes, inv);
  const by = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.equal(by['role-off:web-dev'].severity, 'choice');
  assert.equal(by['role-off:web-dev'].recommended, 'finish', 'board only: let it finish is the default');
  assert.deepEqual(by['role-off:web-dev'].choices, ['finish', 'handoff', 'pause'], 'board only: what a thread can do itself');
  assert.deepEqual(by['role-off:web-dev'].inFlight, { state: 'working', task: 'Checkout page', branch: 'web/checkout', pr: null });
  assert.equal(by['role-off:qa-web'].recommended, 'finish');
  assert.equal(by['tier:backend-dev'].severity, 'safe', 'board only: a tier change applies at the next task');
  assert.ok(by['tier:backend-dev'].inFlight, 'but the Studio still sees the work in flight (amber mark)');
  assert.equal(by['tier:docs-keeper'].severity, 'safe', 'idle: applies at its next task');
  assert.equal(by['path-moved:backend-dev:apps/api/'].recommended, 'move-after-merge');
  assert.deepEqual(by['path-moved:backend-dev:apps/api/'].choices, ['move-after-merge', 'move-and-handover']);
  assert.match(by['path-moved:backend-dev:apps/api/'].note, /not known/);
  assert.ok(items.every((i) => i.stale === true));
  assert.deepEqual([...new Set(items.map((i) => i.severity))], ['choice', 'safe'], 'choices first');
  // From the runner, with files and pending approvals.
  const runner = { source: 'runner', roles: { 'web-dev': { state: 'working', approvals: 1 }, 'backend-dev': { state: 'working', files: ['apps/web/x.ts'] } } };
  const r = Object.fromEntries(impact(changes, runner).map((i) => [i.id, i]));
  assert.equal(r['role-off:web-dev'].severity, 'blocking');
  assert.equal(r['path-moved:backend-dev:apps/api/'].severity, 'safe', 'its work does not touch the path');
  assert.equal(r['role-off:web-dev'].stale, false);
  const r2 = Object.fromEntries(impact(changes, { source: 'runner', roles: { 'web-dev': { state: 'working' }, 'qa-web': { state: 'review', pr: 57 } } }).map((i) => [i.id, i]));
  assert.equal(r2['role-off:web-dev'].recommended, 'handoff', 'runner: working without a PR, hand it off');
  assert.equal(r2['role-off:qa-web'].recommended, 'finish', 'runner: in review with a PR, let it finish');
  assert.ok(r2['role-off:web-dev'].choices.includes('stop-drop'));
  assert.deepEqual(impact([], inv), []);
});

test('a role both switched off and losing its area gets an item for each', () => {
  const { spec } = team();
  spec.ownership = { rows: [{ path: 'apps/web/', writer: 'web-dev' }] };
  const draft = clone(spec);
  setEnabled(draft, 'web-dev', false);
  draft.ownership = { rows: [{ path: 'apps/web/', writer: 'architect' }] };
  const changes = diffTeams(spec, draft, kit);
  assert.deepEqual(changes.map((c) => c.kind).sort(), ['path-moved', 'role-off']);
  const items = impact(changes, inventoryFromBoard({ current: [{ role: 'web-dev', status: 'working', task: 'Checkout', branch: 'web/checkout' }] }));
  assert.deepEqual(items.map((i) => `${i.id}:${i.severity}:${i.recommended}`).sort(), ['path-moved:web-dev:apps/web/:choice:move-after-merge', 'role-off:web-dev:choice:finish']);
});

test('versions are named by short commit', () => {
  assert.equal(versionName('abc1234def567'), 'abc1234');
  assert.equal(versionName('abc1234def567', '2026-11-05T10:00:00Z'), 'abc1234, published 5 Nov');
});
