// "Make this a standing rule" in the Studio's chat (L22 web; mockup v20, signed off) against the fake control plane:
// under an approval the owner approved, the control plane's draft opens a sheet; the owner's limits and words show as
// the line the ledger will quote; a wrong value says why and blocks; the passkey dialog names the rule; the rule is
// made, or nothing changes when the passkey is cancelled or the card changed meanwhile. Kinds not made now show nothing.
//
//   node --test tests/e2e/studio-make-rule.e2e.mjs     # needs the playwright package and a Chromium
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
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

let browser, root;
const open = [];
before(async () => {
  if (skip) return;
  root = mkdtempSync(join(tmpdir(), 'studio-mkrule-'));
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync(process.execPath, [join(KIT, 'bin/agent-team.mjs'), 'init', '--preset', 'minimal', '--project', 'Sample app', '--dir', root], { stdio: 'ignore' });
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});
after(async () => { await browser?.close(); for (const { studio, cp } of open) { studio.closeAllConnections?.(); studio.close(); cp.close(); } });

async function chat(viewport = { width: 1280, height: 900 }) {
  const cp = await fakeControlPlane({ team: 'sample-app', running: false });
  const studio = createStudio({ root, env: cp.env });
  await new Promise((r) => studio.listen(0, '127.0.0.1', r));
  open.push({ studio, cp });
  const base = `http://127.0.0.1:${studio.address().port}`;
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { cp, page, errors, go: async () => { await page.goto(`${base}/?t=${studio.launchToken}`); await page.goto(`${base}/#chat`); } };
}

const REFUND = { kind: 'refund', tool: 'mcp__payments__refund', recipientField: 'customer', amountField: 'amount', currencyField: 'currency', currency: 'USD', fixed: {}, free: ['reason'], system: 'Payments', period: 'week', maxEach: 2500, total: 7500 };
/** An approval the owner approved, with its signed calls, and the draft the control plane makes from it. */
function approved(cp, letter, { form = REFUND, by = { id: 'per_owner', name: 'Owner' }, draft = true } = {}) {
  cp.card({
    id: `card_${letter}`, kind: 'approval', subject: `approval/apr_${letter}`, title: `support-lead asks to refund ${letter}`, body: 'Cracked mug.', state: 'answered',
    answer: { option: 'approve', by, at: new Date().toISOString() },
    data: { letter, callsHash: `h_${letter}`, facts: [{ tool: form.tool, text: 'Pays $24.90 to card ending 4242 · in Payments' }] },
    options: [{ id: 'approve', label: 'Approve', style: 'primary', stepUp: true }, { id: 'deny', label: 'Deny', style: 'danger' }],
  });
  if (draft === true) cp.drafts.set(`apr_${letter}`, [200, { approval: `apr_${letter}`, letter, effect: 'Pays $24.90 to card ending 4242 · in Payments.', form }]);
  else if (draft) cp.drafts.set(`apr_${letter}`, draft);
}

