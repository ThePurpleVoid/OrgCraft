// Systems in PR mode (L40b web half) against the fake control plane: a publish that opens a change for approval sends
// its systems as a pending set bound to the commit; the start plan says they wait; once the code host reports the change
// accepted, "Switch on now" applies them behind a systems step-up whose dialog lists what changes; a set changed by
// someone else after it was shown is refused; a dropped set says why in the chat.
//
//   node --test tests/e2e/studio-pending-systems.e2e.mjs     # needs the playwright package and a Chromium
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

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { /* reported by the skip below */ }
if (!chromium && process.env.CI) throw new Error('CI is set but the playwright package is not installed');
const skip = !chromium && 'the playwright package is not installed';

const ROLE = 'chief-of-staff';
let cp, studio, base, browser, root;
before(async () => {
  if (skip) return;
  root = mkdtempSync(join(tmpdir(), 'studio-pending-'));
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Studio test']);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'studio-test@example.com']);
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'git@github.com:example/sample-app.git']);
  execFileSync(process.execPath, [join(KIT, 'bin/agent-team.mjs'), 'init', '--preset', 'minimal', '--project', 'Sample app', '--dir', root], { stdio: 'ignore' });
  writeFileSync(join(root, '.agent-team/resources.json'), JSON.stringify({ resources: [{ id: 'drive', type: 'mcp', name: 'Shared drive', config: {}, secrets: ['DRIVE_TOKEN'] }], bindings: [{ role: ROLE, resource: 'drive', permission: 'read' }] }, null, 2) + '\n');
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'team']);
  cp = await fakeControlPlane({ team: 'sample-app', running: false });
  studio = createStudio({ root, env: cp.env });
  await new Promise((r) => studio.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${studio.address().port}`;
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});
after(async () => { await browser?.close(); studio?.closeAllConnections?.(); studio?.close(); cp?.close(); });

const post = (page, path, body) => page.evaluate(async ([p, b]) => { const r = await fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, ...(await r.json()) }; }, [path, body]);
const state = (page) => page.evaluate(async () => (await fetch('/v1/team/systems')).json());

/** What a PR-mode publish sends: the HEAD commit's systems as a pending set, after the systems step-up. */
async function sendPending(page, pr = 7) {
  const s = await state(page);
  const ask = await post(page, '/v1/team/systems', { version: s.version, hash: s.hash, pending: true, pr });
  assert.equal(ask.status, 401);
  assert.equal((await post(page, '/v1/team/step-up', { secret: cp.stepUpSecret, scope: ask.scope })).status, 200);
  const r = await post(page, '/v1/team/systems', { version: s.version, hash: s.hash, pending: true, pr });
  assert.equal(r.status, 200);
  return r;
}

async function openStart(page) {
  await page.goto(`${base}/#chat`);
  await page.getByRole('button', { name: 'Start the team' }).click();
  return page.locator('#start-dialog #start-systems');
}

test('a pending set waits, the code host reports it accepted, and Switch on now applies it after the passkey', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/?t=${studio.launchToken}`);
  await sendPending(page);
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.deepEqual(cp.systemsPuts.at(-1).pending, { sha: head, pr: 7 }, 'bound to the commit the change carries');
  assert.equal(cp.systems.version, 0, 'nothing switched on yet');

  const s = await state(page);
  assert.equal(s.pending.ours, true);
  assert.equal(s.pending.ready, false);
  let line = await openStart(page);
  await line.getByText('The system changes wait until this change is approved. Then you switch them on.').waitFor();
  assert.equal(await line.getByRole('button').count(), 0, 'nothing to tap until the change is accepted');

  // The code host reports the change accepted: the chat says so, and the plan offers to switch it on.
  cp.readyPending();
  await page.reload();
  await page.locator('.timeline', { hasText: 'GitHub reports that the change was accepted. Its system changes are ready to switch on.' }).waitFor();
  line = await openStart(page);
  await line.getByText('GitHub reports that the change was accepted.').waitFor();
  await line.getByRole('button', { name: 'Switch on now' }).click();
  const dlg = page.locator('#stepup-dialog');
  await dlg.locator('#stepup-why', { hasText: 'Switch on the system changes from the accepted change' }).waitFor();
  const listed = await dlg.locator('.stepup-items li').allTextContents();
  assert.ok(listed.some((l) => /New system: Shared drive/.test(l)), listed.join(' | '));
  assert.doesNotMatch(listed.join(' '), /chief-of-staff|mcp/);
  await dlg.locator('#stepup-secret').fill(cp.stepUpSecret);
  await dlg.locator('button[type="submit"]').click();
  await line.getByText('Your systems are updated. Work that starts from now uses them.').waitFor();
  assert.deepEqual(cp.applied, [head]);
  assert.equal(cp.systems.bindings[0].permission, 'read');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'start-systems');
  assert.deepEqual(errors, []);
  await page.close();
});

test('a set changed after it was shown is refused with nothing spent; a dropped set says why', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${base}/?t=${studio.launchToken}`);
  // A widening on the PR branch, sent as pending, reported accepted.
  writeFileSync(join(root, '.agent-team/resources.json'), JSON.stringify({ resources: [{ id: 'drive', type: 'mcp', name: 'Shared drive', config: {}, secrets: ['DRIVE_TOKEN'] }], bindings: [{ role: ROLE, resource: 'drive', permission: 'write' }] }, null, 2) + '\n');
  execFileSync('git', ['-C', root, 'commit', '-qam', 'write']);
  await sendPending(page, 8);
  cp.readyPending();
  const line = await openStart(page);
  await line.getByRole('button', { name: 'Switch on now' }).waitFor();
  // Another admin re-confirms the same commit with other content after this page read it.
  cp.pending.contentHash = 'e'.repeat(64);
  await line.getByRole('button', { name: 'Switch on now' }).click();
  await line.getByText('This changed since you were asked. Look again.').waitFor();
  assert.equal(await page.locator('#stepup-dialog').isVisible(), false, 'no passkey asked for a set that changed');
  assert.deepEqual(cp.applied.length, 1);

  // The change is closed without being approved: the set is dropped, and the chat says why.
  cp.dropPending('withdrawn');
  await page.goto(`${base}/#chat`);
  await page.locator('.timeline', { hasText: 'The system changes were dropped because the change was closed without being approved.' }).waitFor();
  await page.close();
});
