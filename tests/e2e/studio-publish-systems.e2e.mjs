// Publishing systems (L40) against the fake control plane. After a publish, the Studio compares the control plane's
// systems with the published resources.json and, when they differ, sends them with PUT /v1/teams/{team}/systems
// behind a step-up scoped systems:<team>. The passkey dialog lists what the control plane gains, including anything
// it was already behind on (security review sev2). The send carries the version and hash it was shown with. The
// run-start plan says when the systems aren't the published ones and offers Send now. A Studio with no control plane
// says nothing about systems.
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
  cp = await fakeControlPlane({ team: 'sample-app', running: false });
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

const items = (dlg) => dlg.locator('.stepup-items li').allTextContents();

test('the first send: the dialog lists all the control plane gains, then the systems are sent', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await widenAndOpen(page, `${base}/?t=${studio.launchToken}`);
  await sheet(page).locator('#widens', { hasText: /^Widens access/ }).waitFor();
  assert.match(await sheet(page).locator('#widens').textContent(), /Shared drive/);
  await page.locator('#confirm').click();

  // The control plane had nothing: the dialog lists the system itself as well as this publish's change.
  const dlg = page.locator('#live-stepup');
  await dlg.locator('.why', { hasText: 'Change which systems your team can use' }).waitFor();
  const listed = await items(dlg);
  assert.ok(listed.some((l) => /New system: Shared drive/.test(l)), listed.join(' | '));
  assert.ok(listed.some((l) => /Shared drive/.test(l) && /Change/.test(l) && !/New system/.test(l)), listed.join(' | '));
  assert.equal(cp.systemsPuts.length, 0, 'nothing is set before the step-up');
  await dlg.getByLabel('Confirmation code').fill(cp.stepUpSecret);
  await dlg.getByRole('button', { name: 'Use passkey' }).click();
  await page.locator('#publish-result .systems-result', { hasText: 'Your systems are updated' }).waitFor();
  assert.equal(cp.systemsPuts.length, 1);
  assert.equal(cp.systemsPuts[0].expect, 0, 'sent against the version it was compared with');
  assert.deepEqual(cp.systems.bindings, [{ role: ROLE, resource: 'drive', permission: 'write' }], 'what was published, not the draft');
  assert.deepEqual(cp.systems.resources.map((r) => [r.id, r.secrets]), [['drive', ['DRIVE_TOKEN']]]);

  const sync = await page.evaluate(async () => (await fetch('/v1/team/systems')).json());
  assert.equal(sync.inSync, true);
  assert.deepEqual(sync.items, []);
  // A send must carry what it was shown: a hash that HEAD no longer has, or a version the control plane moved past.
  const moved = await page.evaluate(async (v) => (await fetch('/v1/team/systems', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: v, hash: 'not-this' }) })).json(), sync.version);
  assert.equal(moved.type, 'systems-moved');
  const stale = await page.evaluate(async (h) => { const r = await fetch('/v1/team/systems', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 0, hash: h }) }); return r.status; }, sync.hash);
  assert.equal(stale, 409);
  assert.equal(cp.systemsPuts.length, 1);

  // A step-up given, then a refusal before the send (HEAD moved): the step-up is dropped, so the next set asks again.
  const post = (path, body) => page.evaluate(async ([p, b]) => { const r = await fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, ...(await r.json()) }; }, [path, body]);
  assert.equal((await post('/v1/team/step-up', { secret: cp.stepUpSecret, scope: 'systems:sample-app' })).status, 200);
  assert.equal((await post('/v1/team/systems', { version: sync.version, hash: 'not-this' })).type, 'systems-moved');
  cp.setSystems({ resources: cp.systems.resources, bindings: [] });
  const next = await page.evaluate(async () => (await fetch('/v1/team/systems')).json());
  const again = await post('/v1/team/systems', { version: next.version, hash: next.hash });
  assert.equal(again.status, 401, 'the held step-up did not survive the refusal');
  assert.match(again.type, /step-up-required$/);
  assert.equal(cp.systemsPuts.length, 1);
  assert.deepEqual(errors, []);
  await page.close();
});

test('cancelling the step-up: the team is published, the systems are not, and Send the system changes tries again', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${base}/?t=${studio.launchToken}`);
  await page.locator(`#canvas [data-node="${ROLE}"]`).waitFor();
  await selectTeammate(page, ROLE);
  await page.locator(`select[data-binding="${ROLE}|drive"]`).selectOption('deploy');
  await page.locator('#publish').click();
  await page.locator('#confirm').click();
  await page.locator('#live-stepup .why', { hasText: 'Change which systems your team can use' }).waitFor();
  await page.keyboard.press('Escape');
  const line = page.locator('#publish-result .systems-result', { hasText: "the system changes weren't sent" });
  await line.waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Send the system changes', 'focus is on the retry, not the page');
  const before = cp.systemsPuts.length;
  await line.getByRole('button', { name: 'Send the system changes' }).click();
  const dlg = page.locator('#live-stepup');
  await dlg.getByLabel('Confirmation code').fill(cp.stepUpSecret);
  await dlg.getByRole('button', { name: 'Use passkey' }).click();
  await page.locator('#publish-result .systems-result', { hasText: 'Your systems are updated' }).waitFor();
  assert.equal(cp.systemsPuts.length, before + 1);
  assert.equal(cp.systems.bindings[0].permission, 'deploy');
  await page.close();
});

