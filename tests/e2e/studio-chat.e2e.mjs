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

// Skipped on a machine without Playwright, but never in CI: there a missing browser is a failure.
if (!chromium && process.env.CI) throw new Error('CI is set but the playwright package is not installed');
const skip = !chromium && 'the playwright package is not installed';

test('a chat round trip, a stale card refreshed, and pause', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/?t=${studio.launchToken}`);
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
  cp.bump(cardId, { title: 'What should the default be for new accounts?' }, { silent: true });
  await decision.getByRole('button', { name: 'Light' }).click();
  await page.getByText('This card changed before your answer arrived').waitFor();
  await page.getByText('What should the default be for new accounts?').waitFor();
  await decision.getByRole('button', { name: 'Follow system' }).click();
  await decision.locator('.answer').waitFor();
  assert.match(await decision.locator('.answer').textContent(), /^Follow system · owner/);
  await page.getByText('Today $6.55 of $50.00').waitFor(); // the reply's usage counted in

  if (SHOTS) {
    await page.screenshot({ path: join(SHOTS, 'desktop-light.png') });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: join(SHOTS, 'desktop-dark.png') });
    await page.emulateMedia({ colorScheme: 'light' });
  }

  // Approvals need a recent sign-in: the page asks for the step-up secret, the Studio server keeps the step-up token.
  const approval = page.locator('.card-msg.k-approval');
  // What the merge is bound to (D1): the PR and the short sha, the full sha on tap, kept open across a live redraw.
  await approval.locator('summary', { hasText: 'commit 3f9c2ab' }).click();
  await approval.getByText('3f9c2ab41e7d0c95b8f6a2d4e1c0b9a8f7e6d5c4').waitFor();
  cp.say('Another update arrives.');
  await page.getByText('Another update arrives.').waitFor();
  assert.equal(await approval.getByText('3f9c2ab41e7d0c95b8f6a2d4e1c0b9a8f7e6d5c4').isVisible(), true, 'still shown after a redraw');
  await approval.getByRole('button', { name: 'Approve' }).click();
  await approval.getByLabel('Step-up secret').fill('not it');
  await approval.getByRole('button', { name: 'Confirm' }).click();
  await approval.getByText('That token was not accepted').waitFor();
  await approval.getByLabel('Step-up secret').fill(cp.stepUpSecret);
  // A live update redraws the chat while the secret is typed in: what was typed must survive it (qa-web, PR #53).
  cp.say('A note that arrives while you type.');
  await page.getByText('A note that arrives while you type.').waitFor();
  assert.equal(await approval.getByLabel('Step-up secret').inputValue(), cp.stepUpSecret, 'the redraw kept the typed secret');
  await approval.getByRole('button', { name: 'Confirm' }).click();
  await approval.locator('.answer').waitFor();
  assert.match(await approval.locator('.answer').textContent(), /^Approve · owner/);

  await page.getByRole('button', { name: 'Pause' }).click();
  await page.locator('#run-state', { hasText: 'Paused' }).waitFor();
  await page.getByText('The run was paused · owner').waitFor();
  await page.getByRole('button', { name: 'Resume' }).waitFor();
  assert.equal(cp.runs[0].state, 'paused');
  assert.deepEqual(errors, []);
  await page.close();
});

test('at 360px the chat fits, the cards answer, and the team is read-only', { skip }, async () => {
  cp.say('The settings page change is ready to try. One step needs you before it merges.');
  cp.card({ id: 'card_phone', kind: 'approval', subject: 'approval/apr_phone', title: 'release-manager asks to merge #14 at 9b1e4d0', data: { pr: 14, headSha: '9b1e4d07c2a5f8e3b6d9c1a4f7e0b3d6c9a2f5e8' }, body: 'QA signed off on both themes. The merge gate is green.', risk: 'low', options: [{ id: 'approve', label: 'Approve', style: 'primary', stepUp: true }, { id: 'deny', label: 'Deny', style: 'danger' }], links: [{ rel: 'pr', url: 'https://example.com/pull/14' }, { rel: 'preview', url: 'https://example.com/preview/14' }] });
  for (const scheme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 760 }, colorScheme: scheme, isMobile: true, hasTouch: true, deviceScaleFactor: SHOTS ? 2 : 1 });
    const page = await ctx.newPage();
    await page.goto(`${base}/?t=${studio.launchToken}`);
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
      // No drag or edit hints that contradict the read-only note.
      assert.equal(await page.getByText('Switch roles on and off').isVisible(), false);
      assert.equal(await page.getByText('Drag a card onto another').isVisible(), false);
      const tab = await page.getByRole('button', { name: 'Chat' }).boundingBox();
      assert.ok(tab.height >= 44, `the page tabs are touch targets (${tab.height}px)`);
      await page.getByRole('button', { name: 'Chat' }).click();
      const [pause, stop] = [await page.locator('#run-pause').boundingBox(), await page.locator('#run-stop').boundingBox()];
      assert.ok(pause && stop && Math.abs(pause.y - stop.y) < 2, 'Pause and Stop share one line');
      assert.ok(stop.height >= 44 && stop.x + stop.width <= 360, 'Stop is a touch target on screen');
    }
    await ctx.close();
  }
});

test('start a run: the published team, a daily cap first, step-up to set it, and the 409 when one is going', { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'studio-e2e-start-'));
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync(process.execPath, [join(KIT, 'bin/agent-team.mjs'), 'init', '--preset', 'minimal', '--project', 'Sample app', '--dir', root], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'team']);
  // Published and pushed: a run is pinned to a commit its remote has.
  const bare = mkdtempSync(join(tmpdir(), 'studio-e2e-origin-'));
  execFileSync('git', ['init', '-q', '--bare', bare]);
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', bare]);
  execFileSync('git', ['-C', root, 'push', '-q', '-u', 'origin', 'HEAD:refs/heads/main']);
  execFileSync('git', ['-C', root, 'branch', '-q', '--set-upstream-to=origin/main']);
  const plane = await fakeControlPlane({ team: 'sample-app', running: false, perDay: null });
  const s2 = createStudio({ root, env: plane.env });
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const at = `http://127.0.0.1:${s2.address().port}`;
  try {
    for (const [width, height, name] of [[1280, 860, 'desktop'], [360, 760, 'phone']]) {
      const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: SHOTS ? 2 : 1 });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${at}/?t=${s2.launchToken}`);
      await page.goto(`${at}/#chat`);
      await page.locator('#run-state', { hasText: 'Not running' }).waitFor();
      assert.equal(await page.locator('#run-pause').isVisible(), false, 'no pause without a run');
      await page.getByRole('button', { name: 'Start a run' }).click();
      const dlg = page.locator('#start-dialog');
      await dlg.getByText('chief-of-staff reports to the owner').waitFor();
      const go = dlg.getByRole('button', { name: 'Start', exact: true });
      if (name === 'desktop') {
        assert.equal(await go.isDisabled(), true, 'Start waits for a daily cap');
        await dlg.getByLabel('Daily cap').fill('20');
      } else {
        await page.waitForFunction(() => document.querySelector('#start-cap').value === '20.00'); // the cap set on desktop
      }
      assert.equal(await go.isDisabled(), false);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `start-${name}.png`) });
      if (name === 'phone') {
        // Someone started one elsewhere meanwhile: the control plane's 409 is shown, nothing else changes.
        plane.runs.push({ id: 'run_elsewhere', state: 'running', started: new Date().toISOString() });
        await go.click();
        await dlg.getByText('run run_elsewhere is still going').waitFor();
        assert.equal(plane.started.length, 1);
        await dlg.getByRole('button', { name: 'Cancel' }).click();
        await ctx.close();
        break;
      }
      await go.click();
      // The first cap lets the team spend at all, so it needs a recent sign-in.
      const su = page.locator('#stepup-dialog');
      await su.getByLabel('Step-up secret').fill('not it');
      await su.getByRole('button', { name: 'Confirm' }).click();
      await su.getByText('That secret was not accepted').waitFor();
      await su.getByLabel('Step-up secret').fill(plane.stepUpSecret);
      await su.getByRole('button', { name: 'Confirm' }).click();
      await page.locator('#run-state', { hasText: 'Running' }).waitFor();
      await dlg.waitFor({ state: 'hidden' });
      assert.equal(plane.budget.perDay, 2000);
      assert.equal(plane.started.length, 1);
      assert.equal(plane.started[0].team.version, execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
      await page.getByText('A run started').waitFor();
      await page.getByRole('button', { name: 'Pause' }).waitFor();
      // Stop it, so the phone pass finds no run going until the one "started elsewhere".
      // The Studio's own dialog, not the browser's confirm() (embed spec 4): Keep it running first, then stop.
      await page.getByRole('button', { name: 'Stop', exact: true }).click();
      const ask = page.locator('dialog.ask-dialog');
      await ask.getByText('Stop the run? Every role session stops after its current step.').waitFor();
      await ask.getByRole('button', { name: 'Keep it running' }).click();
      await ask.waitFor({ state: 'detached' });
      await page.getByRole('button', { name: 'Pause' }).waitFor();
      await page.getByRole('button', { name: 'Stop', exact: true }).click();
      await ask.getByRole('button', { name: 'Stop the run' }).click();
      await page.getByRole('button', { name: 'Start a run' }).waitFor();
      assert.deepEqual(errors, []);
      await ctx.close();
    }
  } finally { s2.closeAllConnections?.(); s2.close(); plane.close(); }
});

