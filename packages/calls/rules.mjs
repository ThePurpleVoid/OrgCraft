// Standing rules' form and line (L22; ADR 0013; strings-now.md §6b), shared by the control plane and the Studio page:
// the page shows the line the ledger will quote, word for word, because it is this code on the same normalised form.
// Pure and browser-safe: no node: imports. Errors are RuleError { status, type?, message }; the server makes them
// problem+json. The form's hash and the step-up scope stay on the server (POST standing-rules answers 401 with it).

/** A rule the form cannot be: `status` is the HTTP status the server answers with, `type` its problem type. */
export class RuleError extends Error {
  constructor(status, message, { type = null } = {}) { super(message); this.name = 'RuleError'; this.status = status; this.type = type; }
}

/** Calendar periods in the team's time zone (CPO ruling): a day from midnight, a week from Monday, a month from the 1st. */
export const PERIODS = { day: 'day', week: 'week', month: 'month' };
/** The fixed list (CPO §6b). Only these three are enforced in Now; the others need data the server does not hold yet. */
export const KINDS = { refund: true, 'pay.known': true, 'send.known': true, reply: false, merge: false, cost: false };
export const NEVER = ['newrecipient', 'live', 'delete', 'passkey', 'outside'];
/** Tools a rule may never cover, by name: deleting things and going live (rule.never.delete, rule.never.live). */
export const NEVER_TOOL = /(delete|remove|destroy|drop|purge|wipe|deploy|publish|release|go_?live|promote)/i;
export const TOOL = /^mcp__[A-Za-z0-9_-]{1,64}__[A-Za-z0-9_-]{1,64}$/;
export const FIELD = /^[A-Za-z0-9_]{1,64}$/;

export const int = (v, what, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) => {
  if (!Number.isSafeInteger(v) || v < min || v > max) throw new RuleError(400, `${what} is a whole number from ${min} to ${max}${what.includes('amount') || what === 'maxEach' || what === 'total' ? ' (minor units, like cents)' : ''}`);
  return v;
};

/** The structured form of a rule from a request body, or a 400 saying what is wrong. */
export function ruleForm(body = {}) {
  const kind = body.kind;
  if (!(kind in KINDS)) throw new RuleError(400, `kind is one of ${Object.keys(KINDS).join(', ')}`);
  if (!KINDS[kind]) throw new RuleError(422, `${kind} rules are not enforced yet; in Now a rule can be refund, pay.known or send.known`, { type: 'rule-kind-later' });
  if (typeof body.tool !== 'string' || !TOOL.test(body.tool)) throw new RuleError(400, 'tool is the exact connector tool the rule covers, like mcp__payments__refund');
  if (NEVER_TOOL.test(body.tool)) throw new RuleError(422, 'a standing rule can never cover deleting things or going live', { type: 'rule-never' });
  if (typeof body.recipientField !== 'string' || !FIELD.test(body.recipientField)) throw new RuleError(400, 'recipientField is the input field that names who it goes to (customer, to, ...)');
  if (!(body.period in PERIODS)) throw new RuleError(400, `period is one of ${Object.keys(PERIODS).join(', ')}: every rule has a limit per period`);
  const label = (v, what) => (v === undefined || v === null ? null : typeof v === 'string' && v.length <= 80 ? v : (() => { throw new RuleError(400, `${what} is a short name`); })());
  const form = { kind, tool: body.tool, recipientField: body.recipientField, period: body.period, ...shapeOf(body, kind) };
  if (kind === 'send.known') {
    return { ...form, n: int(body.n, 'n', { max: 10_000 }), channel: label(body.channel, 'channel') };
  }
  if (typeof body.amountField !== 'string' || !FIELD.test(body.amountField)) throw new RuleError(400, 'amountField is the input field with the amount, in minor units');
  if (typeof body.currency !== 'string' || !/^[A-Z]{3}$/.test(body.currency)) throw new RuleError(400, 'currency is a three-letter code, like USD');
  // The call must say its currency, and it is always compared with the rule's (code review sev 3): a money rule with
  // no currency field would take any currency as the rule's.
  if (typeof body.currencyField !== 'string' || !FIELD.test(body.currencyField)) throw new RuleError(400, 'currencyField is the input field with the currency, compared with the rule\'s on every call');
  const maxEach = int(body.maxEach, 'maxEach');
  const total = int(body.total, 'total');
  if (total < maxEach) throw new RuleError(400, 'total per period is at least maxEach');
  // Refunds may also have a total across all customers (CPO ruling; off by default).
  const all = kind === 'refund' && body.all !== undefined && body.all !== null ? int(body.all, 'all') : null;
  if (all !== null && all < maxEach) throw new RuleError(400, 'all (the total across all customers per period) is at least maxEach');
  return { ...form, amountField: body.amountField, currency: body.currency, currencyField: body.currencyField, maxEach, total, ...(all !== null ? { all } : {}), system: label(body.system, 'system') };
}

