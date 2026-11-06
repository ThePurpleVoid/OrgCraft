// Reads the shared price table from disk (Node only). index.mjs stays pure for the browser.
import { readFileSync } from 'node:fs';

const FILE = new URL('./prices.json', import.meta.url);

/** The kit's dated price table (prices.json next to this file). */
export function loadPrices() {
  return JSON.parse(readFileSync(FILE, 'utf8'));
}
