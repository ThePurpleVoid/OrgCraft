// The Studio's change-safety helpers (apps/studio/public/safety.js) in Node: the popover's Undo puts back only the
// change it names (code review of #97).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// The page imports './team-model.mjs', which the Studio serves from packages/team-model: do the same here.
const dir = mkdtempSync(join(tmpdir(), 'studio-safety-'));
copyFileSync(new URL('../apps/studio/public/safety.js', import.meta.url), join(dir, 'safety.mjs'));
writeFileSync(join(dir, 'team-model.mjs'), `export * from ${JSON.stringify(new URL('../packages/team-model/index.mjs', import.meta.url).href)};\n`);
const { revert, clauseOf, rebaseDraft } = await import(pathToFileURL(join(dir, 'safety.mjs')).href);

const brief = (tier, rules, owns) => `# Clerk\n\n**Model:** ${tier}\n**Reports to:** chief-of-staff\n**Status:** active\n\n## Identity\nYou file things.\n\n## Rules\n${rules}\n\n## Owns (writes)\n${owns}\n`;
const clone = (x) => JSON.parse(JSON.stringify(x));

test('Undo tier change keeps the rule edits; Undo brief changes keeps the tier', () => {
  const published = { roles: { clerk: { enabled: true, brief: brief('standard', '- Old rule', '- `files/`') } } };
  const draft = { roles: { clerk: { enabled: true, brief: brief('deep', '- New rule', '- `files/`') } } };
  const a = clone(draft);
  revert(a, published, { kind: 'tier', role: 'clerk', id: 'tier:clerk' });
  assert.match(a.roles.clerk.brief, /\*\*Model:\*\* standard/);
  assert.match(a.roles.clerk.brief, /- New rule/);
  const b = clone(draft);
  revert(b, published, { kind: 'brief', role: 'clerk', id: 'brief:clerk' });
  assert.match(b.roles.clerk.brief, /\*\*Model:\*\* deep/);
  assert.match(b.roles.clerk.brief, /- Old rule/);
});

test('a kit role: the tier undo resets only that extension field', () => {
  const published = { roles: { qa: { enabled: true, extension: { fields: [], sections: [{ name: 'Rules', text: 'x' }] } } } };
  const draft = { roles: { qa: { enabled: true, extension: { fields: [{ name: 'Model', value: 'deep' }, { name: 'Reports to', value: 'cto' }], sections: [{ name: 'Rules', text: 'y' }] } } } };
  revert(draft, published, { kind: 'tier', role: 'qa', id: 'tier:qa' });
  assert.deepEqual(draft.roles.qa.extension.fields, [{ name: 'Reports to', value: 'cto' }]);
  assert.equal(draft.roles.qa.extension.sections[0].text, 'y');
});

test('Undo area move restores the ownership row and both roles\' Owns lines, so there is one writer', () => {
  const published = { roles: { clerk: { enabled: true, brief: brief('standard', '- r', '- `files/`') } }, ownership: { rows: [{ path: 'files/', writer: 'clerk' }] } };
  const draft = clone(published);
  draft.roles.clerk.brief = brief('standard', '- r', 'Nothing yet');
  draft.roles.filer = { enabled: true, brief: brief('standard', '- r', '- `files/`\n- `other/`') };
  draft.ownership.rows = [{ path: 'files/', writer: 'filer' }];
  revert(draft, published, { kind: 'path-moved', role: 'clerk', id: 'path-moved:clerk:files/' });
  assert.deepEqual(draft.ownership.rows, [{ path: 'files/', writer: 'clerk' }]);
  assert.match(draft.roles.clerk.brief, /^- `files\/`$/m);
  assert.doesNotMatch(draft.roles.filer.brief, /`files\/`/);
  assert.match(draft.roles.filer.brief, /^- `other\/`$/m);
});

test('the popover heading reads as one sentence', () => {
  assert.equal(clauseOf({ kind: 'role-off' }), 'this draft switches it off');
  assert.equal(clauseOf({ kind: 'path-moved' }), 'this draft moves an area it works in away from it');
});

