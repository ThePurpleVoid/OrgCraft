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

export const PERIODS = { day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000 };
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
  const form = { kind, tool: body.tool, recipientField: body.recipientField, period: body.period };
  if (kind === 'send.known') {
    return { ...form, n: int(body.n, 'n', { max: 10_000 }), channel: label(body.channel, 'channel') };
  }
  if (typeof body.amountField !== 'string' || !FIELD.test(body.amountField)) throw new Problem(400, 'amountField is the input field with the amount, in minor units');
  if (typeof body.currency !== 'string' || !/^[A-Z]{3}$/.test(body.currency)) throw new Problem(400, 'currency is a three-letter code, like USD');
  if (body.currencyField !== undefined && (typeof body.currencyField !== 'string' || !FIELD.test(body.currencyField))) throw new Problem(400, 'currencyField is the input field with the currency');
  const maxEach = int(body.maxEach, 'maxEach');
  const total = int(body.total, 'total');
  if (total < maxEach) throw new Problem(400, 'total per period is at least maxEach');
  return { ...form, amountField: body.amountField, currency: body.currency, ...(body.currencyField ? { currencyField: body.currencyField } : {}), maxEach, total, system: label(body.system, 'system') };
}

export const formHash = (form) => sha(`rule/1\n${canonical(form)}`);

/** The one line a rule reads as (CPO §6b patterns), for the ledger and the list. Parts that are not set are left out. */
export function ruleLine(form) {
  const money = (minor) => new Intl.NumberFormat('en-US', { style: 'currency', currency: form.currency ?? 'USD' }).format(minor / 100);
  const parts = {
    refund: ['Refunds', `up to ${money(form.maxEach ?? 0)} each`, `at most ${money(form.total ?? 0)} per customer per ${form.period}`, form.system && `in ${form.system}`],
    'pay.known': ['Payments to people you\'ve paid before', `up to ${money(form.maxEach ?? 0)} each`, `at most ${money(form.total ?? 0)} per ${form.period}`, form.system && `in ${form.system}`],
    'send.known': ['Messages to people the team has written to before', form.channel && `in ${form.channel}`, `at most ${form.n} per ${form.period}`],
  }[form.kind];
  return parts.filter(Boolean).join(' · ');
}

/** Has this teammate read outside text (a trigger's outside block) since a person last decided for its session? */
async function readOutside(q, session) {
  if (!session) return false;
  const [r] = await q(`select exists(
      select 1 from sessions x join deliveries d on d.run = x.run and d.role = x.role and coalesce(d.instance, '') = coalesce(x.instance, '')
        join events e on e.team = d.team and e.id = d.event
      where x.id = $1 and e.type = 'trigger.fired'
        and exists(select 1 from events s where s.team = e.team and s.id = e.envelope->'data'->>'source' and s.type = 'inbound.received')
        and d.created_at > coalesce((select max(a.decided_at) from approvals a where a.session = $1 and a.state in ('approved', 'denied') and a.decided_by not like 'rule:%' and a.decided_by <> 'ledger'), '-infinity'::timestamptz)
    ) as yes`, [session]);
  return Boolean(r?.yes);
}

/** Has the team sent this tool's calls to this recipient before, with a person's yes or under a rule? (rule.never.newrecipient) */
async function known(q, team, tool, field, recipient) {
  const [r] = await q(`select exists(select 1 from approvals a where a.team = $1 and a.state = 'approved' and a.calls @> $2::jsonb)
      or exists(select 1 from standing_rule_uses u join standing_rules s on s.id = u.rule where u.team = $1 and s.spec->>'tool' = $3 and u.recipient = $4) as yes`,
  [team, JSON.stringify([{ tool, input: { [field]: recipient } }]), tool, recipient]);
  return Boolean(r?.yes);
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
      if (c.tool !== f.tool || typeof recipient !== 'string' || !recipient || recipient.length > 200) { ok = false; break; }
      let amount = null;
      if (f.amountField) {
        amount = c.input?.[f.amountField];
        const cur = f.currencyField ? String(c.input?.[f.currencyField] ?? '').toUpperCase() : f.currency;
        if (!Number.isSafeInteger(amount) || amount < 0 || amount > f.maxEach || cur !== f.currency) { ok = false; break; }
      }
      if (f.kind !== 'refund' && !(await known(ctx.q, team, f.tool, f.recipientField, recipient))) { ok = false; break; }
      uses.push({ amount, recipient });
    }
    if (!ok) continue;
    const since = new Date(ctx.now.getTime() - PERIODS[f.period]);
    if (f.kind === 'send.known') {
      const [{ n }] = await ctx.q('select count(*)::int as n from standing_rule_uses where rule = $1 and at > $2', [rule.id, since]);
      if (n + uses.length > f.n) continue;
    } else if (f.kind === 'refund') {
      // Per customer per period.
      const per = {};
      for (const u of uses) per[u.recipient] = (per[u.recipient] ?? 0) + u.amount;
      let over = false;
      for (const [r, add] of Object.entries(per)) {
        const [{ s }] = await ctx.q('select coalesce(sum(amount), 0)::bigint as s from standing_rule_uses where rule = $1 and recipient = $2 and at > $3', [rule.id, r, since]);
        if (Number(s) + add > f.total) over = true;
      }
      if (over) continue;
    } else {
      const [{ s }] = await ctx.q('select coalesce(sum(amount), 0)::bigint as s from standing_rule_uses where rule = $1 and at > $2', [rule.id, since]);
      if (Number(s) + uses.reduce((a, u) => a + u.amount, 0) > f.total) continue;
    }
    return { rule, uses };
  }
  return null;
}

