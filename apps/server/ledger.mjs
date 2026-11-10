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
import { KINDS, NEVER, NEVER_TOOL, PERIODS, RuleError, int as intCore, minorDigits, ruleForm as ruleFormCore, ruleLine } from '../../packages/calls/rules.mjs';

export { KINDS, NEVER, PERIODS, ruleLine };

const WORDS_MAX = 2000;
const DECLINE_DAYS = 7;

const sha = (s) => createHash('sha256').update(s).digest('hex');
const rid = () => `sr_${randomBytes(12).toString('base64url')}`;
/** rules.mjs's int, as a problem+json 400. */
const int = (...a) => problems(() => intCore(...a));

/** The structured form of a rule from a request body, or the problem saying what is wrong (packages/calls/rules.mjs). */
export function ruleForm(body = {}) { return problems(() => ruleFormCore(body)); }
const problems = (fn) => { try { return fn(); } catch (e) { if (e instanceof RuleError) throw new Problem(e.status, e.message, e.type ? { type: e.type } : {}); throw e; } };

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
/** The step-up scope for making a rule: its form and how many days it lasts (security L22m), so the passkey covers both. */
export const ruleScope = (form, days = 30) => `rule:${sha(`rule/2\n${canonical({ days, form })}`)}`;

/**
 * Is this rule no wider than the draft it was made from? The same kind, tool, recipient, amount and currency fields and
 * currency; fixed and free fields only from the call's own other fields. Limits, period, days and labels are the owner's.
 */
export function fromDraft(form, d) {
  for (const k of ['kind', 'tool', 'recipientField', 'amountField', 'currencyField', 'currency']) if ((form[k] ?? null) !== (d[k] ?? null)) return false;
  // A field the draft fixed stays fixed to the approved value, or is left out (narrower); never moved to free (code
  // review L22m sev 3). A free field may be left free, fixed to a value, or left out.
  const draftFixed = d.fixed ?? {};
  const draftFree = new Set(d.free ?? []);
  for (const [k, v] of Object.entries(form.fixed ?? {})) if (k in draftFixed ? draftFixed[k] !== v : !draftFree.has(k)) return false;
  return (form.free ?? []).every((k) => draftFree.has(k));
}

/** Why an approval cannot become a standing rule (rule-draft's 409 reason). */
export const DRAFT_REASONS = ['not-approved', 'unbound', 'many-calls', 'never', 'kind-later', 'no-recipient', 'no-amount', 'nested'];
const RECIPIENT = ['customer', 'customer_id', 'customerId', 'to', 'recipient', 'recipient_id', 'email', 'user', 'user_id', 'account', 'account_id', 'payee', 'channel', 'chat_id'];
const AMOUNT = ['amount', 'amount_cents', 'amountCents', 'amount_minor', 'value', 'total'];

/**
 * The draft form for one signed call (rule-draft): the kind from the action class (a refund tool or action is a
 * refund, other payments pay.known, messages send.known), the recipient, amount and currency fields by their usual
 * names, other target fields fixed to the approved value and content fields free (so the rule is no wider than the
 * call), and the defaults: a week, maxEach the
 * amount rounded up to a whole unit, total three times that, 50 messages. `no(reason, why)` throws the 409.
 */
