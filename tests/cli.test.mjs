import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extendBrief, fitToTeam, presetRoles } from '../bin/agent-team.mjs';

const BASE = `# Role

**Model:** standard
**Reports to:** cto

## Identity
Do the thing.

## Direct reports
a, b, c

## Rules
- One.

## Every thread, every task
- Footer.
`;

test('an extension replaces header fields and appends to sections', () => {
  const out = extendBrief(BASE, '**Model:** deep (high effort)\n\n## Rules\n- Two.\n');
  assert.match(out, /\*\*Model:\*\* deep \(high effort\)/);
  assert.doesNotMatch(out, /\*\*Model:\*\* standard/);
  assert.match(out, /- One\.\n- Two\./);
});

test('"(replace)" replaces a section and new sections go before the footer', () => {
  const out = extendBrief(BASE, '## Direct reports (replace)\nx, y\n\n## Escalation\nCall the owner.\n');
  assert.match(out, /## Direct reports\nx, y\n/);
  assert.ok(out.indexOf('## Escalation') < out.indexOf('## Every thread'));
  assert.doesNotMatch(out, /\(replace\)/);
});

test('a title line renames the role', () => {
  const out = extendBrief(BASE, '# Better role\n**Model:** deep\n');
  assert.match(out, /^# Better role\n/);
  assert.equal(out.match(/^# /gm).length, 1);
});

test('new header fields are added after the existing ones', () => {
  const out = extendBrief(BASE, '**Status:** dormant until needed\n');
  assert.match(out, /\*\*Reports to:\*\* cto\n\*\*Status:\*\* dormant until needed/);
});

test('reporting lines fit the installed team', () => {
  const out = fitToTeam(BASE, new Set(['chief-of-staff', 'a', 'c']));
  assert.match(out, /\*\*Reports to:\*\* chief-of-staff \(cto is not part of this team\)/);
  assert.match(out, /## Direct reports\na, c\n/);
  const none = fitToTeam(BASE, new Set(['chief-of-staff', 'cto']));
  assert.doesNotMatch(none, /## Direct reports/);
  assert.match(none, /\*\*Reports to:\*\* cto/);
});

test('presets resolve to kit roles', () => {
  assert.equal(presetRoles('minimal').length, 11);
  assert.equal(presetRoles('engineering').length, 28);
  assert.ok(presetRoles('company').length >= 48);
  assert.throws(() => presetRoles('nope'), /No preset/);
});
