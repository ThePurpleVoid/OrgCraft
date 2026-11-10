// Minor units by each currency's ISO 4217 exponent (code review L22m), shared by the server and the Studio page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMinor, knownCurrency, minorDigits } from '../packages/calls/money.mjs';
import { money as pageMoney } from '../apps/studio/public/approvals.js';

test('USD has 2 decimals, JPY none, KWD and BHD three; unknown codes are not known', () => {
  assert.deepEqual(['USD', 'JPY', 'KWD', 'BHD', 'EUR'].map(minorDigits), [2, 0, 3, 3, 2]);
  assert.deepEqual([formatMinor(2000, 'USD'), formatMinor(2050, 'USD'), formatMinor(2500, 'JPY'), formatMinor(2500, 'KWD'), formatMinor(3000, 'KWD')].map((x) => x.replace(/\s/g, ' ')), ['$20', '$20.50', '¥2,500', 'KWD 2.500', 'KWD 3']);
  assert.deepEqual(['USD', 'JPY', 'KWD', 'XYZ', 'usd', 'US', 7].map(knownCurrency), [true, true, true, false, false, false, false]);
});

test('the Studio page reads amounts the same way', () => {
  for (const [m, c] of [[2500, 'JPY'], [2500, 'KWD'], [2050, 'USD'], [2000, 'USD']]) assert.equal(pageMoney(m, c).replace(/\s/g, ' '), formatMinor(m, c, []).replace(/\s/g, ' '), `${m} ${c}`);
});
