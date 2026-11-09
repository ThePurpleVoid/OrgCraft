// The approvals ledger and standing rules (L22; ADR 0013; vision R11.2, R11.3 Now; strings-now.md §6b).
//
// The ledger keeps every decision on an approval in the deciding person's own words (never paraphrased), and every
// standing rule made, used and withdrawn. It is append-only.
//
// A standing rule is the owner deciding in advance, from a fixed list of kinds. The server matches the signed calls
// (ADR 0013) against the rule's structured form, never against anyone's prose, and every rule has a limit per period.
// Some things a rule can never cover (rule.never.*): someone new, going live, deleting, and the next outward act after
// a teammate read outside text. A merge (accept) is never covered in Now.
//
//   GET    /v1/teams/{team}/standing-rules          kinds, the never list, the rules with their use this period
//   POST   /v1/teams/{team}/standing-rules          { kind, ...form, words, days } owner + step-up scoped rule:<form hash>
//   DELETE /v1/teams/{team}/standing-rules/{rule}   withdraw at once (narrowing: no step-up), in the ledger
//   GET    /v1/teams/{team}/ledger                  newest first, { items, next }
import { createHash, randomBytes } from 'node:crypto';
import { canonical } from '../../packages/calls/index.mjs';
import { Problem, getTeam } from './store.mjs';

/** Calendar periods in the team's time zone (CPO ruling): a day from midnight, a week from Monday, a month from the 1st. */
export const PERIODS = { day: 'day', week: 'week', month: 'month' };
/** The fixed list (CPO §6b). Only these three are enforced in Now; the others need data the server does not hold yet. */
export const KINDS = { refund: true, 'pay.known': true, 'send.known': true, reply: false, merge: false, cost: false };
export const NEVER = ['newrecipient', 'live', 'delete', 'passkey', 'outside'];
/** Tools a rule may never cover, by name: deleting things and going live (rule.never.delete, rule.never.live). */
const NEVER_TOOL = /(delete|remove|destroy|drop|purge|wipe|deploy|publish|release|go_?live|promote)/i;
const TOOL = /^mcp__[A-Za-z0-9_-]{1,64}__[A-Za-z0-9_-]{1,64}$/;
const FIELD = /^[A-Za-z0-9_]{1,64}$/;
const WORDS_MAX = 2000;
const DECLINE_DAYS = 7;

const sha = (s) => createHash('sha256').update(s).digest('hex');
const rid = () => `sr_${randomBytes(12).toString('base64url')}`;
const int = (v, what, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) => {
  if (!Number.isSafeInteger(v) || v < min || v > max) throw new Problem(400, `${what} is a whole number from ${min} to ${max}${what.includes('amount') || what === 'maxEach' || what === 'total' ? ' (minor units, like cents)' : ''}`);
  return v;
};

