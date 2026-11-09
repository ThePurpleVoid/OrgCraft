// Change safety part 1 in a real browser (PRD 6.9 X1, X5, X9; CPO story criteria 1 to 6 and 12; mockup 06): with
// board reports, every card shows its state, a draft change that touches work in flight marks the card amber with a
// reason and explains itself in place, the inspector lists the work, and the top bar counts it. Without board reports,
// none of it shows.
//
//   node --test tests/e2e/studio-change-safety.e2e.mjs     # needs the playwright package and a Chromium
//   SCREENSHOTS=docs/product/screenshots/change-safety node --test tests/e2e/studio-change-safety.e2e.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { KIT } from '../../bin/agent-team.mjs';
import { createStudio } from '../../apps/studio/server.mjs';
import { context } from '../../tools/report.mjs';
import { isOn, openJob, slugOf, switchTeammate } from './team-page.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { /* reported by the skip below */ }
if (!chromium && process.env.CI) throw new Error('CI is set but the playwright package is not installed');
const skip = !chromium && 'the playwright package is not installed';
const SHOTS = process.env.SCREENSHOTS;

/** A team in a temporary repository; `reports` (board rows) go to its event log when given. */
function team(reports, ownership) {
  const root = mkdtempSync(join(tmpdir(), 'studio-safety-'));
  const home = mkdtempSync(join(tmpdir(), 'studio-safety-home-'));
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Studio test']);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'studio-test@example.com']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']); // a signing setup on the machine is not the test's
  execFileSync(process.execPath, [join(KIT, 'bin/agent-team.mjs'), 'init', '--preset', 'minimal', '--project', 'Sample app', '--dir', root], { stdio: 'ignore' });
  if (ownership) writeFileSync(join(root, '.agent-team/ownership.json'), JSON.stringify({ rows: ownership }, null, 2) + '\n');
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'team']);
  const env = { AGENT_TEAM_HOME: home };
  if (reports) {
    const { log } = context(env, root);
    mkdirSync(dirname(log), { recursive: true });
    writeFileSync(log, reports.map((r, i) => JSON.stringify({ id: `e2e-${i}`, kind: 'status', ...r })).join('\n') + '\n');
  }
  const studio = createStudio({ root, env });
  studio.root = root;
  return studio;
}

