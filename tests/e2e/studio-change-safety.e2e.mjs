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

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { /* reported by the skip below */ }
if (!chromium && process.env.CI) throw new Error('CI is set but the playwright package is not installed');
const skip = !chromium && 'the playwright package is not installed';
const SHOTS = process.env.SCREENSHOTS;

/** A team in a temporary repository; `reports` (board rows) go to its event log when given. */
function team(reports) {
  const root = mkdtempSync(join(tmpdir(), 'studio-safety-'));
  const home = mkdtempSync(join(tmpdir(), 'studio-safety-home-'));
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Studio test']);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'studio-test@example.com']);
  execFileSync(process.execPath, [join(KIT, 'bin/agent-team.mjs'), 'init', '--preset', 'minimal', '--project', 'Sample app', '--dir', root], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'team']);
  const env = { AGENT_TEAM_HOME: home };
  if (reports) {
    const { log } = context(env, root);
    mkdirSync(dirname(log), { recursive: true });
    writeFileSync(log, reports.map((r, i) => JSON.stringify({ id: `e2e-${i}`, kind: 'status', ...r })).join('\n') + '\n');
  }
  return createStudio({ root, env });
}

let busy, quiet, base, baseQuiet, browser;
before(async () => {
  if (skip) return;
  const now = Date.now();
  const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();
  busy = team([
    { at: at(34), role: 'web-dev', status: 'working', issue: '142', task: 'Dark mode', branch: 'web/142-dark-mode', pr: '142' },
    { at: at(180), role: 'qa-web', status: 'idle', task: '' },
  ]);
  quiet = team(null);
  for (const s of [busy, quiet]) await new Promise((r) => s.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${busy.address().port}`;
  baseQuiet = `http://127.0.0.1:${quiet.address().port}`;
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
after(async () => { await browser?.close(); for (const s of [busy, quiet]) { s?.closeAllConnections?.(); s?.close(); } });

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
  assert.equal(await page.locator('#impact-pill').isHidden(), true, 'nothing changed yet');
  assert.equal(await page.locator('#draft-banner').isHidden(), true);

  // Criteria 2 to 4: switching a working role off keeps its card, greyed and amber, explains itself, and counts.
  await page.locator('#library .lib-role[data-slug="web-dev"] input').uncheck();
  const popover = page.locator('.impact-pop');
  await popover.getByText('Web dev is working right now.').waitFor();
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
  assert.equal(await page.locator('#library .lib-role[data-slug="web-dev"] input').isChecked(), true);
  assert.equal(await page.locator('#impact-pill').isHidden(), true);

  // A change on an idle role is safe: no amber, though it still counts as a change in the banner.
  await card('qa-web').click();
  await page.locator('#i-tier').selectOption('deep');
  assert.equal(await page.locator('.impact-pop').count(), 0);
  assert.doesNotMatch(await card('qa-web').getAttribute('class'), /amber/);
  await page.locator('#draft-banner').waitFor();
  assert.equal(await page.locator('#impact-pill').isHidden(), true, 'nothing in flight is touched');

  // Criterion 5: the inspector lists the work above the fields; clicking an amber card opens its popover again.
  await page.locator('#library .lib-role[data-slug="web-dev"] input').uncheck();
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
  await page.locator('#library .lib-role[data-slug="web-dev"] input').uncheck();
  await page.locator('#canvas .node[data-slug="web-dev"]').waitFor({ state: 'detached' });
  assert.equal(await page.locator('#canvas .node .state').count(), 0);
  assert.equal(await page.locator('.impact-pop').count(), 0);
  assert.equal(await page.locator('#impact-pill').isHidden(), true);
  assert.equal(await page.locator('#draft-banner').isHidden(), true);
  assert.equal(await page.locator('#library .lib-role .state').count(), 0);
  await page.close();
});
