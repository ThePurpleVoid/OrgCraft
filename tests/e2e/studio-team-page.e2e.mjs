// The Team page in a real browser, walking demo steps 3 and 4 (prd D3, D4; acceptance-now.md Slice 1 test walk):
// from the product template, shape the org on the chart (move a teammate, switch one off, add one from the catalog),
// watch "{teammate} has no manager" appear and clear, then open a teammate and change its rules, model and hands with
// Kit default / Your change on each field. The same team then reads as a list at 360 px.
//
//   node --test tests/e2e/studio-team-page.e2e.mjs
//   SCREENSHOTS=docs/product/screenshots/team-page node --test tests/e2e/studio-team-page.e2e.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudio } from '../../apps/studio/server.mjs';
import { catalogRow, isOn, selectTeammate, switchTeammate } from './team-page.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { /* reported by the skip below */ }
if (!chromium && process.env.CI) throw new Error('CI is set but the playwright package is not installed');
const skip = !chromium && 'the playwright package is not installed';
const SHOTS = process.env.SCREENSHOTS;

let browser, studio, base;

before(async () => {
  if (skip) return;
  const root = join(mkdtempSync(join(tmpdir(), 'studio-team-page-')), 'acme');
  execFileSync('git', ['init', '-q', root]);
  const git = (...a) => execFileSync('git', ['-C', root, ...a]);
  git('config', 'user.name', 'Studio test');
  git('config', 'user.email', 'studio-test@example.com');
  git('config', 'commit.gpgsign', 'false');
  git('commit', '-q', '--allow-empty', '-m', 'start');
  studio = createStudio({ root, env: { AGENT_TEAM_HOME: mkdtempSync(join(tmpdir(), 'studio-team-page-home-')) } });
  await new Promise((r) => studio.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${studio.address().port}`;
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
after(async () => { await browser?.close(); studio?.closeAllConnections?.(); studio?.close(); });

const card = (page, slug) => page.locator(`#canvas [data-node="${slug}"]`);

/** Drags teammate `slug`'s card onto teammate `onto`'s card, with the pointer, the way a person does (B1.1-2). */
async function dragCard(page, slug, onto) {
  const box = (s) => card(page, s).locator('rect.card').first().boundingBox();
  // Zoom out until both cards are on screen, as a person would (B1.1-5).
  const { height } = page.viewportSize();
  for (let i = 0; i < 8; i++) {
    const [x, y] = [await box(slug), await box(onto)];
    if (x.y >= 0 && y.y >= 0 && x.y + x.height <= height && y.y + y.height <= height) break;
    await page.locator('#canvas').evaluate((el) => el.scrollIntoView({ block: 'start' }));
    if (i) await page.getByRole('button', { name: 'Zoom out' }).click();
  }
  const a = await box(slug);
  const b = await box(onto);
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(a.x + a.width / 2 + ((b.x - a.x) * i) / 8, a.y + a.height / 2 + ((b.y - a.y) * i) / 8);
  await page.mouse.up();
}

const managerOf = async (page, slug) => { await selectTeammate(page, slug); return page.locator('#i-manager').inputValue(); };

test('demo steps 3 and 4 at 1280 px, then the same team as a list at 360 px', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(`${base}/?t=${studio.launchToken}`);
  // SH-4: the first Tab reaches "Skip to content".
  await page.locator('.g-card').first().waitFor();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.className), 'skip');

  // Step 2, to get there: the product template's full org.
  await page.locator('.g-card', { hasText: 'Startup product team' }).click();
  await page.locator('#template-bar').getByRole('button', { name: 'Use this template' }).click();
  const form = page.locator('#create-dialog');
  await form.getByLabel('Project name').fill('Acme');
  await form.getByRole('button', { name: 'Open the team' }).click();
  await card(page, 'backend-dev').waitFor();
  // SH-6: the Team tab is marked current.
  assert.equal(await page.locator('#pages [aria-current="page"]').first().textContent().then((s) => s.trim()), 'Team');

  // ---- Step 3 (D3): shape the org.
  // B1.2-3/4: the catalog shows "{n} on the team", the team's roles first and the rest folded under "Browse all roles…".
  assert.match(await catalogRow(page, 'Backend dev').locator('.count').textContent(), /^1 on the team$/);
  await page.locator('#library details.browse summary', { hasText: 'Browse all roles…' }).waitFor();

  // B1.1-2: drop a teammate on another to make it report there.
  await dragCard(page, 'ai-engineer', 'cto');
  assert.equal(await managerOf(page, 'ai-engineer'), 'cto');

  // B1.1-3: an off teammate dims, keeps its place and says Off.
  await switchTeammate(page, 'mobile-dev', true);
  await switchTeammate(page, 'mobile-dev', false);
  assert.equal(await isOn(page, 'mobile-dev'), false);
  assert.match(await card(page, 'mobile-dev').textContent(), /Off/);

  // B1.1-7: switching QA web's manager off leaves it with no manager; the badge and the check show, and clear when fixed.
  const qaWebManager = await managerOf(page, 'qa-web');
  await switchTeammate(page, qaWebManager, false);
  const checks = page.locator('#issues');
  await page.getByRole('heading', { name: 'Things to look at before you publish' }).waitFor();
  await checks.getByText('QA web has no manager').waitFor();
  await card(page, 'qa-web').locator('.badge-warn').waitFor();
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'no-manager-desktop-light.png') });
  await switchTeammate(page, qaWebManager, true);
  await checks.getByText('QA web has no manager').waitFor({ state: 'detached' });
  assert.equal(await card(page, 'qa-web').locator('.badge-warn').count(), 0);
  // And by moving it: drag QA web onto the CTO, then back to its manager. The line follows.
  await dragCard(page, 'qa-web', 'cto');
  assert.equal(await managerOf(page, 'qa-web'), 'cto');
  await dragCard(page, 'qa-web', qaWebManager);
  assert.equal(await managerOf(page, 'qa-web'), qaWebManager);

  // B1.1-1, B1.2-2: the same role dragged again adds "Backend dev 2"; the role stays in the catalog with its count.
  await catalogRow(page, 'Backend dev').dragTo(card(page, 'cto'));
  await card(page, 'backend-dev-2').waitFor();
  assert.match(await card(page, 'backend-dev-2').textContent(), /Backend dev 2/);
  assert.match(await card(page, 'backend-dev-2').textContent(), /AI teammate · Backend dev/);
  assert.equal(await managerOf(page, 'backend-dev-2'), 'cto');
  assert.match(await catalogRow(page, 'Backend dev').locator('.count').textContent(), /^2 on the team$/);
  // B1.1-6: every change since the last publish is counted.
  assert.match(await page.locator('#summary').textContent(), /\d+ changes not published/);

  // ---- Step 4 (D4): open Backend dev and change it.
  await selectTeammate(page, 'backend-dev');
  const insp = page.locator('#inspector');
  const markOf = (label) => insp.locator('.field', { has: page.locator(`label:text-is("${label}")`) }).first();
  // B1.3-2: a name clash says so, and nothing changes.
  await page.locator('#i-name').fill('CTO');
  await page.locator('#i-name').press('Enter');
  await insp.getByText('Another teammate is already called CTO.').waitFor();
  assert.equal(await page.locator('#i-name').getAttribute('aria-invalid'), 'true');
  await page.locator('#i-name').fill('Backend dev');
  await page.locator('#i-name').press('Enter');
  // B1.3-3: add a rule. It goes on top of the kit's role as an extension, so the kit's text stays (B1.3-8).
  const rules = insp.locator('details.section', { has: page.locator('summary', { hasText: /^Rules/ }) });
  await rules.locator('summary').click();
  await rules.locator('textarea').fill('Every migration has a rollback note.');
  await rules.locator('textarea').blur();
  await insp.locator('details.section', { has: page.locator('summary', { hasText: /^Rules/ }) }).locator('.badge.changed', { hasText: 'added to' }).waitFor();
  // B1.3-3, B1.3-6: change the model tier; the field says Your change, with Reset to default.
  assert.match(await markOf('Model').textContent(), /Kit default/);
  const tier = await page.locator('#i-tier').inputValue();
  const other = await page.locator('#i-tier option').evaluateAll((os, cur) => os.map((o) => o.value).find((v) => v !== cur), tier);
  await page.locator('#i-tier').selectOption(other);
  await markOf('Model').getByText('Your change').waitFor();
  // B1.3-4: same job, more hands.
  await page.locator('#i-pool').fill('2');
  await page.locator('#i-pool').press('Enter');
  await markOf('Same job, more hands').getByText('Your change').waitFor();
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'inspector-desktop-light.png') });
  // Reset to default puts the kit's value back.
  await markOf('Model').getByRole('button', { name: 'Reset to default' }).click();
  await markOf('Model').getByText('Kit default').waitFor();
  assert.equal(await page.locator('#i-tier').inputValue(), tier);
  // The draft keeps the rule.
  await selectTeammate(page, 'backend-dev');
  assert.equal(await insp.locator('details.section', { has: page.locator('summary', { hasText: /^Rules/ }) }).locator('textarea').inputValue(), 'Every migration has a rollback note.');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 1280, 'nothing cut off sideways (B1.1-11)');

  // ---- 360 px (ALL-1, B1.1-12, B1.7): the same draft as a read-only list, top of the org first, no sideways scroll.
  await switchTeammate(page, qaWebManager, false); // a check to show on the list
  await page.setViewportSize({ width: 360, height: 780 });
  await page.getByText('Read-only on a phone. Open on a larger screen to rearrange.').waitFor();
  const first = page.locator('#canvas .tree-btn').first();
  assert.ok((await first.boundingBox()).y < 780, 'the top of the org is on screen');
  await page.locator('#canvas .tree-btn[data-node="qa-web"] .badge-dot').waitFor();
  await page.locator('#canvas .tree-btn[data-node="backend-dev-2"]').waitFor();
  assert.equal(await page.locator('#library').isVisible(), false, 'no catalog to add from on a phone');
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(w <= 360, `no sideways scroll (${w}px)`);
  for (const b of await page.locator('#canvas .tree-btn').all()) assert.ok((await b.boundingBox()).height >= 44, 'touch targets are at least 44 px');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'list-phone-light.png') });

  assert.deepEqual(errors, []);
  await ctx.close();
});