test('a resume refused because today\'s budget is spent says so in words, and Raise today\'s cap resumes it (QA sev-4)', { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'studio-e2e-spent-'));
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync(process.execPath, [join(KIT, 'bin/agent-team.mjs'), 'init', '--preset', 'minimal', '--project', 'Sample app', '--dir', root], { stdio: 'ignore' });
  const plane = await fakeControlPlane({ team: 'sample-app' });
  const s3 = createStudio({ root, env: plane.env });
  await new Promise((r) => s3.listen(0, '127.0.0.1', r));
  const at = `http://127.0.0.1:${s3.address().port}`;
  try {
    const page = await browser.newPage({ viewport: { width: 360, height: 760 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${at}/?t=${s3.launchToken}`);
    await page.goto(`${at}/#chat`);
    await page.locator('#run-state', { hasText: 'Running' }).waitFor();
    plane.usage(4380); // $50.00 spent
    plane.exhaust();
    await page.locator('#run-state', { hasText: 'Paused' }).waitFor();
    plane.card({ id: 'crd_budget', kind: 'budget', subject: 'budget/today', title: "Today's budget is spent", body: 'The run is paused; nothing spends until you choose.', state: 'open',
      options: [{ id: 'tomorrow', label: 'Resume tomorrow', style: 'primary', stepUp: false }, { id: 'raise', label: 'Add half again', style: 'danger', stepUp: true }] }, 'system');
    await page.getByRole('button', { name: 'Resume' }).click();
    const refused = page.getByText("Today's budget is spent, so the run can't resume yet. Raise today's cap to resume it now, or resume it tomorrow.");
    await refused.waitFor();
    assert.equal(await page.getByText("today's budget is spent;").count(), 0, 'not the server\'s own wording');
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'resume-refused-phone.png') });
    // While today's budget card is open, the action points to it: it raises and resumes with one step-up.
    await page.getByRole('button', { name: "Raise today's cap" }).click();
    await page.locator('[data-card-id="crd_budget"].focused').waitFor();
    assert.equal(await page.locator('dialog.ask-dialog').count(), 0);
    // Once that card is answered (Resume tomorrow), the action asks for the new cap itself.
    plane.bump('crd_budget', { state: 'answered', answer: { option: 'tomorrow' } });
    await page.locator('[data-card-id="crd_budget"].answered').waitFor();
    // An amount at or under today's spend changes nothing.
    await page.getByRole('button', { name: "Raise today's cap" }).click();
    const ask = page.locator('dialog.ask-dialog');
    await ask.getByText("Today's spend so far is $50.00").waitFor();
    await ask.locator('input').fill('40');
    await ask.getByRole('button', { name: 'OK' }).click();
    await page.getByText("The new cap must be more than today's spend of $50.00. Nothing changed.").waitFor();
    assert.equal(plane.budget.perDay, 5000);
    // A higher one goes through step-up, then the run resumes.
    await page.getByRole('button', { name: 'Resume' }).click();
    await refused.waitFor();
    await page.getByRole('button', { name: "Raise today's cap" }).click();
    await ask.locator('input').fill('80');
    await ask.getByRole('button', { name: 'OK' }).click();
    const su = page.locator('#stepup-dialog');
    await su.getByText('Raising the daily cap to $80.00 lets the team spend more today.').waitFor();
    await su.getByLabel('Step-up secret').fill(plane.stepUpSecret);
    await su.getByRole('button', { name: 'Confirm' }).click();
    // Each step-up is used once, so resuming asks again.
    await su.getByText("Resuming a run that today's cap paused lets the team spend again.").waitFor();
    assert.equal(plane.budget.perDay, 8000);
    await su.getByLabel('Step-up secret').fill(plane.stepUpSecret);
    await su.getByRole('button', { name: 'Confirm' }).click();
    await page.locator('#run-state', { hasText: 'Running' }).waitFor();
    assert.equal(await refused.count(), 0);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'raise-cap-phone.png') });
    assert.deepEqual(errors, []);
    await page.close();
  } finally { s3.closeAllConnections?.(); s3.close(); plane.close(); }
});
