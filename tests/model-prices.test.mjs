// The kit's price table (packages/model-prices/prices.json) parses, passes checkPrices, and holds the list prices
// read from https://platform.claude.com/docs/en/about-claude/pricing on its asOf date. When prices change, change
// the table, asOf and this test together, from that page, never from memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkPrices, estimate, modelChoice, tierModel, TIERS } from '../packages/model-prices/index.mjs';

const prices = JSON.parse(readFileSync(new URL('../packages/model-prices/prices.json', import.meta.url), 'utf8'));

test('the table parses and passes its own check', () => {
  assert.deepEqual(checkPrices(prices), []);
  assert.match(prices.asOf, /^\d{4}-\d{2}-\d{2}$/);
  for (const [id, p] of Object.entries(prices.models)) {
    for (const k of ['inputPerMTok', 'outputPerMTok', 'cacheReadPerMTok', 'cacheWritePerMTok']) assert.ok(typeof p[k] === 'number' && p[k] >= 0, `${id} ${k}`);
    assert.ok(p.cacheReadPerMTok < p.inputPerMTok && p.cacheWritePerMTok > p.inputPerMTok, `${id}: a cache read is cheaper than input, a write dearer`);
  }
});

test('the list prices as of 2026-11-10 (input, output, cache read, 5-minute cache write, per million tokens)', () => {
  const row = (id) => { const p = prices.models[id]; return [p.inputPerMTok, p.outputPerMTok, p.cacheReadPerMTok, p.cacheWritePerMTok]; };
  assert.deepEqual(row('claude-fable-5-2'), [8, 40, 0.2, 10]);
  assert.deepEqual(row('claude-fable-5-1'), [10, 50, 0.25, 12.5]);
  assert.deepEqual(row('claude-opus-5-5'), [4, 20, 0.2, 5]);
  assert.deepEqual(row('claude-sonnet-5-5'), [2, 10, 0.1, 2.5]);
  assert.deepEqual(row('claude-haiku-5-5'), [0.1, 0.5, 0.01, 0.125]);
});

test('tiers stay where they were; a priced model id is a valid model choice', () => {
  assert.deepEqual(TIERS.map((t) => tierModel(t, prices)), ['claude-opus-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  assert.deepEqual(modelChoice('claude-fable-5-2', prices), { model: 'claude-fable-5-2' });
  assert.equal(estimate({ model: 'claude-fable-5-2', inputTokens: 1e6, outputTokens: 1e6 }, prices).usd, 48);
});
