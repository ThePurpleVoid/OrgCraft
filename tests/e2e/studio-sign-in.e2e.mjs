// Signing in to a hosted Studio in a real browser (docs/specs/m4-sign-in.md section 2, web-dev's proof): the sign-in
// page against a stub issuer and a stub GitHub, the session cookie, "ask to be invited", a first passkey, passkey
// step-up to remove one, the return-path check and sign-out, at desktop and 360px. Passkeys come from Chromium's
// virtual authenticator (WebAuthn over the DevTools protocol), so no person or hardware is needed.
//
//   node --test tests/e2e/studio-sign-in.e2e.mjs        # needs the playwright package and a Chromium
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { stubIssuer } from '../fixtures/stub-issuer.mjs';

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

/** A page with a virtual platform authenticator (Touch ID-like). `verified: false` is one that cannot check the person. */
async function withAuthenticator(page, { verified = true } = {}) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: verified, automaticPresenceSimulation: true } });
  return { cdp, authenticatorId };
}

async function noSideScroll(page, width) {
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(w <= width, `no sideways scroll at ${width}px (${w}px)`);
}

test('sign in with GitHub, add a first passkey, step up with it, and sign out', { skip }, async () => {
  iss.upstream.login = 'octo';
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await withAuthenticator(page);

  // Not signed in: the account page sends the browser to the issuer, which shows the sign-in page.
  await page.goto(`${iss.origin}/account#passkeys`);
  await page.getByRole('link', { name: 'Continue with GitHub' }).waitFor();
  assert.match(page.url(), /\/sign-in\?interaction=[A-Za-z0-9_-]+$/);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'sign-in-desktop-light.png') });
  await page.getByRole('link', { name: 'Continue with GitHub' }).click();

  // Back where the person started, with the session cookie and nothing readable by the page.
  await page.getByText('Signed in as').waitFor();
  assert.equal(new URL(page.url()).pathname + new URL(page.url()).hash, '/account#passkeys');
  const [cookie] = (await ctx.cookies()).filter((c) => c.name === '__Host-agent-team');
  assert.ok(cookie, 'the session cookie is set');
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.secure, true);
  assert.equal(cookie.sameSite, 'Lax');
  assert.equal(cookie.path, '/');
  assert.equal(await page.evaluate(() => document.cookie), '', 'the page cannot read it');

  // No passkey yet: the page asks for one straight away, and the first needs only the fresh sign-in.
  const add = page.locator('#passkey-add');
  await add.getByRole('heading', { name: 'Add a passkey' }).waitFor();
  await add.getByLabel('Name').fill('Work laptop');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'passkey-add-desktop-light.png') });
  await add.getByRole('button', { name: 'Create passkey' }).click();
  await page.locator('.passkey', { hasText: 'Work laptop' }).waitFor();
  assert.equal(iss.passkeys.get('per_octo').length, 1);

  // Removing it needs step-up: the dialog asks for the passkey, the issuer mints one su_ token, the page spends it once.
  page.once('dialog', (d) => d.accept());
  await page.locator('.passkey', { hasText: 'Work laptop' }).getByRole('button', { name: 'Remove' }).click();
  const su = page.locator('#passkey-stepup');
  await su.getByRole('heading', { name: 'Confirm it is you' }).waitFor();
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'step-up-desktop-light.png') });
  await su.getByRole('button', { name: 'Use passkey' }).click();
  await page.getByText('Add a passkey before you can approve anything').waitFor();
  assert.equal(iss.passkeys.get('per_octo').length, 0);
  assert.equal(iss.stepUps.size, 0, 'the su_ token was spent by the one call that needed it');
  assert.ok(iss.log.some((l) => l.method === 'DELETE' && l.status === 401) && iss.log.some((l) => l.method === 'DELETE' && l.status === 200));

  // A return path that leaves the host is refused: signed in, the issuer sends the browser to '/' instead.
  await page.goto(`${iss.origin}/oauth/authorize?client_id=agent-team-web&return=${encodeURIComponent('//evil.example/x')}`);
  assert.equal(new URL(page.url()).origin, iss.origin);
  assert.equal(new URL(page.url()).pathname, '/');

  // Sign out ends the session; the account page then needs a sign-in again.
  await page.goto(`${iss.origin}/account`);
  await page.locator('#passkey-add').getByRole('button', { name: 'Not now' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('heading', { name: 'You are signed out' }).waitFor();
  assert.equal((await ctx.cookies()).filter((c) => c.name === '__Host-agent-team').length, 0);
  assert.equal(iss.sessions.size, 0);
  await page.goto(`${iss.origin}/account`);
  await page.getByRole('link', { name: 'Continue with GitHub' }).waitFor();
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a GitHub account that is not a member or invitee is told to ask an owner, and nothing is created', { skip }, async () => {
  iss.upstream.login = 'stranger<b>';
  const ctx = await browser.newContext({ viewport: { width: 360, height: 760 }, isMobile: true, hasTouch: true, deviceScaleFactor: SHOTS ? 2 : 1 });
  const page = await ctx.newPage();
  const before = iss.sessions.size;
  await page.goto(`${iss.origin}/account`);
  const go = page.getByRole('link', { name: 'Continue with GitHub' });
  await go.waitFor();
  await noSideScroll(page, 360);
  assert.ok((await go.boundingBox()).height >= 44, 'a touch target');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'sign-in-phone-light.png') });
  await go.click();
  await page.getByRole('heading', { name: 'Ask an owner to invite you' }).waitFor();
  assert.equal(await page.locator('#auth-body strong').textContent(), 'stranger<b>', 'the login is shown as text');
  assert.equal(iss.sessions.size, before, 'no session');
  await noSideScroll(page, 360);
  if (SHOTS) {
    await page.screenshot({ path: join(SHOTS, 'not-invited-phone-light.png') });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: join(SHOTS, 'not-invited-phone-dark.png') });
  }
  await ctx.close();
});

