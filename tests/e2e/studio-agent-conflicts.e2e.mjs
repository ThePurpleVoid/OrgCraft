// Path conflicts resolved where they happen (CPO story criteria 9 and 12, D5; mockup 02): an area another role writes is
// held, never written as a second writer, until the owner picks one of three ways out: read only and send fixes as
// BUG, a narrower area (checked again), or move the whole area, which asks twice when the board says the writer is
// working on it now.
//
//   node --test tests/e2e/studio-agent-conflicts.e2e.mjs     # needs the playwright package and a Chromium
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

let studio, base, browser;
before(async () => {
  if (skip) return;
  const root = mkdtempSync(join(tmpdir(), 'studio-conflicts-'));
  const home = mkdtempSync(join(tmpdir(), 'studio-conflicts-home-'));
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Studio test']);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'studio-test@example.com']);
  execFileSync(process.execPath, [join(KIT, 'bin/agent-team.mjs'), 'init', '--preset', 'minimal', '--project', 'Sample firm', '--dir', root], { stdio: 'ignore' });
  // Two areas with writers: the docs keeper's is in flight on the board, the product manager's is not.
  writeFileSync(join(root, '.agent-team/ownership.json'), JSON.stringify({ rows: [
    { path: 'contracts/', writer: 'docs-keeper', notes: '' },
    { path: 'reports/finance/', writer: 'product-manager', notes: '' },
  ] }, null, 2) + '\n');
  writeFileSync(join(root, '.agent-team/resources.json'), JSON.stringify({ resources: [{ id: 'clients', type: 'database', name: 'Client database', config: {}, secrets: ['CLIENTS_URL'] }], bindings: [] }, null, 2) + '\n');
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'team']);
  const env = { AGENT_TEAM_HOME: home };
  const { log } = context(env, root);
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(log, JSON.stringify({ id: 'e2e-1', at: new Date().toISOString(), role: 'docs-keeper', kind: 'status', status: 'working', task: 'Index the signed contracts', branch: 'docs/contracts-index' }) + '\n');
  studio = createStudio({ root, env });
  await new Promise((r) => studio.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${studio.address().port}`;
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});
after(async () => { await browser?.close(); studio?.closeAllConnections?.(); studio?.close(); });

const owns = async (page) => /## Owns \(writes\)\n([\s\S]*?)(\n## |$)/.exec(await page.locator('#e-raw').inputValue())?.[1] ?? '';

test('a clashing area is held until one of three choices, and moving an area in flight asks twice', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/?t=${studio.launchToken}`);
  await page.locator('.lib-role').first().waitFor();
  await page.getByRole('button', { name: 'New agent' }).click();
  const dlg = page.locator('#agent-dialog');
  await dlg.locator('#a-name').fill('Contract reviewer');
  await dlg.locator('#a-manager').selectOption('chief-of-staff');
  await dlg.getByRole('button', { name: 'Continue to the brief' }).click();
  const ed = page.locator('#agent-editor');
  const area = ed.getByLabel('Area to add');
  const box = ed.locator('.conflict');

  // 1. Read only: the area is held, not written, and then becomes a "reads" line that says where fixes go.
  await area.fill('contracts/templates/');
  await area.press('Enter');
  await box.getByText('Docs keeper already writes contracts/').waitFor();
  assert.doesNotMatch(await owns(page), /contracts/, 'never two writers, even for a moment');
  await box.getByRole('button', { name: /^Read only, send fixes to Docs keeper as BUG$/ }).click();
  assert.match(await owns(page), /^- reads `contracts\/templates\/` \(fixes go to docs-keeper as BUG\)$/m);
  assert.equal(await box.count(), 0);
  // Making it "writes" again is held the same way.
  await ed.getByLabel('What it does with contracts/templates/').selectOption('writes');
  await box.getByText('Docs keeper already writes contracts/').waitFor();
  assert.match(await owns(page), /^- reads `contracts\/templates\/`/m, 'the row stays "reads" while the clash is open');
  await box.getByRole('button', { name: 'Cancel' }).click();
  assert.equal(await box.count(), 0);
  assert.match(await owns(page), /^- reads `contracts\/templates\/` \(fixes go to docs-keeper as BUG\)$/m, 'Cancel loses nothing');

  // 2. A narrower area, checked again: one inside the other writer's area is refused, one beside it is taken.
  await area.fill('reports/');
  await area.press('Enter');
  await box.getByText('Product manager already writes reports/finance/').waitFor();
  await box.getByRole('button', { name: 'Take a narrower area' }).click();
  const narrower = box.getByLabel(/A narrower area/);
  await narrower.fill('reports/finance/q1/');
  await box.getByRole('button', { name: 'Take this area' }).click();
  await box.getByText('still overlaps reports/finance/').waitFor();
  assert.doesNotMatch(await owns(page), /reports/);
  await narrower.fill('reports/legal/');
  await narrower.press('Enter');
  assert.match(await owns(page), /^- `reports\/legal\/`$/m);
  assert.doesNotMatch(await owns(page), /Nothing yet/, 'an emptied list does not leave its placeholder behind');
  assert.equal(await box.count(), 0);

  // A move of an area typed inside the writer's: the agent gets the writer's whole area, so the table and brief agree.
  await area.fill('reports/finance/q2/');
  await area.press('Enter');
  await box.getByRole('button', { name: 'Move the whole area to this agent…' }).click();
  await box.waitFor({ state: 'detached' }); // the product manager is not working on it, so one click moves it
  assert.match(await owns(page), /^- `reports\/finance\/`$/m);
  assert.doesNotMatch(await owns(page), /reports\/finance\/q2/);

  // 3. Move the whole area: the docs keeper is working on it now, so the first click says so and a second one moves it.
  await area.fill('contracts/');
  await area.press('Enter');
  await box.getByRole('button', { name: 'Move the whole area to this agent…' }).click();
  await box.getByText('is working now on "Index the signed contracts", branch docs/contracts-index').waitFor();
  assert.doesNotMatch(await owns(page), /^- `contracts\/`/m, 'the first click moves nothing');
  if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await ed.locator('#sec-owns').scrollIntoViewIfNeeded(); await page.screenshot({ path: join(SHOTS, 'agent-editor-conflict.png') }); }
  await box.getByRole('button', { name: 'Move it anyway' }).click();
  assert.match(await owns(page), /^- `contracts\/`$/m);
  assert.doesNotMatch(await owns(page), /contracts\/templates/, 'a reads line inside an area it now writes is folded in');
  assert.equal(await box.count(), 0);
  await ed.locator('#e-checks li.pass', { hasText: 'Every area has one writer' }).waitFor();
  // The ownership table follows: the area's writer is now this agent, and undo puts it back in one step.
  await page.getByRole('button', { name: 'Back to the team' }).click();
  await page.locator('#undo').click();
  await page.locator('#library .lib-role', { hasText: 'Contract reviewer' }).locator('.name').click();
  assert.doesNotMatch(await owns(page), /^- `contracts\/`$/m);

  assert.deepEqual(errors, []);
  await page.close();
});

