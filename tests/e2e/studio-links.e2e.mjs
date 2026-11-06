// Links from emails and Slack messages into the local Studio (kit #101 link paths, apps/studio/public/links.js): the
// server sends each to its page, and the page shows the card, today's budget, the role or the meeting it names.
//
//   node --test tests/e2e/studio-links.e2e.mjs
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

let cp, studio, base, browser;
before(async () => {
  if (skip) return;
  const root = mkdtempSync(join(tmpdir(), 'studio-links-'));
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync(process.execPath, [join(KIT, 'bin/agent-team.mjs'), 'init', '--preset', 'minimal', '--project', 'Sample app', '--dir', root], { stdio: 'ignore' });
  cp = await fakeControlPlane({ team: 'sample-app' });
  studio = createStudio({ root, env: cp.env });
  await new Promise((r) => studio.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${studio.address().port}`;
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});
after(async () => { await browser?.close(); studio?.closeAllConnections?.(); studio?.close(); cp?.close(); });

test('a card, the budget, a role and a meeting, each from its link', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/?t=${studio.launchToken}`);
  await page.getByRole('button', { name: 'Chat' }).click();
  await page.getByLabel('Message the chief of staff').fill('Add a dark mode toggle');
  await page.keyboard.press('Enter');
  const card = page.locator('.card-msg.k-decision');
  await card.waitFor();
  const id = await card.getAttribute('data-card-id');

  // The server redirects the link path; the page brings the card into view and marks it.
  const res = await page.request.get(`${base}/teams/sample-app/inbox?card=${encodeURIComponent(id)}`, { maxRedirects: 0 });
  assert.equal(res.status(), 302);
  assert.equal(res.headers().location, `/#chat?card=${encodeURIComponent(id)}`);
  await page.goto(`${base}/`);
  await page.goto(`${base}/teams/sample-app/inbox?card=${encodeURIComponent(id)}`);
  await page.locator(`.card-msg.focused[data-card-id="${id}"]`).waitFor();
  assert.equal(new URL(page.url()).hash, '#chat', 'the query is dropped from the address');

  // A card that is not there says so.
  await page.goto(`${base}/`);
  await page.goto(`${base}/teams/sample-app/inbox?card=crd_gone`);
  await page.getByText('The card that link points to is not in the recent chat. It may be older, or already answered.').waitFor();

  // Today's budget.
  await page.goto(`${base}/`);
  await page.goto(`${base}/teams/sample-app/budget`);
  await page.locator('#cost.focused').waitFor();

  // A role, picked on the canvas.
  await page.goto(`${base}/teams/sample-app/board?role=chief-of-staff`);
  await page.locator('#canvas .node.selected[data-slug="chief-of-staff"]').waitFor();
  assert.equal(new URL(page.url()).hash, '', 'the team page keeps a clean address');

  // A meeting the team no longer has.
  await page.goto(`${base}/teams/sample-app/meetings/old-review`);
  await page.getByText('That meeting is not in this team any more.').waitFor();
  assert.deepEqual(errors, []);
  await page.close();
});
