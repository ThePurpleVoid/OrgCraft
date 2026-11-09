// The Studio mounted in a host's own admin page, in a real browser, under a strict CSP (docs/specs/studio-embed.md
// section 4, issue #123): every request goes to the host's API base with its bearer token and the Studio header, the
// host's own ids and styles are left alone, the page is kept in memory and reported through onNavigate (the URL never
// changes), chat and the live board are off (step 1 features), the Studio's own dialogs replace confirm(), Publish
// works, and destroy() takes it all off the page so it can be mounted again. Not one CSP violation.
//
//   node --test tests/e2e/studio-embed.e2e.mjs
//   SCREENSHOTS=docs/product/screenshots/studio-embed node --test tests/e2e/studio-embed.e2e.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { embedHost, TOKEN } from '../fixtures/embed-host.mjs';
import { isOn, openFromMore, switchTeammate } from './team-page.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { /* reported by the skip below */ }
if (!chromium && process.env.CI) throw new Error('CI is set but the playwright package is not installed');
const skip = !chromium && 'the playwright package is not installed';
const SHOTS = process.env.SCREENSHOTS;

let host, browser;
before(async () => {
  if (skip) return;
  host = await embedHost();
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
after(async () => { await browser?.close(); host?.close(); });

/** A page that records CSP violations, page errors and console errors from the first byte. */
async function open(ctx, { on = null, query = '' } = {}) {
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  await page.addInitScript(() => {
    window.cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => window.cspViolations.push(`${e.violatedDirective} ${e.blockedURI} ${e.sample ?? ''}`.trim()));
  });
  await page.goto(`${(on ?? host).origin}/admin/team${query}`);
  return { page, problems };
}

test('mounted in a host page under a strict CSP: scoped, in memory, step 1 features, its own dialogs, Publish, destroy', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  const { page, problems } = await open(ctx);
  const ats = page.locator('#team.ats');
  await ats.locator('.lib-role').first().waitFor();
  const url = page.url();

  // The host's own page is left alone: its ids, its text, its styles.
  assert.equal(await page.locator('header.host-header #publish').textContent(), 'Host button');
  assert.equal(await page.locator('header.host-header #project').textContent(), 'Host admin');
  assert.equal(await page.locator('body > #canvas').textContent(), "The host's own #canvas");
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(250, 240, 230)');
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.host-header button')).borderRadius), '0px');
  assert.equal(await page.evaluate(() => document.body.className), '', 'no Studio state on the host body');
  // The Studio's state is on its root, and its own #project is the one inside it.
  assert.equal(await ats.getAttribute('data-page'), 'team');
  assert.equal(await ats.locator('#project').textContent(), 'Sample app');

  // Step 1 features: no Chat page, no Live board; Publish is there.
  assert.equal(await ats.getByRole('button', { name: 'Chat', exact: true }).isVisible(), false);
  assert.equal(await ats.getByRole('button', { name: 'Rollout', exact: true }).isVisible(), false, 'an embedded Studio has no rollout source yet');
  assert.equal(await ats.getByRole('button', { name: 'Live' }).isVisible(), false);
  assert.equal(await ats.locator('#publish').isVisible(), true);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'embedded-team-light.png') });

  // In memory: Meetings changes the page, never the URL, and the host hears it.
  await openFromMore(ats, 'Meetings');
  await ats.locator('#meetings-page').getByRole('heading', { name: 'No meetings yet' }).waitFor();
  assert.equal(page.url(), url);
  assert.deepEqual(await page.evaluate(() => window.navs), ['meetings']);
  // The host can open a page too (a link in its own nav); chat stays off.
  await page.evaluate(() => window.studio.navigate('chat'));
  assert.equal(await ats.getAttribute('data-page'), 'team');
  assert.deepEqual(await page.evaluate(() => window.navs), ['meetings', 'team']);

  // The Studio's own dialog, not confirm(): a meeting being edited asks before it is dropped.
  await openFromMore(ats, 'Meetings');
  await ats.locator('summary', { hasText: 'New meeting' }).click();
  await ats.getByRole('button', { name: 'Daily standup' }).click();
  await ats.getByRole('button', { name: 'Team', exact: true }).click();
  const ask = ats.locator('dialog.ask-dialog');
  await ask.getByText('Discard the changes to this meeting?').waitFor();
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'embedded-ask-dialog-light.png') });
  await ask.getByRole('button', { name: 'Keep editing' }).click();
  await ask.waitFor({ state: 'detached' });
  assert.equal(await ats.getAttribute('data-page'), 'meetings');
  await ats.getByRole('button', { name: 'Team', exact: true }).click();
  await ask.getByRole('button', { name: 'Discard' }).click();
  await ats.locator('.lib-role').first().waitFor();
  assert.equal(await ats.getAttribute('data-page'), 'team');

  // Edit and Publish through the host's API base.
  await switchTeammate(ats, 'release-manager', false);
  await ats.locator('#publish').click();
  await ats.locator('#files > summary').click();
  const dlg = ats.locator('#publish-dialog');
  await dlg.getByText("Writes the team's files on a new branch and opens a pull request.").waitFor();
  await dlg.locator('#changes summary').first().waitFor();
  const go = dlg.locator('#confirm');
  assert.equal(await go.isVisible(), true);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'embedded-publish-light.png') });
  await go.click();
  // The handler opened a pull request on (fake) GitHub; the page links to it, in a new tab with no opener.
  const result = dlg.locator('#publish-result', { hasText: /Opened a pull request for \d+ files? on agent-team\// });
  await result.waitFor();
  const link = result.getByRole('link', { name: '#1' });
  assert.equal(await link.getAttribute('href'), 'https://github.com/acme/shop/pull/1');
  assert.equal(await link.getAttribute('target'), '_blank');
  assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(host.gh.pulls.length, 1);
  assert.match(host.gh.pulls[0].head, /^agent-team\//);
  assert.equal(page.url(), url);

  // Every request: the host's base, its bearer token, the Studio header; a POST is JSON with the commit it read.
  assert.ok(host.seen.length >= 4, `requests seen: ${host.seen.length}`);
  assert.deepEqual(host.refused, []);
  for (const r of host.seen) { assert.equal(r.studioHeader, '1', r.path); assert.equal(r.auth, `Bearer ${TOKEN}`, r.path); if (r.method === 'POST') assert.match(r.type, /^application\/json/, r.path); }
  const paths = new Set(host.seen.map((r) => `${r.method} ${r.path}`));
  for (const p of ['GET /v1/team', 'POST /v1/team/preview', 'POST /v1/team/publish']) assert.ok(paths.has(p), p);
  assert.ok(![...paths].some((p) => p.includes('/board')), 'no board reads or streams with live off');
  const sent = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => new URL(e.name).pathname).filter((p) => p.includes('/v1/')));
  assert.ok(sent.length && sent.every((p) => p.startsWith('/api/agent-team/studio/v1/')), sent.join(', '));

  // destroy(): nothing of the Studio is left, and it mounts again.
  await dlg.getByRole('button', { name: 'Keep editing' }).click();
  await page.evaluate(() => window.studio.destroy());
  assert.equal(await page.locator('#team').innerHTML(), '');
  assert.equal(await page.evaluate(() => document.getElementById('team').className), '');
  await page.keyboard.press('Control+z'); // no Studio listener answers any more
  await page.evaluate(() => window.remount());
  await ats.locator('.lib-role').first().waitFor();
  // A fresh read of the default branch, where the change waits in its pull request.
  assert.equal(await isOn(ats, 'release-manager'), true);
  assert.equal(await ats.getByRole('button', { name: 'Undo' }).isDisabled(), true, 'no undo history survives destroy()');

  assert.deepEqual(await page.evaluate(() => window.cspViolations), []);
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('mounted twice on one page is refused with a reason', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const { page, problems } = await open(ctx);
  await page.locator('#team.ats .lib-role').first().waitFor();
  const message = await page.evaluate(() => { try { window.remount(); return null; } catch (e) { return e.message; } });
  assert.match(message, /already mounted on this page; destroy\(\) it first/);
  assert.deepEqual(await page.evaluate(() => window.cspViolations), []);
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('in the dark and at 390px the mounted Studio stays inside its element with no sideways scroll', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark', deviceScaleFactor: SHOTS ? 3 : 1 });
  const { page, problems } = await open(ctx);
  // A phone gets the team as a read-only list (B1.7), so the catalog is not shown.
  await page.locator('#team.ats #canvas [data-node]').first().waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= 390);
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(250, 240, 230)', 'dark mode stays inside the Studio');
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.getElementById('team')).backgroundColor), 'rgb(250, 240, 230)');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'embedded-phone-dark.png') });
  assert.deepEqual(await page.evaluate(() => window.cspViolations), []);
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('mount, destroy and mount again before the first read is back: one Studio, one request per click (React StrictMode)', { skip }, async () => {
  const empty = await embedHost({ team: false });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const { page, problems } = await open(ctx, { on: empty, query: '?race' });
    const ats = page.locator('#team.ats');
    await ats.locator('#gallery-page').getByRole('heading', { name: 'Start a team' }).waitFor();
    assert.equal(empty.seen.filter((r) => r.path === '/v1/team').length, 2, 'both mounts read the team');
    await ats.locator('.g-card', { hasText: 'Customer support team' }).click();
    await ats.locator('#template-bar').getByText('Preview: Customer support team').waitFor();
    await ats.locator('#template-bar').getByRole('button', { name: 'Use this template' }).click();
    const form = ats.locator('#create-dialog');
    assert.equal(await form.getByLabel('Project name').inputValue(), 'shop', 'the repository name, as the folder name locally');
    await form.getByLabel('Project name').fill('Help desk');
    await form.getByRole('button', { name: 'Open the team' }).click();
    await ats.locator('#template-bar').getByText('A new team from the Customer support team template.').waitFor();
    await page.waitForTimeout(300); // a second, doubled request would have been sent by now
    assert.equal(empty.seen.filter((r) => r.path === '/v1/team/from-template').length, 2, 'one for the preview, one for the team');
    assert.equal(await ats.locator('.bar').count(), 1);
    assert.deepEqual(await page.evaluate(() => window.cspViolations), []);
    assert.deepEqual(problems, []);
    await ctx.close();
  } finally { empty.close(); }
});

