// Systems in PR mode (L40b web half) against the fake control plane: a publish that opens a change for approval sends
// its systems as a pending set bound to the commit; the start plan says they wait; once the code host reports the change
// accepted, "Switch on now" applies them behind a systems step-up whose dialog lists what changes; a set changed by
// someone else after it was shown is refused; a dropped set says why in the chat.
//
//   node --test tests/e2e/studio-pending-systems.e2e.mjs     # needs the playwright package and a Chromium
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
let cp, studio, base, browser, root, ghOut;
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
  // A stand-in for gh: "pr view" prints what the test put in ghOut; with none it answers as gh does when no change is
  // open; ghOut holding "broken" is a gh that can't be read (signed out, offline).
  const bin = mkdtempSync(join(tmpdir(), 'studio-pending-gh-'));
  ghOut = join(bin, 'pr.json');
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\n[ "$1 $2" = "pr view" ] || exit 1\n[ -f '${ghOut}' ] || { echo 'no pull requests found for branch' >&2; exit 1; }\ngrep -q broken '${ghOut}' && { echo 'gh: not logged in' >&2; exit 4; }\ncat '${ghOut}'\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  studio = createStudio({ root, env: { ...cp.env, AGENT_TEAM_GH: join(bin, 'gh') } });
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
  await line.getByText('The system changes are waiting for the change to be approved.').waitFor();
  assert.equal(await line.getByRole('link', { name: 'See the change' }).getAttribute('href'), 'https://github.com/example/sample-app/pull/7');
  assert.match(await line.locator('button.info').getAttribute('data-tip'), /^This team was published as a change for review \(see the change\)\./);
  assert.equal(await line.getByRole('button', { name: 'Switch on now' }).count(), 0, 'nothing to switch on until the change is accepted');

  // The code host reports the change accepted: the chat says so, and the plan offers to switch it on.
  cp.readyPending();
  await page.reload();
  await page.locator('.timeline', { hasText: 'Your team\'s checks say the change was accepted. OrgCraft hasn\'t confirmed this itself. Its system changes are ready to switch on.' }).waitFor();
  line = await openStart(page);
  await line.getByText("Your team's checks say the change was accepted.", { exact: false }).waitFor();
  assert.match(await line.locator('button.info').getAttribute('data-tip'), /not from your code host/, 'the tooltip says who reported it');
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

