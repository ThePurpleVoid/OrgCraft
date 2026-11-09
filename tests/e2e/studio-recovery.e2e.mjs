// L27 web half (mockup v19, signed off 2026-11-09): "Use a passkey" on the sign-in page, so losing GitHub never
// locks anyone out; Security › Recovery owners on the account page; and the "only you can recover" banner on the
// hosted pages. Against the stub issuer, whose routes follow apps/server (identity.mjs passkey sign-in, recovery.mjs).
// Passkeys come from Chromium's virtual authenticator.
//
//   node --test tests/e2e/studio-recovery.e2e.mjs
//   SCREENSHOTS=docs/product/screenshots/recovery node --test tests/e2e/studio-recovery.e2e.mjs
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
  iss = await stubIssuer({ members: {
    octo: { id: 'per_octo', name: 'Octo Cat', workspaces: [{ tenant: 'acme', name: 'Acme', role: 'owner' }] },
    dana: { id: 'per_dana', name: 'Dana Ruiz', workspaces: [{ tenant: 'acme', name: 'Acme', role: 'owner' }] },
    sam: { id: 'per_sam', name: 'Sam Lee', workspaces: [{ tenant: 'acme', name: 'Acme', role: 'owner' }] },
  } });
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
after(async () => { await browser?.close(); iss?.close(); });

async function withAuthenticator(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
}

/** Signs `login` in with GitHub on the account page and adds a first passkey there. */
async function signInWithPasskey(page, login, name) {
  iss.upstream.login = login;
  await page.goto(`${iss.origin}/account`);
  await page.getByRole('link', { name: 'Continue with GitHub' }).click();
  const add = page.locator('#passkey-add');
  await add.getByLabel('Name').fill(name);
  await add.getByRole('button', { name: 'Create passkey' }).click();
  await page.locator('.passkey', { hasText: name }).waitFor();
}

/** Answers the step-up dialog with the passkey on this device. */
async function stepUp(page, action) {
  const su = page.locator('#passkey-stepup');
  await su.getByText(`${action}. Use your passkey to confirm. It covers this one action only.`).waitFor();
  await su.getByRole('button', { name: 'Use passkey' }).click();
}

test('the sign-in page offers a passkey next to GitHub; a passkey alone signs in, and a failed one says so', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await withAuthenticator(page);
  await signInWithPasskey(page, 'dana', 'Dana laptop');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(/error=signed-out/);

  // Signed out: the page has both ways in, and the lost-sign-in line.
  await page.goto(`${iss.origin}/account`);
  await page.getByRole('heading', { name: 'Sign in to this organization' }).waitFor();
  await page.getByText('Use the account you were invited with.').waitFor();
  await page.getByRole('link', { name: 'Continue with GitHub' }).waitFor();
  await page.getByText('Lost your sign-in? Ask a recovery owner of this organization to let you back in.').waitFor();
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'sign-in-passkey-desktop-light.png') });

  // GitHub is gone (the stub GitHub would sign in someone else): the passkey alone gets Dana back to where she was.
  iss.upstream.login = 'nobody';
  await page.getByRole('button', { name: 'Use a passkey' }).click();
  await page.getByText('Signed in as').waitFor();
  assert.equal(new URL(page.url()).pathname, '/account');
  assert.ok(iss.log.some((l) => l.method === 'SIGN-IN' && l.path === 'passkey' && l.person === 'per_dana'));
  assert.deepEqual(errors, []);
  await ctx.close();

  // A device with no passkey for this site: the prompt fails, and the page says so in words, never the browser's.
  const c2 = await browser.newContext({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });
  const p2 = await c2.newPage();
  await withAuthenticator(p2);
  await p2.goto(`${iss.origin}/account`);
  await p2.getByRole('button', { name: 'Use a passkey' }).click();
  await p2.getByRole('alert').getByText("That sign-in didn't work. Try again, or use another way below.").waitFor();
  assert.ok(await p2.evaluate(() => document.documentElement.scrollWidth <= 360), 'no sideways scroll at 360px');
  assert.ok((await p2.getByRole('button', { name: 'Use a passkey' }).boundingBox()).height >= 44);
  if (SHOTS) await p2.screenshot({ path: join(SHOTS, 'sign-in-passkey-failed-phone-light.png') });
  await c2.close();
});

