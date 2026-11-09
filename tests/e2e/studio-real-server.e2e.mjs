// The Studio's chat in a real browser against the real control plane (apps/server, PGlite in memory), not the
// stand-in: chat, a decision card, an approval with step-up, a stale card, the daily cap with step-up, the budget card
// when the cap is spent, and resume. Only the roles are simulated, by writing what their tools would (m3.createCard,
// m3.requestApproval, usage.recorded events): there is no runner yet, so starting a run waits for part 2b.
//
//   npm ci --prefix apps/server && node --test tests/e2e/studio-real-server.e2e.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { KIT } from '../../bin/agent-team.mjs';
import { createStudio } from '../../apps/studio/server.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { /* reported by the skip below */ }
const serverDeps = existsSync(join(KIT, 'apps/server/node_modules/@electric-sql/pglite'));
if (process.env.CI && (!chromium || !serverDeps)) throw new Error('CI is set but playwright or the control plane\'s dependencies (npm ci --prefix apps/server) are missing');
const skip = (!chromium && 'the playwright package is not installed') || (!serverDeps && 'run npm ci --prefix apps/server first');
const SHOTS = process.env.SCREENSHOTS;

const ADMIN = 'adm_e2e';
const SECRET = 'a long step-up secret for the browser test';
const TEAM = 'sample-app';
let db, plane, studio, base, browser, m3;

