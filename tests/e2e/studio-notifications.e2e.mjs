// The Notifications page of a hosted Studio in a real browser (CPO story "email notifications", opt-in copy, D49):
// /teams/{team}/notifications signs the person in first, an address gets a code and is verified, the suggested kinds
// are ticked but nothing is saved until Save, switches save at once after that, and a code that is wrong or could not
// be sent says so. Against the stub issuer, whose emails API follows apps/server (kit #101). Desktop and 360px.
//
//   node --test tests/e2e/studio-notifications.e2e.mjs
//   SCREENSHOTS=docs/product/screenshots/notifications node --test tests/e2e/studio-notifications.e2e.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { stubIssuer } from '../fixtures/stub-issuer.mjs';
import { emailsHtml, shownKinds, teamFromPath } from '../../apps/studio/public/notifications.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { /* reported by the skip below */ }
if (!chromium && process.env.CI) throw new Error('CI is set but the playwright package is not installed');
const skip = !chromium && 'the playwright package is not installed';
const SHOTS = process.env.SCREENSHOTS;

let iss, browser;
before(async () => {
  if (skip) return;
  iss = await stubIssuer();
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
after(async () => { await browser?.close(); iss?.close(); });

test('the team comes from the path, and nothing else passes', () => {
  assert.equal(teamFromPath('/teams/sample-app/notifications'), 'sample-app');
  assert.equal(teamFromPath('/teams/sample-app/notifications/'), 'sample-app');
  for (const p of ['/teams//notifications', '/teams/a%2Fb/notifications', '/teams/x/inbox', '/notifications', '/teams/%E0%A4%A/notifications']) assert.equal(teamFromPath(p), null, p);
});

test('suggested kinds show only until something is saved, and never after every kind is switched off', () => {
  const kinds = [{ id: 'approval', suggested: true }, { id: 'budget80' }, { id: 'budget100', suggested: true }];
  assert.deepEqual([...shownKinds({ kinds: [] }, kinds)], ['approval', 'budget100']);
  assert.deepEqual([...shownKinds({ kinds: ['budget80'] }, kinds)], ['budget80']);
  assert.deepEqual([...shownKinds({ kinds: [] }, kinds, true)], []);
  const html = emailsHtml({ kinds: [{ id: 'approval', label: 'Approval needed' }], emails: [{ id: 'eml_1', email: 'a@<b>.io', verified: true, kinds: [] }], notes: new Map() });
  assert.match(html, /a@&lt;b&gt;\.io/);
  assert.match(html, /data-save="eml_1"/);
});

test('verify an address, save the suggested kinds, switch one more on, and remove it', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());

  // Signed out: sign-in first, then back to the page the email linked to.
  await page.goto(`${iss.origin}/teams/sample-app/notifications`);
  await page.getByRole('link', { name: 'Continue with GitHub' }).click();
  await page.getByRole('heading', { name: 'Emails' }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/teams/sample-app/notifications');
  await page.getByText('Get an email when something needs you. Nothing is sent until you verify your address and choose what you want.').waitFor();
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'emails-empty-light.png') });

  await page.getByLabel('Your email address').fill('Dana@Example.com');
  await page.getByRole('button', { name: 'Send a code' }).click();
  await page.getByText('We sent a code to dana@example.com. It works for 15 minutes.').waitFor();
  const { code } = iss.codes.at(-1);
  assert.equal(iss.codes.at(-1).email, 'dana@example.com');

  // A wrong code says so, and the right one verifies.
  await page.getByLabel('Code').fill(code === '000000' ? '111111' : '000000');
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.getByRole('alert').getByText('That code is not right. Check the latest email and try again.').waitFor();
  await page.getByLabel('Code').fill(code);
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.getByText('Verified. Choose what to email you about:').waitFor();

  // D49: the suggested two are ticked, but nothing is saved until Save.
  const box = (label) => page.getByLabel(label, { exact: true });
  for (const [label, on] of [['Approval needed', true], ['Budget at 80%', false], ['Budget at 100%', true], ['A role is blocked', false], ['Meeting minutes', false]]) assert.equal(await box(label).isChecked(), on, label);
  await page.getByText('The email links to the Studio. You always approve there, never by replying.').waitFor();
  assert.deepEqual(iss.emails[0].kinds, [], 'nothing saved yet');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'emails-verified-light.png') });
  await box('Meeting minutes').check();
  assert.deepEqual(iss.emails[0].kinds, [], 'a tick waits for Save the first time');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Saved. You will get these emails.').waitFor();
  assert.deepEqual(iss.emails[0].kinds, ['approval', 'budget100', 'minutes']);

  // After that each switch saves at once.
  await box('A role is blocked').check();
  await page.getByText('Saved.', { exact: true }).waitFor();
  assert.deepEqual(iss.emails[0].kinds.sort(), ['approval', 'blocked', 'budget100', 'minutes']);
  for (const l of ['Approval needed', 'Budget at 100%', 'A role is blocked', 'Meeting minutes']) await box(l).uncheck();
  await page.getByText('Saved. Nothing is emailed to this address now; it stays verified.').waitFor();
  assert.deepEqual(iss.emails[0].kinds, []);
  assert.equal(await page.getByRole('button', { name: 'Save' }).count(), 0, 'no suggestions after every kind was switched off');
  await page.reload();
  await page.getByText('Verified. Choose what to email you about:').waitFor();

  // A second address, then removing the first.
  await page.getByRole('button', { name: 'Add another address' }).click();
  await page.getByLabel('Your email address').fill('dana@work.example');
  await page.getByRole('button', { name: 'Send a code' }).click();
  await page.getByText('We sent a code to dana@work.example.').waitFor();
  await page.locator('.n-address', { hasText: 'dana@example.com' }).getByRole('button', { name: 'Remove' }).click();
  await page.locator('.n-address', { hasText: 'dana@example.com' }).waitFor({ state: 'detached' });
  assert.deepEqual(iss.emails.map((e) => e.email), ['dana@work.example']);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('when the team cannot send yet, the page says why; at 360px nothing scrolls sideways', { skip }, async () => {
  iss.mail.sink = false;
  const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: SHOTS ? 3 : 1 });
  const page = await ctx.newPage();
  await page.goto(`${iss.origin}/teams/sample-app/notifications`);
  await page.getByRole('link', { name: 'Continue with GitHub' }).click();
  await page.getByRole('heading', { name: 'Emails' }).waitFor();
  await page.getByRole('button', { name: 'Use another address' }).click();
  await page.getByLabel('Your email address').fill('pat@example.com');
  await page.getByRole('button', { name: 'Send a code' }).click();
  await page.getByText('The code could not be sent: this team has no email sink yet.').waitFor();
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(w <= 360, `no sideways scroll (${w}px)`);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'emails-no-sink-phone-light.png') });
  // A team the person is not on.
  await page.goto(`${iss.origin}/teams/other-team/notifications`);
  await page.getByText('There is no team called other-team here, or you are not on it.').waitFor();
  iss.mail.sink = true;
  await ctx.close();
});