/**
 * The call's shape a rule allows (security review sev 2): `fixed` input fields that must equal these values, and
 * `free` fields that may hold any plain value. A covered call has no other field and nothing nested, so the owner's
 * rule is never wider than what they read. Both are in the form, so in its hash and its line.
 */
function shapeOf(body, kind) {
  const fixed = body.fixed ?? {};
  const free = body.free ?? [];
  if (!fixed || typeof fixed !== 'object' || Array.isArray(fixed) || Object.keys(fixed).length > 20) throw new RuleError(400, 'fixed is an object of at most 20 input fields and the exact value each must have');
  if (!Array.isArray(free) || free.length > 20) throw new RuleError(400, 'free is a list of at most 20 input fields that may hold any plain value');
  const own = [body.recipientField, ...(kind === 'send.known' ? [] : [body.amountField, body.currencyField])].filter(Boolean);
  const seen = new Set(own);
  for (const [k, v] of Object.entries(fixed)) {
    if (!FIELD.test(k) || seen.has(k)) throw new RuleError(400, `fixed names each input field once, and not the recipient, amount or currency field: ${k}`);
    if (!(typeof v === 'string' ? v.length <= 200 : Number.isSafeInteger(v) || typeof v === 'boolean')) throw new RuleError(400, `fixed.${k} is a short text, a whole number or true/false`);
    seen.add(k);
  }
  for (const k of free) {
    if (typeof k !== 'string' || !FIELD.test(k) || seen.has(k)) throw new RuleError(400, `free names each input field once, and none already named: ${k}`);
    seen.add(k);
  }
  return { fixed: Object.fromEntries(Object.entries(fixed).sort(([a], [b]) => (a < b ? -1 : 1))), free: [...free].sort() };
}

/**
 * How many minor units a currency's major unit has, as a power of ten (code review, L22m): USD 2, JPY 0, KWD 3. Amounts
 * in rules and calls are whole minor units, so "up to ¥2,500" is maxEach 2500, and 2.500 KWD is 2500.
 */
export function minorDigits(currency) {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits; } catch { return 2; }
}

/** Whole minor units as money, without decimals when there are none: $20, $20.50, ¥2,500, KWD 2.500. */
export function formatMinor(minor, currency = 'USD') {
  const d = minorDigits(currency);
  const whole = minor % 10 ** d === 0;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, ...(whole ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : { minimumFractionDigits: d, maximumFractionDigits: d }) }).format(minor / 10 ** d);
}

/** An input field as words (CPO rule.part.fields.names): customer_email, customerEmail and customer.email read "customer email". */
export function fieldName(field) {
  return String(field).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_.\-]+/g, ' ').trim().toLowerCase();
}

/** The one line a rule reads as (CPO §6b patterns), for the ledger and the list. Parts that are not set are left out. */
export function ruleLine(form) {
  // "$20", or "$20.50" when there are cents (strings-now rule.* examples).
  const money = (minor) => formatMinor(minor, form.currency ?? 'USD');
  const parts = {
    refund: ['Refunds', `up to ${money(form.maxEach ?? 0)} each`, `at most ${money(form.total ?? 0)} per customer a ${form.period}`, form.all && `at most ${money(form.all)} a ${form.period} in all`, form.system && `in ${form.system}`],
    'pay.known': ['Payments to people you\'ve paid before', `up to ${money(form.maxEach ?? 0)} each`, `at most ${money(form.total ?? 0)} a ${form.period}`, form.system && `in ${form.system}`],
    'send.known': ['Messages to people the team has written to before', form.channel && `in ${form.channel}`, `at most ${form.n} a ${form.period}`],
  }[form.kind];
  // rule.part.with, one per fixed field, then rule.part.fields: every field a covered call may carry, so the line is
  // never narrower than the rule (security sev 2). Anything not listed makes it ask a person.
  const fixed = Object.entries(form.fixed ?? {}).map(([k, v]) => `only when ${fieldName(k)} is "${v}"`);
  const fields = [form.recipientField, form.amountField, form.currencyField, ...(form.free ?? []), ...Object.keys(form.fixed ?? {})].filter(Boolean);
  return [...parts, ...fixed, `may include: ${fields.map(fieldName).join(', ')}`].filter(Boolean).join(' · ');
}

