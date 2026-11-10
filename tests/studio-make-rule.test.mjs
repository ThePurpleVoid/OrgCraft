// Amounts in the standing-rule sheet (L22 web, code review L22m sev3): typed in the rule's own currency, sent in its
// minor units, whatever its exponent (USD 2, JPY 0, KWD 3), and shown back the same way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exponentOf, money } from '../apps/studio/public/approvals.js';
import { formOf, initial, major, toMinor } from '../apps/studio/public/make-rule.js';

test('each currency keeps its own minor units', () => {
  assert.deepEqual(['USD', 'JPY', 'KWD'].map((c) => exponentOf(c)), [2, 0, 3]);
  assert.equal(toMinor('25', 'USD'), 2500);
  assert.equal(toMinor('25.5', 'USD'), 2550);
  assert.equal(toMinor('25.505', 'USD'), null);
  assert.equal(toMinor('25', 'JPY'), 25);
  assert.equal(toMinor('25.5', 'JPY'), null, 'yen has no fractions');
  assert.equal(toMinor('2.5', 'KWD'), 2500);
  assert.equal(toMinor('2.125', 'KWD'), 2125);
  assert.equal(toMinor('0', 'USD'), 0);
  assert.equal(toMinor('abc', 'USD'), null);
  assert.equal(toMinor('$25', 'USD'), 2500);
  assert.equal(toMinor('USD 25', 'USD'), 2500);
  assert.equal(toMinor('1,000', 'USD', 'en-US'), 100000, 'thousands (qa-web D3)');
  assert.equal(toMinor('1,000.50', 'USD', 'en-US'), 100050);
  assert.equal(toMinor('1 000.50', 'USD', 'en-US'), 100050);
  assert.equal(toMinor('1,000', 'JPY', 'en-US'), 1000);
  // Never guess (CPO): where the mark is ".", "25,50" could be 25.50 or 2,550, so it is refused; "1.000,50" too.
  assert.equal(toMinor('25,50', 'USD', 'en-US'), null);
  assert.equal(toMinor('1.000,50', 'USD', 'en-US'), null);
  assert.equal(toMinor('1,00', 'USD', 'en-US'), null);
  // Where the mark is ",", the same text reads the other way round.
  assert.equal(toMinor('25,50', 'USD', 'de-DE'), 2550);
  assert.equal(toMinor('1.000,50', 'USD', 'de-DE'), 100050);
  assert.equal(toMinor('1.000', 'USD', 'de-DE'), 100000);
  assert.equal(toMinor('25.50', 'USD', 'de-DE'), null);
  assert.equal(major(2550, 'USD', 'de-DE'), '25,50');
  assert.equal(toMinor(major(2550, 'USD', 'de-DE'), 'USD', 'de-DE'), 2550, 'the prefilled box reads back');
  assert.equal(major(2500, 'JPY'), '2500');
  assert.equal(major(2500, 'KWD'), '2.500');
  assert.equal(major(2000, 'KWD'), '2');
  assert.equal(major(2550, 'USD'), '25.50');
  assert.match(money(2500, 'JPY'), /2,500/);
  assert.match(money(2125, 'KWD'), /2\.125/);
});

test('a yen rule typed as 25 is sent as 25, never 2500', () => {
  const draft = { letter: 'A', form: { kind: 'refund', tool: 'mcp__pay__refund', recipientField: 'customer', amountField: 'amount', currencyField: 'currency', currency: 'JPY', fixed: {}, free: [], period: 'week', maxEach: 3000, total: 9000 } };
  const s = { ...initial(draft), each: '25', total: '75', all: '250', words: 'small refunds' };
  assert.equal(initial(draft).each, '3000');
  const { form, ok } = formOf(s);
  assert.equal(ok, true);
  assert.deepEqual([form.maxEach, form.total, form.all], [25, 75, 250]);
});
