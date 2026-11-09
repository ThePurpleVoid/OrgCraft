// Several teammates of one role (ADR 0011, plans/build/team-json-0.22.md section 7): a member is
// roles/<id>.extend.md with "Based on", and a team without one reads, compiles and resolves exactly as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT } from '../bin/agent-team.mjs';
import {
  addMember, compileLayer, displayName, handsTo, importLayer, listMembers, membersOf, resolveSpec, setDisplayName,
  setHandsTo, typeOf, validate,
} from '../packages/team-model/index.mjs';
import { loadKit } from '../packages/team-model/node.mjs';

const kit = loadKit();
const teamJson = (extra = {}) => JSON.stringify({ kit: 'github:ThePurpleVoid/OrgCraft#v0.22.0', preset: 'engineering', include: [], exclude: [], values: { PROJECT_NAME: 'Acme' }, ...extra }, null, 2) + '\n';
const memberFile = (lines) => lines.join('\n') + '\n';
const MAYA = memberFile(['# Maya', '', '**Based on:** backend-dev', '**Reports to:** cto', '', '## Owns (writes) (replace)', 'Nothing yet.']);
const layer = (files = {}, team = {}) => ({ 'team.json': teamJson(team), ...files });
const errors = (issues) => issues.filter((i) => i.level === 'error').map((i) => i.message);
const warnings = (issues) => issues.filter((i) => i.level === 'warning').map((i) => i.message);

test('import: an extension with Based on whose id is not a role is a member, on unless exclude lists it', () => {
  const spec = importLayer(layer({ 'roles/backend-dev-2.extend.md': MAYA }), kit);
  assert.equal(spec.roles['backend-dev-2'].source, 'member');
  assert.equal(spec.roles['backend-dev-2'].type, 'backend-dev');
  assert.equal(spec.roles['backend-dev-2'].enabled, true);
  const off = importLayer(layer({ 'roles/backend-dev-2.extend.md': MAYA }, { exclude: ['backend-dev-2'] }), kit);
  assert.equal(off.roles['backend-dev-2'].enabled, false);
  // Without Based on it stays what it was before 0.22.
  const plain = importLayer(layer({ 'roles/nobody.extend.md': '# Nobody\n' }), kit);
  assert.equal(plain.roles.nobody.source, 'missing');
});

test('compile: a member keeps its file byte for byte, is never in include, and is in exclude when off', () => {
  const files = layer({ 'roles/backend-dev-2.extend.md': MAYA });
  const spec = importLayer(files, kit);
  const out = compileLayer(spec, kit);
  assert.equal(out['roles/backend-dev-2.extend.md'], MAYA);
  assert.equal(out['team.json'], files['team.json']);
  spec.roles['backend-dev-2'].enabled = false;
  const off = JSON.parse(compileLayer(spec, kit)['team.json']);
  assert.deepEqual(off.exclude, ['backend-dev-2']);
  assert.deepEqual(off.include, []);
});

