// The model price table and the tier-to-model map, shared by the Studio (estimates), the runner (which model a tier
// runs on, and a cost fallback when the SDK reports none) and the server. One copy: prices.json in this folder.
// Pure, like packages/team-model: no file system, so the browser can use it. Callers pass the table in;
// node.mjs reads it from disk.
//
//   tierModel(tier, table, overrides)  → model id      overrides: { <tier>: <model> } from the runner config
//   priceOf(model, table)              → the model's row, or null
//   estimate(usage, table)             → { usd, model, asOf }   usage: { model | tier, inputTokens, outputTokens, ... }
//
// The SDK's own reported cost (total_cost_usd) stays the source of truth for money spent; this table is for
// estimates before a run and for a run whose SDK reports no cost.

export const PRICES_SCHEMA = 'agent-team/model-prices@1';
export const TIERS = ['deep', 'standard', 'routine', 'light'];

/** The model a tier runs on: an override first, then the table; an unknown tier runs as standard. */
export function tierModel(tier, table, overrides = {}) {
  const map = { ...table.tiers, ...overrides };
  return map[tier] ?? map.standard;
}

/** The price row of a model, or null when the table does not list it. */
export function priceOf(model, table) {
  return table.models?.[model] ?? null;
}

/** What some usage costs at list price: { usd, model, asOf }; usd is null when the model is not in the table. */
export function estimate({ model, tier, inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0 } = {}, table, overrides) {
  const id = model ?? tierModel(tier ?? 'standard', table, overrides);
  const p = priceOf(id, table);
  if (!p) return { usd: null, model: id, asOf: table.asOf };
  const usd = (inputTokens * p.inputPerMTok + outputTokens * p.outputPerMTok
    + cacheReadTokens * (p.cacheReadPerMTok ?? p.inputPerMTok) + cacheWriteTokens * (p.cacheWritePerMTok ?? p.inputPerMTok)) / 1e6;
  return { usd, model: id, asOf: table.asOf };
}

/** Problems with a price table, as strings: the schema, every tier mapped to a listed model, numbers that are prices. */
export function checkPrices(table) {
  const out = [];
  if (table?.schema !== PRICES_SCHEMA) out.push(`schema must be ${PRICES_SCHEMA}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(table?.asOf ?? '')) out.push('asOf must be a date (YYYY-MM-DD)');
  for (const t of TIERS) if (!table?.models?.[table?.tiers?.[t]]) out.push(`tier ${t} runs on "${table?.tiers?.[t]}", which has no price`);
  for (const [id, p] of Object.entries(table?.models ?? {})) {
    for (const k of ['inputPerMTok', 'outputPerMTok']) if (!(typeof p[k] === 'number' && p[k] >= 0)) out.push(`${id}: ${k} must be a number`);
  }
  return out;
}