test('the owner makes a refund rule from an approved card: limits, words, the quoted line, one scoped passkey', { skip }, async () => {
  const { cp, page, errors, go } = await chat();
  approved(cp, 'A');
  await go();
  const card = page.locator('[data-card-id="card_A"]');
  const make = card.getByRole('button', { name: 'Make this a standing rule' });
  await make.waitFor();
  assert.match(await make.getAttribute('data-tip'), /Next time something like A comes up/);
  await make.click();
  const sheet = card.locator('.mkrule');
  await page.waitForFunction(() => document.activeElement?.id === 'mr-title-apr_A');
  await sheet.getByText('From A, which you approved: Pays $24.90 to card ending 4242 · in Payments.').waitFor();
  const quote = sheet.locator('#mr-quote-apr_A');
  assert.match(await quote.textContent(), /You made a standing rule: Refunds · up to \$25 each · at most \$75 per customer a week · at most \$250 a week in all · in Payments · may include: customer, amount, currency, reason · "…"$/);
  const save = sheet.getByRole('button', { name: 'Make the rule with your passkey' });
  assert.equal(await save.isDisabled(), true, 'no words yet');
  await sheet.getByText('Add your words first. They go in the ledger with the rule.').waitFor();
  // Wrong values say why, and block.
  await sheet.getByLabel('At most … per customer a week').fill('10');
  await sheet.getByText('The limit per period has to be at least the amount each time.').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'mr-total-apr_A', 'typing keeps the field');
  await sheet.getByLabel('At most … per customer a week').fill('60');
  await sheet.getByLabel('At most … a week in all').fill('50');
  await sheet.getByText('The total for all customers has to be at least the limit per customer.').waitFor();
  await sheet.getByLabel('At most … a week in all').fill('200');
  await sheet.getByLabel('Ends after … days').fill('120');
  await sheet.getByText('Pick between 1 and 90 days.').waitFor();
  await sheet.getByLabel('Ends after … days').fill('14');
  await sheet.getByLabel('Period').selectOption('month');
  await sheet.getByLabel('In your own words, why the team doesn\'t need to ask you for this').pressSequentially('small refunds don\'t need me');
  assert.match(await quote.textContent(), /at most \$60 per customer a month · at most \$200 a month in all · .* · "small refunds don't need me"$/);
  assert.equal(await save.isDisabled(), false);
  await save.click();
  const dlg = page.locator('#stepup-dialog');
  await dlg.locator('#stepup-why', { hasText: 'Make standing rule: Refunds · up to $25 each · at most $60 per customer a month' }).waitFor();
  assert.deepEqual(await dlg.locator('.stepup-items li').allTextContents(), ['Ends after 14 days'], 'the passkey covers how long it lasts');
  assert.equal(cp.rules.length, 0, 'nothing made before the passkey');
  await dlg.locator('#stepup-secret').fill(cp.stepUpSecret);
  await dlg.locator('button[type="submit"]').click();
  await card.getByText(/^Standing rule #1 is in force until /).waitFor();
  await page.waitForFunction(() => document.activeElement?.id === 'mr-result-apr_A');
  const posted = cp.rulePosts[0];
  assert.deepEqual({ maxEach: posted.maxEach, total: posted.total, all: posted.all, period: posted.period, days: posted.days, words: posted.words, tool: posted.tool }, { maxEach: 2500, total: 6000, all: 20000, period: 'month', days: 14, words: 'small refunds don\'t need me', tool: 'mcp__payments__refund' });
  assert.equal(cp.ledger[0].kind, 'rule-added');
  assert.equal(posted.approval, 'apr_A', 'bound to the approval it came from');
  // One rule per approval (qa-web D1): after a reload the card says which rule, with no button.
  await page.reload();
  await card.getByText('Standing rule #1 was made from this ask.').waitFor();
  assert.equal(await card.getByRole('button', { name: 'Make this a standing rule' }).count(), 0);
  assert.deepEqual(errors, []);
});

test('another owner\'s approval names them; amounts with thousands; a second window gets the rule already made', { skip }, async () => {
  const { cp, page, errors, go } = await chat();
  approved(cp, 'K', { by: { id: 'per_kim', name: 'Kim' } });
  cp.drafts.set('apr_K', [200, { approval: 'apr_K', letter: 'K', effect: 'Pays $24.90 to card ending 4242 · in Payments.', form: REFUND }]); // no approvedBy: the card's own answer names Kim (qa-web D2)
  await go();
  const card = page.locator('[data-card-id="card_K"]');
  await card.getByRole('button', { name: 'Make this a standing rule' }).click();
  const sheet = card.locator('.mkrule');
  await sheet.getByText('From K, which Kim approved: Pays $24.90 to card ending 4242 · in Payments.').waitFor();
  // "1,000" is a thousand (qa-web D3), and field names read as words.
  // Something that isn't an amount says how to write one; a leading $ and "1.000,50" are read (qa-web D3).
  await sheet.getByLabel('At most … per customer a week').fill('lots');
  await sheet.getByText('Use digits only, like 25 or 1,000.').waitFor();
  await sheet.getByLabel('At most … per customer a week').fill('$25');
  await sheet.getByLabel('At most … a week in all').fill('1.000,50');
  assert.match(await sheet.locator('#mr-quote-apr_K').textContent(), /at most \$25 per customer a week · at most \$1,000\.50 a week in all/);
  assert.equal(await sheet.getByText('Use digits only, like 25 or 1,000.').count(), 0);
  await sheet.getByLabel('At most … per customer a week').fill('1,000');
  await sheet.getByLabel('At most … a week in all').fill('2 500.50');
  assert.match(await sheet.locator('#mr-quote-apr_K').textContent(), /at most \$1,000 per customer a week · at most \$2,500\.50 a week in all · in Payments · may include: customer, amount, currency, reason/);
  assert.equal(await sheet.getByText('Enter an amount above zero.').count(), 0);
  // Another window made a rule from K meanwhile: this one is told which, and nothing more is made.
  cp.rules.unshift({ id: 'sr_9', number: 9, approval: 'apr_K', kind: 'refund', form: REFUND, words: 'x', live: true });
  await sheet.getByLabel('In your own words, why the team doesn\'t need to ask you for this').fill('big orders are fine');
  await sheet.getByRole('button', { name: 'Make the rule with your passkey' }).click();
  await page.locator('#stepup-dialog #stepup-secret').fill(cp.stepUpSecret);
  await page.locator('#stepup-dialog button[type="submit"]').click();
  await card.getByText('Standing rule #9 was made from this ask.').waitFor();
  assert.equal(cp.rules.length, 1, 'no second rule');
  assert.deepEqual(errors, []);
});

