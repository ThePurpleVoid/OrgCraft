# model-prices

One dated table of model prices, and which model each tier runs on. The Studio uses it for cost estimates (meetings, "Try it on a task"), the runner for the tier-to-model map and as a cost fallback when the SDK reports none. The SDK's own reported cost stays the source of truth for money actually spent.

```js
import { estimate, tierModel } from './index.mjs';
import { loadPrices } from './node.mjs';      // or fetch prices.json in the browser

const prices = loadPrices();
tierModel('routine', prices);                // 'claude-sonnet-5-5'
estimate({ tier: 'deep', inputTokens: 20000, outputTokens: 1500 }, prices); // { usd: 0.11, model, asOf: '2026-11-10' }
```

`prices.json` (`agent-team/model-prices@1`): `asOf` (the date the prices were read), `currency`, `tiers` (deep, standard, routine, light → model id) and `models` (per million tokens: `inputPerMTok`, `outputPerMTok`, `cacheReadPerMTok`, `cacheWritePerMTok`). Every estimate shown to a person carries `asOf` ("Estimate, prices as of 10 Nov 2026").

When prices change, update the numbers and `asOf` in one pull request; `tests/model-prices.test.mjs` checks the table.