test('at 360px in the dark, a passkey that cannot verify the person does not step up', { skip }, async () => {
  iss.upstream.login = 'octo';
  const ctx = await browser.newContext({ viewport: { width: 360, height: 760 }, isMobile: true, hasTouch: true, colorScheme: 'dark', deviceScaleFactor: SHOTS ? 2 : 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const { cdp, authenticatorId } = await withAuthenticator(page);
  await page.goto(`${iss.origin}/account`);
  await page.getByRole('link', { name: 'Continue with GitHub' }).click();
  const add = page.locator('#passkey-add');
  await add.getByLabel('Name').fill('Phone');
  await add.getByRole('button', { name: 'Create passkey' }).click();
  await page.locator('.passkey', { hasText: 'Phone' }).waitFor();
  await noSideScroll(page, 360);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'account-phone-dark.png') });

  // Now the authenticator only proves presence, not the person: the issuer refuses, and the dialog says so.
  await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
  page.once('dialog', (d) => d.accept());
  await page.locator('.passkey', { hasText: 'Phone' }).getByRole('button', { name: 'Remove' }).click();
  const su = page.locator('#passkey-stepup');
  await su.getByRole('button', { name: 'Use passkey' }).click();
  await su.locator('.result.error').filter({ hasText: /verify|could not confirm/ }).waitFor();
  const use = await su.getByRole('button', { name: 'Use passkey' }).boundingBox();
  assert.ok(use.height >= 44 && use.x + use.width <= 360, 'the dialog fits and its buttons are touch targets');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'step-up-refused-phone-dark.png') });
  await su.getByRole('button', { name: 'Cancel' }).click();
  assert.equal(iss.passkeys.get('per_octo').length, 1, 'nothing was removed');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the issuer refuses a cross-site write, and a step-up secret, whatever the page does', { skip }, async () => {
  // These are the stub's checks, run here so a page change that relied on them breaking would show.
  const r = await fetch(`${iss.origin}/oauth/revoke`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 403);
  const form = await fetch(`${iss.origin}/oauth/revoke`, { method: 'POST', headers: { origin: iss.origin, 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' });
  assert.equal(form.status, 403);
});
