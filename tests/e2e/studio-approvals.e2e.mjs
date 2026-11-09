// Approvals in the Studio (L22 web half; mockup v19 Approvals; strings-now §6b) against the fake control plane: the
// standing rules with their use and Withdraw (no passkey), the kinds not enforced yet greyed out, what a rule can
// never cover, the ledger in the person's own words with Show all and Show older, and the approval card's lines for
// a re-ask after a decline and an answer under a rule.
//
//   node --test tests/e2e/studio-approvals.e2e.mjs
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
import { ledgerLine, ruleLine, usedLine } from '../../apps/studio/public/approvals.js';
import { declineHtml } from '../../apps/studio/public/chat.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { /* reported by the skip below */ }
if (!chromium && process.env.CI) throw new Error('CI is set but the playwright package is not installed');
const skip = !chromium && 'the playwright package is not installed';

const REFUND = { kind: 'refund', tool: 'mcp__payments__refund', recipientField: 'customer', period: 'week', amountField: 'amount', currency: 'USD', maxEach: 2000, total: 6000, system: 'Payments' };
const SEND = { kind: 'send.known', tool: 'mcp__mail__send', recipientField: 'to', period: 'day', n: 50, channel: null };
const day = (d) => new Date(Date.now() + d * 86_400_000).toISOString();

