// Custom agents in the team model: drafting a brief, editing it as data, path conflicts, checks and role packs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, KIT } from '../bin/agent-team.mjs';
import { addAgent, briefSection, checkSlug, compileLayer, draftRole, importLayer, ownsPaths, pathConflicts, readPack, rolePack, setBriefField, setBriefSection, setOwnsPaths, slugify, validate } from '../packages/team-model/index.mjs';
import { loadKit, readLayer, writeLayer } from '../packages/team-model/node.mjs';

const kit = loadKit();
function team() {
  const root = mkdtempSync(join(tmpdir(), 'agents-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync(process.execPath, [join(KIT, 'bin/agent-team.mjs'), 'init', '--preset', 'engineering', '--project', 'Agents', '--dir', root], { stdio: 'ignore' });
  return { root, spec: importLayer(readLayer(root), kit) };
}

test('copying a kit role makes a separate agent that names itself', () => {
  const { spec } = team();
  const slug = slugify('Accessibility auditor');
  assert.equal(slug, 'accessibility-auditor');
  assert.equal(checkSlug(spec, kit, slug).ok, true);
  assert.equal(checkSlug(spec, kit, 'qa-web').ok, false);
  assert.equal(checkSlug(spec, kit, 'qa-web', { replaceKit: true }).ok, true);
  assert.equal(checkSlug(spec, kit, 'Bad Slug').ok, false);
  const md = draftRole(spec, kit, { start: 'copy', from: 'qa-web', title: 'Accessibility auditor', slug, group: 'quality', reportsTo: 'head-of-quality' });
  assert.match(md, /^# Accessibility auditor$/m);
  assert.match(md, /team-status\.sh accessibility-auditor status working/);
  assert.doesNotMatch(md, /team-status\.sh qa-web /);
  assert.match(briefSection(md, 'identity'), /Playwright/);
  addAgent(spec, slug, md);
  assert.equal(spec.roles[slug].source, 'project');
  assert.equal(spec.roles['qa-web'].brief, undefined, 'the kit role is untouched');
  assert.equal(checkSlug(spec, kit, slug).ok, false, 'a slug is taken once used');
});

test('a blank agent starts from the kit template', () => {
  const { spec } = team();
  const md = draftRole(spec, kit, { start: 'blank', title: 'Data pipeline dev', slug: 'data-pipeline-dev', group: 'data', reportsTo: 'cto' });
  assert.match(md, /^# Data pipeline dev$/m);
  assert.match(md, /^\*\*Group:\*\* data$/m);
  assert.match(md, /^\*\*Status:\*\* active$/m);
  assert.match(md, /team-status\.sh data-pipeline-dev status working/);
  assert.doesNotMatch(md, /<slug>/);
});

test('sections, fields and owned paths edit as data', () => {
  let md = '# A\n\n**Model:** standard\n\n## Identity\nOld\n\n## Every thread, every task\n- x\n';
  md = setBriefSection(md, 'Identity', 'New');
  md = setBriefSection(md, 'Sign-off evidence', '- screenshots');
  md = setBriefField(md, 'Model', 'deep');
  assert.equal(briefSection(md, 'identity'), 'New');
  assert.ok(md.indexOf('## Sign-off evidence') < md.indexOf('## Every thread'), 'new sections go before the footer');
  md = setOwnsPaths(md, [{ path: 'tests/a11y/', mode: 'writes' }, { path: 'apps/web/src/components/', mode: 'reads', note: 'fixes go to web-dev as BUG' }]);
  assert.deepEqual(ownsPaths(md).paths, [{ path: 'tests/a11y/', mode: 'writes', note: '' }, { path: 'apps/web/src/components/', mode: 'reads', note: 'fixes go to web-dev as BUG' }]);
  assert.equal(briefSection(setBriefSection(md, 'Sign-off evidence', ''), 'sign-off evidence'), '');
});

test('two writers on one area is an error until it is resolved in place', () => {
  const { spec } = team();
  spec.ownership = { rows: [{ path: 'apps/web/', writer: 'web-dev', notes: '' }] };
  let md = draftRole(spec, kit, { start: 'copy', from: 'qa-web', title: 'Accessibility auditor', slug: 'accessibility-auditor', group: 'quality', reportsTo: 'head-of-quality' });
  md = setOwnsPaths(md, [{ path: 'apps/web/src/components/', mode: 'writes' }]);
  addAgent(spec, 'accessibility-auditor', md);
  assert.deepEqual(pathConflicts(spec, 'accessibility-auditor', 'apps/web/src/components/'), [{ path: 'apps/web/', writer: 'web-dev' }]);
  assert.ok(validate(spec, kit).some((i) => i.level === 'error' && i.where === 'roles/accessibility-auditor' && /one writer/.test(i.message)));
  spec.roles['accessibility-auditor'].brief = setOwnsPaths(md, [{ path: 'apps/web/src/components/', mode: 'reads' }, { path: 'tests/a11y/', mode: 'writes' }]);
  assert.ok(!validate(spec, kit).some((i) => i.level === 'error'), JSON.stringify(validate(spec, kit).filter((i) => i.level === 'error')));
});

test('an agent publishes as a project role, and travels as a role pack', () => {
  const { root, spec } = team();
  const md = draftRole(spec, kit, { start: 'copy', from: 'qa-web', title: 'Accessibility auditor', slug: 'accessibility-auditor', group: 'quality', reportsTo: 'head-of-quality' });
  addAgent(spec, 'accessibility-auditor', setOwnsPaths(md, [{ path: 'tests/a11y/', mode: 'writes' }]));
  writeLayer(root, compileLayer(spec, kit));
  assert.ok(readLayer(root)['roles/accessibility-auditor.md']);
  const files = build(root).files;
  assert.match(files.get('docs/team/roles/accessibility-auditor.md'), /^# Accessibility auditor/m);
  assert.deepEqual(importLayer(readLayer(root), kit).roles['accessibility-auditor'].brief, spec.roles['accessibility-auditor'].brief);
  const pack = rolePack(spec, 'accessibility-auditor');
  assert.deepEqual(JSON.parse(pack['pack.json']).needs.paths, ['tests/a11y/']);
  const [back] = readPack(pack);
  assert.equal(back.slug, 'accessibility-auditor');
  assert.equal(back.md, spec.roles['accessibility-auditor'].brief);
  const other = team().spec;
  const imported = draftRole(other, kit, { start: 'import', md: back.md, title: 'Accessibility auditor', slug: 'a11y-auditor', reportsTo: 'head-of-quality' });
  assert.match(imported, /team-status\.sh a11y-auditor status working/);
});

test('an extension file keeps its own formatting through a round trip', () => {
  const { root } = team();
  const text = '# QA Web\n**Model:** routine\n\n## Rules (replace)\n- Same rules as QA Android.\n';
  writeLayer(root, { ...readLayer(root), 'roles/qa-web.extend.md': text });
  const spec = importLayer(readLayer(root), kit);
  assert.equal(compileLayer(spec, kit)['roles/qa-web.extend.md'], text);
  spec.roles['qa-web'].extension.fields[0].value = 'standard';
  assert.match(compileLayer(spec, kit)['roles/qa-web.extend.md'], /\*\*Model:\*\* standard/);
});