test('a card deadline shows its day when it is not today (QA #28 D)', async () => {
  const { fmtWhen } = await import(new URL('../apps/studio/public/chat.js', import.meta.url).href);
  const now = new Date(2026, 10, 6, 5, 40);
  assert.doesNotMatch(fmtWhen(new Date(2026, 10, 6, 5, 42).toISOString(), now), /tomorrow|yesterday/);
  assert.match(fmtWhen(new Date(2026, 10, 7, 5, 42).toISOString(), now), /^tomorrow /);
  assert.match(fmtWhen(new Date(2026, 10, 9, 5, 42).toISOString(), now), /9/);
});

test('the popover says what the role is doing, and a quiet row\'s age once (QA notes on #97)', async () => {
  const { popoverHtml } = await import(pathToFileURL(join(dir, 'safety.mjs')).href + '?again');
  const item = { id: 'role-off:x', kind: 'role-off', role: 'x' };
  const html = (row) => popoverHtml({ slug: 'x', title: 'X', items: [item], row, spec: {}, roles: [], newest: null });
  assert.match(html({ status: 'blocked', age_s: 60 }), /X is blocked, and this draft switches it off/);
  assert.match(html({ status: 'working', age_s: 60 }), /X is working right now/);
  const stale = html({ status: 'working', age_s: 3 * 3600, last_at: 'x', task: 'Review', issue: '31' });
  assert.match(stale, /X has work in flight/);
  assert.equal((stale.match(/3 h/g) ?? []).length, 1);
});