test('rule lines, use and ledger lines are the CPO\'s patterns, with unset parts left out and never an id', () => {
  assert.equal(ruleLine(REFUND), 'Refunds · up to $20.00 each · at most $60.00 per customer per week · in Payments');
  assert.equal(ruleLine(SEND), 'Messages to people the team has written to before · at most 50 per day');
  assert.equal(usedLine({ form: REFUND, used: { n: 2, amount: 3500 } }), 'Used 2 times this week. $25.00 left.');
  assert.equal(usedLine({ form: SEND, used: { n: 50 } }), "Used 50 times this day. 0 left. This rule's limit for this day is used up, so the next one asks you.");
  const me = 'per_owner';
  assert.match(ledgerLine({ at: day(0), kind: 'approved', by: me, words: 'yes, refund her', letter: 'A', what: 'Refund $64.00 to Dana R.', channel: 'chat' }, me), / · You approved A: Refund \$64\.00 to Dana R\. · "yes, refund her" · in Chat$/);
  assert.match(ledgerLine({ at: day(0), kind: 'denied', by: 'per_kim', name: 'Kim Lo', words: null, what: 'Email 1,240 customers' }, me), / · Kim Lo declined: Email 1,240 customers · \(no words given\)$/);
  assert.match(ledgerLine({ at: day(0), kind: 'rule-used', by: 'rule:sr_1', ruleNumber: 9, ruleLine: 'Refunds · up to $20.00 each' }, me), / · Done under standing rule #9: Refunds · up to \$20\.00 each$/);
  assert.doesNotMatch(ledgerLine({ at: day(0), kind: 'denied', by: 'per_kim', what: 'x' }, me), /per_kim/);
  assert.match(ledgerLine({ at: day(0), kind: 'denied', by: 'per_kim', what: 'x' }, me), /Someone who no longer has access declined/);
});

test('an approval asked again after a decline says who declined it, what changed, and until when it can\'t be asked', () => {
  const card = (db, changed) => ({ kind: 'approval', data: { declinedBefore: db, ...(changed ? { changed } : {}) } });
  const html = declineHtml(card({ declinedOn: '2026-11-08T10:00:00Z', cooldownUntil: '2026-11-15T10:00:00Z', declinedBy: 'per_owner' }, { what: 'the amount is now $40' }), 'per_owner');
  assert.match(html, /You declined this on (8 Nov|Nov 8)\. What changed: the amount is now \$40\./);
  assert.match(html, /The team can&#39;t ask for this again until (15 Nov|Nov 15), unless something changes\./);
  const other = declineHtml(card({ declinedOn: '2026-11-08T10:00:00Z', declinedBy: 'per_kim', declinedByName: 'Kim Lo' }, { what: 'smaller' }), 'per_owner');
  assert.match(other, /Kim Lo declined this on (8 Nov|Nov 8)\./);
  assert.match(other, /What changed: smaller/);
  assert.doesNotMatch(other, /per_kim/);
  assert.match(declineHtml({ kind: 'approval', data: { changed: { from: ['apr_1'] } } }), /This changed since you were asked\. Look again\./);
  assert.equal(declineHtml({ kind: 'approval', data: {} }), '');
});

let cp, studio, base, browser, root;
before(async () => {
  if (skip) return;
  root = mkdtempSync(join(tmpdir(), 'studio-approvals-'));
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync(process.execPath, [join(KIT, 'bin/agent-team.mjs'), 'init', '--preset', 'minimal', '--project', 'Sample app', '--dir', root], { stdio: 'ignore' });
  cp = await fakeControlPlane({ team: 'sample-app' });
  studio = createStudio({ root, env: cp.env });
  await new Promise((r) => studio.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${studio.address().port}`;
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});
after(async () => { await browser?.close(); studio?.closeAllConnections?.(); studio?.close(); cp?.close(); });

test('the Approvals page: rules with Withdraw, kinds not available yet, the never list, and the ledger in your words', { skip }, async () => {
  cp.rules.push(
    { id: 'sr_a', number: 1, kind: 'refund', form: REFUND, line: 'server text', words: 'small refunds don\'t need me', createdBy: 'per_owner', createdAt: day(-2), expiresAt: day(28), live: true, used: { n: 1, amount: 1200 } },
    { id: 'sr_b', number: 2, kind: 'send.known', form: SEND, line: 'server text', words: 'routine follow-ups', createdBy: 'per_kim', createdByName: 'Kim Lo', createdAt: day(-5), expiresAt: day(25), live: false, withdrawnAt: day(-1), withdrawnBy: 'per_kim', withdrawnByName: 'Kim Lo', used: { n: 0 } },
  );
  const long = 'x'.repeat(240);
  cp.ledger.push(
    { at: day(0), kind: 'approved', by: 'per_owner', words: 'yes, refund her', letter: 'A', what: 'Refund $64.00 to Dana R.', channel: 'chat' },
    { at: day(0), kind: 'denied', by: 'per_kim', name: 'Kim Lo', words: long, letter: 'B', what: 'Email 1,240 customers', channel: 'approvals' },
    { at: day(-1), kind: 'rule-used', by: 'rule:sr_a', ruleNumber: 1, ruleLine: 'Refunds · up to $20.00 each' },
    { at: day(-2), kind: 'rule-added', by: 'per_owner', words: 'small refunds don\'t need me', ruleNumber: 1, ruleLine: 'Refunds · up to $20.00 each' },
  );
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/?t=${studio.launchToken}`);
  await page.locator('#canvas .node').first().waitFor();
  await page.locator('#more-btn').click();
  await page.getByRole('button', { name: 'Approvals' }).click();
  await page.getByRole('heading', { name: 'Approvals', level: 1 }).waitFor();

  const rules = page.locator('#rules');
  const a = rules.locator('li.rule', { hasText: '#1' });
  await a.getByText('Refunds · up to $20.00 each · at most $60.00 per customer per week · in Payments').waitFor();
  await a.getByText('Decided by You on').waitFor();
  await a.getByText('"small refunds don\'t need me"', { exact: false }).waitFor();
  await a.getByText('Used 1 times this week. $48.00 left.', { exact: false }).waitFor();
  for (const k of ['Replies to customers who wrote first', 'Merges into {target}', 'Tasks that cost more than usual']) await rules.locator('.kinds li', { hasText: k }).getByText('Not available yet').waitFor();
  assert.equal(await rules.locator('.kinds button').count(), 0, 'nothing to pick for a kind not enforced yet');
  await rules.getByRole('heading', { name: "Can't be covered by a standing rule" }).waitFor();
  await rules.getByText('Messages or payments to someone new').waitFor();
  await rules.getByText('Withdrawn rules').click();
  await rules.getByText(/^Withdrawn by Kim Lo on /).waitFor();
  assert.doesNotMatch(await rules.textContent(), /server text|per_/, 'the CPO\'s words and names only');

  const ledger = page.locator('#ledger');
  await ledger.getByText(/ · You approved A: Refund \$64\.00 to Dana R\. · "yes, refund her" · in Chat$/).waitFor();
  await ledger.getByText(/ · Kim Lo declined B: Email 1,240 customers · "x{200}…" · in Approvals$/).waitFor();
  await ledger.getByText('Show all').click();
  await ledger.getByText(`“${long}”`).waitFor();
  await ledger.getByRole('button', { name: 'Show older' }).click();
  await ledger.getByText(/ · You made a standing rule: Refunds · up to \$20\.00 each · "small refunds don't need me"$/).waitFor();
  assert.doesNotMatch(await ledger.textContent(), /per_|rule:sr_/);

  // Withdraw: at once, no passkey; the ledger says so.
  await a.getByRole('button', { name: 'Withdraw' }).click();
  await rules.getByText('No standing rules yet. Every approval asks you.').waitFor();
  assert.equal(cp.rules[0].live, false);
  await ledger.getByText(/ · You withdrew standing rule #1: Refunds · up to \$20\.00 each · at most \$60\.00 per customer per week · in Payments$/).waitFor();

  // A phone: one column, no sideways scroll, 44 px targets.
  await page.setViewportSize({ width: 360, height: 780 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 360), 'no sideways scroll at 360px');
  assert.ok((await ledger.getByRole('button', { name: 'Show older' }).or(ledger.locator('summary').first()).first().boundingBox()).height >= 44);
  assert.deepEqual(errors, []);
  await page.close();
});