before(async () => {
  if (skip) return;
  const { openDb } = await import('../../apps/server/db.mjs');
  const { masterKey } = await import('../../apps/server/vault.mjs');
  const store = await import('../../apps/server/store.mjs');
  const { createControlPlane } = await import('../../apps/server/server.mjs');
  const { hashStepUpSecret, stepUpVerifier } = await import('../../apps/server/m3.mjs');
  db = await openDb();
  await store.ensureTenant(db, 'acme');
  plane = createControlPlane({ db, key: masterKey(randomBytes(32).toString('base64')), tenant: 'acme', adminToken: ADMIN, stepUpVerifier: stepUpVerifier(await hashStepUpSecret(SECRET)), pollMs: 100 });
  await new Promise((r) => plane.listen(0, '127.0.0.1', r));
  m3 = plane.m3;
  const cp = `http://127.0.0.1:${plane.address().port}`;
  const auth = { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' };
  assert.equal((await fetch(`${cp}/v1/teams`, { method: 'POST', headers: auth, body: JSON.stringify({ id: TEAM }) })).status, 201);

  const root = mkdtempSync(join(tmpdir(), 'studio-real-'));
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync(process.execPath, [join(KIT, 'bin/agent-team.mjs'), 'init', '--preset', 'minimal', '--project', 'Sample app', '--dir', root], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'team']);
  // Published and pushed: a run is pinned to a commit its remote has.
  const bare = mkdtempSync(join(tmpdir(), 'studio-e2e-origin-'));
  execFileSync('git', ['init', '-q', '--bare', bare]);
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', bare]);
  execFileSync('git', ['-C', root, 'push', '-q', '-u', 'origin', 'HEAD:refs/heads/main']);
  execFileSync('git', ['-C', root, 'branch', '-q', '--set-upstream-to=origin/main']);
  studio = createStudio({ root, env: { AGENT_TEAM_SERVER: cp, AGENT_TEAM_SERVER_TOKEN: ADMIN, AGENT_TEAM_SERVER_TEAM: TEAM } });
  await new Promise((r) => studio.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${studio.address().port}`;
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
after(async () => { await browser?.close(); studio?.closeAllConnections?.(); studio?.close(); plane?.runners?.closeAll(); plane?.closeAllConnections?.(); plane?.close(); await db?.close(); });

/** What a role's tool calls would write. */
const role = {
  say: (text) => m3.tx('acme', (ctx) => ctx.emit(TEAM, 'chat.message', { from: { kind: 'role', id: 'chief-of-staff' }, text }, { actor: { kind: 'role', id: 'chief-of-staff', via: 'tool' }, subject: 'chat' })),
  decide: (card) => m3.tx('acme', (ctx) => m3.createCard(ctx, TEAM, { kind: 'decision', ...card })),
  approval: (a) => m3.tx('acme', (ctx) => m3.requestApproval(ctx, TEAM, a)),
  spend: (cost, n) => m3.appendEvents('acme', TEAM, [{ specversion: '1.0', id: `ev_e2e_usage_${n}`, type: 'usage.recorded', version: 1, source: `/tenants/acme/teams/${TEAM}`, tenant: 'acme', team: TEAM, time: new Date().toISOString(), actor: { kind: 'role', id: 'chief-of-staff', via: 'tool' }, data: { inputTokens: 1, outputTokens: 1, cost, currency: 'USD' } }]),
};

test('against the real control plane: chat, cards, an approval with step-up, a stale card, the daily cap and the budget card', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/?t=${studio.launchToken}`);
  await page.goto(`${base}/#chat`);
  await page.getByText('Ask the chief of staff for something').waitFor();
  await page.locator('#run-state', { hasText: 'Not running' }).waitFor();

  // The daily cap, set from the Start dialog: the first one needs step-up. Start itself waits for runner part 2b.
  await page.getByRole('button', { name: 'Start a run' }).click();
  const dlg = page.locator('#start-dialog');
  await dlg.getByText('chief-of-staff reports to the owner').waitFor();
  await dlg.getByLabel('Daily cap').fill('10');
  await dlg.getByRole('button', { name: 'Start', exact: true }).click();
  const su = page.locator('#stepup-dialog');
  await su.getByLabel('Confirmation code').fill(SECRET);
  await su.getByRole('button', { name: 'Use passkey' }).click();
  // The real server starts the run (its roster check passes on the published team); no runner picks it up yet.
  await page.locator('#run-state', { hasText: 'Running' }).waitFor();
  await page.getByText('A run started').waitFor();
  await page.getByText('Today $0.00 of $10.00').waitFor();

  // The owner's words, verbatim, through the real chat endpoint; a reply as the chief of staff's tool would write it.
  const words = 'Add a dark mode toggle,\n  keep my *exact* words <b>please</b>';
  await page.getByLabel('Message the chief of staff').fill(words);
  await page.keyboard.press('Enter');
  await page.locator('.msg.me .verbatim').first().waitFor();
  assert.equal(await page.locator('.msg.me .verbatim').first().textContent(), words);
  await role.say('Got it. I routed it to the **CTO**.');
  await page.getByText('I routed it to the').waitFor();

  // A decision card (only card.updated on the real server), answered with its version; then a stale one.
  const { result: dec } = await role.decide({ subject: 'decision/theme', title: 'What should the default be?', body: 'Follow the device, or start light.', options: [{ id: 'system', label: 'Follow system' }, { id: 'light', label: 'Light' }], recommendation: { option: 'system', why: 'Matches what people chose.' } });
  const decision = page.locator(`.card-msg[data-card-id="${dec.id}"]`);
  await decision.getByRole('button', { name: 'Follow system' }).waitFor();
  await decision.getByRole('button', { name: 'Follow system' }).click();
  await decision.locator('.answer', { hasText: 'Follow system' }).waitFor();

  const { result: dec2 } = await role.decide({ subject: 'decision/name', title: 'Name the setting', options: [{ id: 'theme', label: 'Theme' }, { id: 'appearance', label: 'Appearance' }] });
  const second = page.locator(`.card-msg[data-card-id="${dec2.id}"]`);
  await second.getByRole('button', { name: 'Theme' }).waitFor();
  // Answered elsewhere before this page's answer arrives: the real 409 carries the card, which shows as answered.
  await m3.answerCard('acme', dec2.id, { option: 'appearance', version: 1 }, 'someone-else');
  await second.getByRole('button', { name: 'Theme' }).click({ timeout: 2000 }).catch(() => { /* the live refresh may win the race */ });
  await second.locator('.answer', { hasText: 'Appearance' }).waitFor();

  // An approval: approving needs step-up, which the card asks for inline.
  const sha = 'c0ffee1234567890abcdef1234567890abcdef12';
  const { result: apr } = await role.approval({ action: 'accept', call: { command: 'gh pr merge 12', pr: 12, headSha: sha }, why: 'QA signed off with evidence.', role: 'release-manager', risk: 'low', links: [{ rel: 'pr', url: 'https://example.com/pull/12' }] });
  const approval = page.locator(`.card-msg[data-card-id="${apr.card.id}"]`);
  // D1: the card is bound to the PR and its head commit; the short sha shows, the full one on tap.
  await approval.getByText('release-manager asks to merge #12 at c0ffee1').waitFor();
  await approval.locator('summary', { hasText: 'commit c0ffee1' }).click();
  await approval.locator('.bound .sha', { hasText: sha }).waitFor();
  await approval.getByRole('button', { name: 'Approve' }).click();
  await approval.getByLabel('Confirmation code').fill('not the secret');
  await approval.getByRole('button', { name: 'Use passkey' }).click();
  await approval.getByText("That didn't work").waitFor();
  await approval.getByLabel('Confirmation code').fill(SECRET);
  await approval.getByRole('button', { name: 'Use passkey' }).click();
  await approval.locator('.answer', { hasText: 'Approve' }).waitFor();

  // Spending the whole cap pauses the run and posts a budget card; "Add half again" needs step-up and resumes.
  await role.spend(1000, 1);
  await page.locator('#run-state', { hasText: 'Paused' }).waitFor();
  const budget = page.locator('.card-msg.k-budget');
  await budget.getByRole('button', { name: 'Add half again' }).waitFor();
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'real-server-desktop.png') });
  // Resume is refused while today's cap is spent, and says so.
  await page.locator('#run-pause', { hasText: 'Resume' }).click();
  // The real server's budget-exhausted type reaches the page through the Studio's relay, as a sentence (#162).
  await page.locator('.result.error', { hasText: "Today's budget is spent, so the run can't resume yet. Raise the cap for today to resume it now" }).waitFor();
  assert.equal(await page.getByText("today's budget is spent;").count(), 0, 'not the server\'s own wording');
  await budget.getByRole('button', { name: 'Add half again' }).click();
  await budget.getByLabel('Confirmation code').fill(SECRET);
  await budget.getByRole('button', { name: 'Use passkey' }).click();
  await budget.locator('.answer', { hasText: 'Add half again' }).waitFor();
  await page.locator('#run-state', { hasText: 'Running' }).waitFor();
  await page.getByText("Today's budget is spent, so the run can't resume").waitFor({ state: 'detached' }); // the refusal goes once the run is going

  assert.deepEqual(errors, []);
  await page.close();
});