test('the control plane behind HEAD: an unrelated publish lists the earlier widening; in sync, nothing is asked', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // As if an earlier send was cancelled, or a teammate's change arrived by pull: the control plane still has Read.
  cp.setSystems({ resources: cp.systems.resources, bindings: [{ role: ROLE, resource: 'drive', permission: 'read' }] });
  await page.goto(`${base}/?t=${studio.launchToken}`);
  await page.locator(`#canvas [data-node="${ROLE}"]`).waitFor();
  await selectTeammate(page, ROLE);
  await page.locator('#i-name').fill('Chief of staff Ada');
  await page.locator('#i-name').press('Tab');
  await page.locator('#publish').click();
  await page.locator('#confirm').click();
  const dlg = page.locator('#live-stepup');
  await dlg.locator('.why', { hasText: 'Change which systems your team can use' }).waitFor();
  const listed = await items(dlg);
  assert.equal(listed.length, 1, listed.join(' | '));
  assert.match(listed[0], /Shared drive/);
  assert.match(listed[0], /Read/);
  await dlg.getByLabel('Confirmation code').fill(cp.stepUpSecret);
  await dlg.getByRole('button', { name: 'Use passkey' }).click();
  await page.locator('#publish-result .systems-result', { hasText: 'Your systems are updated' }).waitFor();
  assert.equal(cp.systems.bindings[0].permission, 'deploy');

  // In sync: another unrelated publish asks nothing and says nothing about systems.
  const before = cp.systemsPuts.length;
  await sheet(page).getByRole('button', { name: 'Keep editing' }).click();
  await selectTeammate(page, ROLE);
  await page.locator('#i-name').fill('Chief of staff Bea');
  await page.locator('#i-name').press('Tab');
  await page.locator('#publish').click();
  await page.locator('#confirm').click();
  await page.locator('#publish-result', { hasText: /^Saved/ }).waitFor();
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#live-stepup').isVisible(), false);
  assert.equal(await page.locator('#publish-result .systems-result').count(), 0);
  assert.equal(cp.systemsPuts.length, before);
  await page.close();
});

test('the run-start plan: systems not the published ones, Send now, a cancel, then sent', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  cp.setSystems({ resources: cp.systems.resources, bindings: [] });
  await page.goto(`${base}/?t=${studio.launchToken}`);
  await page.goto(`${base}/#chat`);
  await page.getByRole('button', { name: 'Start the team' }).click();
  const start = page.locator('#start-dialog');
  const line = start.locator('#start-systems');
  await line.getByText("Your latest system changes haven't been sent yet").waitFor();
  await line.getByRole('button', { name: 'Send them now' }).click();
  const dlg = page.locator('#stepup-dialog');
  await dlg.locator('#stepup-why', { hasText: 'Change which systems your team can use' }).waitFor();
  const listed = await items(dlg);
  assert.equal(listed.length, 1);
  // People's words, never ids (qa-web L40 N1): the chat page has no team loaded, so the names come from the server.
  assert.match(listed[0], /Chief of staff/);
  assert.match(listed[0], /Shared drive/);
  assert.doesNotMatch(listed[0], /chief-of-staff|(?<!Shared )drive\b|mcp/);
  await dlg.getByRole('button', { name: /cancel/i }).click();
  await line.getByText("Your latest system changes haven't been sent yet").waitFor();
  const before = cp.systemsPuts.length;
  await line.getByRole('button', { name: 'Send them now' }).click();
  await dlg.locator('#stepup-secret').fill(cp.stepUpSecret);
  await dlg.locator('button[type="submit"]').click();
  await line.getByText('Your systems are updated').waitFor();
  assert.equal(cp.systemsPuts.length, before + 1);
  assert.equal(cp.systems.bindings.length, 1);
  await page.close();
});

test('a send that only takes access away says what it removes; the running header offers Send and Stop', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  // The control plane still has a system the published file dropped: nothing is gained, something is removed.
  const drive = cp.systems.resources.find((r) => r.id === 'drive');
  cp.setSystems({ resources: [drive, { id: 'wiki', type: 'mcp', name: 'Old wiki', secrets: [] }], bindings: [...cp.systems.bindings, { role: ROLE, resource: 'wiki', permission: 'read' }] });
  cp.runs.push({ id: 'run_systems', state: 'running', started: new Date().toISOString() });
  await page.goto(`${base}/?t=${studio.launchToken}`);
  await page.goto(`${base}/#chat`);
  const head = page.locator('#run-systems');
  await head.getByText('While the team is working, it keeps the systems it started with').waitFor();
  await head.getByText("Your changes take access away").waitFor();
  assert.equal(await head.getByRole('button', { name: 'Stop the team now' }).isVisible(), true);
  await head.getByRole('button', { name: 'Send them now' }).click();
  const dlg = page.locator('#stepup-dialog');
  await dlg.locator('#stepup-why', { hasText: 'Change which systems your team can use' }).waitFor();
  const listed = await items(dlg);
  assert.ok(listed.includes('Old wiki is removed'), listed.join(' | '));
  assert.doesNotMatch(listed.join(' '), /(?<!Old )wiki\b|chief-of-staff/);
  await dlg.locator('#stepup-secret').fill(cp.stepUpSecret);
  await dlg.locator('button[type="submit"]').click();
  await head.getByText('Sent. The team uses them the next time it starts.').waitFor();
  assert.deepEqual(cp.systems.resources.map((r) => r.id), ['drive']);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'run-systems');
  cp.runs.find((r) => r.id === 'run_systems').state = 'stopped';
  await page.close();
});

test('no control plane says nothing about systems', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await widenAndOpen(page, `${plainBase}/?t=${plain.launchToken}`);
  await page.locator('#confirm').click();
  await page.locator('#publish-result', { hasText: /^Saved/ }).waitFor();
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#live-stepup').isVisible(), false);
  assert.equal(await page.locator('#publish-result .systems-result').count(), 0, 'no control plane: the repository is where systems live');
  await page.close();
});
