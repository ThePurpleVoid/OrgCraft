// Kit 0.13: protocols and project instructions are a neutral core plus packs (CPO story "Neutral protocols", D37 to D41).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KIT } from '../bin/agent-team.mjs';
import { PACK_DOCS, checkPacks, composeDoc, docSlots, fitToPacks, importLayer, parseFills, teamDoc, teamPacks, validate } from '../packages/team-model/index.mjs';
import { loadKit } from '../packages/team-model/node.mjs';

const kit = loadKit();
const cli = join(KIT, 'bin/agent-team.mjs');
// Criterion 1: the words the core must not use.
const ENGINEERING = /\b(pull requests?|PRs?|merge[sd]?|merging|branch(es)?|commits?|deploy\w*|ci|builds?|building|worktrees?|migrations?)\b/i;

test('the core protocols and project instructions use no engineering words (criterion 1)', () => {
  for (const f of PACK_DOCS) {
    const core = teamDoc(kit, f, []);
    const hit = core.split('\n').find((l) => ENGINEERING.test(l));
    assert.equal(hit, undefined, `${f}: ${hit}`);
    assert.doesNotMatch(core, /<!-- (slot|fill)/, f);
  }
});

test('core plus the engineering pack is exactly the 0.12 text: no rule lost or changed (criteria 2 and 4, D41)', () => {
  for (const f of PACK_DOCS) assert.equal(teamDoc(kit, f, ['engineering']), readFileSync(join(KIT, 'tests/fixtures/core-0.12', f), 'utf8'), f);
  assert.deepEqual(checkPacks(kit), []);
  // Every slot the engineering pack fills exists, and every fill is used.
  for (const f of PACK_DOCS) for (const name of Object.keys(parseFills(kit.packs.engineering[f]))) assert.ok(docSlots(kit.docs[f]).includes(name), `${f}: ${name}`);
});

test('a team without "packs" gets the engineering pack; packs [] gets the core only', () => {
  assert.deepEqual(teamPacks({}), ['engineering']);
  assert.deepEqual(teamPacks({ packs: [] }), []);
  for (const preset of ['minimal', 'engineering', 'company']) {
    const root = mkdtempSync(join(tmpdir(), `packs-${preset}-`));
    execFileSync('git', ['init', '-q'], { cwd: root });
    const r = spawnSync(process.execPath, [cli, 'init', '--preset', preset, '--project', 'Acme', '--kit', 'file:' + KIT], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const team = JSON.parse(readFileSync(join(root, '.agent-team/team.json'), 'utf8'));
    assert.equal(team.packs, undefined, preset);
    assert.match(readFileSync(join(root, 'docs/team/protocols.md'), 'utf8'), /## Pull requests/, preset);
    assert.match(readFileSync(join(root, 'docs/team/roles/chief-of-staff.md'), 'utf8'), /Push before long steps/, preset);
    team.packs = [];
    writeFileSync(join(root, '.agent-team/team.json'), JSON.stringify(team, null, 2));
    assert.equal(spawnSync(process.execPath, [cli, 'sync'], { cwd: root, encoding: 'utf8' }).status, 0, preset);
    const protocols = readFileSync(join(root, 'docs/team/protocols.md'), 'utf8');
    assert.doesNotMatch(protocols, /## Pull requests/, preset);
    assert.match(protocols, /## Saving work/, preset);
    assert.match(readFileSync(join(root, 'docs/team/roles/chief-of-staff.md'), 'utf8'), /Save your work where the team can see it/, preset);
  }
});

test('an unknown pack is refused by validate and by sync', () => {
  const spec = importLayer({ 'team.json': JSON.stringify({ preset: 'minimal', packs: ['legal'] }) }, kit);
  assert.ok(validate(spec, kit).some((i) => i.level === 'error' && /packs lists "legal"/.test(i.message)));
  const root = mkdtempSync(join(tmpdir(), 'packs-bad-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  spawnSync(process.execPath, [cli, 'init', '--preset', 'minimal', '--project', 'Acme', '--kit', 'file:' + KIT], { cwd: root });
  const f = join(root, '.agent-team/team.json');
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), packs: ['legal'] }));
  const r = spawnSync(process.execPath, [cli, 'sync'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /packs lists "legal"/);
});

test('composeDoc: a fill replaces its slot, a missing fill keeps the default, empty slots leave no gap', () => {
  const core = 'A\n\n<!-- slot:x -->\nneutral\n<!-- /slot -->\n\n<!-- slot:y -->\n<!-- /slot -->\n\nB\n';
  assert.equal(composeDoc(core, []), 'A\n\nneutral\n\nB\n');
  assert.equal(composeDoc(core, ['<!-- fill:x -->\nengineering\n\n<!-- fill:y -->\nmore\n']), 'A\n\nengineering\n\nmore\n\nB\n');
  assert.equal(fitToPacks('x Push before long steps and at the end of the task. y', []), 'x Save your work where the team can see it before long steps and at the end of the task. y');
  assert.equal(fitToPacks('Push before long steps and at the end of the task.', ['engineering']), 'Push before long steps and at the end of the task.');
});
