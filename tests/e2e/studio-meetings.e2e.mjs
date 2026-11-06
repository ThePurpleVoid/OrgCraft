// The Meetings view in a real browser (CPO story "meeting definitions editor", criteria 1 to 11 from the Studio side;
// mockup 03): a starter, the schedule, attendees by role and lane, format, busy attendees, the owner's part and the
// cap, the run in words, the estimate, the checks, Publish to .agent-team/meetings.json and back, and the phone list.
//
//   node --test tests/e2e/studio-meetings.e2e.mjs
//   SCREENSHOTS=docs/product/screenshots/meetings node --test tests/e2e/studio-meetings.e2e.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KIT } from '../../bin/agent-team.mjs';
import { createStudio } from '../../apps/studio/server.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { /* reported by the skip below */ }
if (!chromium && process.env.CI) throw new Error('CI is set but the playwright package is not installed');
const skip = !chromium && 'the playwright package is not installed';
const SHOTS = process.env.SCREENSHOTS;

let studio, root, base, browser;
before(async () => {
  if (skip) return;
  root = mkdtempSync(join(tmpdir(), 'studio-meetings-'));
  const home = mkdtempSync(join(tmpdir(), 'studio-meetings-home-'));
  const git = (...a) => execFileSync('git', ['-C', root, ...a]);
  git('init', '-q');
  git('config', 'user.name', 'Studio test');
  git('config', 'user.email', 'studio-test@example.com');
  git('config', 'commit.gpgsign', 'false');
  execFileSync(process.execPath, [join(KIT, 'bin/agent-team.mjs'), 'init', '--preset', 'minimal', '--project', 'Sample app', '--dir', root], { stdio: 'ignore' });
  git('add', '-A');
  git('commit', '-qm', 'team');
  studio = createStudio({ root, env: { AGENT_TEAM_HOME: home } });
  await new Promise((r) => studio.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${studio.address().port}`;
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
after(async () => { await browser?.close(); studio?.closeAllConnections?.(); studio?.close(); });

test('define a daily standup for the CTO lane, publish it, and read it back unchanged', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(`${base}/?t=${studio.launchToken}`);
  await page.locator('.lib-role').first().waitFor();
  await page.getByRole('button', { name: 'Meetings', exact: true }).click();
  const view = page.locator('#meetings-page');
  // D19: no sample meetings; the definitions wait for a runner.
  await view.getByRole('heading', { name: 'No meetings yet' }).waitFor();
  await view.getByText("Meetings run once the team's runner is connected.").waitFor();

  // Criterion 1: a starter, prefilled in neutral words.
  await view.locator('summary', { hasText: 'New meeting' }).click();
  await view.getByRole('button', { name: 'Daily standup' }).click();
  assert.equal(await view.getByLabel('Name').inputValue(), 'Daily standup');
  assert.match(await view.getByLabel('Agenda each attendee answers').inputValue(), /^1\. What you finished since the last standup/);
  // Criterion 2: weekdays at 09:00 in the team's zone, skipped when quiet.
  for (const d of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']) assert.equal(await view.getByRole('button', { name: d }).getAttribute('aria-pressed'), 'true', d);
  assert.equal(await view.getByRole('button', { name: 'Saturday' }).getAttribute('aria-pressed'), 'false');
  await view.getByText(/Times are in UTC because the team has no time zone yet/).waitFor();
  assert.equal(await view.getByLabel('Skip it when nothing changed since the last one').isChecked(), true);
  // Criterion 4: run by the chief of staff; the CTO's whole lane and one more role.
  assert.equal(await view.getByLabel('Run by').inputValue(), 'chief-of-staff');
  await view.getByLabel('Add roles or a whole lane').selectOption('lane:cto');
  await view.locator('.chip', { hasText: "CTO's lane" }).waitFor();
  // A role already in the CTO's lane is not offered again (QA note a).
  assert.equal(await view.getByLabel('Add roles or a whole lane').locator('option[value="role:release-manager"]').count(), 0);
  await view.getByLabel('Add roles or a whole lane').selectOption('role:product-manager');
  await view.locator('.chip', { hasText: 'Product manager' }).waitFor();
  // Criteria 8 and 9: the run in words and the estimate, from the definition.
  const side = page.locator('.m-side');
  await side.getByText(/Chief of staff opens the meeting and sends the agenda to \d+ attendees\./).waitFor();
  await side.getByText(/^Per meeting$/).waitFor();
  assert.match(await side.locator('.estimate .total td').last().textContent(), /^\$\d+\.\d\d$/);
  assert.match(await side.locator('.estimate tr', { hasText: 'Per month' }).textContent(), /about \$\d+\.\d\d/);
  await side.getByText(/Estimate, prices as of \d{4}-\d\d-\d\d\./).waitFor();
  const perMeeting = await side.locator('.estimate .total td').last().textContent();
  assert.equal(Number(await page.locator('#m-cap').inputValue()), Math.max(1, Math.ceil(Number(perMeeting.slice(1)))), 'a new limit starts at the estimate, rounded up');
  // Criterion 5: discussion is allowed, with the honest note, and it costs more.
  await view.getByText('Discussion', { exact: true }).click();
  await view.getByText('Discussion meetings run as a written round until the runner supports them.').waitFor();
  assert.notEqual(await side.locator('.estimate .total td').last().textContent(), perMeeting, 'the estimate follows the format');
  await view.getByText('Written round', { exact: true }).click();
  await view.getByText('Answer from its board reports').click();
  // Criterion 6 and 10: an empty agenda and a zero cap are check errors, in place.
  await view.getByLabel('Agenda each attendee answers').fill('');
  await side.locator('li.error', { hasText: 'Has no agenda' }).waitFor();
  await view.getByLabel('Agenda each attendee answers').fill('1. Done.\n2. Next.\n3. Blocked by.');
  await page.locator('#m-cap').fill('0');
  await side.locator('li.error', { hasText: 'The cost cap must be above zero' }).waitFor();
  await page.locator('#m-cap').fill('1.00');
  await side.locator('li.none', { hasText: 'No problems with this meeting.' }).waitFor();
  // Criterion 7: the owner's part.
  assert.equal(await view.getByLabel('Send me the minutes').isChecked(), true);
  assert.equal(await view.getByLabel('I join and can speak').isChecked(), false);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'meetings-editor-light.png') });
  if (SHOTS) { await page.emulateMedia({ colorScheme: 'dark' }); await page.screenshot({ path: join(SHOTS, 'meetings-editor-dark.png') }); await page.emulateMedia({ colorScheme: 'light' }); }

  // D27: Save to the draft, then Publish writes the file.
  await view.getByRole('button', { name: 'Save to the draft' }).click();
  await view.getByText('Saved to the draft. Publish writes it to the team.').waitFor();
  await view.locator('.meeting-row', { hasText: 'Daily standup' }).getByText(/Mon to Fri 09:00 · \d+ roles · written round/).waitFor();
  await page.locator('#publish').click();
  await page.locator('#changes summary', { hasText: '.agent-team/meetings.json' }).waitFor();
  await page.locator('#confirm').click();
  await page.locator('#publish-result', { hasText: 'Committed' }).waitFor();
  const file = JSON.parse(readFileSync(join(root, '.agent-team/meetings.json'), 'utf8'));
  const m = file.meetings[0];
  assert.equal(m.id, 'daily-standup');
  assert.deepEqual(m.when, { days: ['mon', 'tue', 'wed', 'thu', 'fri'], at: '09:00' });
  assert.deepEqual(m.attendees, { roles: ['product-manager'], lanes: ['cto'], rule: null });
  assert.equal(m.facilitator, 'chief-of-staff');
  assert.equal(m.format, 'round');
  assert.equal(m.ifBusy, 'proxy');
  assert.deepEqual(m.owner, { minutes: true, speaks: false });
  assert.equal(m.capUsd, 1);
  assert.equal(m.skipIfQuiet, true);
  // The attendees' briefs wake on a meeting (sync, criterion 12).
  assert.match(readFileSync(join(root, 'docs/team/roles/release-manager.md'), 'utf8'), /^- meeting$/m);

  // Criterion 11: reopened, the same meetings with zero diff.
  await page.locator('#publish-dialog').getByRole('button', { name: 'Close' }).click();
  await page.goto(`${base}/#meetings`);
  await view.locator('.meeting-row', { hasText: 'Daily standup' }).waitFor();
  await page.locator('#publish').click();
  await page.getByText('Nothing to publish: the repository already has this team.').waitFor();
  assert.deepEqual(errors, []);
  await page.close();
});

test('on a phone the meetings are a read-only list (D28)', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: SHOTS ? 3 : 1 });
  const page = await ctx.newPage();
  await page.goto(`${base}/?t=${studio.launchToken}`);
  await page.goto(`${base}/#meetings`);
  const view = page.locator('#meetings-page');
  await view.locator('.meeting-row', { hasText: 'Daily standup' }).waitFor();
  await view.getByText('Edit meetings on a larger screen.').waitFor();
  assert.equal(await view.locator('summary', { hasText: 'New meeting' }).count(), 0);
  assert.equal(await page.locator('#m-form').count(), 0);
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(w <= 390, `no sideways scroll (${w}px)`);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'meetings-phone-light.png') });
  await ctx.close();
});