test('Add a runner: a code after step-up, shown once, that registers a runner on the real control plane', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/?t=${studio.launchToken}`);
  await page.goto(`${base}/#chat`);
  await page.getByRole('button', { name: 'Add a runner…' }).click();
  const dlg = page.locator('#runner-dialog');
  await dlg.getByText('No runner is registered yet.').waitFor();
  await dlg.getByLabel('Name for the machine').fill("Dana's Mac mini");
  await dlg.getByRole('button', { name: 'Get a code' }).click();
  const su = page.locator('#stepup-dialog');
  await su.getByLabel('Confirmation code').fill(SECRET);
  await su.getByRole('button', { name: 'Use passkey' }).click();
  const code = (await dlg.getByLabel('Runner code').textContent()).trim();
  assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const cmd = await dlg.locator('#runner-cmd').textContent();
  assert.match(cmd, new RegExp(`^agent-team-runner register --server 'http://127\\.0\\.0\\.1:\\d+' --code ${code} --name 'Dana'\\\\''s Mac mini'$`));
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'runner-code.png') });

  // The code is what register sends: the real control plane trades it for a runner key, once.
  const cp = `http://127.0.0.1:${plane.address().port}`;
  const reg = await fetch(`${cp}/v1/runners`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: "Dana's Mac mini", capabilities: { sandboxes: ['process'], runtimes: ['agent-sdk'] } }) });
  assert.equal(reg.status, 201);
  assert.ok((await reg.json()).key);

  // Shown once: closing the dialog clears it, and opening it again lists the runner, not the code.
  await dlg.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Add a runner…' }).click();
  await dlg.getByText("Dana's Mac mini").waitFor();
  assert.equal(await dlg.getByLabel('Runner code').count(), 0);
  assert.equal(await dlg.getByRole('button', { name: 'Get a code' }).isVisible(), true);
  assert.deepEqual(errors, []);
  await page.close();
});
