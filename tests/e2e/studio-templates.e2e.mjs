// The template gallery in a real browser (CPO story "team templates", criteria 5 to 10; D31 to D34): a repository
// with no team opens the gallery, a template previews on the canvas with nothing written, "Use this template" opens
// it as a draft with no check errors, suggested systems wait to be connected, Publish writes it, and from then on
// the repository opens its team, never the gallery. And the gallery on a phone.
//
//   node --test tests/e2e/studio-templates.e2e.mjs
//   SCREENSHOTS=docs/product/screenshots/templates node --test tests/e2e/studio-templates.e2e.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudio } from '../../apps/studio/server.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { /* reported by the skip below */ }
if (!chromium && process.env.CI) throw new Error('CI is set but the playwright package is not installed');
const skip = !chromium && 'the playwright package is not installed';
const SHOTS = process.env.SCREENSHOTS;

const studios = [];
let browser;

/** An empty repository named `name` with one empty commit, and a Studio on it. */
async function emptyStudio(name) {
  const root = join(mkdtempSync(join(tmpdir(), 'studio-templates-')), name);
  execFileSync('git', ['init', '-q', root]);
  const git = (...a) => execFileSync('git', ['-C', root, ...a]);
  git('config', 'user.name', 'Studio test');
  git('config', 'user.email', 'studio-test@example.com');
  git('config', 'commit.gpgsign', 'false');
  git('commit', '-q', '--allow-empty', '-m', 'start');
  const studio = createStudio({ root, env: { AGENT_TEAM_HOME: mkdtempSync(join(tmpdir(), 'studio-templates-home-')) } });
  await new Promise((r) => studio.listen(0, '127.0.0.1', r));
  studios.push(studio);
  return { root, studio, base: `http://127.0.0.1:${studio.address().port}` };
}