/**
 * Input fields that name who or what a call acts on: a recipient, payee, customer or account. Matching declines on
 * these (plus the tool, which names the system and the effect) means a re-ask for $63.99 in place of $64.00, or the
 * same email reworded, is still the thing that was declined (CPO, AI-10).
 */
const TARGET_FIELDS = ['to', 'recipient', 'recipients', 'customer', 'customer_id', 'customerId', 'payee', 'payee_id', 'payeeId', 'account', 'account_id', 'accountId', 'email', 'user', 'user_id', 'userId', 'channel', 'phone', 'number'];
const targetOf = (input) => {
  const out = [];
  for (const k of TARGET_FIELDS) {
    const v = input?.[k];
    for (const x of Array.isArray(v) ? v : [v]) if (typeof x === 'string' || typeof x === 'number') out.push(`${k}=${String(x).trim().toLowerCase()}`);
  }
  return out.sort();
};

/**
 * The effect key of a set of signed calls: each call's tool (system and effect) with its targets, order ignored. Null
 * when any call names no target: then only the exact same calls count as asked before.
 */
export function effectHash(calls) {
  if (!Array.isArray(calls) || !calls.length) return null;
  const parts = [];
  for (const c of calls) {
    const t = targetOf(c.input);
    if (!t.length) return null;
    parts.push(`${c.tool}\n${t.join('\n')}`);
  }
  return sha(`effect/1\n${[...new Set(parts)].sort().join('\n\n')}`);
}

/**
 * An earlier "no" from a person in this team, within 7 days (declines stick, AI-10), to the same effect on the same
 * target (or the exact same calls). `exact` says whether nothing at all changed.
 */
export async function declinedBefore(ctx, team, hash, effect = null) {
  if (!hash) return null;
  const [r] = await ctx.q(`select id, decided_at, decided_by, calls_hash = $2 as exact from approvals where team = $1 and (calls_hash = $2 or ($5::text is not null and effect_hash = $5)) and state = 'denied'
    and decided_by not like 'rule:%' and decided_by not in ('ledger', 'changed') and decided_at > $3::timestamptz - make_interval(days => $4)
    order by (calls_hash = $2) desc, decided_at desc limit 1`, [team, hash, ctx.now, DECLINE_DAYS, effect]);
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
    live: !r.withdrawn_at && new Date(r.expires_at) > at, used: { n: Number(r.used_n), ...(r.spec.amountField ? { amount: Number(r.used_amount) } : {}) } });

  async function list(tenant, team) {
    await getTeam(db, tenant, team);
    const at = now();
    const rows = await db.tenant(tenant, ({ q }) => q(`select r.*, row_number() over (order by r.created_at, r.id) as n,
        (select count(*) from standing_rule_uses u where u.rule = r.id and u.at > $2::timestamptz - (case r.spec->>'period' when 'day' then interval '1 day' when 'week' then interval '7 days' else interval '30 days' end)) as used_n,
        (select coalesce(sum(u.amount), 0) from standing_rule_uses u where u.rule = r.id and u.at > $2::timestamptz - (case r.spec->>'period' when 'day' then interval '1 day' when 'week' then interval '7 days' else interval '30 days' end)) as used_amount
      from standing_rules r where r.team = $1 order by r.created_at desc, r.id desc`, [team, at]));
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
      ...(r.rule ? { rule: r.rule, ruleNumber: r.rule_spec ? Number(r.rule_number) : null, ruleLine: r.rule_spec ? ruleLine(r.rule_spec) : null } : {}),
      ...(r.calls_hash ? { callsHash: r.calls_hash } : {}) }));
    return { items, next: rows.length === n ? String(rows.at(-1).id) : null };
  }

  return { list, add, withdraw, ledger };
}