test('the plan: one line per item, with the target; a deferred move keeps its writer in what is published (criteria 9, 11)', async () => {
  const { planText, publishable, recommendations } = await import(pathToFileURL(join(dir, 'safety.mjs')).href + '?plan');
  const item = { id: 'path-moved:clerk:files/', kind: 'path-moved', role: 'clerk', detail: 'files/ moves from clerk to filer', severity: 'choice', inFlight: { state: 'working', task: 'Index', branch: 'b', pr: '7' }, choices: ['move-after-merge', 'move-and-handover'], recommended: 'move-after-merge' };
  const published = { roles: { clerk: { enabled: true, brief: brief('standard', '- r', '- `files/`') } }, ownership: { rows: [{ path: 'files/', writer: 'clerk' }] } };
  const draft = JSON.parse(JSON.stringify(published));
  draft.roles.clerk.brief = brief('standard', '- r', 'Nothing yet');
  draft.roles.filer = { enabled: true, brief: brief('standard', '- r', '- `files/`') };
  draft.ownership.rows = [{ path: 'files/', writer: 'filer' }];
  const on = [{ slug: 'clerk', title: 'Clerk' }, { slug: 'filer', title: 'Filer' }];
  const picks = recommendations([item], draft, on);
  assert.deepEqual(picks.get(item.id), { choice: 'move-after-merge', target: 'filer' });
  assert.match(planText([item], picks, (s) => s), /^- clerk \(clerk\): Index, branch b, PR #7\. Area files\/ moved from clerk to filer: move the area after PR #7 merges\.$/m);
  const { spec, deferred } = publishable(draft, published, [item], picks);
  assert.deepEqual(spec.ownership.rows, [{ path: 'files/', writer: 'clerk' }]);
  assert.doesNotMatch(spec.roles.filer.brief, /`files\//);
  assert.deepEqual(deferred.map(({ owns, ...f }) => f), [{ path: 'files/', from: 'clerk', to: 'filer', pr: '7' }]);
  assert.deepEqual(deferred[0].owns.filer, [{ path: 'files/', mode: 'writes', note: '' }], 'the draft\'s Owns lines, kept for a reload');
  assert.equal(draft.ownership.rows[0].writer, 'filer', 'the draft keeps the move');
  picks.set(item.id, { choice: 'move-and-handover', target: 'filer' });
  assert.match(planText([item], picks, (s) => s), /move the area now and hand the files over, to filer\./);
  assert.equal(publishable(draft, published, [item], picks).deferred.length, 0);
  assert.equal(planText([], new Map(), (s) => s), '');
  assert.match(planText([item], picks, (s) => s), /^The team carries these out when this change is merged\./m, 'no chief of staff assumed');
  assert.match(planText([item], picks, (s) => s, 'front desk'), /^Front desk carries these out/m);
});

test('a deferred move comes back into a draft read from disk (code review of #103)', async () => {
  const { publishable, recommendations, reapplyFollowUp } = await import(pathToFileURL(join(dir, 'safety.mjs')).href + '?again2');
  const item = { id: 'path-moved:clerk:files/', kind: 'path-moved', role: 'clerk', detail: 'x', severity: 'choice', inFlight: { pr: '7' }, choices: ['move-after-merge', 'move-and-handover'], recommended: 'move-after-merge' };
  const published = { roles: { clerk: { enabled: true, brief: brief('standard', '- r', '- `files/`') }, filer: { enabled: true, brief: brief('standard', '- r', '- `other/`') } }, ownership: { rows: [{ path: 'files/', writer: 'clerk' }] } };
  const draft = JSON.parse(JSON.stringify(published));
  draft.roles.clerk.brief = brief('standard', '- r', 'Nothing yet');
  draft.roles.filer.brief = brief('standard', '- r', '- `other/`\n- `files/`');
  draft.ownership.rows = [{ path: 'files/', writer: 'filer' }];
  const { spec: onDisk, deferred } = publishable(draft, published, [item], recommendations([item], draft, [{ slug: 'clerk', title: 'C' }, { slug: 'filer', title: 'F' }]));
  const reloaded = JSON.parse(JSON.stringify(onDisk));
  assert.equal(reapplyFollowUp(reloaded, JSON.parse(JSON.stringify(deferred[0]))), true);
  assert.deepEqual(reloaded.ownership.rows, [{ path: 'files/', writer: 'filer' }]);
  assert.match(reloaded.roles.filer.brief, /^- `files\/`$/m);
  assert.match(reloaded.roles.filer.brief, /^- `other\/`$/m);
  assert.doesNotMatch(reloaded.roles.clerk.brief, /`files\/`/);
  assert.equal(reapplyFollowUp(reloaded, deferred[0]), false, 'once is enough');
});

test('a kept draft made before someone else published comes back on top of their version (publish.stale, B1.1-10)', () => {
  const from = { values: { PROJECT_NAME: 'Acme' }, roles: { a: { enabled: true }, b: { enabled: true }, c: { enabled: false } }, meetings: { meetings: [] } };
  // Mine: switched b off and c on, and added a meeting.
  const mine = { ...clone(from), roles: { a: { enabled: true }, b: { enabled: false }, c: { enabled: true } }, meetings: { meetings: [{ id: 'weekly' }] } };
  // Theirs, published meanwhile: a renamed, a new role d, and the project name changed.
  const now = { values: { PROJECT_NAME: 'Acme Inc' }, roles: { a: { enabled: true, extension: { title: 'Alpha' } }, b: { enabled: true }, c: { enabled: false }, d: { enabled: true } }, meetings: { meetings: [] } };
  const out = rebaseDraft(from, mine, now);
  assert.deepEqual(out.roles, { a: { enabled: true, extension: { title: 'Alpha' } }, b: { enabled: false }, c: { enabled: true }, d: { enabled: true } }, 'their work stays, mine is on top');
  assert.equal(out.values.PROJECT_NAME, 'Acme Inc');
  assert.deepEqual(out.meetings, { meetings: [{ id: 'weekly' }] });
  // A role I removed stays removed; nothing of mine changes theirs when I did not touch it.
  const gone = rebaseDraft(from, { ...clone(from), roles: { a: { enabled: true }, b: { enabled: true } } }, now);
  assert.equal(gone.roles.c, undefined);
  assert.deepEqual(gone.roles.d, { enabled: true });
});