test('Send them now from a pushed branch waits (open PR with its number; none, closed or unreadable without); a purely local branch sends directly', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/?t=${studio.launchToken}`);
  // A widening (deploy) on a pushed branch with an open pull request (#12).
  execFileSync('git', ['-C', root, 'checkout', '-qb', 'more-drive']);
  writeFileSync(join(root, '.agent-team/resources.json'), JSON.stringify({ resources: [{ id: 'drive', type: 'mcp', name: 'Shared drive', config: {}, secrets: ['DRIVE_TOKEN'] }], bindings: [{ role: ROLE, resource: 'drive', permission: 'deploy' }] }, null, 2) + '\n');
  execFileSync('git', ['-C', root, 'commit', '-qam', 'admin']);
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', root, 'update-ref', 'refs/remotes/origin/more-drive', head]);
  execFileSync('git', ['-C', root, 'branch', '-q', '--set-upstream-to', 'origin/more-drive']);
  writeFileSync(ghOut, JSON.stringify({ number: 12, state: 'OPEN' }));
  const before = cp.systems.version;
  const line = await openStart(page);
  assert.match(await line.getByRole('button', { name: 'Send them now' }).getAttribute('data-tip'), /passkey confirms the list first/);
  await line.getByRole('button', { name: 'Send them now' }).click();
  const dlg = page.locator('#stepup-dialog');
  await dlg.locator('#stepup-secret').fill(cp.stepUpSecret);
  await dlg.locator('button[type="submit"]').click();
  await line.getByText('The system changes are waiting for the change to be approved.').waitFor();
  assert.deepEqual(cp.systemsPuts.at(-1).pending, { sha: head, pr: 12 }, 'stored as pending, bound to the commit');
  assert.equal(cp.systems.version, before, 'nothing switched on: an unreviewed widening does not apply');
  assert.notEqual(cp.systems.bindings[0]?.permission, 'deploy');

  // Any other pushed, non-default branch waits too, with no PR number: gh can't be read, no PR, or the PR is closed.
  for (const [why, gh] of [['gh unreadable', 'broken'], ['no PR', null], ['PR closed', JSON.stringify({ number: 12, state: 'CLOSED' })]]) {
    cp.dropPending('withdrawn');
    if (gh) writeFileSync(ghOut, gh); else rmSync(ghOut, { force: true });
    const s0 = await state(page);
    let r = await post(page, '/v1/team/systems', { version: s0.version, hash: s0.hash });
    if (r.status === 401) { assert.equal((await post(page, '/v1/team/step-up', { secret: cp.stepUpSecret, scope: r.scope })).status, 200); r = await post(page, '/v1/team/systems', { version: s0.version, hash: s0.hash }); }
    assert.equal(r.status, 200, why);
    assert.deepEqual(cp.systemsPuts.at(-1).pending, { sha: head }, `${why}: waits, with no PR number`);
    assert.equal(cp.systems.version, before, `${why}: nothing applied`);
  }
  // With no change open, the plan says to send it for review, and has no link to a change.
  await page.reload();
  const nochange = await openStart(page);
  await nochange.getByText('The system changes are waiting. Send your published change for review', { exact: false }).waitFor();
  assert.equal(await nochange.getByRole('link').count(), 0);
  assert.match(await nochange.locator('button.info').getAttribute('data-tip'), /no change is open for review yet/);
  await page.keyboard.press('Escape');

  // A detached HEAD waits too, with no PR number, so detaching can't skip review.
  cp.dropPending('withdrawn');
  execFileSync('git', ['-C', root, 'checkout', '-q', '--detach']);
  const sd = await state(page);
  let rd = await post(page, '/v1/team/systems', { version: sd.version, hash: sd.hash });
  if (rd.status === 401) { assert.equal((await post(page, '/v1/team/step-up', { secret: cp.stepUpSecret, scope: rd.scope })).status, 200); rd = await post(page, '/v1/team/systems', { version: sd.version, hash: sd.hash }); }
  assert.equal(rd.status, 200);
  assert.deepEqual(cp.systemsPuts.at(-1).pending, { sha: head }, 'detached: waits, with no PR number');
  assert.equal(cp.systems.version, before, 'detached: nothing applied');
  execFileSync('git', ['-C', root, 'checkout', '-q', 'more-drive']);

  // The same branch with no upstream: a purely local branch, so the send applies directly.
  cp.dropPending('withdrawn');
  rmSync(ghOut, { force: true });
  execFileSync('git', ['-C', root, 'branch', '-q', '--unset-upstream']);
  const s = await state(page);
  const ask = await post(page, '/v1/team/systems', { version: s.version, hash: s.hash });
  if (ask.status === 401) assert.equal((await post(page, '/v1/team/step-up', { secret: cp.stepUpSecret, scope: ask.scope })).status, 200);
  const r = ask.status === 401 ? await post(page, '/v1/team/systems', { version: s.version, hash: s.hash }) : ask;
  assert.equal(r.status, 200);
  assert.equal(cp.systemsPuts.at(-1).pending, undefined);
  assert.equal(cp.systems.bindings[0].permission, 'deploy');
  assert.deepEqual(errors, []);
  await page.close();
});

test('on a phone: Escape on the passkey goes back to Switch on now, which is 44px; switched on elsewhere reads as already on', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 360, height: 780 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/?t=${studio.launchToken}`);
  writeFileSync(join(root, '.agent-team/resources.json'), JSON.stringify({ resources: [{ id: 'drive', type: 'mcp', name: 'Shared drive', config: {}, secrets: ['DRIVE_TOKEN'] }], bindings: [{ role: ROLE, resource: 'drive', permission: 'read' }] }, null, 2) + '\n');
  execFileSync('git', ['-C', root, 'commit', '-qam', 'back to read']);
  await sendPending(page, 9);
  let line = await openStart(page);
  const link = line.getByRole('link', { name: 'See the change' });
  await link.waitFor();
  for (const el of [link, line.locator('button.info')]) assert.ok((await el.boundingBox()).height >= 44, 'tappable on a phone (qa-web P2)');
  cp.readyPending();
  await page.reload();
  line = await openStart(page);
  const on = line.getByRole('button', { name: 'Switch on now' });
  await on.waitFor();
  for (const el of [on, line.locator('button.info')]) assert.ok((await el.boundingBox()).height >= 44, 'tappable on a phone (qa-web P2)');
  await on.click();
  await page.locator('#stepup-dialog #stepup-why').waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.id === 'start-systems-switchon');

  // Another window switches the set on; this one then taps Switch on now.
  const s = await state(page);
  const other = await post(page, '/v1/team/systems/pending/apply', { sha: s.pending.sha, contentHash: s.pending.contentHash });
  if (other.status === 401) assert.equal((await post(page, '/v1/team/step-up', { secret: cp.stepUpSecret, scope: other.scope })).status, 200);
  assert.equal((await post(page, '/v1/team/systems/pending/apply', { sha: s.pending.sha, contentHash: s.pending.contentHash })).status, 200);
  const applied = cp.applied.length;
  await on.click();
  await line.getByText('These system changes are already switched on. Nothing else to do.').waitFor();
  assert.equal(cp.applied.length, applied, 'nothing applied twice');
  assert.deepEqual(errors, []);
  await page.close();
});