/** The structured form of a rule from a request body, or a 400 saying what is wrong. */
export function ruleForm(body = {}) {
  const kind = body.kind;
  if (!(kind in KINDS)) throw new Problem(400, `kind is one of ${Object.keys(KINDS).join(', ')}`);
  if (!KINDS[kind]) throw new Problem(422, `${kind} rules are not enforced yet; in Now a rule can be refund, pay.known or send.known`, { type: 'rule-kind-later' });
  if (typeof body.tool !== 'string' || !TOOL.test(body.tool)) throw new Problem(400, 'tool is the exact connector tool the rule covers, like mcp__payments__refund');
  if (NEVER_TOOL.test(body.tool)) throw new Problem(422, 'a standing rule can never cover deleting things or going live', { type: 'rule-never' });
  if (typeof body.recipientField !== 'string' || !FIELD.test(body.recipientField)) throw new Problem(400, 'recipientField is the input field that names who it goes to (customer, to, ...)');
  if (!(body.period in PERIODS)) throw new Problem(400, `period is one of ${Object.keys(PERIODS).join(', ')}: every rule has a limit per period`);
  const label = (v, what) => (v === undefined || v === null ? null : typeof v === 'string' && v.length <= 80 ? v : (() => { throw new Problem(400, `${what} is a short name`); })());
  const form = { kind, tool: body.tool, recipientField: body.recipientField, period: body.period, ...shapeOf(body, kind) };
  if (kind === 'send.known') {
    return { ...form, n: int(body.n, 'n', { max: 10_000 }), channel: label(body.channel, 'channel') };
  }
  if (typeof body.amountField !== 'string' || !FIELD.test(body.amountField)) throw new Problem(400, 'amountField is the input field with the amount, in minor units');
  if (typeof body.currency !== 'string' || !/^[A-Z]{3}$/.test(body.currency)) throw new Problem(400, 'currency is a three-letter code, like USD');
  // The call must say its currency, and it is always compared with the rule's (code review sev 3): a money rule with
  // no currency field would take any currency as the rule's.
  if (typeof body.currencyField !== 'string' || !FIELD.test(body.currencyField)) throw new Problem(400, 'currencyField is the input field with the currency, compared with the rule\'s on every call');
  const maxEach = int(body.maxEach, 'maxEach');
  const total = int(body.total, 'total');
  if (total < maxEach) throw new Problem(400, 'total per period is at least maxEach');
  // Refunds may also have a total across all customers (CPO ruling; off by default).
  const all = kind === 'refund' && body.all !== undefined && body.all !== null ? int(body.all, 'all') : null;
  if (all !== null && all < maxEach) throw new Problem(400, 'all (the total across all customers per period) is at least maxEach');
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
  if (!fixed || typeof fixed !== 'object' || Array.isArray(fixed) || Object.keys(fixed).length > 20) throw new Problem(400, 'fixed is an object of at most 20 input fields and the exact value each must have');
  if (!Array.isArray(free) || free.length > 20) throw new Problem(400, 'free is a list of at most 20 input fields that may hold any plain value');
  const own = [body.recipientField, ...(kind === 'send.known' ? [] : [body.amountField, body.currencyField])].filter(Boolean);
  const seen = new Set(own);
  for (const [k, v] of Object.entries(fixed)) {
    if (!FIELD.test(k) || seen.has(k)) throw new Problem(400, `fixed names each input field once, and not the recipient, amount or currency field: ${k}`);
    if (!(typeof v === 'string' ? v.length <= 200 : Number.isSafeInteger(v) || typeof v === 'boolean')) throw new Problem(400, `fixed.${k} is a short text, a whole number or true/false`);
    seen.add(k);
  }
  for (const k of free) {
    if (typeof k !== 'string' || !FIELD.test(k) || seen.has(k)) throw new Problem(400, `free names each input field once, and none already named: ${k}`);
    seen.add(k);
  }
  return { fixed: Object.fromEntries(Object.entries(fixed).sort(([a], [b]) => (a < b ? -1 : 1))), free: [...free].sort() };
}

/** Does this call's input have exactly the fields the rule names, every fixed one as fixed, and nothing nested? */
function fitsShape(f, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const allowed = new Set([f.recipientField, f.amountField, f.currencyField, ...Object.keys(f.fixed ?? {}), ...(f.free ?? [])].filter(Boolean));
  for (const [k, v] of Object.entries(input)) {
    if (!allowed.has(k)) return false;
    if (v !== null && typeof v === 'object') return false;
  }
  // Nothing the rule depends on may be missing ("facts whole", L6): its recipient, amount and currency fields and every
  // fixed field. Free fields are what the line calls "may include", so they may be left out.
  for (const k of [f.recipientField, f.amountField, f.currencyField, ...Object.keys(f.fixed ?? {})].filter(Boolean)) if (!(k in input)) return false;
  for (const [k, v] of Object.entries(f.fixed ?? {})) if (input[k] !== v) return false;
  return true;
}

/** The action classes a rule kind can cover; anything else (a passkey-only change, a deploy, a secret) never is. */
const ACTIONS = { refund: ['payment', 'refund'], 'pay.known': ['payment'], 'send.known': ['outbound-message', 'send', 'message'] };

export const formHash = (form) => sha(`rule/1\n${canonical(form)}`);

