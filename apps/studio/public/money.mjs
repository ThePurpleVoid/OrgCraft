// Money in whole minor units (packages/calls/money.mjs re-exports this file), by each currency's own ISO 4217 exponent (code review L22m): USD has 2 decimals, JPY
// none, KWD and BHD three. "up to ¥2,500" is 2500 and 2.500 KWD is 2500, so a rule's line and the calls it is compared
// with mean the same amount. Pure and browser-safe (Intl only).

let known = null;
/** Is this an ISO 4217 code this runtime knows (Intl.supportedValuesOf)? Codes are upper case. */
export function knownCurrency(code) {
  if (typeof code !== 'string' || !/^[A-Z]{3}$/.test(code)) return false;
  known ??= new Set(typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('currency') : []);
  // A runtime without the list knows codes by formatting them; an unknown one still fails the check above.
  return known.size ? known.has(code) : (() => { try { new Intl.NumberFormat('en-US', { style: 'currency', currency: code }); return true; } catch { return false; } })();
}

/** The currency's minor-unit exponent: USD 2, JPY 0, KWD 3. */
export function minorDigits(currency) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
}

/**
 * Whole minor units as money, without decimals when there are none: $20, $20.50, ¥2,500, KWD 2.500. `digits` is a
 * rule's pinned exponent (security L22mu): the line reads by the exponent the owner confirmed, not this runtime's ICU.
 */
export function formatMinor(minor, currency = 'USD', locale = 'en-US', digits = minorDigits(currency)) {
  const d = digits;
  const n = Number(minor ?? 0);
  const whole = n % 10 ** d === 0;
  return new Intl.NumberFormat(locale, { style: 'currency', currency, ...(whole ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : { minimumFractionDigits: d, maximumFractionDigits: d }) }).format(n / 10 ** d);
}
