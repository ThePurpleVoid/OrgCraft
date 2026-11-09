import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadBriefs, parseBrief, TIERS } from '../tools/briefs.mjs';
import { check, parents, tree } from '../tools/roster.mjs';
import { toSubagent } from '../tools/export-subagents.mjs';

const dir = fileURLToPath(new URL('../team/roles', import.meta.url));
const roles = loadBriefs(dir);

test('every kit brief passes the check with no warnings', () => {
  const { errors, warnings } = check(roles);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('every brief has a known tier, a group and the shared footer', () => {
  for (const r of roles) {
    assert.ok(TIERS.includes(r.tier), r.slug);
    assert.ok(r.group, r.slug);
    // Kit 0.22: a brief names its own slug as {{ROLE}}, which sync fills with each teammate's id.
    assert.match(r.body, /roles\/\{\{ROLE\}\}\.md/, r.slug);
  }
});

test('the chief of staff is the only role that reports to the owner', () => {
  assert.deepEqual(roles.filter((r) => r.reportsTo === 'owner').map((r) => r.slug), ['chief-of-staff']);
});

test('a missing manager falls back to the chief of staff', () => {
  const few = roles.filter((r) => ['chief-of-staff', 'backend-dev'].includes(r.slug));
  assert.equal(parents(few)['backend-dev'], 'chief-of-staff');
  assert.equal(check(few).errors.length, 0);
});

test('loops and bad tiers are errors', () => {
  const a = parseBrief('a', '# A\n**Model:** standard\n**Reports to:** b\n## Identity\nx\n## Owns (writes)\ny\n');
  const b = parseBrief('b', '# B\n**Model:** huge\n**Reports to:** a\n## Identity\nx\n## Owns (writes)\ny\n');
  const top = parseBrief('top', '# T\n**Model:** deep\n**Reports to:** owner\n## Identity\nx\n## Owns (writes)\ny\n');
  const { errors } = check([a, b, top]);
  assert.ok(errors.some((e) => e.includes('loops')));
  assert.ok(errors.some((e) => e.startsWith('b: **Model:**')));
});

test('the tree starts at the owner and lists every role once', () => {
  const t = tree(roles).split('\n');
  assert.equal(t[0], 'owner');
  assert.equal(t.length, roles.length + 1);
});

test('subagent export has valid frontmatter and keeps the brief', () => {
  const cto = roles.find((r) => r.slug === 'cto');
  const md = toSubagent(cto);
  assert.match(md, /^---\nname: cto\ndescription: ".+"\nmodel: opus\n---\n/);
  assert.ok(md.includes('## Direct reports'));
  const triager = toSubagent(roles.find((r) => r.slug === 'bug-triager'));
  assert.match(triager, /\nmodel: haiku\n/);
});