test('two members of one type resolve to two briefs; Every thread names each own id, the rest is the type', () => {
  const spec = importLayer(layer({ 'roles/backend-dev-2.extend.md': MAYA }), kit);
  const { roles } = resolveSpec(spec, kit);
  const one = roles.find((r) => r.slug === 'backend-dev').md;
  const two = roles.find((r) => r.slug === 'backend-dev-2').md;
  assert.match(two, /^# Maya$/m);
  assert.match(two, /^\*\*Type:\*\* Backend dev \(backend-dev\)$/m);
  assert.doesNotMatch(two, /Based on/);
  assert.match(two, /team-status\.sh backend-dev-2 status working/);
  assert.match(two, /`roles\/backend-dev-2\.md` in project memory/);
  assert.match(one, /team-status\.sh backend-dev status working/);
  assert.doesNotMatch(one, /Type:/);
  // The job itself is the type's words.
  const identity = (md) => /## Identity\n([\s\S]*?)\n## /.exec(md)[1];
  assert.equal(identity(two), identity(one));
});

test('addMember: <type>-2 with the computed name "<Type> 2", the type\'s manager and Owns: Nothing yet', () => {
  const spec = importLayer(layer(), kit);
  const { id } = addMember(spec, kit, { type: 'backend-dev' });
  assert.equal(id, 'backend-dev-2');
  assert.equal(displayName(spec, kit, id), 'Backend dev 2');
  assert.equal(displayName(spec, kit, 'backend-dev'), 'Backend dev');
  assert.equal(typeOf(spec, id), 'backend-dev');
  const md = resolveSpec(spec, kit).roles.find((r) => r.slug === id).md;
  assert.match(md, /^\*\*Reports to:\*\* cto$/m);
  assert.match(md, /## Owns \(writes\)\nNothing yet\./);
  assert.equal(compileLayer(spec, kit)['roles/backend-dev-2.extend.md'], '**Based on:** backend-dev\n**Reports to:** cto\n\n## Owns (writes) (replace)\nNothing yet.\n');
  // The next one is -3, a given name is written, and a given manager wins.
  const next = addMember(spec, kit, { type: 'backend-dev', title: 'Ana', reportsTo: 'chief-of-staff' });
  assert.equal(next.id, 'backend-dev-3');
  assert.equal(displayName(spec, kit, 'backend-dev-3'), 'Ana');
  assert.deepEqual(membersOf(spec, 'backend-dev'), ['backend-dev', 'backend-dev-2', 'backend-dev-3']);
  assert.throws(() => addMember(spec, kit, { type: 'backend-dev-2' }), /teammate, not a role/);
});

test('setDisplayName: only the title line changes, the id stays, and a duplicate is refused with 409', () => {
  const files = layer({ 'roles/backend-dev-2.extend.md': MAYA, 'ownership.json': JSON.stringify({ rows: [{ path: 'api/', writer: 'backend-dev-2' }] }, null, 2) + '\n' });
  const spec = importLayer(files, kit);
  setDisplayName(spec, 'backend-dev-2', '  Maya   Silva ', kit);
  const out = compileLayer(spec, kit);
  assert.equal(out['roles/backend-dev-2.extend.md'], MAYA.replace('# Maya', '# Maya Silva'));
  assert.equal(out['ownership.json'], files['ownership.json']);
  assert.ok(spec.roles['backend-dev-2']);
  const e = assert.throws(() => setDisplayName(spec, 'backend-dev', 'maya  silva', kit), (err) => err.status === 409 && err.message === 'Another teammate is already called Maya Silva');
  assert.equal(e, undefined);
  assert.throws(() => setDisplayName(spec, 'backend-dev', '   ', kit), /1 to 60/);
});

test('validate: unknown type, chain, kit-shadowed id, pin below 0.22, duplicate name, bad Pool', () => {
  const unknown = importLayer(layer({ 'roles/x-2.extend.md': '**Based on:** no-such-role\n**Reports to:** cto\n' }), kit);
  assert.ok(errors(validate(unknown, kit)).some((m) => /based on "no-such-role", which is neither/.test(m)));
  const chain = importLayer(layer({ 'roles/backend-dev-2.extend.md': MAYA, 'roles/backend-dev-2-b.extend.md': '**Based on:** backend-dev-2\n**Reports to:** cto\n' }), kit);
  assert.ok(errors(validate(chain, kit)).some((m) => /based on backend-dev-2, which is a teammate, not a role; base it on backend-dev/.test(m)));
  const shadow = importLayer(layer({ 'roles/qa-web.extend.md': '**Based on:** backend-dev\n' }), kit);
  assert.ok(errors(validate(shadow, kit)).some((m) => /qa-web is a kit role, so it can't be based on backend-dev/.test(m)));
  const old = importLayer(layer({ 'roles/backend-dev-2.extend.md': MAYA }, { kit: 'github:ThePurpleVoid/OrgCraft#v0.21.0' }), kit);
  assert.ok(errors(validate(old, kit)).some((m) => m === 'uses "Based on", which needs kit 0.22 or later; team.json pins github:ThePurpleVoid/OrgCraft#v0.21.0'));
  assert.ok(validate(old, kit).some((i) => i.where === 'roles/backend-dev-2.extend.md'), 'names the file');
  const dup = importLayer(layer({ 'roles/backend-dev-2.extend.md': MAYA, 'roles/backend-dev.extend.md': '# maya\n' }), kit);
  assert.ok(errors(validate(dup, kit)).some((m) => /are both called/.test(m)));
  const pool = importLayer(layer({ 'roles/backend-dev-2.extend.md': MAYA.replace('**Reports to:** cto', '**Reports to:** cto\n**Pool:** 11') }), kit);
  assert.ok(errors(validate(pool, kit)).some((m) => /Pool must be a whole number from 1 to 10/.test(m)));
  const fine = importLayer(layer({ 'roles/backend-dev-2.extend.md': MAYA.replace('**Reports to:** cto', '**Reports to:** cto\n**Pool:** 2') }), kit);
  assert.deepEqual(errors(validate(fine, kit)).filter((m) => /Pool|Based on|teammate|called/.test(m)), []);
});

test('validate: orphan, overlap, and Hands to targets that are off or need picking', () => {
  const spec = importLayer(layer({ 'roles/backend-dev-2.extend.md': MAYA }), kit);
  const w = warnings(validate(spec, kit));
  assert.ok(w.includes('Nobody hands work to Maya, and nothing wakes them'));
  assert.ok(w.includes('Backend dev and Maya do the same job in the same lane; use Pool instead') === false, 'backend-dev owns paths, so it is not an overlap');
  const twin = importLayer(layer({ 'roles/backend-dev-2.extend.md': MAYA, 'roles/backend-dev-3.extend.md': MAYA.replace('# Maya', '# Leo') }), kit);
  assert.ok(warnings(validate(twin, kit)).includes('Maya and Leo do the same job in the same lane; use Pool instead'));
  const hands = MAYA + '\n## Hands to (replace)\n- mobile-dev: the API change\n- backend-dev: review\n- qa-web\n';
  const wired = importLayer(layer({ 'roles/backend-dev-2.extend.md': hands, 'roles/backend-dev-3.extend.md': MAYA.replace('# Maya', '# Leo') }, { exclude: ['mobile-dev'] }), kit);
  const ww = warnings(validate(wired, kit));
  assert.ok(ww.includes('Maya hands to mobile-dev, which is off'), ww.join('\n'));
  assert.ok(ww.includes('Maya hands to backend-dev: pick which Backend dev'), ww.join('\n'));
  assert.ok(!ww.some((m) => /hands to qa-web/.test(m)));
});

test('handsTo: structured lines and prose; every kit brief parses with no targets and no problems', () => {
  const md = '# X\n\n## Hands to\n- qa-web: the change, with its plan\n- owner\nSecurity reviewer (always)\n- someone-else: nope\n';
  const h = handsTo(md, ['qa-web']);
  assert.deepEqual(h.targets, [{ to: 'qa-web', what: 'the change, with its plan' }, { to: 'owner' }]);
  assert.deepEqual(h.text, ['Security reviewer (always)', '- someone-else: nope']);
  assert.deepEqual(h.problems, []);
  assert.equal(setHandsTo(md, h), md, 'writes back what it read');
  assert.match(setHandsTo(md, { targets: [{ to: 'cto', what: 'x' }], text: ['note'] }), /## Hands to\n- cto: x\nnote\n/);
  const roster = Object.keys(kit.roles);
  for (const f of readdirSync(join(KIT, 'team/roles')).filter((x) => x.endsWith('.md') && !x.startsWith('_'))) {
    const r = handsTo(readFileSync(join(KIT, 'team/roles', f), 'utf8'), roster);
    assert.deepEqual([r.targets, r.problems], [[], []], f);
  }
});

test('listMembers: members and catalog as GET /v1/team returns them', () => {
  const spec = importLayer(layer({ 'roles/backend-dev-2.extend.md': MAYA.replace('**Reports to:** cto', '**Reports to:** cto\n**Pool:** 2') }), kit);
  const { members, catalog } = listMembers(spec, kit);
  const maya = members.find((m) => m.id === 'backend-dev-2');
  assert.deepEqual({ ...maya, problems: undefined, handsToNotes: undefined }, {
    id: 'backend-dev-2', name: 'Maya', type: 'backend-dev', typeTitle: 'Backend dev', source: 'member', enabled: true, reportsTo: 'cto', lane: 'cto',
    pool: 2, owns: [], handsTo: [], handsToNotes: undefined, wakesOn: [], bindings: [], model: 'standard', problems: undefined,
  });
  assert.ok(maya.problems.some((p) => p.message === 'Nobody hands work to Maya, and nothing wakes them'));
  assert.equal(catalog.find((c) => c.type === 'backend-dev').count, 2);
  assert.equal(catalog.find((c) => c.type === 'backend-dev').title, 'Backend dev');
  assert.equal(catalog.length, Object.keys(kit.roles).length);
});

test('a team without members gets no new warnings or errors from 0.22', () => {
  const spec = importLayer(layer(), kit);
  const plain = validate(spec, kit).map((i) => i.message);
  assert.ok(!plain.some((m) => /teammate|hands to|use Pool|Nobody hands|called|Based on/.test(m)), plain.join('\n'));
});

test('setDisplayName needs the kit, and a name clashes with a teammate who is switched off', () => {
  const spec = importLayer(layer({ 'roles/backend-dev-2.extend.md': MAYA }, { exclude: ['backend-dev-2'] }), kit);
  assert.throws(() => setDisplayName(spec, 'backend-dev', 'Ana'), /needs the kit/);
  assert.throws(() => setDisplayName(spec, 'backend-dev', 'Maya', kit), (e) => e.status === 409 && /already called Maya/.test(e.message));
  assert.throws(() => setDisplayName(spec, 'backend-dev-2', 'CTO', kit), (e) => e.status === 409, 'a kit role\'s own title counts');
});