/** The one line a rule reads as (CPO §6b patterns), for the ledger and the list. Parts that are not set are left out. */
export function ruleLine(form) {
  // "$20", or "$20.50" when there are cents (strings-now rule.* examples).
  const money = (minor) => new Intl.NumberFormat('en-US', { style: 'currency', currency: form.currency ?? 'USD', ...(minor % 100 === 0 ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : {}) }).format(minor / 100);
  const parts = {
    refund: ['Refunds', `up to ${money(form.maxEach ?? 0)} each`, `at most ${money(form.total ?? 0)} per customer a ${form.period}`, form.all && `at most ${money(form.all)} a ${form.period} in all`, form.system && `in ${form.system}`],
    'pay.known': ['Payments to people you\'ve paid before', `up to ${money(form.maxEach ?? 0)} each`, `at most ${money(form.total ?? 0)} a ${form.period}`, form.system && `in ${form.system}`],
    'send.known': ['Messages to people the team has written to before', form.channel && `in ${form.channel}`, `at most ${form.n} a ${form.period}`],
  }[form.kind];
  // rule.part.with, one per fixed field, then rule.part.fields: every field a covered call may carry, so the line is
  // never narrower than the rule (security sev 2). Anything not listed makes it ask a person.
  const fixed = Object.entries(form.fixed ?? {}).map(([k, v]) => `only when ${k} is "${v}"`);
  const fields = [form.recipientField, form.amountField, form.currencyField, ...(form.free ?? []), ...Object.keys(form.fixed ?? {})].filter(Boolean);
  return [...parts, ...fixed, `may include: ${fields.join(', ')}`].filter(Boolean).join(' · ');
}

/** Has this teammate read outside text (a trigger's outside block) since a person last decided for its session? */
async function readOutside(q, session) {
  if (!session) return false;
  // Since a person last decided for this session: a trigger wake carrying outside text, a call whose output came from
  // outside the team (session.result outside: a web fetch, an email read through a connector), or a step I/O row so
  // marked (security review sev 3).
  const [r] = await q(`with since as (select coalesce((select max(a.decided_at) from approvals a where a.session = $1 and a.state in ('approved', 'denied')
        and a.decided_by not like 'rule:%' and a.decided_by not in ('ledger', 'changed')), '-infinity'::timestamptz) as at)
    select exists(
      select 1 from sessions x join deliveries d on d.run = x.run and d.role = x.role and coalesce(d.instance, '') = coalesce(x.instance, '')
        join events e on e.team = d.team and e.id = d.event
      where x.id = $1 and e.type = 'trigger.fired'
        and exists(select 1 from events s where s.team = e.team and s.id = e.envelope->'data'->>'source' and s.type = 'inbound.received')
        and d.created_at > (select at from since)
    ) or exists(
      select 1 from events e where e.type = 'session.result' and e.envelope->'actor'->>'session' = $1 and e.envelope->'data'->>'outside' = 'true'
        and e.received_at > (select at from since)
    ) or exists(
      select 1 from step_io i where i.session = $1 and i.outside and i.created_at > (select at from since)
    ) as yes`, [session]);
  return Boolean(r?.yes);
}

/** Has the team sent this tool's calls to this recipient before, with a person's yes or under a rule? (rule.never.newrecipient) */
async function known(q, team, rule, tool, field, recipient) {
  // A person's yes (never a rule's or the ledger's), or this rule's own earlier uses (security review low 2).
  const [r] = await q(`select exists(select 1 from approvals a where a.team = $1 and a.state = 'approved' and a.decided_by not like 'rule:%'
        and a.decided_by not in ('ledger', 'changed') and a.calls @> $2::jsonb)
      or exists(select 1 from standing_rule_uses u where u.rule = $4 and u.recipient = $3) as yes`,
  [team, JSON.stringify([{ tool, input: { [field]: recipient } }]), recipient, rule]);
  return Boolean(r?.yes);
}

/**
 * The calendar period `now` is in, in the team's time zone (its budget day's zone when it has one, else UTC):
 * { start, end }. Postgres does the zone arithmetic, so 23- and 25-hour days come out right, as for the budget day.
 */
export async function periodOf(q, team, period, now) {
  const unit = PERIODS[period] ?? 'day';
  const [r] = await q(`with z as (select coalesce((select to_jsonb(b)->>'time_zone' from budgets b where b.team = $1
        and exists(select 1 from pg_timezone_names n where n.name = to_jsonb(b)->>'time_zone')), 'UTC') as tz)
    select date_trunc($2, $3::timestamptz at time zone z.tz) at time zone z.tz as start,
      (date_trunc($2, $3::timestamptz at time zone z.tz) + ('1 ' || $2)::interval) at time zone z.tz as "end" from z`, [team, unit, now]);
  return { start: new Date(r.start), end: new Date(r.end) };
}

/**
 * Which live rule covers every one of these signed calls, within its limits, or null. Locks the rules it reads, so two
 * asks at once cannot both spend the last of a limit. Returns { rule, uses: [{ amount, recipient }] }.
 */
