// Publishing a systems change (L40) against the fake control plane: the Publish sheet shows "Widens access" for a
// binding raised from read to write, the publish commits it, then the Studio sends the published resources.json with
// PUT /v1/teams/{team}/systems behind a step-up scoped systems:<team>. A publish with no systems change sends nothing,
// and a Studio with no control plane says nothing about systems.
//
//   node --test tests/e2e/studio-publish-systems.e2e.mjs     # needs the playwright package and a Chromium
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KIT } from '../../bin/agent-team.mjs';
import { createStudio } from '../../apps/studio/server.mjs';
import { fakeControlPlane } from '../fixtures/fake-control-plane.mjs';
import { selectTeammate } from './team-page.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { /* reported by the skip below */ }
if (!chromium && process.env.CI) throw new Error('CI is set but the playwright package is not installed');
const skip = !chromium && 'the playwright package is not installed';

const ROLE = 'chief-of-staff';
let cp, studio, base, browser, plain, plainBase;

function repo(name) {
  const root = mkdtempSync(join(tmpdir(), `studio-systems-${name}-`));
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Studio test']);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'studio-test@example.com']);
  execFileSync(process.execPath, [join(KIT, 'bin/agent-team.mjs'), 'init', '--preset', 'minimal', '--project', 'Sample app', '--dir', root], { stdio: 'ignore' });
  // One system, already connected read-only to the chief of staff, and published.
  writeFileSync(join(root, '.agent-team/resources.json'), JSON.stringify({ resources: [{ id: 'drive', type: 'mcp', name: 'Shared drive', config: {}, secrets: ['DRIVE_TOKEN'] }], bindings: [{ role: ROLE, resource: 'drive', permission: 'read' }] }, null, 2) + '\n');
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'team']);
  return root;
}

before(async () => {
  if (skip) return;
  cp = await fakeControlPlane({ team: 'sample-app' });
  studio = createStudio({ root: repo('cp'), env: cp.env });
  await new Promise((r) => studio.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${studio.address().port}`;
  plain = createStudio({ root: repo('plain'), env: { AGENT_TEAM_HOME: mkdtempSync(join(tmpdir(), 'studio-systems-home-')) } });
  await new Promise((r) => plain.listen(0, '127.0.0.1', r));
  plainBase = `http://127.0.0.1:${plain.address().port}`;
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});
after(async () => { await browser?.close(); for (const s of [studio, plain]) { s?.closeAllConnections?.(); s?.close(); } cp?.close(); });

const sheet = (page) => page.locator('#publish-dialog');

/** Raises the chief of staff's drive from read to write, then opens the Publish sheet. */
async function widenAndOpen(page, at) {
  await page.goto(at);
  await page.locator(`#canvas [data-node="${ROLE}"]`).waitFor();
  await selectTeammate(page, ROLE);
  await page.locator(`select[data-binding="${ROLE}|drive"]`).selectOption('write');
  await page.locator('#publish').click();
}

test('a widened binding: Widens access, the publish, a step-up scoped to the team, and the systems sent', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await widenAndOpen(page, `${base}/?t=${studio.launchToken}`);
  await sheet(page).locator('#widens', { hasText: /^Widens access/ }).waitFor();
  assert.match(await sheet(page).locator('#widens').textContent(), /Shared drive/);
  await page.locator('#confirm').click();

  // The control plane asks for a step-up scoped systems:sample-app; the dialog says what it covers.
  const dlg = page.locator('#live-stepup');
  await dlg.locator('.why', { hasText: 'Change what the team can reach' }).waitFor();
  assert.equal(cp.systemsPuts.length, 0, 'nothing is set before the step-up');
  await dlg.getByLabel('Confirmation code').fill(cp.stepUpSecret);
  await dlg.getByRole('button', { name: 'Use passkey' }).click();
  await page.locator('#publish-result .systems-result', { hasText: 'OrgCraft now has the new systems' }).waitFor();
  assert.equal(cp.systemsPuts.length, 1);
  assert.deepEqual(cp.systems.bindings, [{ role: ROLE, resource: 'drive', permission: 'write' }], 'what was published, not the draft');
  assert.deepEqual(cp.systems.resources.map((r) => [r.id, r.secrets]), [['drive', ['DRIVE_TOKEN']]]);

  // In sync now, by content.
  const sync = await page.evaluate(async () => (await fetch('/v1/team/systems')).json());
  assert.equal(sync.inSync, true);
  assert.deepEqual(errors, []);
  await page.close();
});

test('cancelling the step-up: the team is published, the systems are not, and Send the systems tries again', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${base}/?t=${studio.launchToken}`);
  await page.locator(`#canvas [data-node="${ROLE}"]`).waitFor();
  await selectTeammate(page, ROLE);
  await page.locator(`select[data-binding="${ROLE}|drive"]`).selectOption('deploy');
  await page.locator('#publish').click();
  await page.locator('#confirm').click();
  await page.locator('#live-stepup .why', { hasText: 'Change what the team can reach' }).waitFor();
  await page.keyboard.press('Escape');
  const line = page.locator('#publish-result .systems-result', { hasText: "the new systems weren't sent" });
  await line.waitFor();
  const before = cp.systemsPuts.length;
  await line.getByRole('button', { name: 'Send the systems' }).click();
  const dlg = page.locator('#live-stepup');
  await dlg.getByLabel('Confirmation code').fill(cp.stepUpSecret);
  await dlg.getByRole('button', { name: 'Use passkey' }).click();
  await page.locator('#publish-result .systems-result', { hasText: 'OrgCraft now has the new systems' }).waitFor();
  assert.equal(cp.systemsPuts.length, before + 1);
  assert.equal(cp.systems.bindings[0].permission, 'deploy');
  await page.close();
});

test('no systems change sends nothing; no control plane says nothing about systems', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${base}/?t=${studio.launchToken}`);
  await page.locator(`#canvas [data-node="${ROLE}"]`).waitFor();
  const before = cp.systemsPuts.length;
  // A change that is not a system: the chief of staff's name.
  await selectTeammate(page, ROLE);
  await page.locator('#i-name').fill('Chief of staff Ada');
  await page.locator('#i-name').press('Tab');
  await page.locator('#publish').click();
  await page.locator('#confirm').click();
  await page.locator('#publish-result', { hasText: /^Saved/ }).waitFor();
  assert.equal(await page.locator('#live-stepup').isVisible(), false);
  assert.equal(await page.locator('#publish-result .systems-result').count(), 0);
  assert.equal(cp.systemsPuts.length, before);

  await widenAndOpen(page, `${plainBase}/?t=${plain.launchToken}`);
  await page.locator('#confirm').click();
  await page.locator('#publish-result', { hasText: /^Saved/ }).waitFor();
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#live-stepup').isVisible(), false);
  assert.equal(await page.locator('#publish-result .systems-result').count(), 0, 'no control plane: the repository is where systems live');
  await page.close();
});
