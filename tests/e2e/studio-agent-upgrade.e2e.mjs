// A kit upgrade that ships a role with a custom agent's name (CPO story criterion 14, PRD A7): the agent shows an
// error with two ways out, Rename mine and Use the kit's role. A custom agent is never silently replaced.
//
//   node --test tests/e2e/studio-agent-upgrade.e2e.mjs     # needs the playwright package and a Chromium
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KIT } from '../../bin/agent-team.mjs';
import { createStudio } from '../../apps/studio/server.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { /* reported by the skip below */ }
if (!chromium && process.env.CI) throw new Error('CI is set but the playwright package is not installed');
const skip = !chromium && 'the playwright package is not installed';
const SHOTS = process.env.SCREENSHOTS;

let studio, base, browser;
before(async () => {
  if (skip) return;
  const root = mkdtempSync(join(tmpdir(), 'studio-upgrade-'));
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Studio test']);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'studio-test@example.com']);
  execFileSync(process.execPath, [join(KIT, 'bin/agent-team.mjs'), 'init', '--preset', 'minimal', '--project', 'Sample firm', '--dir', root], { stdio: 'ignore' });
  // The team made its own "analytics-lead" when the kit it synced with had none; the pinned kit now ships one.
  writeFileSync(join(root, '.agent-team/roles/analytics-lead.md'), '# Numbers person\n\n**Model:** standard\n**Group:** insights\n**Reports to:** chief-of-staff\n**Status:** active\n\n## Identity\nYou keep the monthly figures honest.\n\n## Owns (writes)\n- `figures/`\n\n## Every thread, every task\n- `scripts/agent-team/team-status.sh analytics-lead status working --task "<task>"`\n');
  const lockFile = join(root, '.agent-team/kit.lock.json');
  const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
  lock.kitRoles = lock.kitRoles.filter((s) => s !== 'analytics-lead');
  writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'team']);
  studio = createStudio({ root, env: {} });
  await new Promise((r) => studio.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${studio.address().port}`;
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});
after(async () => { await browser?.close(); studio?.closeAllConnections?.(); studio?.close(); });

test('a custom agent the kit now ships a role for: an error with Rename mine and Use the kit\'s role', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/?t=${studio.launchToken}`);
  await page.locator('#checks.error').waitFor();
  await page.locator('#issues li.error', { hasText: 'adds a role called analytics-lead' }).waitFor({ state: 'attached' });
  await page.locator('#library .lib-role', { hasText: 'Numbers person' }).locator('.name').click();
  const ed = page.locator('#agent-editor');
  const box = ed.locator('#e-kit-clash');
  await box.getByText('The kit now has a role called analytics-lead').waitFor();
  await ed.locator('#e-checks li.error', { hasText: 'adds a role called analytics-lead' }).waitFor();
  if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, 'agent-editor-kit-clash.png') }); }

  assert.equal(await box.getByLabel('A new slug for your agent').inputValue(), 'numbers-person', 'offered from its name');
  await ed.locator('.badge', { hasText: 'name clash' }).waitFor();
  // Rename mine: the slug is checked like a new one; a free one moves the agent, and the kit's role is back (off).
  await box.getByLabel('A new slug for your agent').fill('cto');
  await box.getByRole('button', { name: 'Rename mine' }).click();
  await box.getByText('The kit has a role called cto').waitFor();
  await box.getByLabel('A new slug for your agent').fill('numbers-person');
  await box.getByRole('button', { name: 'Rename mine' }).click();
  await box.waitFor({ state: 'detached' });
  await ed.getByText('.agent-team/roles/numbers-person.md').waitFor();
  assert.match(await page.locator('#e-raw').inputValue(), /team-status\.sh numbers-person status/);
  assert.equal(await ed.locator('#e-checks li.error').count(), 0);
  await page.getByRole('button', { name: 'Back to the team' }).click();
  assert.equal(await page.locator('#issues li', { hasText: 'adds a role called' }).count(), 0);
  assert.equal(await page.locator('#library .lib-role[data-slug="analytics-lead"] input').isChecked(), false, "the kit's role is back, switched off");

  // Undo, then Use the kit's role: the agent goes, and the kit's role takes its place, switched on.
  await page.locator('#undo').click();
  await page.locator('#library .lib-role', { hasText: 'Numbers person' }).locator('.name').click();
  await ed.locator('#e-kit-clash').getByRole('button', { name: "Use the kit's role" }).click();
  await ed.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#library .lib-role', { hasText: 'Numbers person' }).count(), 0);
  assert.equal(await page.locator('#library .lib-role[data-slug="analytics-lead"] input').isChecked(), true);
  assert.equal(await page.locator('#issues li', { hasText: 'adds a role called' }).count(), 0);

  assert.deepEqual(errors, []);
  await page.close();
});
