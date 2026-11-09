// L11b: a teammate's name and its role's title are separate fields. The name is "**Name:**" in the seat's extension;
// the "# " line of a role's own extension is the role's title (a pack's or the team's), shared by every teammate.
// Renaming any seat, the role's own included, never changes the role's title. No migration: without a Name field
// a seat is called by its role's title ("Backend dev", then "Backend dev 2"…).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from '../bin/agent-team.mjs';
import {
  addMember, briefOfMember, compileLayer, displayName, importLayer, listMembers, resolveSpec, roleTitle, setDisplayName, validate,
} from '../packages/team-model/index.mjs';
import { loadKit } from '../packages/team-model/node.mjs';

const kit = loadKit();
const teamJson = JSON.stringify({ kit: 'github:ThePurpleVoid/OrgCraft#v0.22.0', preset: 'engineering', include: [], exclude: [], values: { PROJECT_NAME: 'Acme' } }, null, 2) + '\n';
const MAYA = '# Maya\n\n**Based on:** backend-dev\n**Reports to:** cto\n';
const md = (spec, id) => resolveSpec(spec, kit).roles.find((r) => r.slug === id).md;

test('renaming a role\'s own seat leaves the role title alone: catalog, typeTitle and the other teammates\' Type line', () => {
  const spec = importLayer({ 'team.json': teamJson, 'roles/backend-dev-2.extend.md': MAYA }, kit);
  setDisplayName(spec, 'backend-dev', 'Ana', kit);
  assert.deepEqual(spec.roles['backend-dev'].extension, { fields: [{ name: 'Name', value: 'Ana' }], sections: [] });
  assert.equal(spec.roles['backend-dev'].extension.title, undefined, 'the role title is not written');
  const { members, catalog } = listMembers(spec, kit);
  const of = (id) => members.find((m) => m.id === id);
  assert.deepEqual([of('backend-dev').name, of('backend-dev').typeTitle], ['Ana', 'Backend dev']);
  assert.deepEqual([of('backend-dev-2').name, of('backend-dev-2').typeTitle], ['Maya', 'Backend dev']);
  assert.equal(catalog.find((c) => c.type === 'backend-dev').title, 'Backend dev');
  assert.match(md(spec, 'backend-dev-2'), /^# Maya$/m);
  assert.match(md(spec, 'backend-dev-2'), /^\*\*Type:\*\* Backend dev \(backend-dev\)$/m);
  // The renamed seat's own brief is called by its name, and the Name field is not a header line.
  assert.match(md(spec, 'backend-dev'), /^# Ana$/m);
  assert.doesNotMatch(md(spec, 'backend-dev'), /\*\*Name:\*\*/);
  assert.equal(compileLayer(spec, kit)['roles/backend-dev.extend.md'], '**Name:** Ana\n');
});

test('a pack title on the role\'s own seat is the role title; a rename keeps it, and teammates inherit it', () => {
  const files = { 'team.json': teamJson, 'roles/bug-triager.extend.md': '# Problem-report triager\n', 'roles/bug-triager-2.extend.md': '**Based on:** bug-triager\n**Reports to:** owner\n' };
  const spec = importLayer(files, kit);
  assert.equal(displayName(spec, kit, 'bug-triager'), 'Problem-report triager');
  assert.equal(displayName(spec, kit, 'bug-triager-2'), 'Problem-report triager 2');
  setDisplayName(spec, 'bug-triager', 'Sam', kit);
  assert.equal(spec.roles['bug-triager'].extension.title, 'Problem-report triager');
  assert.equal(displayName(spec, kit, 'bug-triager'), 'Sam');
  // The unnamed teammate is now the only one called by the role title, so it loses its number.
  assert.equal(displayName(spec, kit, 'bug-triager-2'), 'Problem-report triager');
  const { members, catalog } = listMembers(spec, kit);
  assert.ok(members.filter((m) => m.type === 'bug-triager').every((m) => m.typeTitle === 'Problem-report triager'));
  assert.equal(catalog.find((c) => c.type === 'bug-triager').title, 'Problem-report triager');
  assert.match(md(spec, 'bug-triager-2'), /^\*\*Type:\*\* Problem-report triager \(bug-triager\)$/m);
  assert.equal(compileLayer(spec, kit)['roles/bug-triager.extend.md'], '# Problem-report triager\n\n**Name:** Sam\n');
  assert.equal(roleTitle(kit.roles['bug-triager'], '# Problem-report triager\n\n**Name:** Sam\n'), 'Problem-report triager');
});

test('no migration: legacy files read the same, a new teammate gets a Name field, and names stay unique', () => {
  // A teammate's legacy "# Maya" is still its name; a role without a Name is called by its title.
  const spec = importLayer({ 'team.json': teamJson, 'roles/backend-dev-2.extend.md': MAYA }, kit);
  assert.equal(displayName(spec, kit, 'backend-dev-2'), 'Maya');
  assert.equal(displayName(spec, kit, 'backend-dev'), 'Backend dev');
  const { id } = addMember(spec, kit, { type: 'backend-dev', title: 'Lee' });
  assert.equal(compileLayer(spec, kit)[`roles/${id}.extend.md`], '**Name:** Lee\n**Based on:** backend-dev\n**Reports to:** cto\n\n## Owns (writes) (replace)\nNothing yet.\n');
  assert.equal(displayName(spec, kit, id), 'Lee');
  assert.throws(() => setDisplayName(spec, 'backend-dev', 'lee', kit), (e) => e.status === 409);
  // A Name on a teammate's file round-trips, and validate is clean.
  const again = importLayer(compileLayer(spec, kit), kit);
  assert.equal(displayName(again, kit, id), 'Lee');
  assert.deepEqual(validate(again, kit).filter((i) => i.level === 'error'), []);
});

test('a role\'s own Name never passes to its other teammates (it is a seat setting)', () => {
  const out = briefOfMember({ typeMd: kit.roles['backend-dev'], typeExtensionMd: '**Name:** Ana\n', extensionMd: '**Based on:** backend-dev\n**Reports to:** cto\n', id: 'backend-dev-2', type: 'backend-dev' });
  assert.doesNotMatch(out, /Ana/);
  assert.match(out, /^\*\*Type:\*\* Backend dev \(backend-dev\)$/m);
});

test('sync: the org chart and the Type line name the role, not the renamed seat', () => {
  const root = mkdtempSync(join(tmpdir(), 'names-'));
  mkdirSync(join(root, '.agent-team/roles'), { recursive: true });
  writeFileSync(join(root, '.agent-team/team.json'), teamJson);
  writeFileSync(join(root, '.agent-team/roles/backend-dev.extend.md'), '**Name:** Ana\n');
  writeFileSync(join(root, '.agent-team/roles/backend-dev-2.extend.md'), MAYA);
  const { files } = build(root);
  const tree = files.get('docs/team/project-instructions.md');
  assert.match(tree, /─ Maya \(backend-dev-2\), Backend dev \(/);
  assert.doesNotMatch(tree, /, Ana \(/);
  assert.match(files.get('docs/team/roles/backend-dev-2.md'), /^\*\*Type:\*\* Backend dev \(backend-dev\)$/m);
  assert.match(files.get('docs/team/roles/backend-dev.md'), /^# Ana$/m);
});