test('the Studio\'s own prompt answers OK on Enter, and a destructive question starts on Cancel', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const { page, problems } = await open(ctx);
  const ats = page.locator('#team.ats');
  await ats.locator('.lib-role').first().waitFor();
  await openFromMore(ats, 'Meetings');
  await ats.locator('summary', { hasText: 'New meeting' }).click();
  await ats.getByRole('button', { name: 'Daily standup' }).click();
  await ats.locator('#m-tz').click();
  const ask = ats.locator('dialog.ask-dialog');
  await ask.getByRole('textbox').fill('Europe/Lisbon');
  await page.keyboard.press('Enter');
  await ask.waitFor({ state: 'detached' });
  await ats.getByText('Times are in Europe/Lisbon.').waitFor();
  // Delete starts on Cancel: Enter keeps the meeting.
  await ats.getByRole('button', { name: 'Save to the draft' }).click();
  await ats.getByRole('button', { name: 'Delete' }).click();
  assert.equal(await ask.getByRole('button', { name: 'Cancel' }).evaluate((b) => b === document.activeElement), true);
  await page.keyboard.press('Enter');
  await ask.waitFor({ state: 'detached' });
  await ats.locator('.meeting-row', { hasText: 'Daily standup' }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.cspViolations), []);
  assert.deepEqual(problems, []);
  await ctx.close();
});
