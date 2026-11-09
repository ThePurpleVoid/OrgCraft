// The Publish sheet (B5.1, L14; demo steps 7, 8 and 13): Widens access first, the checks as "Checks: {passed} of
// {total} passed", one plain line per change with its own Undo, the work in progress, and the files folded.
//
//   node --test tests/e2e/studio-publish-sheet.e2e.mjs
//   SCREENSHOTS=docs/product/screenshots/publish-sheet node --test tests/e2e/studio-publish-sheet.e2e.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudio } from '../../apps/studio/server.mjs';
import { isOn, selectTeammate, switchTeammate } from './team-page.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { /* reported by the skip below */ }
if (!chromium && process.env.CI) throw new Error('CI is set but the playwright package is not installed');
const skip = !chromium && 'the playwright package is not installed';
const SHOTS = process.env.SCREENSHOTS;

let browser, studio, base, root;
before(async () => {
  if (skip) return;
  root = join(mkdtempSync(join(tmpdir(), 'studio-publish-sheet-')), 'acme');
  execFileSync('git', ['init', '-q', root]);
  const git = (...a) => execFileSync('git', ['-C', root, ...a]);
  git('config', 'user.name', 'Studio test');
  git('config', 'user.email', 'studio-test@example.com');
  git('config', 'commit.gpgsign', 'false');
  git('commit', '-q', '--allow-empty', '-m', 'start');
  studio = createStudio({ root, env: { AGENT_TEAM_HOME: mkdtempSync(join(tmpdir(), 'studio-publish-sheet-home-')) } });
  await new Promise((r) => studio.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${studio.address().port}`;
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
after(async () => { await browser?.close(); studio?.closeAllConnections?.(); studio?.close(); });

const sheet = (page) => page.locator('#publish-dialog');
const lines = (page) => sheet(page).locator('#sheet-changes li').evaluateAll((els) => els.map((e) => (e.querySelector('.ctext') ?? e).textContent.trim()));

test('demo steps 7, 8 and 13: the first publish, then a small change with Widens access and Undo', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/?t=${studio.launchToken}`);
  await page.locator('.g-card', { hasText: 'Startup product team' }).click();
  await page.locator('#template-bar').getByRole('button', { name: 'Use this template' }).click();
  await page.locator('#create-dialog').getByLabel('Project name').fill('Acme');
  await page.locator('#create-dialog').getByRole('button', { name: 'Open the team' }).click();
  await page.locator('#canvas [data-node="backend-dev"]').waitFor();

  // ---- Step 7 (D7): the first publish. One line per teammate, the checks, the files folded until opened.
  const label = await page.locator('#publish').textContent();
  const n = Number(/^Publish (\d+) changes$/.exec(label)?.[1]);
  assert.ok(n > 10, label);
  await page.locator('#publish').click();
  assert.equal(await sheet(page).getByRole('heading', { level: 2 }).textContent(), label, 'the sheet is titled like the button');
  await sheet(page).locator('#sheet-checks', { hasText: /^Checks/ }).waitFor();
  assert.match(await sheet(page).locator('#sheet-checks').textContent(), /Checks: \d+ of 7 passed/);
  assert.equal((await lines(page)).length, n, 'one line per change, as many as the button says');
  assert.ok((await lines(page)).includes('Backend dev switched on'));
  assert.equal(await sheet(page).locator('[data-undo-line]').count(), 0, 'a first publish has nothing to undo to');
  assert.equal(await sheet(page).locator('#files').getAttribute('open'), null, 'B5.1-2: the files are folded');
  await sheet(page).locator('#files-title', { hasText: /^Files that will change \(\d+\)$/ }).waitFor();
  await sheet(page).locator('#files > summary').click();
  await sheet(page).locator('#changes summary', { hasText: '.agent-team/team.json' }).waitFor();
  await page.locator('#advanced').evaluate((d) => { d.open = true; });
  await page.locator('#branch').fill('first-team');
  await page.locator('#confirm').click();
  await page.locator('#publish-result', { hasText: /^Saved \d+ changes? in your files/ }).waitFor();
  await sheet(page).getByRole('button', { name: 'Keep editing' }).click();
  // B5.1-8: the same draft can't be published twice.
  assert.equal(await page.locator('#publish').isDisabled(), true);

  // ---- Step 13 (D13) with step 8: switch on a teammate and give another more hands.
  if (await isOn(page, 'performance-tester')) await switchTeammate(page, 'performance-tester', false);
  else await switchTeammate(page, 'performance-tester', true);
  const on = await isOn(page, 'performance-tester');
  await selectTeammate(page, 'backend-dev');
  await page.locator('#i-pool').fill('2');
  await page.locator('#i-pool').dispatchEvent('change');
  await page.locator('#publish', { hasText: 'Publish 2 changes' }).waitFor();
  await page.locator('#publish').click();
  const want = [on ? 'Performance tester switched on' : 'Performance tester switched off', 'Backend dev works on up to 2 tasks at once (was 1)'];
  assert.deepEqual((await lines(page)).sort(), want.sort());
  // Widens access comes first, from the server's comparison, with the passkey note.
  const widens = sheet(page).locator('#widens');
  await widens.waitFor();
  const text = await widens.textContent();
  assert.match(text, /^Widens access/);
  assert.match(text, /Backend dev can work on up to 2 tasks at once \(was 1\)/);
  assert.match(text, /needs your passkey/);
  assert.ok(await sheet(page).evaluate((d) => d.querySelector('#widens').compareDocumentPosition(d.querySelector('#sheet-checks')) & Node.DOCUMENT_POSITION_FOLLOWING), 'Widens access is above the checks');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'publish-sheet-desktop-light.png') });

  // Undo one line: only that change goes, the sheet and the button agree, and the keyboard stays in the list.
  const undo = sheet(page).getByRole('button', { name: 'Undo: Backend dev works on up to 2 tasks at once (was 1)' });
  await undo.click();
  await page.locator('#publish', { hasText: /^Publish 1 change$/ }).waitFor();
  assert.deepEqual(await lines(page), want.filter((x) => x.startsWith('Performance tester')));
  assert.equal(await sheet(page).getByRole('heading', { level: 2 }).textContent(), await page.locator('#publish').textContent());
  assert.match(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.id ?? ''), /^Undo: |publish-title/);
  await page.locator('#files-title', { hasText: /^Files that will change \(\d\)$/ }).waitFor();
  await sheet(page).locator('#files > summary').click();
  // B5.1-2: the owner's own files first; what OrgCraft regenerates is folded under Updated automatically.
  const generatedFold = sheet(page).locator('#changes details.generated');
  await generatedFold.waitFor();
  assert.equal(await generatedFold.getAttribute('open'), null);
  assert.match(await generatedFold.locator('> summary').textContent(), /^Updated automatically \(\d+ files\)$/);
  assert.match(await sheet(page).locator('#changes > details:not(.generated) > summary').first().textContent(), /\.agent-team\/(team\.json|roles\/[a-z0-9-]+\.extend\.md)$/);
  // ALL-5 with everything open: no engineering words in the sheet's sentences (file names and diffs are names, in code style).
  await generatedFold.locator('> summary').click();
  await sheet(page).locator('#advanced > summary').click();
  const words = await sheet(page).evaluate((d) => { const c = d.cloneNode(true); for (const x of c.querySelectorAll('.changes > details > summary, .changes details:not(.generated) summary, pre, input')) x.remove(); return c.innerText; });
  assert.doesNotMatch(words, /\b(writes?|sync|commit(ted|s)?|pull request|agents?|run|deploys?|workspaces?|members?|instances?)\b/i);
  assert.equal(await sheet(page).locator('#confirm').textContent(), 'Publish');
  await page.locator('#confirm').click();
  await page.locator('#publish-result', { hasText: /^Saved 1 change in your files\. Your teammates pick it up once the change is approved\. To send it for review, run this in your project folder:/ }).waitFor();
  assert.equal(await page.locator('#publish-result code.cmd').textContent(), 'git push -u origin first-team');
  const changed = execFileSync('git', ['-C', root, 'show', '--name-only', '--format=', 'HEAD'], { encoding: 'utf8' }).trim().split('\n');
  assert.ok(changed.includes('.agent-team/team.json'), changed.join(', '));
  assert.ok(!changed.some((f) => /backend-dev/.test(f)), 'the undone change is not published');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('someone publishes first: the second publish is refused as stale, and after a reload the draft is back on top of theirs (B1.1-10)', { skip }, async () => {
  const open = async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${base}/?t=${studio.launchToken}`);
    await page.locator('#canvas [data-node="backend-dev"]').waitFor();
    return { ctx, page };
  };
  const a = await open();
  const b = await open();
  const flip = async (page, slug) => { const on = await isOn(page, slug); await switchTeammate(page, slug, !on); return !on; };
  const aWants = await flip(a.page, 'mobile-dev');
  const bWants = await flip(b.page, 'qa-web');

  // B publishes first.
  await b.page.locator('#publish').click();
  await b.page.locator('#advanced').evaluate((d) => { d.open = true; });
  await b.page.locator('#branch').fill('b-first');
  await b.page.locator('#confirm').click();
  await b.page.locator('#publish-result', { hasText: /^Saved 1 change in your files/ }).waitFor();

  // A, without reloading: refused, never a silent undo of B's change.
  await a.page.locator('#publish').click();
  await a.page.locator('#advanced').evaluate((d) => { d.open = true; });
  await a.page.locator('#branch').fill('a-second');
  await a.page.locator('#confirm').click();
  await a.page.locator('#publish-result', { hasText: /^Someone published a change to this team after you started\./ }).waitFor();
  assert.equal(execFileSync('git', ['-C', root, 'branch', '--list', 'a-second'], { encoding: 'utf8' }).trim(), '', 'nothing was written');

  // A reloads: its change is back, on top of B's.
  await a.page.reload();
  await a.page.locator('#restored', { hasText: /^Your unpublished changes from .+ are back\./ }).waitFor();
  assert.equal(await isOn(a.page, 'mobile-dev'), aWants, 'A\'s change came back');
  assert.equal(await isOn(a.page, 'qa-web'), bWants, 'B\'s published change is kept');
  await a.page.locator('#publish', { hasText: /^Publish 1 change$/ }).waitFor();
  await a.page.locator('#publish').click();
  await a.page.locator('#advanced').evaluate((d) => { d.open = true; });
  await a.page.locator('#branch').fill('a-second');
  await a.page.locator('#confirm').click();
  await a.page.locator('#publish-result', { hasText: /^Saved 1 change in your files/ }).waitFor();
  await a.ctx.close();
  await b.ctx.close();
});
