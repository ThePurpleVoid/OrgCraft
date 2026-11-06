// The rollout view in a real browser (PRD 6.9 X7, demo step 17, CPO copy "Rollout view after a publish", D61 to D63,
// acceptance criteria 1 to 4): after a publish merges on the default branch, one line per role from the board
// reports since then. A role is on the new version only when a report after the merge names it; a role that reports
// no version is grey and outside n of m; a mid-task role names the choice made at publish; the empty and the
// waiting-for-merge states say so. Desktop and 360px.
//
//   node --test tests/e2e/studio-rollout.e2e.mjs
//   SCREENSHOTS=docs/product/screenshots/rollout node --test tests/e2e/studio-rollout.e2e.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { KIT } from '../../bin/agent-team.mjs';
import { createStudio } from '../../apps/studio/server.mjs';
import { changeUrl, localRollout, pendingOf } from '../../apps/studio/rollout.mjs';
import { choiceWords, rolloutHtml, sortRoles, stateLine, summaryLine, UNKNOWN_HINT } from '../../apps/studio/public/rollout.js';
import { context } from '../../tools/report.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { /* reported by the skip below */ }
if (!chromium && process.env.CI) throw new Error('CI is set but the playwright package is not installed');
const skip = !chromium && 'the playwright package is not installed';
const SHOTS = process.env.SCREENSHOTS;

const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A team on main, pushed to an origin whose HEAD is main. `publish` adds a second team commit (the publish) on top. */
function repo({ publish = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'studio-rollout-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Studio test'); git(root, 'config', 'user.email', 'studio-test@example.com'); git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'README.md'), '# Sample app\n');
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'start');
  const bare = mkdtempSync(join(tmpdir(), 'studio-rollout-origin-'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  git(root, 'remote', 'add', 'origin', bare);
  if (publish) {
    execFileSync(process.execPath, [join(KIT, 'bin/agent-team.mjs'), 'init', '--preset', 'minimal', '--project', 'Sample app', '--dir', root], { stdio: 'ignore' });
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'The team');
    // The publish: docs-keeper switched off, and the change step's plan for work in progress.
    rmSync(join(root, 'docs/team/roles/docs-keeper.md'));
    const tj = join(root, '.agent-team/team.json');
    writeFileSync(tj, readFileSync(tj, 'utf8').replace(/\n*$/, '\n\n'));
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'Publish the team (#7)\n\nWork in progress\n- Backend dev (backend-dev): working on #12 Invoices: hand the work off now, to web-dev.\n- Web dev (web-dev): working on #9 Search: let it finish its current task first.\n');
  }
  git(root, 'push', '-q', 'origin', 'main');
  git(root, 'remote', 'set-head', 'origin', 'main');
  return root;
}

function studio(root, reports) {
  const home = mkdtempSync(join(tmpdir(), 'studio-rollout-home-'));
  const env = { AGENT_TEAM_HOME: home };
  if (reports) {
    const { log } = context(env, root);
    mkdirSync(dirname(log), { recursive: true });
    writeFileSync(log, reports.map((r, i) => JSON.stringify({ id: `ro-${i}`, kind: 'status', ...r })).join('\n') + '\n');
  }
  return createStudio({ root, env });
}

