// Kit 0.12: team templates (team/templates/<id>/), `agent-team templates`, `init --template` and `validate --template`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KIT, VERSION } from '../bin/agent-team.mjs';
import { checkTemplate, readTemplate, templateCard, templateLayer, templateSpec, validate } from '../packages/team-model/index.mjs';
import { loadKit, loadTemplates } from '../packages/team-model/node.mjs';

const kit = loadKit();
const templates = loadTemplates();
const cli = join(KIT, 'bin/agent-team.mjs');
const clone = (x) => JSON.parse(JSON.stringify(x));
const withTemplate = (id, edit) => {
  const files = clone(templates[id]);
  const t = JSON.parse(files['template.json']);
  edit(t, files);
  files['template.json'] = JSON.stringify(t);
  return files;
};

test('the three must-ship templates exist, in the template format', () => {
  for (const id of ['startup-product-team', 'customer-support-team', 'content-studio']) {
    assert.ok(templates[id], `missing ${id}`);
    const { template } = readTemplate(templates[id]);
    assert.equal(template.schema, 'agent-team/team-template@1');
    assert.equal(template.id, id);
  }
});

test('every template gives a team with zero validate errors and zero warnings', () => {
  for (const [id, files] of Object.entries(templates)) {
    assert.deepEqual(checkTemplate(files, kit), [], id);
    const spec = templateSpec(files, kit, { project: 'Acme', kitVersion: VERSION });
    assert.deepEqual(validate(spec, kit).filter((i) => i.level !== 'info'), [], id);
  }
});

test('team.json records the template and kit version; no demo data in the generated team', () => {
  for (const [id, files] of Object.entries(templates)) {
    const team = JSON.parse(templateLayer(files, kit, { project: 'Acme', kitVersion: VERSION })['team.json']);
    assert.equal(team.from, `${id}@${VERSION}`);
    assert.equal(team.values.PROJECT_NAME, 'Acme');
    const layer = templateLayer(files, kit, { project: 'Acme', kitVersion: VERSION });
    assert.ok(!layer['board.json'] && !Object.keys(layer).some((f) => /demo|sample/i.test(f)), id);
  }
});

test('init --template writes exactly the layer the Studio makes from the same template', () => {
  for (const id of Object.keys(templates)) {
    const root = mkdtempSync(join(tmpdir(), `tpl-${id}-`));
    execFileSync('git', ['init', '-q'], { cwd: root });
    const r = spawnSync(process.execPath, [cli, 'init', '--template', id, '--project', 'Acme', '--kit', 'file:' + KIT], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const layer = templateLayer(templates[id], kit, { project: 'Acme', kitVersion: VERSION, kitSpec: 'file:' + KIT });
    for (const [file, text] of Object.entries(layer)) assert.equal(readFileSync(join(root, '.agent-team', file), 'utf8'), text, `${id}: ${file}`);
    const v = spawnSync(process.execPath, [cli, 'validate'], { cwd: root, encoding: 'utf8' });
    assert.equal(v.status, 0, v.stdout + v.stderr);
    assert.match(v.stdout, /0 errors, 0 warnings/);
  }
});

test('business-function templates use no code, Git, CI or engineering words in their briefs', () => {
  const words = /\b(code|git|github|ci|pull requests?|PRs?|merge|deploy|repo(sitory)?|engineer(ing|s)?|bugs?|commits?|branch(es)?|tests?|builds?|cto|qa)\b(?!-)/i;
  for (const [id, files] of Object.entries(templates)) {
    if (JSON.parse(files['template.json']).group !== 'business-function') continue;
    const root = mkdtempSync(join(tmpdir(), `neutral-${id}-`));
    execFileSync('git', ['init', '-q'], { cwd: root });
    spawnSync(process.execPath, [cli, 'init', '--template', id, '--project', 'Acme', '--kit', 'file:' + KIT], { cwd: root });
    const card = templateCard(files, kit);
    for (const slug of card.roles) {
      // The shared "Every thread, every task" footer is the same for every role in every team.
      const brief = readFileSync(join(root, 'docs/team/roles', `${slug}.md`), 'utf8').split('## Every thread, every task')[0];
      const hit = brief.split('\n').find((l) => words.test(l));
      assert.equal(hit, undefined, `${id}/${slug}: ${hit}`);
    }
    for (const text of [card.title, card.summary]) assert.doesNotMatch(text, words, id);
  }
});

test('templates list on the command line with a card per template', () => {
  const r = spawnSync(process.execPath, [cli, 'templates'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  for (const id of Object.keys(templates)) assert.match(r.stdout, new RegExp(`^${id}\\s`, 'm'));
  const card = templateCard(templates['customer-support-team'], kit);
  assert.equal(card.groupTitle, 'Run a business function');
  assert.ok(card.roles.includes('support-responder') && card.roles.includes('knowledge-base-writer'));
});

test('checkTemplate catches unknown roles, secrets, a missing hand-off and missing sign-off evidence', () => {
  const issues = (files) => checkTemplate(files, kit).filter((i) => i.level === 'error').map((i) => i.message).join('\n');
  assert.match(issues(withTemplate('content-studio', (t) => t.roles.push('no-such-role'))), /no-such-role/);
  assert.match(issues(withTemplate('content-studio', (t) => { t.systems[0].config = { password: 'hunter2hunter2' }; })), /secret|config/i);
  assert.match(issues(withTemplate('content-studio', (t, f) => { f['roles/fact-checker.md'] = f['roles/fact-checker.md'].replace(/## Hands to\n[^\n]*\n/, ''); })), /Hands to/);
  assert.match(issues(withTemplate('content-studio', (t, f) => { f['roles/editor.md'] = f['roles/editor.md'].replace(/## Sign-off evidence\n(- [^\n]*\n)+/, ''); })), /evidence/i);
  const bad = spawnSync(process.execPath, [cli, 'validate', '--template', 'no-such-template'], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
});
