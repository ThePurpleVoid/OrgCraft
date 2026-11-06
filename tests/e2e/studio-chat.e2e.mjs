// The chief-of-staff chat in a real browser (Playwright, Chromium): a round trip against a control plane whose runner
// is stubbed, a stale card answered and refreshed, pause, and the layout at desktop and 360px, light and dark.
//
//   node --test tests/e2e/                        # needs the playwright package and a Chromium
//   SCREENSHOTS=docs/product/screenshots/studio-chat node --test tests/e2e/
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
const SHOTS = process.env.SCREENSHOTS;

let cp, studio, base, browser;
before(async () => {
  if (!chromium) return;
  const root = mkdtempSync(join(tmpdir(), 'studio-e2e-'));
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync(process.execPath, [join(KIT, 'bin/agent-team.mjs'), 'init', '--preset', 'minimal', '--project', 'Sample app', '--dir', root], { stdio: 'ignore' });
  cp = await fakeControlPlane({ team: 'sample-app' });
  studio = createStudio({ root, env: cp.env });
  await new Promise((r) => studio.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${studio.address().port}`;
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
after(async () => { await browser?.close(); studio?.closeAllConnections?.(); studio?.close(); cp?.close(); });

const skip = !chromium && 'the playwright package is not installed';

test('a chat round trip, a stale card refreshed, and pause', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base);
  await page.getByRole('button', { name: 'Chat' }).click();
  await page.getByText('Ask the chief of staff for something').waitFor();
  await page.getByText('Today $6.20 of $50.00').waitFor();
  assert.equal(await page.locator('#run-state').textContent(), 'Running');

  const words = 'Add a dark mode toggle to the settings page,\nand make sure it remembers my choice.  <b>not bold</b>';
  await page.getByLabel('Message the chief of staff').fill(words);
  await page.keyboard.press('Enter');
  const mine = page.locator('.msg.me .verbatim').first();
  await mine.waitFor();
  assert.equal(await mine.textContent(), words, 'shown exactly as typed');
  await page.getByText('routed it to the CTO').waitFor();
  const decision = page.locator('.card-msg.k-decision');
  await decision.getByRole('button', { name: 'Follow system' }).waitFor();
  assert.equal(await page.locator('.msg.me').count(), 1, 'the message appears once');

  // Someone else changes the card before the owner answers: the answer is refused and the current card shown.
  const cardId = await decision.getAttribute('data-card-id');
  cp.bump(cardId, { title: 'What should the default be for new accounts?' });
  await decision.getByRole('button', { name: 'Light' }).click();
  await page.getByText('This card changed before your answer arrived').waitFor();
  await page.getByText('What should the default be for new accounts?').waitFor();
  await decision.getByRole('button', { name: 'Follow system' }).click();
  await decision.locator('.answer').waitFor();
  assert.match(await decision.locator('.answer').textContent(), /^Follow system · owner/);

  if (SHOTS) {
    await page.screenshot({ path: join(SHOTS, 'desktop-light.png') });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: join(SHOTS, 'desktop-dark.png') });
    await page.emulateMedia({ colorScheme: 'light' });
  }

  await page.getByRole('button', { name: 'Pause' }).click();
  await page.locator('#run-state', { hasText: 'Paused' }).waitFor();
  await page.getByRole('button', { name: 'Resume' }).waitFor();
  assert.equal(cp.runs[0].state, 'paused');
  assert.deepEqual(errors, []);
  await page.close();
});

test('at 360px the chat fits, the cards answer, and the team is read-only', { skip }, async () => {
  for (const scheme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 760 }, colorScheme: scheme, isMobile: true, hasTouch: true, deviceScaleFactor: SHOTS ? 2 : 1 });
    const page = await ctx.newPage();
    await page.goto(`${base}/#chat`);
    await page.locator('.card-msg.k-approval').first().waitFor();
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(width <= 360, `no sideways scroll (${width}px)`);
    const send = await page.locator('#chat-send').boundingBox();
    assert.ok(send && send.x + send.width <= 360 && send.y + send.height <= 760, 'the send button is on screen');
    await page.locator('.card-msg.k-approval').last().scrollIntoViewIfNeeded();
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `phone-${scheme}.png`) });
    if (scheme === 'light') {
      await page.getByRole('button', { name: 'Team' }).click();
      await page.getByText('On a small screen the team is read-only').waitFor();
      assert.equal(await page.locator('#publish').isVisible(), false);
      assert.equal(await page.locator('#library input').first().isDisabled(), true);
    }
    await ctx.close();
  }
});