let busy, quiet, pubA, pubB, base, baseQuiet, browser;
before(async () => {
  if (skip) return;
  const now = Date.now();
  const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();
  busy = team([
    { at: at(34), role: 'web-dev', status: 'working', issue: '142', task: 'Dark mode', branch: 'web/142-dark-mode', pr: '142' },
    { at: at(180), role: 'qa-web', status: 'idle', task: '' },
  ], [{ path: 'web/', writer: 'web-dev', notes: '' }]);
  quiet = team(null);
  const reports = [{ at: at(34), role: 'web-dev', status: 'working', issue: '142', task: 'Dark mode', branch: 'web/142-dark-mode', pr: '142' }];
  pubA = team(reports, [{ path: 'web/', writer: 'web-dev', notes: '' }]);
  pubB = team(reports, [{ path: 'web/', writer: 'web-dev', notes: '' }]);
  for (const s of [busy, quiet, pubA, pubB]) await new Promise((r) => s.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${busy.address().port}`;
  baseQuiet = `http://127.0.0.1:${quiet.address().port}`;
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
after(async () => { await browser?.close(); for (const s of [busy, quiet, pubA, pubB]) { s?.closeAllConnections?.(); s?.close(); } });

test('a running team: states on cards, an amber mark with its reason, the popover, the inspector and the count', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/?t=${busy.launchToken}`);
  const card = (slug) => page.locator(`#canvas .node[data-slug="${slug}"]`);

  // Criterion 1: the board state and the task on every card, the same word on the library row; a quiet one in grey.
  await card('web-dev').locator('.state', { hasText: 'working · #142 Dark mode' }).waitFor();
  await page.locator('#library .lib-role[data-slug="web-dev"] .state', { hasText: 'working' }).waitFor();
  assert.match(await card('qa-web').locator('.state').textContent(), /^last heard 3 h ago/);
  assert.match(await card('qa-web').getAttribute('class'), /\bquiet\b/);
  assert.equal(await card('architect').locator('.state').count(), 0, 'a role with no reports shows no state line');
  assert.equal(await page.locator('#impact-pill').isHidden(), true, 'nothing changed yet');
  assert.equal(await page.locator('#draft-banner').isHidden(), true);

  // Criteria 2 to 4: switching a working role off keeps its card, greyed and amber, explains itself, and counts.
  await switchTeammate(page, 'web-dev', false);
  const popover = page.locator('.impact-pop');
  await popover.getByText('Web dev is working right now, and this draft switches it off.').waitFor();
  await popover.getByText('#142 Dark mode').waitFor();
  await popover.getByText('web/142-dark-mode').waitFor();
  await popover.getByText('Based on board reports; may be out of date.').waitFor();
  assert.match(await card('web-dev').getAttribute('class'), /\bamber\b.*\bghost\b|\bghost\b.*\bamber\b|amber/);
  assert.match(await card('web-dev').locator('.meta').textContent(), /switched off in this draft/);
  await page.locator('#impact-pill', { hasText: '1 change · 1 touches work in progress' }).waitFor();
  await page.locator('#draft-banner', { hasText: /The team keeps running the live version \([0-9a-f]{7}, published \d+ \w+\) until you publish/ }).waitFor();
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'canvas-amber-popover-light.png') });
  if (SHOTS) { await page.emulateMedia({ colorScheme: 'dark' }); await page.screenshot({ path: join(SHOTS, 'canvas-amber-popover-dark.png') }); await page.emulateMedia({ colorScheme: 'light' }); }

  // Undo from the popover puts it back as published.
  await popover.getByRole('button', { name: 'Undo switch off' }).click();
  await popover.waitFor({ state: 'detached' });
  assert.equal(await isOn(page, 'web-dev'), true);
  assert.equal(await page.locator('#impact-pill').isHidden(), true);

  // A change on an idle role is safe: no amber, though it still counts as a change in the banner.
  await card('qa-web').click();
  await page.locator('#i-tier').selectOption('deep');
  assert.equal(await page.locator('.impact-pop').count(), 0);
  assert.doesNotMatch(await card('qa-web').getAttribute('class'), /amber/);
  await page.locator('#draft-banner').waitFor();
  assert.equal(await page.locator('#impact-pill').isHidden(), true, 'nothing in flight is touched');

  // Criterion 5: the inspector lists the work above the fields; clicking an amber card opens its popover again.
  await switchTeammate(page, 'web-dev', false);
  await popover.getByRole('button', { name: 'Close' }).click();
  await card('web-dev').click();
  await popover.waitFor();
  const now = page.locator('#inspector .now-live');
  await now.getByRole('heading', { name: /Now, on the live version/ }).waitFor();
  await now.getByText('#142 Dark mode').waitFor();
  await now.getByText('switched off in this draft: you choose what happens to this work when you publish.').waitFor();
  await page.locator('#impact-pill', { hasText: '2 changes · 1 touches work in progress' }).waitFor();

  // Criterion 6: the count and "Review the impact" open Publish.
  await popover.getByRole('button', { name: 'Review the impact' }).click();
  await page.locator('#publish-dialog[open], dialog[open]').first().waitFor();

  assert.deepEqual(errors, []);
  await page.close();
});