export async function coveredBy(ctx, team, { action, bound, session }) {
  if (!bound || action === 'accept') return null;
  if (bound.calls.some((c) => NEVER_TOOL.test(c.tool))) return null;
  const rules = await ctx.q("select id, kind, spec, words from standing_rules where team = $1 and withdrawn_at is null and expires_at > $2 order by created_at for update", [team, ctx.now]);
  if (!rules.length) return null;
  if (await readOutside(ctx.q, session)) return null; // rule.never.outside
  for (const rule of rules) {
    const f = rule.spec;
    const uses = [];
    let ok = true;
    for (const c of bound.calls) {
      const recipient = c.input?.[f.recipientField];
      if (c.tool !== f.tool || !ACTIONS[f.kind].includes(action) || !fitsShape(f, c.input) || typeof recipient !== 'string' || !recipient || recipient.length > 200) { ok = false; break; }
      let amount = null;
      if (f.amountField) {
        amount = c.input?.[f.amountField];
        const cur = f.currencyField ? String(c.input?.[f.currencyField] ?? '').toUpperCase() : f.currency;
        if (!Number.isSafeInteger(amount) || amount < 0 || amount > f.maxEach || cur !== f.currency) { ok = false; break; }
      }
      if (f.kind !== 'refund' && !(await known(ctx.q, team, rule.id, f.tool, f.recipientField, recipient))) { ok = false; break; }
      uses.push({ amount, recipient });
    }
    if (!ok) continue;
    const { start: since } = await periodOf(ctx.q, team, f.period, ctx.now);
    if (f.kind === 'send.known') {
      const [{ n }] = await ctx.q('select count(*)::int as n from standing_rule_uses where rule = $1 and at >= $2', [rule.id, since]);
      if (n + uses.length > f.n) continue;
    } else if (f.kind === 'refund') {
      // Per customer per period.
      const per = {};
      for (const u of uses) per[u.recipient] = (per[u.recipient] ?? 0) + u.amount;
      let over = false;
      for (const [r, add] of Object.entries(per)) {
        const [{ s }] = await ctx.q('select coalesce(sum(amount), 0)::bigint as s from standing_rule_uses where rule = $1 and recipient = $2 and at >= $3', [rule.id, r, since]);
        if (Number(s) + add > f.total) over = true;
      }
      // And the total across all customers, when the rule has one: whichever is hit first sends it to a person.
      if (!over && f.all) {
        const [{ s }] = await ctx.q('select coalesce(sum(amount), 0)::bigint as s from standing_rule_uses where rule = $1 and at >= $2', [rule.id, since]);
        if (Number(s) + uses.reduce((a, u) => a + u.amount, 0) > f.all) over = true;
      }
      if (over) continue;
    } else {
      const [{ s }] = await ctx.q('select coalesce(sum(amount), 0)::bigint as s from standing_rule_uses where rule = $1 and at >= $2', [rule.id, since]);
      if (Number(s) + uses.reduce((a, u) => a + u.amount, 0) > f.total) continue;
    }
    return { rule, uses };
  }
  return null;
}

/**
 * Input fields that name who or what a call acts on: a recipient, payee, customer or account, by any of their usual
 * names (customer, customer_id, customerId, to, bcc, email, account ...). Declines match on their values with the same
 * tool (the system and the effect), whatever field carries them (code review sev 3): a re-ask for $63.99 in place of
 * $64.00, the same email reworded, a renamed field or one more target field is still the thing that was declined.
 */
const TARGET = /^(to|cc|bcc|recipients?|customer|payee|account|email|user|channel|phone|number|destination|member|contact)(_?id)?$|(_id|Id)$/i;

/**
 * The (tool, target value) pairs of a set of signed calls, looking into nested objects (three levels: `customer: { id }`
 * counts as the customer). A call with no target adds nothing; null only when no call names one, and then only the
 * exact calls match (code review sev 4).
 */
export function targetsOf(calls) {
  if (!Array.isArray(calls) || !calls.length) return null;
  const out = new Set();
  const walk = (tool, obj, depth, under) => {
    if (depth > 3 || !obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      const hit = under || TARGET.test(k);
      for (const x of Array.isArray(v) ? v : [v]) {
        if (x && typeof x === 'object') walk(tool, x, depth + 1, hit);
        else if (hit && ((typeof x === 'string' && x.trim()) || typeof x === 'number')) out.add(`${tool}\n${String(x).trim().toLowerCase()}`);
      }
    }
  };
  for (const c of calls) walk(c.tool, c.input ?? {}, 0, false);
  return out.size ? [...out].sort() : null;
}