test('no button for a kind not made now, an ask settled by a rule, or a card with no draft', { skip }, async () => {
  const { cp, page, go } = await chat();
  approved(cp, 'A', { draft: [409, { type: 'rule-not-possible', reason: 'kind-later', error: 'later' }] });
  approved(cp, 'B', { by: 'rule:sr_1' });
  approved(cp, 'C', { draft: [200, { approval: 'apr_C', letter: 'C', effect: 'x', form: { ...REFUND, kind: 'merge' } }] });
  approved(cp, 'D');
  await go();
  await page.locator('[data-card-id="card_D"]').getByRole('button', { name: 'Make this a standing rule' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Make this a standing rule' }).count(), 1, 'only under D');
  for (const l of ['A', 'B', 'C']) assert.doesNotMatch(await page.locator(`[data-card-id="card_${l}"]`).textContent(), /kind-later|rule-not-possible|merge\b|standing rule/i);
});

test('cancelling the passkey makes nothing and says the approval stands; a changed card makes nothing', { skip }, async () => {
  const { cp, page, go } = await chat({ width: 390, height: 860 });
  approved(cp, 'A', { form: { kind: 'send.known', tool: 'mcp__mail__send', recipientField: 'to', fixed: {}, free: ['subject', 'body'], channel: 'Support inbox', period: 'week', n: 50 } });
  await go();
  const card = page.locator('[data-card-id="card_A"]');
  await card.getByRole('button', { name: 'Make this a standing rule' }).click();
  const sheet = card.locator('.mkrule');
  assert.match(await sheet.locator('#mr-quote-apr_A').textContent(), /Messages to people the team has written to before · in Support inbox · at most 50 a week/);
  await sheet.getByLabel('In your own words, why the team doesn\'t need to ask you for this').fill('they wrote to us first');
  await sheet.getByRole('button', { name: 'Make the rule with your passkey' }).click();
  await page.locator('#stepup-dialog #stepup-why').waitFor();
  await page.keyboard.press('Escape');
  await sheet.getByText('The rule wasn\'t made. Your approval of A still stands.').waitFor();
  await page.waitForFunction(() => document.activeElement?.dataset?.mrgo === 'apr_A');
  assert.equal(cp.rulePosts.length, 0);
  // The card changes after the sheet opened: the control plane refuses, and nothing is made.
  cp.refuseRule([409, { type: 'rule-stale', error: 'the approval changed' }]);
  await sheet.getByRole('button', { name: 'Make the rule with your passkey' }).click();
  await page.locator('#stepup-dialog #stepup-secret').fill(cp.stepUpSecret);
  await page.locator('#stepup-dialog button[type="submit"]').click();
  await sheet.getByText('This card changed after you opened it, so the rule wasn\'t made. Open the card again to start over.').waitFor();
  assert.equal(cp.rules.length, 0);
  // Not now closes the sheet and goes back to the button.
  await sheet.getByRole('button', { name: 'Not now' }).click();
  await page.waitForFunction(() => document.activeElement?.dataset?.mkrule === 'apr_A');
});