test('nothing running, nothing shown: no states, no marks, no count (criterion 12)', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${baseQuiet}/?t=${quiet.launchToken}`);
  await page.locator('#canvas .node[data-slug="web-dev"]').waitFor();
  await switchTeammate(page, 'web-dev', false);
  await page.locator('#canvas .node.off[data-slug="web-dev"]').waitFor();
  assert.equal(await page.locator('#canvas .node .state').count(), 0);
  assert.equal(await page.locator('.impact-pop').count(), 0);
  assert.equal(await page.locator('#impact-pill').isHidden(), true);
  assert.equal(await page.locator('#draft-banner').isHidden(), true);
  assert.equal(await page.locator('#library .lib-role .state').count(), 0);
  await page.close();
});

test('Undo area move after the editor\'s Move leaves one writer: the table row and both briefs go back', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/?t=${busy.launchToken}`);
  await page.locator('#canvas .node[data-slug="web-dev"] .state').waitFor();
  await page.getByRole('button', { name: 'Custom role', exact: true }).click();
  const dlg = page.locator('#agent-dialog');
  await dlg.locator('#a-name').fill('Site builder');
  await dlg.locator('#a-group').selectOption('engineering');
  await dlg.getByRole('button', { name: 'Continue to the brief' }).click();
  const ed = page.locator('#agent-editor');
  const box = ed.locator('.conflict');
  await ed.getByLabel('Area to add').fill('web/');
  await ed.getByLabel('Area to add').press('Enter');
  await box.getByRole('button', { name: 'Move the whole area to this role…' }).click();
  await box.getByRole('button', { name: 'Move it anyway' }).click();
  await box.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Back to the team' }).click();

  const card = page.locator('#canvas .node[data-slug="web-dev"]');
  await page.locator('#impact-pill', { hasText: 'touches work in progress' }).waitFor();
  assert.match(await card.locator('.meta').textContent(), /area moves away/);
  if (!(await page.locator('.impact-pop').count())) await card.click();
  await page.locator('.impact-pop').getByRole('button', { name: 'Undo area move' }).click();
  await page.locator('#impact-pill').waitFor({ state: 'hidden' });
  await page.locator('#checks', { hasText: /^No problems/ }).waitFor();
  await openJob(page, 'Site builder');
  assert.doesNotMatch(await page.locator('#e-raw').inputValue(), /`web\/`/, 'the new agent no longer writes the area');
  assert.deepEqual(errors, []);
  await page.close();
});

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });

test('the impact step: choices with the recommendation, a hand-off target, and the plan in the commit message only (criteria 8 to 10)', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${pubA.address().port}/?t=${pubA.launchToken}`);
  await page.locator('#canvas .node[data-slug="web-dev"] .state').waitFor();
  await switchTeammate(page, 'web-dev', false);
  await page.locator('#impact-pill').click();
  const box = page.locator('#impact');
  await box.getByRole('heading', { name: 'Work in progress' }).waitFor();
  await box.getByRole('heading', { name: 'Web dev' }).waitFor();
  await box.getByText('#142 Dark mode').waitFor();
  await box.getByText('Based on board reports; may be out of date.').waitFor();
  const finish = box.getByRole('radio', { name: /Let it finish its current task first/ });
  assert.equal(await finish.isChecked(), true, 'the recommendation is preselected');
  // A hand-off asks for a target among the roles that are on, never the role itself.
  await box.getByRole('radio', { name: /Hand the work off now/ }).check();
  const target = box.getByLabel("Hand Web dev's work to");
  assert.equal(await box.locator('label.choice:has(input[value="handoff"]) + label.target').count(), 1, 'the target sits under its choice');
  const options = await target.locator('option').evaluateAll((os) => os.map((o) => o.value));
  assert.ok(!options.includes('web-dev') && options.length > 0);
  assert.equal(await target.inputValue(), 'cto', 'a kit role hands off to its manager by default');
  await target.selectOption('qa-web');
  const plan = page.locator('#plan pre');
  await plan.getByText(/^- Web dev \(web-dev\): Dark mode, branch web\/142-dark-mode, PR #142\. Switched off: hand the work off now, to qa-web\.$/m).waitFor();
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'publish-impact-light.png') });
  // "Use the recommendations" puts every item back on its recommendation.
  await box.getByRole('button', { name: 'Use the recommendations' }).click();
  assert.equal(await box.getByRole('radio', { name: /Let it finish/ }).isChecked(), true);
  await plan.getByText(/Switched off: let it finish its current task first\./).waitFor();

  await page.locator('#confirm').click();
  await page.locator('#publish-result', { hasText: 'Committed' }).waitFor();
  const msg = git(pubA.root, 'log', '-1', '--format=%B');
  assert.match(msg, /^Work in progress$/m);
  assert.match(msg, /^Chief of staff carries these out when this change is merged\./m, 'the role that takes requests, by name');
  assert.match(msg, /^- Web dev \(web-dev\): .*let it finish its current task first\.$/m);
  // git grep exits 1 when nothing matches: no file holds the plan.
  assert.throws(() => execFileSync('git', ['-C', pubA.root, 'grep', '-l', 'Work in progress', 'HEAD', '--', '.agent-team'], { stdio: 'pipe' }), 'no file holds the plan');
  assert.deepEqual(errors, []);
  await page.close();
});

test('never two writers: "move after the PR merges" keeps the writer in the files and the checks remind (criterion 11)', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${pubB.address().port}/?t=${pubB.launchToken}`);
  await page.locator('#canvas .node[data-slug="web-dev"] .state').waitFor();
  await page.getByRole('button', { name: 'Custom role', exact: true }).click();
  const dlg = page.locator('#agent-dialog');
  await dlg.locator('#a-name').fill('Site builder');
  await dlg.locator('#a-group').selectOption('engineering');
  await dlg.getByRole('button', { name: 'Continue to the brief' }).click();
  const ed = page.locator('#agent-editor');
  await ed.getByLabel('Area to add').fill('web/');
  await ed.getByLabel('Area to add').press('Enter');
  await ed.locator('.conflict').getByRole('button', { name: 'Move the whole area to this role…' }).click();
  await ed.locator('.conflict').getByRole('button', { name: 'Move it anyway' }).click();
  await page.getByRole('button', { name: 'Back to the team' }).click();

  await page.locator('#impact-pill').click();
  const box = page.locator('#impact');
  const after = box.getByRole('radio', { name: /Move the area after PR #142 merges/ });
  assert.equal(await after.isChecked(), true);
  await box.getByText('The published files keep the current writer').waitFor();
  await page.locator('#plan pre').getByText(/Area web\/ moved from web-dev to site-builder: move the area after PR #142 merges\./).waitFor();
  await page.locator('#confirm').click();
  await page.locator('#publish-result', { hasText: 'Committed' }).waitFor();
  const rows = JSON.parse(git(pubB.root, 'show', 'HEAD:.agent-team/ownership.json')).rows;
  assert.equal(rows.find((r) => r.path === 'web/').writer, 'web-dev', 'the files keep the current writer');
  assert.doesNotMatch(git(pubB.root, 'show', 'HEAD:.agent-team/roles/site-builder.md'), /`web\/`/, 'and the new agent does not write it yet');
  // The checks keep a reminder, and the draft still carries the move for the next publish.
  await page.locator('#publish-dialog').getByRole('button', { name: 'Close' }).click();
  await page.locator('#issues li', { hasText: 'web/ moves from web-dev to site-builder after PR #142 merges. Publish again then' }).waitFor();
  await page.locator('#impact-pill', { hasText: 'touches work in progress' }).waitFor();
  // A reload reads the published team from disk; the deferred move and its reminder come back with the draft.
  await page.reload();
  await page.locator('#issues li', { hasText: 'web/ moves from web-dev to site-builder after PR #142 merges. Publish again then' }).waitFor();
  await page.locator('#impact-pill', { hasText: 'touches work in progress' }).waitFor();
  await openJob(page, 'Site builder');
  assert.match(await page.locator('#e-raw').inputValue(), /^- `web\/`$/m, 'the new agent still takes the area in the draft');
  assert.deepEqual(errors, []);
  await page.close();
});
