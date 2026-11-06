// The team model's contract: a layer imported into a TeamSpec and compiled back builds exactly the same team.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { build, KIT } from '../bin/agent-team.mjs';
import { compileLayer, formatExtension, importLayer, parseExtension, resolveSpec, setEnabled, setField, setSection } from '../packages/team-model/index.mjs';
import { loadKit, readLayer, writeLayer } from '../packages/team-model/node.mjs';

const kit = loadKit();
const tmp = (name) => mkdtempSync(join(tmpdir(), `team-model-${name}-`));

/** A repository folder holding just this layer (plus ownership.md, which the dashboard export reads). */
function repoFrom(layerDir, ownership) {
  const root = tmp('repo');
  cpSync(layerDir, join(root, '.agent-team'), { recursive: true });
  if (ownership && existsSync(ownership)) { mkdirSync(join(root, 'docs/team'), { recursive: true }); cpSync(ownership, join(root, 'docs/team/ownership.md')); }
  return root;
}

/** Builds the team from a repository folder, then from the layer that import → compile gives, and compares. */
function assertRoundTrip(root) {
  const before = build(root).files;
  const spec = JSON.parse(JSON.stringify(importLayer(readLayer(root), kit))); // through JSON, as the Studio stores it
  const copy = tmp('copy');
  cpSync(root, copy, { recursive: true });
  writeLayer(copy, compileLayer(spec, kit));
  const after = build(copy).files;
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  for (const [path, content] of before) assert.equal(after.get(path), content, `${path} differs after the round trip`);
  return spec;
}

const layers = [
  ['examples/native-mobile', join(KIT, 'examples/native-mobile/.agent-team'), null],
  ['this repository', join(KIT, '.agent-team'), join(KIT, 'docs/team/ownership.md')],
];
for (const [name, dir, ownership] of layers) {
  test(`round trip: ${name}`, () => assertRoundTrip(repoFrom(dir, ownership)));
}

for (const preset of Object.keys(kit.presets)) {
  for (const subagents of [false, true]) {
    test(`round trip: a fresh ${preset} team${subagents ? ' with subagents' : ''}`, () => {
      const root = tmp(preset);
      const args = [join(KIT, 'bin/agent-team.mjs'), 'init', '--preset', preset, '--project', 'Round Trip', '--dir', root];
      if (subagents) args.push('--subagents');
      execFileSync(process.execPath, args, { stdio: 'ignore' });
      assertRoundTrip(root);
    });
  }
}

test('import lists the whole library and marks what is on', () => {
  const spec = importLayer(readLayer(repoFrom(join(KIT, 'examples/native-mobile/.agent-team'))), kit);
  assert.equal(Object.keys(kit.roles).every((s) => s in spec.roles), true);
  assert.equal(spec.roles['mobile-dev'].enabled, false);
  assert.equal(spec.roles['ios-dev'].source, 'project');
  assert.equal(spec.roles['cfo'].enabled, false);
  assert.equal(spec.roles['cto'].extension.sections[0].mode, 'replace');
});

test('switching roles on and off gives the smallest include/exclude', () => {
  const root = tmp('toggle');
  execFileSync(process.execPath, [join(KIT, 'bin/agent-team.mjs'), 'init', '--preset', 'minimal', '--dir', root], { stdio: 'ignore' });
  const spec = importLayer(readLayer(root), kit);
  setEnabled(spec, 'performance-tester', true);
  setEnabled(spec, 'docs-keeper', false);
  const team = JSON.parse(compileLayer(spec, kit)['team.json']);
  assert.deepEqual(team.include, ['performance-tester']);
  assert.deepEqual(team.exclude, ['docs-keeper']);
  setEnabled(spec, 'docs-keeper', true);
  assert.deepEqual(JSON.parse(compileLayer(spec, kit)['team.json']).exclude, []);
});

test('editing a kit role writes an extension that sync applies', () => {
  const root = tmp('edit');
  execFileSync(process.execPath, [join(KIT, 'bin/agent-team.mjs'), 'init', '--preset', 'minimal', '--dir', root], { stdio: 'ignore' });
  const spec = importLayer(readLayer(root), kit);
  setField(spec, 'backend-dev', 'Model', 'deep (high effort)');
  setSection(spec, 'backend-dev', 'Rules', '- Every migration has a rollback note.');
  const layer = compileLayer(spec, kit);
  assert.equal(layer['roles/backend-dev.extend.md'], '**Model:** deep (high effort)\n\n## Rules\n- Every migration has a rollback note.\n');
  writeLayer(root, layer);
  const brief = build(root).files.get('docs/team/roles/backend-dev.md');
  assert.match(brief, /\*\*Model:\*\* deep \(high effort\)/);
  assert.match(brief, /- Every migration has a rollback note\./);
  // resolveSpec (what the editor shows) agrees with sync.
  const resolved = resolveSpec(spec, kit).roles.find((r) => r.slug === 'backend-dev');
  assert.match(resolved.md, /rollback note/);
});

