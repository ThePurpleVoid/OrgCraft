// Live overrides in the Studio (L18 web half; SH-5, SH-10, G38.4) against the fake control plane: Stop everything
// in the More menu in one tap with no passkey, a banner that stays until it is lifted (a run that starts doesn't
// clear it), Resume behind the step-up bound to lift:<id>, and Pause on a teammate from a 360 px phone.
//
//   node --test tests/e2e/studio-live-overrides.e2e.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KIT } from '../../bin/agent-team.mjs';
import { createStudio } from '../../apps/studio/server.mjs';
import { fakeControlPlane } from '../fixtures/fake-control-plane.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { /* reported by the skip below */ }
if (!chromium && process.env.CI) throw new Error('CI is set but the playwright package is not installed');
const skip = !chromium && 'the playwright package is not installed';
const SHOTS = process.env.SCREENSHOTS;

let cp, studio, base, browser, plain, plainBase;
before(async () => {
  if (skip) return;
  const root = mkdtempSync(join(tmpdir(), 'studio-live-'));
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync(process.execPath, [join(KIT, 'bin/agent-team.mjs'), 'init', '--preset', 'minimal', '--project', 'Sample app', '--dir', root], { stdio: 'ignore' });
  cp = await fakeControlPlane({ team: 'sample-app' });
  studio = createStudio({ root, env: cp.env });
  await new Promise((r) => studio.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${studio.address().port}`;
  // The same repository with no control plane: nothing live is offered.
  plain = createStudio({ root, env: { AGENT_TEAM_HOME: mkdtempSync(join(tmpdir(), 'studio-live-home-')) } });
  await new Promise((r) => plain.listen(0, '127.0.0.1', r));
  plainBase = `http://127.0.0.1:${plain.address().port}`;
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
after(async () => { await browser?.close(); for (const s of [studio, plain]) { s?.closeAllConnections?.(); s?.close(); } cp?.close(); });

const openMore = (page) => page.locator('#more-btn').click();

test('Stop everything in one tap; the banner stays through a run start; Resume needs the step-up', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/?t=${studio.launchToken}`);
  await page.locator('#canvas .node').first().waitFor();
  assert.equal(await page.locator('#live-banner').isVisible(), false);

  // SH-5: one tap, no confirm, no passkey.
  await openMore(page);
  await page.getByRole('button', { name: 'Stop everything' }).click();
  const banner = page.locator('#live-banner');
  await banner.getByText("Everything is stopped. Resume when you're ready.").waitFor();
  assert.equal(cp.runs[0].state, 'paused', 'the run paused');
  assert.equal(cp.live.length, 1);
  assert.equal(await page.locator('#live-stepup').isVisible(), false, 'no passkey to stop');
  await openMore(page);
  assert.equal(await page.locator('#stop-all').isDisabled(), true, 'already stopped');
  await page.keyboard.press('Escape');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'stop-everything-desktop-light.png') });

  // A run that starts on the control plane's side never clears it: only a lift does (security sev 2 on 7539ce0).
  cp.runs.push({ id: 'run_2', state: 'running', started: new Date().toISOString() });
  await page.reload();
  await banner.getByText("Everything is stopped. Resume when you're ready.").waitFor();

  // Resume asks for the step-up, bound to lift:<id>; cancelling changes nothing.
  await banner.getByRole('button', { name: 'Resume: Stop everything' }).click();
  const dlg = page.locator('#live-stepup');
  await dlg.getByText('Resuming needs your passkey.').waitFor();
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  assert.equal(cp.live.length, 1, 'nothing lifted without the step-up');
  await banner.getByRole('button', { name: 'Resume: Stop everything' }).click();
  await dlg.getByLabel('Step-up secret').fill('wrong');
  await dlg.getByRole('button', { name: 'Resume' }).click();
  await dlg.getByText('That was not accepted. Try again.').waitFor();
  await dlg.getByLabel('Step-up secret').fill(cp.stepUpSecret);
  await dlg.getByRole('button', { name: 'Resume' }).click();
  await banner.waitFor({ state: 'hidden' });
  assert.equal(cp.live.length, 0);
  assert.equal(cp.runs[0].state, 'running', 'the runs it paused carry on');
  assert.ok(cp.events.some((e) => e.type === 'live.changed' && e.data.op === 'lifted' && e.data.stepUp));
  assert.deepEqual(errors, []);
  await page.close();
});

test('SH-10: Pause a teammate from a 360 px phone; it stops at once, and comes back only with the step-up', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/?t=${studio.launchToken}`);
  const item = page.locator('#canvas .tree-btn').first();
  await item.waitFor();
  const slug = await item.getAttribute('data-node');
  await item.click();
  const pause = page.locator('#i-live-pause');
  await pause.waitFor();
  assert.equal(await pause.isDisabled(), false, 'Pause works on a phone, where editing is read-only');
  const box = await pause.boundingBox();
  assert.ok(box.height >= 44, `a 44 px target (${box.height})`);
  await pause.click();
  await page.locator('#live-banner', { hasText: `${slug} is paused` }).waitFor();
  assert.deepEqual(cp.live.map((x) => [x.kind, x.member, x.state]), [['member', slug, 'paused']]);
  assert.equal(await page.locator('#i-live-pause').count(), 0, 'paused already: the banner has Resume');
  // No horizontal scroll with the banner on a phone.
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'pause-teammate-phone-light.png') });

  await page.locator('#live-banner [data-lift]').click();
  await page.locator('#live-stepup').getByLabel('Step-up secret').fill(cp.stepUpSecret);
  await page.locator('#live-stepup').getByRole('button', { name: 'Resume' }).click();
  await page.locator('#live-banner').waitFor({ state: 'hidden' });
  assert.equal(cp.live.length, 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('with no control plane connected, nothing live is offered', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await page.goto(`${plainBase}/?t=${plain.launchToken}`);
  await page.locator('#canvas .node').first().waitFor();
  await page.locator('#canvas .node[data-slug]:not([data-slug="owner"])').first().click();
  await page.locator('#i-wiring').waitFor();
  assert.equal(await page.locator('#i-live-pause').count(), 0);
  await openMore(page);
  assert.equal(await page.locator('#stop-all').isVisible(), false);
  assert.equal(await page.locator('#live-banner').isVisible(), false);
  await page.close();
});