test('a pack says what it needs: each system is asked for, bound only on Connect, and its areas go through the same choices', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/?t=${studio.launchToken}`);
  await page.locator('.lib-role').first().waitFor();
  await page.getByRole('button', { name: 'New agent' }).click();
  const dlg = page.locator('#agent-dialog');
  const md = '# Archivist\n\n**Model:** routine\n**Group:** legal\n**Reports to:** chief-of-staff\n**Status:** active\n\n## Identity\nYou keep every signed contract findable.\n\n## Owns (writes)\n- `contracts/`\n\n## Wakes on\n- handoff\n';
  const file = (name, text) => ({ name, mimeType: name.endsWith('.json') ? 'application/json' : 'text/markdown', buffer: Buffer.from(text) });
  await dlg.locator('#a-files').setInputFiles([
    file('pack.json', JSON.stringify({ schema: 'agent-team/role-pack@1', roles: ['archivist'], needs: { resources: ['database', 'mailbox'], paths: ['contracts/'] } })),
    file('archivist.md', md),
  ]);
  await page.waitForFunction(() => document.querySelector('#a-name').value === 'Archivist');
  await dlg.getByRole('button', { name: 'Add it, switched off' }).click();
  const ed = page.locator('#agent-editor');

  // Asked, not bound: the database the team has can be connected; the mailbox it has not set up can only be skipped.
  const db = ed.locator('.need', { hasText: 'Needs a database' });
  await db.waitFor();
  assert.doesNotMatch(await ed.locator('.ed-systems').textContent(), /Client database/, 'nothing is bound before Connect');
  if (SHOTS) { await ed.locator('#sec-tools').scrollIntoViewIfNeeded(); await page.screenshot({ path: join(SHOTS, 'agent-editor-pack-needs-before-connect.png') }); }
  const mail = ed.locator('.need', { hasText: 'Needs a mailbox' });
  await mail.getByText('This team has no mailbox set up yet').waitFor();
  await mail.getByRole('button', { name: 'Skip' }).click();
  await mail.waitFor({ state: 'detached' });
  await db.getByLabel('Permission for the database').selectOption('write');
  await db.getByRole('button', { name: 'Connect' }).click();
  await db.waitFor({ state: 'detached' });
  await ed.locator('.ed-systems', { hasText: 'Client database' }).waitFor();
  if (SHOTS) { await ed.locator('#sec-tools').scrollIntoViewIfNeeded(); await page.screenshot({ path: join(SHOTS, 'agent-editor-pack-needs-connected.png') }); }

  // Its area is one the docs keeper writes: the same three choices, on the row.
  const box = ed.locator('.conflict');
  await box.getByText('Docs keeper already writes contracts/').waitFor();
  await box.getByRole('button', { name: /^Read only/ }).click();
  assert.match(await page.locator('#e-raw').inputValue(), /^- reads `contracts\/` \(fixes go to docs-keeper as BUG\)$/m);
  assert.equal(await box.count(), 0);

  assert.deepEqual(errors, []);
  await page.close();
});