/**
 * An earlier "no" from a person in this team, within 7 days (declines stick, AI-10), to the same effect on the same
 * target (or the exact same calls). `exact` says whether nothing at all changed.
 */
export async function declinedBefore(ctx, team, hash, targets = null) {
  if (!hash) return null;
  const [r] = await ctx.q(`select id, decided_at, decided_by, calls_hash = $2 as exact from approvals where team = $1
    and (calls_hash = $2 or ($5::text[] is not null and effect_targets && $5::text[])) and state = 'denied'
    and decided_by not like 'rule:%' and decided_by not in ('ledger', 'changed') and decided_at > $3::timestamptz - make_interval(days => $4)
    order by (calls_hash = $2) desc, decided_at desc limit 1`, [team, hash, ctx.now, DECLINE_DAYS, targets]);
  return r ? { ...r, until: new Date(new Date(r.decided_at).getTime() + DECLINE_DAYS * 86_400_000) } : null;
}

/** One ledger line. `words` are the person's own, kept exactly (cut only by the column's 4,000). */
export async function ledgerRow(q, tenant, team, { kind, approval = null, rule = null, by, words = null, callsHash = null, channel = null }) {
  await q('insert into approval_ledger(tenant, team, kind, approval, rule, by, words, calls_hash, channel) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [tenant, team, kind, approval, rule, by, typeof words === 'string' && words ? words.slice(0, 4000) : null, callsHash, channel]);
}

export function createLedger({ db, m3, now = () => new Date() }) {
  /**
   * Display names (name, else login) for principals who are or were members of this tenant; anyone else (the server's
   * own, a rule, someone never a member) has none. Read outside any tenant transaction (one connection on PGlite).
   */
  async function namesOf(tenant, ids) {
    const want = [...new Set(ids.filter((x) => typeof x === 'string' && x.startsWith('per_')))];
    if (!want.length) return new Map();
    const rows = await db.system(`select distinct p.id, coalesce(nullif(p.name, ''), p.login) as name from people p
      join members m on m.person = p.id and m.tenant = $1 where p.id = any($2)`, [tenant, want]);
    return new Map(rows.map((x) => [x.id, x.name]));
  }
  const nameIn = (names, id) => (id ? names.get(id) ?? null : null);
  const view = (r, n, at, names = new Map()) => ({ id: r.id, number: n, kind: r.kind, form: r.spec, line: ruleLine(r.spec), words: r.words, createdBy: r.created_by, createdByName: nameIn(names, r.created_by), createdAt: new Date(r.created_at).toISOString(),
    expiresAt: new Date(r.expires_at).toISOString(), ...(r.withdrawn_at ? { withdrawnAt: new Date(r.withdrawn_at).toISOString(), withdrawnBy: r.withdrawn_by, withdrawnByName: nameIn(names, r.withdrawn_by) } : {}),
    live: !r.withdrawn_at && new Date(r.expires_at) > at, used: { n: Number(r.used_n), ...(r.spec.amountField ? { amount: Number(r.used_amount) } : {}), resetsAt: r.resets_at ? new Date(r.resets_at).toISOString() : null } });

  async function list(tenant, team) {
    await getTeam(db, tenant, team);
    const at = now();
    const rows = await db.tenant(tenant, async ({ q }) => {
      const bounds = {};
      for (const p of Object.keys(PERIODS)) bounds[p] = await periodOf(q, team, p, at);
      const out = await q('select r.*, row_number() over (order by r.created_at, r.id) as n from standing_rules r where r.team = $1 order by r.created_at desc, r.id desc', [team]);
      for (const r of out) {
        const b = bounds[r.spec.period] ?? bounds.day;
        const [u] = await q('select count(*)::int as n, coalesce(sum(amount), 0)::bigint as amount from standing_rule_uses where rule = $1 and at >= $2', [r.id, b.start]);
        Object.assign(r, { used_n: u.n, used_amount: u.amount, resets_at: b.end });
      }
      return out;
    });
    const names = await namesOf(tenant, rows.flatMap((r) => [r.created_by, r.withdrawn_by]));
    return { kinds: Object.entries(KINDS).map(([id, enforced]) => ({ id, enforced })), never: NEVER, rules: rows.map((r) => view(r, Number(r.n), at, names)) };
  }

  async function add(tenant, team, body, who, stepUp) {
    await getTeam(db, tenant, team);
    if (who.role !== 'owner') throw new Problem(403, 'only an owner makes a standing rule', { type: 'forbidden' });
    const form = ruleForm(body ?? {});
    const words = typeof body?.words === 'string' ? body.words.trim() : '';
    if (words.length < 3 || words.length > WORDS_MAX) throw new Problem(400, 'words are the owner\'s own reason, kept in the ledger exactly as written (3 to 2,000 characters)');
    const days = body?.days === undefined ? 30 : int(body.days, 'days', { max: 90 });
    const hash = formHash(form);
    // ADR 0013 rule 2: a standing rule is a capability change, so the step-up names this exact rule.
    await m3.requireStepUp(tenant, who.principal, stepUp, 'Making a standing rule', `rule:${hash}`);
    const at = now();
    const id = rid();
    await m3.tx(tenant, async (ctx) => {
      await ctx.q('insert into standing_rules(id, tenant, team, kind, spec, spec_hash, words, created_by, created_at, expires_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [id, tenant, team, form.kind, JSON.stringify(form), hash, words, who.principal, at, new Date(at.getTime() + days * 86_400_000)]);
      await ledgerRow(ctx.q, tenant, team, { kind: 'rule-added', rule: id, by: who.principal, words });
      await ctx.audit({ team, actorKind: 'person', actorId: who.principal, action: 'standing-rule', target: id, decision: 'allowed', detail: { op: 'add', form, hash } });
    });
    return { id, form, line: ruleLine(form), hash, expiresAt: new Date(at.getTime() + days * 86_400_000).toISOString() };
  }

  async function withdraw(tenant, team, rule, who) {
    await getTeam(db, tenant, team);
    return m3.tx(tenant, async (ctx) => {
      const gone = await ctx.q('update standing_rules set withdrawn_at = $3, withdrawn_by = $4 where id = $1 and team = $2 and withdrawn_at is null returning id', [rule, team, ctx.now, who.principal]);
      if (!gone.length) throw new Problem(404, 'no such live rule');
      await ledgerRow(ctx.q, tenant, team, { kind: 'rule-withdrawn', rule, by: who.principal });
      await ctx.audit({ team, actorKind: 'person', actorId: who.principal, action: 'standing-rule', target: rule, decision: 'allowed', detail: { op: 'withdraw' } });
      return { id: rule, withdrawn: true };
    });
  }

  async function ledger(tenant, team, { limit = 50, before = null } = {}) {
    await getTeam(db, tenant, team);
    const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
    if (before !== null && before !== undefined && before !== '' && !/^\d{1,18}$/.test(String(before))) throw new Problem(400, 'before is the next value of the previous page');
    const rows = await db.tenant(tenant, ({ q }) => q(`select l.*, a.action, a.calls, a.role, c.card as card, s.spec as rule_spec,
        (select count(*)::int from standing_rules x where x.team = s.team and (x.created_at, x.id) <= (s.created_at, s.id)) as rule_number
      from approval_ledger l left join approvals a on a.id = l.approval left join cards c on c.id = a.card left join standing_rules s on s.id = l.rule
      where l.team = $1 and ($2::bigint is null or l.id < $2) order by l.id desc limit $3`, [team, before || null, n]));
    const names = await namesOf(tenant, rows.map((r) => r.by));
    // {what}: the first fact the server rendered from the signed calls, else the card's title.
    const whatOf = (card) => (Array.isArray(card?.data?.facts) && card.data.facts[0]?.text ? String(card.data.facts[0].text) : card?.title ?? null);
    const items = rows.map((r) => ({ at: new Date(r.at).toISOString(), kind: r.kind, by: r.by, name: nameIn(names, r.by), words: r.words ?? null, channel: r.channel ?? null,
      // {letter}: the ask's letter once cards carry lettered asks; none yet.
      ...(r.approval ? { approval: r.approval, action: r.action, role: r.role, what: whatOf(r.card), letter: r.card?.data?.letter ?? null } : {}),
      ...(r.rule ? { rule: r.rule, ruleNumber: r.rule_spec ? Number(r.rule_number) : null, ruleForm: r.rule_spec ?? null, ruleLine: r.rule_spec ? ruleLine(r.rule_spec) : null } : {}),
      ...(r.calls_hash ? { callsHash: r.calls_hash } : {}) }));
    return { items, next: rows.length === n ? String(rows.at(-1).id) : null };
  }

  return { list, add, withdraw, ledger };
}