test('a project role switched off keeps its file, is listed in exclude, and comes back unchanged', () => {
  const root = repoFrom(join(KIT, 'examples/native-mobile/.agent-team'));
  const original = readLayer(root);
  const brief = original['roles/qa-ios.md'];
  const spec = importLayer(original, kit);
  setEnabled(spec, 'qa-ios', false);
  const off = compileLayer(spec, kit);
  assert.equal(off['roles/qa-ios.md'], brief, 'the file stays');
  assert.ok(JSON.parse(off['team.json']).exclude.includes('qa-ios'), 'exclude lists it');
  writeLayer(root, off);
  assert.equal(existsSync(join(root, '.agent-team/roles/qa-ios.md')), true);
  assert.equal(existsSync(join(root, '.agent-team/config.sh')), true, 'files outside the model are left alone');
  assert.equal(build(root).roles.some((r) => r.slug === 'qa-ios'), false, 'sync does not install it');
  // import → compile of the switched-off layer changes nothing.
  const again = importLayer(readLayer(root), kit);
  assert.equal(again.roles['qa-ios'].enabled, false);
  assert.deepEqual(compileLayer(again, kit), off);
  // Switching it back on restores the layer as it was.
  setEnabled(again, 'qa-ios', true);
  const on = compileLayer(again, kit);
  assert.equal(on['roles/qa-ios.md'], brief);
  assert.deepEqual(JSON.parse(on['team.json']), JSON.parse(original['team.json']));
});

test('a custom agent (not in the kit) switched off survives a publish and switching back on gives the same brief', () => {
  const root = repoFrom(join(KIT, 'examples/native-mobile/.agent-team'));
  const md = '# Pricing analyst\n\n**Reports to:** cto\n\n## Mission\nKeep prices honest.\n';
  writeFileSync(join(root, '.agent-team/roles/pricing-analyst.md'), md);
  const spec = importLayer(readLayer(root), kit);
  assert.equal(spec.roles['pricing-analyst'].source, 'project');
  setEnabled(spec, 'pricing-analyst', false);
  writeLayer(root, compileLayer(spec, kit));
  assert.equal(readFileSync(join(root, '.agent-team/roles/pricing-analyst.md'), 'utf8'), md);
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.agent-team/team.json'), 'utf8')).exclude, ['mobile-dev', 'qa-mobile', 'pricing-analyst']);
  assert.equal(build(root).roles.some((r) => r.slug === 'pricing-analyst'), false);
  const back = importLayer(readLayer(root), kit);
  setEnabled(back, 'pricing-analyst', true);
  writeLayer(root, compileLayer(back, kit));
  assert.equal(build(root).roles.find((r) => r.slug === 'pricing-analyst').source, 'project');
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.agent-team/team.json'), 'utf8')).exclude, ['mobile-dev', 'qa-mobile']);
});

test('extensions survive parse and format', () => {
  const md = '# Lead dev\n\n**Model:** deep\n**Status:** dormant until asked\n\n## Rules\n- One.\n- Two.\n\n## Owns (writes) (replace)\napi/\n';
  const ext = parseExtension(md);
  assert.deepEqual(ext, { title: 'Lead dev', fields: [{ name: 'Model', value: 'deep' }, { name: 'Status', value: 'dormant until asked' }], sections: [{ name: 'Rules', mode: 'append', text: '- One.\n- Two.' }, { name: 'Owns (writes)', mode: 'replace', text: 'api/' }] });
  assert.equal(formatExtension(ext), md);
});

test('the CLI imports and compiles', () => {
  const root = tmp('cli');
  const cli = join(KIT, 'bin/agent-team.mjs');
  execFileSync(process.execPath, [cli, 'init', '--preset', 'minimal', '--dir', root], { stdio: 'ignore' });
  const spec = JSON.parse(execFileSync(process.execPath, [cli, 'import', '--dir', root], { encoding: 'utf8' }));
  assert.equal(spec.schema, 'agent-team/team-spec@1');
  spec.roles['ux-writer'].enabled = true;
  writeFileSync(join(root, 'spec.json'), JSON.stringify(spec));
  execFileSync(process.execPath, [cli, 'compile', join(root, 'spec.json'), '--dir', root], { stdio: 'ignore' });
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.agent-team/team.json'), 'utf8')).include, ['ux-writer']);
  assert.ok(readdirSync(join(root, 'docs/team/roles')).includes('ux-writer.md'));
});
