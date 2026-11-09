// "Do it" in the Studio's chat (L39 web half; governance G3) against the fake control plane: the team's open asks show
// their letters, one tap takes every ask it can cover with each card version shown, an ask held by a sign-off stays
// open, one passkey covers a set with bound asks, and a set that changed since it was shown approves nothing.
//
//   node --test tests/e2e/studio-do-it.e2e.mjs     # needs the playwright package and a Chromium
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
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

let browser, root;
const open = [];
before(async () => {
  if (skip) return;
  root = mkdtempSync(join(tmpdir(), 'studio-doit-'));
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync(process.execPath, [join(KIT, 'bin/agent-team.mjs'), 'init', '--preset', 'minimal', '--project', 'Sample app', '--dir', root], { stdio: 'ignore' });
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});
after(async () => { await browser?.close(); for (const { studio, cp } of open) { studio.closeAllConnections?.(); studio.close(); cp.close(); } });

/** A Studio on its own fake control plane, and the chat page open on it. */
async function chat() {
  const cp = await fakeControlPlane({ team: 'sample-app', running: false });
  const studio = createStudio({ root, env: cp.env });
  await new Promise((r) => studio.listen(0, '127.0.0.1', r));
  open.push({ studio, cp });
  const base = `http://127.0.0.1:${studio.address().port}`;
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { cp, page, errors, go: async () => { await page.goto(`${base}/?t=${studio.launchToken}`); await page.goto(`${base}/#chat`); } };
}

const ask = (cp, letter, extra = {}) => cp.card({
  id: `card_${letter}`, kind: 'approval', subject: `approval/apr_${letter}`, title: `web-dev asks to send report ${letter}`, body: 'Ready.',
  data: { letter, ...(extra.data ?? {}) }, options: [{ id: 'approve', label: 'Approve', style: 'primary', stepUp: true }, { id: 'deny', label: 'Deny', style: 'danger' }], ...extra.card,
});

test('Do it covers the asks it can, leaves a held one open, and sends each card version shown', { skip }, async () => {
  const { cp, page, errors, go } = await chat();
  ask(cp, 'A');
  ask(cp, 'B');
  ask(cp, 'C', { data: { blocked: 'QA has not signed off this version' } });
  ask(cp, 'D', { card: { recommendation: { option: 'deny', why: 'The report has errors.' } } });
  await go();
  for (const l of ['A', 'B', 'C']) await page.locator(`[data-card-id="card_${l}"] h3 .letter`, { hasText: `${l}.` }).waitFor();
  // The control shows once, on the newest ask, and says what it covers and what needs the person first.
  assert.equal(await page.locator('#doit').count(), 1);
  assert.equal(await page.locator('[data-card-id="card_D"] #doit').count(), 1);
  assert.equal(await page.locator('#doit .doitcov').textContent(), 'Covers A and B. C and D need you to do something first.');
  await page.locator('#doit').click();
  await page.locator('[data-card-id="card_A"] .answer', { hasText: /took the recommendation on A and B with Do it · in Chat$/ }).waitFor();
  await page.locator('[data-card-id="card_B"] .answer', { hasText: 'took the recommendation on A and B with Do it' }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.className), 'muted doit-none', 'focus on what is left (qa-web F1)');
  assert.deepEqual(cp.doIts[0].asks, [{ approval: 'apr_A', version: 1 }, { approval: 'apr_B', version: 1 }]);
  assert.equal(cp.doIts[0].via, 'chat');
  // Only the held ask is left: nothing to cover, so no button, and the reason.
  await page.locator('.doit-none', { hasText: 'Each ask on this card needs its own answer.' }).waitFor();
  assert.equal(await page.locator('#doit').count(), 0);
  assert.equal(await page.locator('[data-card-id="card_C"] .answer').count(), 0);
  assert.deepEqual(errors, []);
});

test('one bound ask: one passkey for the set, scoped to it', { skip }, async () => {
  const { cp, page, go } = await chat();
  ask(cp, 'A', { data: { facts: [{ text: 'send email to client@example.com: Launch posts' }], callsHash: 'h1' } });
  await go();
  await page.locator('#doit .doitcov', { hasText: 'Takes option 1. Confirm with your passkey.' }).waitFor();
  assert.match(await page.locator('#doit .doitcov').textContent(), /The passkey shows each payment and send\./);
  await page.locator('#doit').click();
  const dlg = page.locator('#stepup-dialog');
  await dlg.locator('#stepup-why').waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.id === 'doit');
  assert.equal(cp.doIts.length, 0);
  await page.locator('#doit').click();
  await dlg.locator('#stepup-why', { hasText: 'Take the recommended answer on A' }).waitFor();
  assert.deepEqual(await dlg.locator('.stepup-items li').allTextContents(), ['A. web-dev asks to send report A', 'send email to client@example.com: Launch posts'], 'each ask, then each send on its own line');
  assert.equal(cp.doIts.length, 0, 'nothing approved before the passkey');
  await dlg.locator('#stepup-secret').fill(cp.stepUpSecret);
  await dlg.locator('button[type="submit"]').click();
  await page.locator('[data-card-id="card_A"] .answer').waitFor();
  assert.equal(cp.doIts.length, 1);
});

test('an ask that changed since it was shown: nothing is approved, the page says so, and Do it works on the new one', { skip }, async () => {
  const { cp, page, go } = await chat();
  ask(cp, 'A');
  ask(cp, 'B');
  await go();
  await page.locator('#doit').waitFor();
  assert.equal(await page.locator('#doit .doitcov').textContent(), 'Covers A and B.', 'nothing left over, no passkey: neither is mentioned');
  // B changes while the page still shows version 1 (its card.updated is held back).
  cp.bump('card_B', { title: 'web-dev asks to send report B, now to everyone' }, { silent: true });
  await page.locator('#doit').click();
  await page.getByText('This changed since you were asked. Look again.').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'This changed since you were asked. Look again.');
  assert.equal(cp.doIts.length, 0);
  assert.equal(await page.locator('[data-card-id="card_A"] .answer').count(), 0, 'all or nothing');
  await page.locator('[data-card-id="card_B"] h3', { hasText: 'now to everyone' }).waitFor();
  await page.locator('#doit').click();
  await page.locator('[data-card-id="card_B"] .answer').waitFor();
  assert.deepEqual(cp.doIts[0].asks.find((x) => x.approval === 'apr_B'), { approval: 'apr_B', version: 2 });
});