export function draftForm(action, calls, no) {
  if (!Array.isArray(calls) || !calls.length) no('unbound', 'this ask has no signed call to make a rule from');
  if (calls.length !== 1) no('many-calls', 'this ask covers several calls; a rule is made from one');
  const { tool, input } = calls[0];
  if (typeof tool !== 'string' || !/^mcp__/.test(tool) || NEVER_TOOL.test(tool)) no('never', 'a standing rule can never cover this kind of action');
  const kind = /refund/i.test(`${action} ${tool}`) ? 'refund' : action === 'payment' ? 'pay.known' : ['outbound-message', 'send', 'message'].includes(action) ? 'send.known' : null;
  if (!kind) no('kind-later', 'rules for this kind of action are not available yet');
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.values(input).some((v) => v !== null && typeof v === 'object')) no('nested', 'the call carries nested data, so no rule can match it exactly');
  const recipientField = RECIPIENT.find((k) => typeof input[k] === 'string' && input[k]);
  if (!recipientField) no('no-recipient', 'the call does not say who it goes to in a field a rule can use');
  const system = tool.split('__')[1];
  let form = { kind, tool, recipientField, period: 'week' };
  const used = new Set([recipientField]);
  if (kind === 'send.known') form = { ...form, n: 50, channel: system };
  else {
    const amountField = AMOUNT.find((k) => Number.isSafeInteger(input[k]) && input[k] > 0);
    const currencyField = ['currency', 'currency_code', 'currencyCode'].find((k) => typeof input[k] === 'string' && /^[A-Za-z]{3}$/.test(input[k]));
    if (!amountField || !currencyField) no('no-amount', 'the call does not say its amount and currency in fields a rule can use');
    const unit = 10 ** minorDigits(input[currencyField].toUpperCase());
    const maxEach = Math.ceil(input[amountField] / unit) * unit;
    form = { ...form, amountField, currencyField, currency: input[currencyField].toUpperCase(), maxEach, total: maxEach * 3, system };
    used.add(amountField); used.add(currencyField);
  }
  // Fields that name who or where else it goes (cc, bcc, destination, account, *_id: the ledger's TARGET) keep the
  // approved value as `fixed` (code review L22m sev 3): a rule from one message to a known `to` must not let later ones
  // bcc anyone, nor a refund route to another destination. Only content fields (subject, body, note ...) stay free.
  const other = Object.keys(input).filter((k) => !used.has(k) && /^[A-Za-z0-9_]{1,64}$/.test(k));
  const fixed = Object.fromEntries(other.filter((k) => TARGET.test(k) && input[k] !== null).map((k) => [k, input[k]]));
  const free = other.filter((k) => !TARGET.test(k));
  if (other.length > 20 || Object.keys(fixed).length > 20) no('nested', 'the call carries more fields than a rule can name');
  try { return ruleForm({ ...form, fixed, free }); } catch (e) { return no(e.type === 'rule-never' ? 'never' : 'kind-later', e.message); }
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
      // Below a target key only id-like keys count (`customer: { id, email }`), never its country or currency.
      const hit = TARGET.test(k) || (under && /^(id|email|key|ref)$/i.test(k));
      for (const x of Array.isArray(v) ? v : [v]) {
        if (x && typeof x === 'object') walk(tool, x, depth + 1, TARGET.test(k));
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
export async function ledgerRow(q, tenant, team, { kind, approval = null, rule = null, by, words = null, callsHash = null, channel = null, tap = null, letters = null }) {
  await q('insert into approval_ledger(tenant, team, kind, approval, rule, by, words, calls_hash, channel, tap, letters) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
    [tenant, team, kind, approval, rule, by, typeof words === 'string' && words ? words.slice(0, 4000) : null, callsHash, channel, tap, letters?.length ? letters.join(',') : null]);
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
    // Made from an approval ("Make this a standing rule"): bound to that approval's draft, never wider, and at most one
    // rule from it, even from two windows (qa-web D1, CTO).
    const from = body?.approval ?? null;
    if (from !== null && (typeof from !== 'string' || !from || from.length > 100)) throw new Problem(400, 'approval is the id of the approval the rule is made from');
    if (from !== null) {
      const { draft: d, made } = await approvedDraft(tenant, team, from);
      if (made) throw new Problem(409, `standing rule #${made.number} was already made from this approval`, { type: 'rule-exists', body: { id: made.id, number: made.number } });
      if (!fromDraft(form, d)) throw new Problem(400, 'the rule is wider than the approval it is made from: the same kind, tool, recipient, amount and currency fields, and only the call\'s other fields', { type: 'rule-not-from-draft' });
    }
    const hash = formHash(form);
    // ADR 0013 rule 2: a standing rule is a capability change, so the step-up names this exact rule and how long it lasts.
    await m3.requireStepUp(tenant, who.principal, stepUp, 'Making a standing rule', ruleScope(form, days));
    const at = now();
    const id = rid();
    await m3.tx(tenant, async (ctx) => {
      // The unique index settles two windows at once: the second insert fails and is answered as rule-exists.
      try {
        await ctx.q('insert into standing_rules(id, tenant, team, kind, spec, spec_hash, words, created_by, created_at, expires_at, from_approval) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
          [id, tenant, team, form.kind, JSON.stringify(form), hash, words, who.principal, at, new Date(at.getTime() + days * 86_400_000), from]);
      } catch (e) {
        if (from !== null && (e?.code === '23505' || /standing_rules_from_approval/.test(String(e?.message)))) {
          const [made] = await madeFrom(tenant, team, from).catch(() => []);
          throw new Problem(409, 'a standing rule was already made from this approval', { type: 'rule-exists', body: made ? { id: made.id, number: made.number } : {} });
        }
        throw e;
      }
      await ledgerRow(ctx.q, tenant, team, { kind: 'rule-added', rule: id, by: who.principal, words });
      await ctx.audit({ team, actorKind: 'person', actorId: who.principal, action: 'standing-rule', target: id, decision: 'allowed', detail: { op: 'add', form, hash } });
    });
    // {n} of rule.made: the same count the list and the ledger use (rules on this team by when they were made).
    const [{ number }] = await db.tenant(tenant, ({ q }) => q('select count(*)::int as number from standing_rules where team = $1 and (created_at, id) <= ($2, $3)', [team, at, id]));
    return { id, number, form, line: ruleLine(form), hash, expiresAt: new Date(at.getTime() + days * 86_400_000).toISOString() };
  }

  /** The rule made from this approval, with its number, if any. */
  const madeFrom = (tenant, team, apr) => db.tenant(tenant, ({ q }) => q(`select s.id, (select count(*)::int from standing_rules x where x.team = s.team and (x.created_at, x.id) <= (s.created_at, s.id)) as number
    from standing_rules s where s.team = $1 and s.from_approval = $2`, [team, apr]));

  /**
   * "Make this a standing rule" (L22 web, mockup v20): a draft form from one approval a person approved, no wider than
   * that call. Owner only. 409 rule-not-possible with `reason` when it cannot be one (DRAFT_REASONS).
   */
  async function draft(tenant, team, apr, who) {
    await getTeam(db, tenant, team);
    if (who.role !== 'owner') throw new Problem(403, 'only an owner makes a standing rule', { type: 'forbidden' });
    const { a, draft: form, made } = await approvedDraft(tenant, team, apr);
    const facts = a.card?.data?.facts;
    const names = await namesOf(tenant, [a.decided_by]);
    return { approval: a.id, letter: a.card?.data?.letter ?? null, effect: Array.isArray(facts) && facts[0]?.text ? String(facts[0].text) : a.card?.title ?? null,
      approvedBy: { id: a.decided_by, name: nameIn(names, a.decided_by) }, made: made ? { id: made.id, number: made.number } : null, form, line: ruleLine(form) };
  }

  /** A person-approved approval on this team, its draft form, and the rule already made from it; or the 404/409. */
  async function approvedDraft(tenant, team, apr) {
    const [a] = await db.tenant(tenant, ({ q }) => q('select a.id, a.state, a.decided_by, a.action, a.calls, c.card from approvals a left join cards c on c.id = a.card where a.team = $1 and a.id = $2', [team, apr]));
    if (!a) throw new Problem(404, 'no such approval on this team');
    const no = (reason, why) => { throw new Problem(409, why, { type: 'rule-not-possible', body: { reason } }); };
    const person = a.state === 'approved' && a.decided_by && !/^rule:/.test(a.decided_by) && !['ledger', 'changed'].includes(a.decided_by);
    if (!person) no('not-approved', 'only an ask a person approved can become a standing rule');
    const [made] = await madeFrom(tenant, team, a.id);
    return { a, draft: draftForm(a.action, a.calls, no), made: made ?? null };
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
      // {letter}: the ask's letter (L39). `tap` is how it was decided when not by the person's words ('do-it'), with
      // the letters that tap covered; `words` is only ever what the person typed.
      ...(r.approval ? { approval: r.approval, action: r.action, role: r.role, what: whatOf(r.card), letter: r.card?.data?.letter ?? null, tap: r.tap ?? null, covered: r.letters ? r.letters.split(',') : null } : {}),
      ...(r.rule ? { rule: r.rule, ruleNumber: r.rule_spec ? Number(r.rule_number) : null, ruleForm: r.rule_spec ?? null, ruleLine: r.rule_spec ? ruleLine(r.rule_spec) : null } : {}),
      ...(r.calls_hash ? { callsHash: r.calls_hash } : {}) }));
    return { items, next: rows.length === n ? String(rows.at(-1).id) : null };
  }

  return { list, add, withdraw, ledger, draft };
}