test('Security › Recovery owners: the banner while fewer than two count, naming yourself counts at once, a second waits 24 hours', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await withAuthenticator(page);
  await signInWithPasskey(page, 'octo', 'Octo laptop');

  const banner = page.locator('.recovery-banner');
  await banner.getByText('Nobody can recover Acme. If its owners lose their sign-in, nobody can let them back in. Add two recovery owners.').waitFor();
  const sec = page.locator('#recovery');
  await sec.getByRole('heading', { name: 'Security' }).waitFor();
  await sec.getByRole('heading', { name: 'Recovery owners' }).waitFor();
  await sec.getByText('If someone loses every way to sign in, a recovery owner can let them back in. Keep at least two, so that losing one sign-in never locks Acme out.').waitFor();
  await sec.getByText('Only an owner with a passkey can add one. It needs your passkey.').waitFor();

  // Yourself first: in a workspace with none, it counts at once (after the passkey).
  await sec.getByLabel('Person').selectOption({ label: 'Octo Cat' });
  await sec.getByRole('button', { name: 'Add a recovery owner' }).click();
  await stepUp(page, 'Add Octo Cat as a recovery owner');
  await sec.locator('tbody tr', { hasText: 'Octo Cat' }).waitFor();
  assert.equal(iss.recovery.length, 1);
  await banner.getByText('Only you can recover Acme. If you lose your sign-in, nobody can let you back in. Add a second recovery owner.').waitFor();

  // Sam has no passkey: refused in the CPO's words, with nothing added.
  await sec.getByLabel('Person').selectOption({ label: 'Sam Lee' });
  await sec.getByRole('button', { name: 'Add a recovery owner' }).click();
  await stepUp(page, 'Add Sam Lee as a recovery owner');
  await sec.getByRole('alert').getByText("Sam Lee has no passkey yet, so they can't confirm a recovery. Ask them to add one in their account.").waitFor();
  assert.equal(iss.recovery.filter((r) => !r.removed).length, 1);

  // Dana has one (she added it in this stub's other test or now): her addition waits 24 hours, and says so.
  if (!(iss.passkeys.get('per_dana') ?? []).length) iss.passkeys.set('per_dana', [{ id: 'dana-key', name: 'Dana laptop', createdAt: new Date().toISOString(), lastUsed: null }]);
  await sec.getByLabel('Person').selectOption({ label: 'Dana Ruiz' });
  await sec.getByRole('button', { name: 'Add a recovery owner' }).click();
  await stepUp(page, 'Add Dana Ruiz as a recovery owner');
  const pending = sec.locator('tbody tr.pending', { hasText: 'Dana Ruiz' });
  await sec.getByRole('status').getByText(/^Dana Ruiz becomes a recovery owner at .+\. We've told every owner\.$/).waitFor();
  await pending.getByText(/^Starts .+/).waitFor(); // the row names her once (qa-web)
  assert.equal(await pending.locator('.sr-only').textContent(), 'Has a passkey');
  await banner.waitFor(); // still only one counts until the 24 hours pass
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'recovery-owners-desktop-light.png'), fullPage: true });

  // Cancel undoes the pending one, with the passkey.
  await pending.getByRole('button', { name: 'Cancel' }).click();
  await stepUp(page, 'Cancel adding Dana Ruiz as a recovery owner');
  await pending.waitFor({ state: 'detached' });

  // The banner is on the other hosted page too, and links here.
  await page.goto(`${iss.origin}/teams/sample-app/notifications`);
  await page.locator('.recovery-banner').getByRole('link', { name: 'Add a recovery owner' }).click();
  await page.waitForURL(/\/account#recovery$/);
  await page.locator('#recovery').waitFor();

  // Two that count: the banner goes.
  const dana = iss.recovery.find((r) => r.person === 'per_dana');
  iss.recovery.push({ person: 'per_dana', addedBy: 'per_octo', addedAt: Date.now() - 2 * 86400_000, effectiveAt: Date.now() - 86400_000, removed: false });
  await page.reload();
  await page.locator('#recovery tbody tr', { hasText: 'Dana Ruiz' }).waitFor();
  assert.equal(await page.locator('.recovery-banner').count(), 0);
  assert.ok(!dana || dana.removed);
  assert.doesNotMatch(await page.locator('#recovery').textContent(), /server text|per_/, 'only the CPO\'s words and names');
  await page.setViewportSize({ width: 360, height: 780 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 360), 'no sideways scroll at 360px');
  assert.ok((await page.locator('#recovery tbody tr', { hasText: 'Dana Ruiz' }).getByRole('button', { name: 'Remove' }).boundingBox()).height >= 44);

  // Down to the last one: a warning before any passkey; Cancel keeps them, Remove anyway goes on to the passkey.
  await page.locator('#recovery tbody tr', { hasText: 'Dana Ruiz' }).getByRole('button', { name: 'Remove' }).click();
  await stepUp(page, 'Remove Dana Ruiz as a recovery owner');
  await page.locator('#recovery tbody tr', { hasText: 'Dana Ruiz' }).waitFor({ state: 'detached' });
  const lastRow = page.locator('#recovery tbody tr', { hasText: 'Octo Cat' });
  const warn = page.locator('#recovery-last');
  await lastRow.getByRole('button', { name: 'Remove' }).click();
  await warn.getByText('Octo Cat is the last recovery owner. After this, nobody can let anyone back into Acme if they lose their sign-in. Remove anyway?').waitFor();
  assert.equal(await page.locator('#passkey-stepup[open]').count(), 0, 'the warning comes before the passkey');
  await warn.getByRole('button', { name: 'Cancel' }).click();
  assert.equal(iss.recovery.filter((r) => !r.removed).length, 1);
  await lastRow.getByRole('button', { name: 'Remove' }).click();
  await warn.getByRole('button', { name: 'Remove anyway' }).click();
  await stepUp(page, 'Remove Octo Cat as a recovery owner');
  // The server's floor (CTO ruling): confirm "no-recovery" and a step-up scoped to removing exactly this last owner.
  await page.locator('#recovery tbody tr', { hasText: 'Octo Cat' }).waitFor({ state: 'detached' });
  assert.ok(iss.log.some((l) => l.method === 'RECOVERY' && l.path === 'removed-last' && l.person === 'per_octo'), 'removed as the last one, confirmed and scoped');
  await page.locator('.recovery-banner').getByText('Nobody can recover Acme. If its owners lose their sign-in, nobody can let them back in. Add two recovery owners.').waitFor();
  assert.deepEqual(errors, []);
  await ctx.close();
});
