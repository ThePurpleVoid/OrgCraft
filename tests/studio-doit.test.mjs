// L39: a Do it tap in the ledger reads as the CPO's one line for the letters it covered, shown once per tap, and
// never as words the person didn't type.
//   node --test tests/studio-doit.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerHtml, ledgerLine } from '../apps/studio/public/approvals.js';

const at = '2026-11-09T09:25:00.000Z';
const row = (letter) => ({ at, kind: 'approved', by: 'p_me', name: 'Ada', words: null, channel: 'chat', approval: `apr_${letter}`, what: `Send report ${letter}`, letter, tap: 'do-it', covered: ['A', 'B'] });

test('a Do it row reads as the tap, with its letters', () => {
  const line = ledgerLine(row('A'), 'p_me');
  assert.match(line, /You took the recommendation on A and B with Do it · in Chat$/);
  assert.doesNotMatch(line, /Tapped|"/);
});

test('one tap, one line, though the ledger keeps a row per ask', () => {
  const html = ledgerHtml({ items: [row('A'), row('B')] }, 'p_me');
  assert.equal(html.match(/took the recommendation/g).length, 1);
});