before(async () => {
  if (skip) return;
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
after(async () => { await browser?.close(); for (const s of studios) { s.closeAllConnections?.(); s.close(); } });

test('from the gallery to a published support team, and the repository opens its team after', { skip }, async () => {
  const { root, studio, base } = await emptyStudio('help-desk');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'Europe/Lisbon', deviceScaleFactor: SHOTS ? 2 : 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(`${base}/?t=${studio.launchToken}`);

  // Criterion 5: the gallery, grouped without jargon, the three must-ship templates above the fold.
  const gallery = page.locator('#gallery-page');
  await gallery.getByRole('heading', { name: 'Start a team' }).waitFor();
  for (const g of ['Build a product', 'Run a business function']) await gallery.getByRole('heading', { name: g }).waitFor();
  for (const t of ['Startup product team', 'Customer support team', 'Content studio']) {
    const box = await gallery.locator('.g-card', { hasText: t }).boundingBox();
    assert.ok(box && box.y + box.height <= 900, `${t} is visible without scrolling`);
  }
  assert.equal(await page.locator('#publish').isVisible(), false);
  // Neutral protocols criterion 5: each card says which shared rules it uses.
  await gallery.locator('.g-card', { hasText: 'Startup product team' }).getByText('Shared rules: the core and engineering (pull requests, the merge gate, deploys)').waitFor();
  await gallery.locator('.g-card', { hasText: 'Customer support team' }).getByText('Shared rules: the core only').waitFor();
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'gallery-light.png') });
  await gallery.getByLabel('Search starting teams').fill('help articles');
  await gallery.locator('.g-card', { hasText: 'Customer support team' }).waitFor();
  assert.equal(await gallery.locator('.g-card').count(), 1);
  await gallery.getByLabel('Search starting teams').fill('');

  // Criterion 6: a preview on the canvas, with its lists, and nothing written.
  await gallery.locator('.g-card', { hasText: 'Customer support team' }).click();
  const bar = page.locator('#template-bar');
  await bar.getByText('Preview: Customer support team').waitFor();
  await bar.getByText('Systems to connect').waitFor();
  await page.locator('.node[data-slug="support-lead"]').waitFor();
  assert.equal(await page.locator('#publish').isVisible(), false, 'no Publish while previewing');
  assert.equal(await page.locator('#library .cat-role').first().isDisabled(), true, 'the preview is read-only');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'preview-support-light.png') });
  assert.deepEqual(readdirSync(root), ['.git'], 'nothing is written by a preview (D31)');

  // Criterion 7: the create form, the browser's time zone, and a draft with no check errors.
  await bar.getByRole('button', { name: 'Use this template' }).click();
  const form = page.locator('#create-dialog');
  assert.equal(await form.getByLabel('Project name').inputValue(), 'help-desk');
  assert.equal(await form.getByLabel('Time zone').inputValue(), 'Europe/Lisbon');
  await form.getByLabel('Project name').fill('Help desk');
  await form.getByLabel("Owner's name").fill('Dana');
  await form.getByRole('button', { name: 'Open the team' }).click();
  await bar.getByText('A new team from the Customer support team template.').waitFor();
  await page.locator('#checks', { hasText: 'No problems' }).waitFor();
  // The team's settings, read-only, when no role is picked.
  const facts = page.locator('#inspector .team-facts');
  await facts.getByText('Europe/Lisbon').waitFor();
  assert.match(await facts.textContent(), /Shared rules\s*the core only/);
  assert.match(await facts.textContent(), /Started from\s*Customer support team \(kit /);
  assert.equal(await page.locator('#publish').isVisible(), true);
  assert.equal(await page.locator('#pages [data-page="chat"]').isVisible(), false, 'no chat before the team exists');

  // Criterion 10: suggested systems wait, with nothing set, until the owner connects one.
  await page.locator('#views [data-view="systems"]').click();
  const strip = page.locator('#systems-strip');
  await strip.locator('.chip.suggested', { hasText: 'Support inbox' }).waitFor();
  await strip.getByText('Dashed: suggested by the template, with nothing set.').waitFor();
  await strip.locator('.chip.suggested', { hasText: 'Support inbox' }).click();
  await strip.locator('.chip:not(.suggested)', { hasText: 'Support inbox' }).waitFor();
  await page.locator('#inspector').getByText('Who may use it').waitFor();
  assert.equal(await page.locator('#s-secrets').inputValue(), '');
  await page.locator('#views [data-view="org"]').click();

  // Publish writes the team; from then on the repository opens its team (criteria 8 and 9).
  await page.locator('#publish').click();
  await page.locator('#changes summary', { hasText: '.agent-team/team.json' }).waitFor();
  await page.locator('#branch').fill('team');
  await page.locator('#confirm').click();
  await page.locator('#publish-result', { hasText: 'Committed' }).waitFor();
  const team = JSON.parse(execFileSync('git', ['-C', root, 'show', 'team:.agent-team/team.json'], { encoding: 'utf8' }));
  assert.match(team.from, /^customer-support-team@/);
  assert.equal(team.values.PROJECT_NAME, 'Help desk');
  assert.equal(team.values.TIMEZONE, 'Europe/Lisbon');
  const resources = JSON.parse(readFileSync(join(root, '.agent-team/resources.json'), 'utf8'));
  assert.deepEqual(resources.resources.map((r) => [r.name, r.secrets]), [['Support inbox', []]]);
  await page.locator('#publish-dialog').getByRole('button', { name: 'Close' }).click();
  await page.reload();
  await page.locator('.lib-role').first().waitFor();
  assert.equal(await gallery.isVisible(), false, 'a repository with a team never shows the gallery (D32)');
  assert.equal(await bar.isVisible(), false);
  assert.equal(await page.locator('#pages [data-page="chat"]').isVisible(), true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('almost empty, and the gallery in dark', { skip }, async () => {
  const { studio, base } = await emptyStudio('notes');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', deviceScaleFactor: SHOTS ? 2 : 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/?t=${studio.launchToken}`);
  await page.getByRole('heading', { name: 'Start a team' }).waitFor();
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'gallery-dark.png') });
  await page.locator('.g-card', { hasText: 'Content studio' }).click();
  await page.locator('#template-bar').getByText('Preview: Content studio').waitFor();
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'preview-content-dark.png') });
  await page.getByRole('button', { name: 'Back to the starting teams' }).click();
  await page.getByRole('button', { name: 'Start almost empty' }).click();
  await page.locator('#create-dialog').getByRole('button', { name: 'Open the team' }).click();
  await page.locator('#template-bar').getByText('A new team.').waitFor();
  await page.locator('.node[data-slug="chief-of-staff"]').waitFor();
  assert.equal(await page.locator('.node:not(.owner)').count(), 1);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('on a phone the gallery is for browsing (criterion 11)', { skip }, async () => {
  const { studio, base } = await emptyStudio('phone');
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: SHOTS ? 3 : 1 });
  const page = await ctx.newPage();
  await page.goto(`${base}/?t=${studio.launchToken}`);
  await page.getByRole('heading', { name: 'Start a team' }).waitFor();
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(w <= 390, `no sideways scroll (${w}px)`);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'gallery-phone-light.png') });
  await page.locator('.g-card', { hasText: 'Startup product team' }).click();
  await page.locator('#template-bar').getByText('Create the team on a larger screen.').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Use this template' }).count(), 0);
  await ctx.close();
});