let root, s1, s2, s3, version, browser;
before(async () => {
  root = repo();
  // Where the change is seen: GitHub, from origin. The credential in it never reaches the page.
  git(root, 'remote', 'set-url', 'origin', 'https://x-access-token:ghs_secret@github.com/acme/shop.git');
  version = git(root, 'rev-parse', 'HEAD');
  const old = git(root, 'rev-parse', 'HEAD~1');
  const soon = (min) => new Date(Date.now() + min * 60_000).toISOString(); // after the publish commit, whatever the clock
  s1 = studio(root, [
    { at: soon(1), role: 'qa-web', status: 'idle', task: '', team_version: version.slice(0, 12) },
    { at: soon(1), role: 'web-dev', status: 'working', issue: '9', task: 'Search', team_version: old.slice(0, 12) },
    { at: soon(1), role: 'backend-dev', status: 'working', issue: '12', task: 'Invoices', team_version: old.slice(0, 12) },
    { at: soon(1), role: 'architect', status: 'idle', task: '', team_version: old.slice(0, 12) },
    { at: soon(1), role: 'cto', status: 'idle', task: '' }, // an older kit: no version
    { at: new Date(Date.now() - 5 * 3600_000).toISOString(), role: 'release-manager', status: 'idle', task: '', team_version: old.slice(0, 12) },
  ]);
  s2 = studio(repo({ publish: false }), null);
  // Waiting for a merge: a team commit here that origin's main does not have yet.
  const waiting = repo();
  git(waiting, 'checkout', '-q', '-b', 'team/publish');
  const tj = join(waiting, '.agent-team/team.json');
  writeFileSync(tj, readFileSync(tj, 'utf8') + '\n');
  git(waiting, 'commit', '-qam', 'Publish the team');
  s3 = studio(waiting, null);
  if (skip) return;
  for (const s of [s1, s2, s3]) await new Promise((r) => s.listen(0, '127.0.0.1', r));
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
after(async () => { await browser?.close(); for (const s of [s1, s2, s3]) { s?.closeAllConnections?.(); s?.close(); } });

test('the copy: each state, the summary and the choice words (CPO D61 to D63)', () => {
  const now = Date.parse('2026-11-06T12:00:00Z');
  const t = (slug) => ({ 'web-dev': 'Web dev' })[slug] ?? slug;
  assert.deepEqual(stateLine({ state: 'moved', lastAt: '2026-11-06T11:50:00Z' }, { now }), { text: 'On the new version', tone: 'ok' });
  assert.deepEqual(stateLine({ state: 'next-task', lastAt: '2026-11-06T11:50:00Z' }, { now }), { text: 'Picks up the new version at its next task', tone: 'plain' }, 'the normal path: no amber (CPO)');
  assert.equal(stateLine({ state: 'finishing', task: 'Invoices', plan: { choice: 'handoff', to: 'web-dev' }, lastAt: '2026-11-06T11:50:00Z' }, { now, titleOf: t }).text, 'Finishing "Invoices" on the old version · handing off to Web dev');
  assert.equal(stateLine({ state: 'off-finishing', task: 'Docs', lastAt: '2026-11-06T11:50:00Z' }, { now }).text, 'Switched off · finishing "Docs" first');
  assert.deepEqual(stateLine({ state: 'off' }, { now }), { text: 'Off', tone: 'grey' });
  assert.deepEqual(stateLine({ state: 'unknown', lastAt: '2026-11-06T11:50:00Z' }, { now }), { text: 'Version not reported', tone: 'grey', hint: UNKNOWN_HINT });
  assert.deepEqual(stateLine({ state: 'no-report', lastAt: '2026-11-06T07:00:00Z' }, { now }), { text: 'No report since the publish · last heard 5 h ago', tone: 'grey' });
  assert.deepEqual(stateLine({ state: 'no-report' }, { now }), { text: 'No report since the publish', tone: 'grey' });
  assert.deepEqual(stateLine({ state: 'moved', lastAt: '2026-11-06T09:00:00Z' }, { now }), { text: 'On the new version · last heard 3 h ago', tone: 'grey' }, 'D14: quiet over 2 h is grey');
  assert.equal(choiceWords({ choice: 'finish' }), 'then switches over');
  assert.deepEqual(sortRoles([{ role: 'b', state: 'off' }, { role: 'z', state: 'moved' }, { role: 'a', state: 'moved' }, { role: 'y', state: 'unknown' }, { role: 'x', state: 'no-report' }, { role: 'w', state: 'next-task' }, { role: 'v', state: 'off-finishing' }, { role: 'u', state: 'finishing' }]).map((x) => x.role),
    ['u', 'v', 'w', 'x', 'y', 'a', 'z', 'b'], 'what needs a look first; by title inside a group');
  assert.equal(choiceWords({ choice: 'pause' }), 'paused');
  assert.equal(summaryLine({ moved: 1, of: 4, finishing: 2, offFinishing: 0, unknown: 1 }), '1 of 4 roles on the new version, 2 finishing work first · 1 not reporting a version');
  assert.equal(summaryLine({ moved: 3, of: 3, finishing: 0, unknown: 0, allMoved: true }), 'All 3 roles on the new version.');
  assert.match(rolloutHtml({ version: null, roles: [] }), /Nothing to roll out yet\. After you publish and the change merges, this shows which roles have picked it up\./);
  assert.match(rolloutHtml({ version: null, roles: [], pending: { version: 'abc1234' } }), /Waiting for the change to merge\. Roles keep running the version before it until it does\./);
  assert.match(rolloutHtml({ version: 'abc1234', name: 'abc1234, published 6 Nov', roles: [], summary: { moved: 0, of: 0 }, pending: { version: 'def5678' } }), /Roles keep running abc1234, published 6 Nov until it does\./);
  assert.match(rolloutHtml({ version: 'abc1234', name: 'abc1234, published 6 Nov', roles: [], summary: { moved: 0, of: 9, finishing: 0 }, pending: { version: 'def5678' } }), /0 of 9 roles on abc1234, published 6 Nov</, 'pending: the count names the merged version');
  assert.match(rolloutHtml({ version: 'abc1234', name: 'abc1234, published 6 Nov', roles: [], summary: { moved: 0, of: 9, finishing: 0 } }), /0 of 9 roles on the new version</);
  assert.ok(!rolloutHtml({ version: 'abc1234', name: '<b>x</b>', roles: [{ role: '<i>', state: 'off' }], summary: { moved: 0, of: 0 } }).includes('<b>x'), 'escaped');
});

test('the local data: the default branch says what merged, its message gives the plan, and a branch ahead of it is waiting', () => {
  const r = localRollout(root, { current: [] });
  assert.equal(r.version, version);
  assert.equal(r.pr, 7);
  assert.deepEqual(r.roles.find((x) => x.role === 'docs-keeper').state, 'off');
  assert.equal(r.pending, null);
  assert.equal(r.changeUrl, 'https://github.com/acme/shop/pull/7', 'the pull request, without the credential');
  assert.equal(changeUrl(repo({ publish: false }), { version }), null, 'not GitHub: no link');
  assert.equal(localRollout(repo({ publish: false }), { current: [] }).version, null, 'nothing merged yet');
  assert.equal(pendingOf(root), null, 'pendingOf agrees with localRollout');
  assert.equal(pendingOf('/nonexistent-dir'), null, 'no repository: nothing pending, no throw');
});

test('desktop: one line per role from the reports since the merge, n of m, and the plan (criteria 1 to 3)', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${s1.address().port}/?t=${s1.launchToken}`);
  await page.getByRole('button', { name: 'Rollout' }).click();
  const view = page.locator('#rollout-page');
  await view.getByRole('heading', { name: new RegExp(`^Rollout of ${version.slice(0, 7)}, published \\d+ \\w+ · see the change$`) }).waitFor();
  const line = (slug) => view.locator(`.ro-row[data-role="${slug}"] .ro-state`);
  // 10 roles counted: 11 published minus the one reporting no version; docs-keeper was switched off (outside the count).
  await view.getByText('1 of 9 roles on the new version, 2 finishing work first · 1 not reporting a version').waitFor();
  assert.equal(await line('qa-web').textContent(), 'On the new version');
  assert.deepEqual((await view.locator('.ro-row').evaluateAll((els) => els.map((e) => e.dataset.role))).slice(0, 4), ['backend-dev', 'web-dev', 'architect', 'chief-of-staff'], 'mid-task first, then idle, then no report');
  assert.equal(await view.locator('.ro-row').last().getAttribute('data-role'), 'docs-keeper', 'off last');
  const link = view.getByRole('link', { name: 'see the change' });
  assert.equal(await link.getAttribute('href'), 'https://github.com/acme/shop/pull/7');
  assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(await line('web-dev').textContent(), 'Finishing "Search" on the old version · then switches over');
  assert.equal(await line('backend-dev').textContent(), 'Finishing "Invoices" on the old version · handing off to Web dev');
  assert.equal(await line('architect').textContent(), 'Picks up the new version at its next task');
  assert.match(await line('cto').textContent(), /^Version not reported/);
  assert.match(await view.locator('.ro-row[data-role="cto"]').getAttribute('class'), /ro-grey/, 'D62: grey, not amber');
  assert.equal(await line('release-manager').textContent(), 'No report since the publish · last heard 5 h ago');
  assert.equal(await line('docs-keeper').textContent(), 'Off');
  assert.equal(await line('security-reviewer').textContent(), 'No report since the publish');
  await view.locator('.ro-row[data-role="cto"]').getByRole('button', { name: /^Why/ }).click();
  await view.getByText(UNKNOWN_HINT).waitFor();
  await view.getByText(/^Based on board reports; may be out of date\. Newest report /).waitFor();
  assert.equal(await page.locator('#publish').isVisible(), false, 'read-only (D63): no publish here');
  assert.equal(new URL(page.url()).hash, '#rollout');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'rollout-desktop.png'), fullPage: true });
  assert.deepEqual(errors, []);
  await page.close();
});

test('360px: the lines stack, nothing scrolls sideways; and the empty and waiting states (criterion 4)', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 360, height: 780 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${s1.address().port}/?t=${s1.launchToken}`);
  await page.goto(`http://127.0.0.1:${s1.address().port}/#rollout`);
  await page.locator('#rollout-page .ro-summary').waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll');
  const why = await page.locator('.ro-row[data-role="cto"] .ro-why').boundingBox();
  assert.ok(why.height >= 44, 'a 44px tap target');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'rollout-phone.png'), fullPage: true });

  await page.goto(`http://127.0.0.1:${s2.address().port}/?t=${s2.launchToken}`);
  await page.goto(`http://127.0.0.1:${s2.address().port}/#rollout`);
  // A repository with no team opens the gallery; the rollout needs a team first.
  await page.locator('#gallery-page').waitFor();

  await page.goto(`http://127.0.0.1:${s3.address().port}/?t=${s3.launchToken}`);
  await page.goto(`http://127.0.0.1:${s3.address().port}/#rollout`);
  await page.getByText(/^Waiting for the change to merge\. Roles keep running [0-9a-f]{7}, published \d+ \w+ until it does\. As of the last time the Studio checked the repository\.$/).waitFor();
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'rollout-waiting-phone.png') });
  assert.deepEqual(errors, []);
  await page.close();
});
