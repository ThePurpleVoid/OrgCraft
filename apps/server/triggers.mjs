// Triggers (N2, local PR L21; plans/n8n/n2-triggers-architecture.md). A trigger is a wake-up: a webhook, a schedule or
// an event inside the team wakes one teammate with the trusted text the team owner wrote. Outside data never enters
// that text except as quoted, cut, one-line field values; the body reaches the role only in the fenced `outside` block.
//
//   POST   /v1/hooks/{hook}                         no credential but the hook's own signature (section 1)
//   GET    /v1/teams/{team}/hooks                   viewer: name, url, scheme, state, counts; never a secret
//   POST   /v1/teams/{team}/hooks                   admin + step-up: { name, scheme: hmac | bearer } -> { id, url, secret }
//   POST   /v1/teams/{team}/hooks/{hook}/rotate     admin + step-up: a new secret; the old one works 24 more hours
//   DELETE /v1/teams/{team}/hooks/{hook}            admin + step-up: revoked; its URL is 404 at once
//   GET    /v1/teams/{team}/triggers/{trigger}/history   viewer: what each signal did (summaries only)
//   POST   /v1/teams/{team}/triggers/test           editor: { trigger, sample: { kind, fields } } -> { passes, failed, wake }
//
// Floods (CTO R6): an unknown hook, a bad signature or a request over the per-hook limit writes nothing; rejections are
// counted in memory and written as one row per hook per minute by the tick. Verified signals over the team ceiling
// (300 an hour) are a row, never an event. Fan-out (CTO R7): one root cause wakes at most 50 teammates across its whole
// chain, and a chain of event triggers is at most 5 deep; the rest is held and shown as trigger.held.
import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { Problem, SLUG, getTeam, id, putSecret, readSecret } from './store.mjs';

export const LIMITS = Object.freeze({ bodyBytes: 256 * 1024, perHookPerMinute: 600, ceilingPerHour: 300, fanOut: 50, depth: 5, triggers: 100, toleranceSec: 300, keepDays: 7, queueHours: 24 });
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
const hookId = () => `hk_${[...randomBytes(32)].map((b) => B32[b & 31]).join('')}`; // 160 bits: the URL is the first secret
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const ROOT_EVENTS = ['message.handoff', 'message.bug', 'message.signoff', 'message.blocked', 'report.status', 'proposal.accepted', 'proposal.opened', 'ready.posted', 'meeting.minutes', 'approval.decided', 'budget.warned', 'run.started'];

// ---- triggers.json, frozen with a run -------------------------------------------------------------------------------

const OPS = ['is', 'isNot', 'contains', 'startsWith', 'in', 'matches', 'exists'];

/** A regex a filter may use: short, no backreferences, no nested quantifiers (a bounded match on cut strings). */
export function safeRegex(src) {
  if (typeof src !== 'string' || !src || src.length > 200) return null;
  let flags = '';
  let body = src;
  if (body.startsWith('(?i)')) { flags = 'i'; body = body.slice(4); }
  if (/\\[1-9]|\(\?<?[=!]/.test(body)) return null; // backreferences and lookarounds
  if (/\([^)]*[+*][^)]*\)\s*[+*{]/.test(body)) return null; // (a+)+ and friends
  try { return new RegExp(body, flags); } catch { return null; }
}

function checkFilter(f, where, depth = 0) {
  if (!Array.isArray(f) || f.length > 20) throw new Problem(400, `${where}: filter is a list of at most 20 conditions`);
  for (const c of f) {
    if (c && Array.isArray(c.any) && depth === 0) { checkFilter(c.any, where, 1); continue; }
    if (!c || typeof c.field !== 'string' || !/^[A-Za-z0-9_.]{1,100}$/.test(c.field) || !OPS.includes(c.op)) throw new Problem(400, `${where}: each condition is { field, op (${OPS.join(', ')}), value }, or { any: [...] } one level deep`);
    if (c.op === 'matches' && !safeRegex(c.value)) throw new Problem(400, `${where}: ${JSON.stringify(String(c.value).slice(0, 40))} is not a pattern a filter may use (at most 200 characters, no backreferences, lookarounds or nested repeats)`);
    if (c.op === 'in' && (!Array.isArray(c.value) || c.value.length > 50)) throw new Problem(400, `${where}: in takes a list of at most 50 values`);
  }
}

/** RunCreate.team.triggers, checked and kept as published (at most 100). */
export function checkTriggers(list, roles) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > LIMITS.triggers) throw new Problem(400, `team.triggers is a list of at most ${LIMITS.triggers}`);
  const slugs = new Set(roles.map((r) => r.slug));
  const seen = new Set();
  return list.map((t) => {
    const where = `trigger ${t?.id ?? '?'}`;
    if (!t || !SLUG.test(t.id ?? '')) throw new Problem(400, 'every trigger has an id (lowercase letters, digits and dashes)');
    if (seen.has(t.id)) throw new Problem(400, `${where} is listed twice`);
    seen.add(t.id);
    if (!slugs.has(t.to)) throw new Problem(400, `${where}: to names a teammate on this team`);
    if (typeof t.wake !== 'string' || !t.wake.trim() || t.wake.length > 2000) throw new Problem(400, `${where}: wake is the text the teammate is woken with, at most 2,000 characters`);
    const s = t.source ?? {};
    let source;
    if (typeof s.hook === 'string') {
      if (!SLUG.test(s.hook)) throw new Problem(400, `${where}: source.hook is a hook's name`);
      source = { hook: s.hook, kind: typeof s.kind === 'string' ? s.kind.slice(0, 100) : 'webhook.received' };
    } else if (s.schedule && typeof s.schedule === 'object') {
      if (!parseCron(s.schedule.cron)) throw new Problem(400, `${where}: source.schedule.cron is five fields (minute hour day month weekday)`);
      const tz = s.schedule.timezone ?? 'UTC';
      try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { throw new Problem(400, `${where}: timezone is an IANA name, like Europe/Berlin`); }
      source = { schedule: { cron: s.schedule.cron, catchUp: s.schedule.catchUp === 'one' ? 'one' : 'none', timezone: tz } };
    } else if (typeof s.event === 'string') {
      if (!ROOT_EVENTS.includes(s.event)) throw new Problem(400, `${where}: source.event is one of ${ROOT_EVENTS.join(', ')}`);
      if (s.from !== undefined && !slugs.has(s.from)) throw new Problem(400, `${where}: source.from names a teammate on this team`);
      source = { event: s.event, ...(s.from ? { from: s.from } : {}) };
    } else throw new Problem(400, `${where}: source is { hook, kind }, { schedule: { cron } } or { event }`);
    if (t.filter !== undefined) checkFilter(t.filter, where);
    const perHour = t.rate?.perHour ?? 60;
    if (!Number.isInteger(perHour) || perHour < 1 || perHour > 600) throw new Problem(400, `${where}: rate.perHour is 1 to 600`);
    return { id: t.id, name: typeof t.name === 'string' ? t.name.slice(0, 100) : t.id, source, ...(t.filter ? { filter: t.filter } : {}), to: t.to, wake: t.wake, rate: { perHour }, ignoreSelf: t.ignoreSelf !== false, on: t.on !== false };
  });
}

// ---- Filters and the wake text --------------------------------------------------------------------------------------

/** Does a signal's fields pass the filter? Returns { passes, failed? }: the first condition that failed. */
export function passes(filter = [], fields = {}) {
  const one = (c) => {
    if (Array.isArray(c.any)) return c.any.some(one);
    const v = fields[c.field];
    const s = v === undefined || v === null ? '' : String(v);
    switch (c.op) {
      case 'exists': return v !== undefined && v !== null && s !== '';
      case 'is': return s === String(c.value);
      case 'isNot': return s !== String(c.value);
      case 'contains': return s.toLowerCase().includes(String(c.value).toLowerCase());
      case 'startsWith': return s.toLowerCase().startsWith(String(c.value).toLowerCase());
      case 'in': return Array.isArray(c.value) && c.value.map(String).includes(s);
      case 'matches': { const re = safeRegex(c.value); return Boolean(re && re.test(s.slice(0, 500))); }
      default: return false;
    }
  };
  for (const c of filter) if (!one(c)) return { passes: false, failed: Array.isArray(c.any) ? { any: true } : { field: c.field, op: c.op } };
  return { passes: true };
}

/** The trusted wake text with {field} placeholders: quoted, one line, at most 200 characters each. */
export function renderWake(text, fields = {}) {
  return String(text).replace(/\{([A-Za-z0-9_.]{1,100})\}/g, (_, k) => {
    const v = fields[k];
    if (v === undefined || v === null) return '';
    return `“${String(v).replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/[“”]/g, '"').slice(0, 200)}”`;
  });
}

/** A JSON body's top-level scalars and one level of objects, flattened to a.b: at most 50 keys, strings cut to 500. */
export function fieldsOf(body) {
  let v;
  try { v = JSON.parse(body); } catch { return {}; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out = {};
  const put = (k, x) => { if (Object.keys(out).length < 50 && /^[A-Za-z0-9_.]{1,100}$/.test(k)) out[k] = typeof x === 'string' ? x.slice(0, 500) : x; };
  for (const [k, x] of Object.entries(v)) {
    if (x === null || ['string', 'number', 'boolean'].includes(typeof x)) put(k, x);
    else if (typeof x === 'object' && !Array.isArray(x)) for (const [k2, y] of Object.entries(x)) if (y === null || ['string', 'number', 'boolean'].includes(typeof y)) put(`${k}.${k2}`, y);
  }
  return out;
}

// ---- Schedules ------------------------------------------------------------------------------------------------------

/** Five-field cron (numbers, *, ranges, lists, steps): a matcher over { minute, hour, day, month, weekday }, or null. */
export function parseCron(expr) {
  const parts = String(expr ?? '').trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  const sets = [];
  for (let i = 0; i < 5; i++) {
    const [lo, hi] = ranges[i];
    const set = new Set();
    for (const item of parts[i].split(',')) {
      const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(item);
      if (!m) return null;
      const a = m[1] === '*' ? lo : Number(m[2]);
      const b = m[1] === '*' ? hi : m[3] !== undefined ? Number(m[3]) : m[4] ? hi : a;
      const step = m[4] ? Number(m[4]) : 1;
      if (a < lo || b > hi || a > b || step < 1) return null;
      for (let x = a; x <= b; x += step) set.add(i === 4 && x === 7 ? 0 : x);
    }
    sets.push(set);
  }
  return ({ minute, hour, day, month, weekday }) => sets[0].has(minute) && sets[1].has(hour) && sets[2].has(day) && sets[3].has(month) && sets[4].has(weekday);
}

const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function wallClock(at, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' }).formatToParts(at).map((x) => [x.type, x.value]));
  return { minute: Number(p.minute), hour: Number(p.hour) % 24, day: Number(p.day), month: Number(p.month), weekday: WD[p.weekday] };
}

/** The slots (whole UTC minutes) a schedule was due in (after, upTo], newest last, looking back at most a day. */
export function dueSlots(schedule, after, upTo) {
  const match = parseCron(schedule.cron);
  if (!match) return [];
  const end = Math.floor(upTo.getTime() / 60_000) * 60_000;
  const start = Math.max(after ? Math.floor(after.getTime() / 60_000) * 60_000 + 60_000 : end, end - 24 * 3600_000);
  const out = [];
  for (let t = start; t <= end; t += 60_000) if (match(wallClock(new Date(t), schedule.timezone ?? 'UTC'))) out.push(new Date(t));
  return out;
}

// ---- The module -----------------------------------------------------------------------------------------------------

export function createTriggers({ db, key, m3, publicUrl = '', now = () => new Date() }) {
  const base = () => String(publicUrl || '').replace(/\/+$/, '');
  const urlOf = (hid) => `${base()}/v1/hooks/${hid}`;
  // In memory only (R6): per-hook request counts this minute, and rejections waiting for the tick to write one row.
  const perMinute = new Map();
  const rejected = new Map(); // hook -> { tenant, team, n, reasons: Set }

  const notFound = () => new Problem(404, 'not found');

  // -- Hooks (admin + step-up) --

  async function listHooks(tenant, team) {
    await getTeam(db, tenant, team);
    const rows = await db.tenant(tenant, ({ q }) => q(`select h.id, h.name, h.scheme, h.state, h.last_at,
      (select coalesce(jsonb_object_agg(state, n), '{}') from (select state, count(*)::int + coalesce(sum(dupes), 0)::int as n from inbound i where i.hook = h.id and i.received_at > now() - interval '24 hours' group by state) c) as counts
      from hooks h where h.team = $1 order by h.created_at`, [team]));
    return { hooks: rows.map((h) => ({ id: h.id, name: h.name, url: urlOf(h.id), scheme: h.scheme, state: h.state, lastAt: h.last_at ? new Date(h.last_at).toISOString() : null, last24h: h.counts })) };
  }

  async function createHook(tenant, team, body, by, stepUp) {
    await getTeam(db, tenant, team);
    const name = body?.name;
    if (!SLUG.test(name ?? '')) throw new Problem(400, 'name is the hook\'s name in triggers.json (lowercase letters, digits and dashes)');
    const scheme = body?.scheme ?? 'hmac';
    if (!['hmac', 'bearer'].includes(scheme)) throw new Problem(400, 'scheme is hmac (signed, X-Team-Signature) or bearer (a header, for tools that cannot sign)');
    await m3.requireStepUp(tenant, by, stepUp, 'Adding a webhook');
    const hid = hookId();
    const secret = randomBytes(32).toString('base64url');
    const secretName = `HOOK_${hid.slice(3).toUpperCase()}`;
    try {
      await db.tenant(tenant, ({ q }) => q("insert into hooks(id, tenant, team, name, scheme, secret_name, created_by) values ($1, $2, $3, $4, $5, $6, $7)", [hid, tenant, team, name, scheme, secretName, by]));
    } catch (e) {
      if (/hooks_team_name|unique/i.test(e.message)) throw new Problem(409, `this team already has a hook called ${name}`);
      throw e;
    }
    await putSecret(db, key, tenant, secretName, secret);
    await m3.tx(tenant, (ctx) => ctx.audit({ team, actorKind: 'person', actorId: by, action: 'hook', target: hid, decision: 'allowed', detail: { op: 'create', name, scheme } }));
    return { id: hid, name, scheme, url: urlOf(hid), secret, note: 'The secret is shown once. Store it where the sending system keeps its secrets.' };
  }

  async function rotateHook(tenant, team, hid, by, stepUp) {
    await getTeam(db, tenant, team);
    const [h] = await db.tenant(tenant, ({ q }) => q("select * from hooks where id = $1 and team = $2 and state = 'active'", [hid, team]));
    if (!h) throw notFound();
    await m3.requireStepUp(tenant, by, stepUp, 'Rotating a webhook secret');
    const secret = randomBytes(32).toString('base64url');
    const next = `HOOK_${hid.slice(3).toUpperCase()}_${Date.now().toString(36).toUpperCase()}`.slice(0, 64);
    await putSecret(db, key, tenant, next, secret);
    await db.tenant(tenant, ({ q }) => q("update hooks set prev_secret_name = secret_name, prev_expires = now() + interval '24 hours', secret_name = $2 where id = $1", [hid, next]));
    await m3.tx(tenant, (ctx) => ctx.audit({ team, actorKind: 'person', actorId: by, action: 'hook', target: hid, decision: 'allowed', detail: { op: 'rotate' } }));
    return { id: hid, secret, note: 'The old secret keeps working for 24 hours.' };
  }

  async function revokeHook(tenant, team, hid, by, stepUp) {
    await getTeam(db, tenant, team);
    const [h] = await db.tenant(tenant, ({ q }) => q("select id from hooks where id = $1 and team = $2 and state = 'active'", [hid, team]));
    if (!h) throw notFound();
    await m3.requireStepUp(tenant, by, stepUp, 'Removing a webhook');
    await db.tenant(tenant, ({ q }) => q("update hooks set state = 'revoked' where id = $1", [hid]));
    await m3.tx(tenant, (ctx) => ctx.audit({ team, actorKind: 'person', actorId: by, action: 'hook', target: hid, decision: 'allowed', detail: { op: 'revoke' } }));
    return { id: hid, state: 'revoked' };
  }

  // -- A signal arrives (section 1) --

  function overLimit(hid) {
    const minute = Math.floor(now().getTime() / 60_000);
    const c = perMinute.get(hid);
    if (!c || c.minute !== minute) { perMinute.set(hid, { minute, n: 1 }); return false; }
    c.n += 1;
    return c.n > LIMITS.perHookPerMinute;
  }

  function reject(h, reason) {
    const r = rejected.get(h.id) ?? { tenant: h.tenant, team: h.team, n: 0, reasons: new Set() };
    r.n += 1; r.reasons.add(reason);
    rejected.set(h.id, r);
  }

  async function verify(h, raw, headers) {
    const secrets = [h.secret_name, ...(h.prev_secret_name && h.prev_expires && new Date(h.prev_expires) > now() ? [h.prev_secret_name] : [])];
    const values = (await Promise.all(secrets.map((n) => readSecret(db, key, h.tenant, n)))).filter(Boolean);
    const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
    if (h.scheme === 'bearer') {
      const got = /^Bearer (.+)$/.exec(String(headers.authorization ?? ''))?.[1] ?? '';
      return values.some((v) => same(got, v)) ? null : 'signature';
    }
    const sig = String(headers['x-team-signature'] ?? '');
    const t = /(?:^|,)\s*t=(\d{1,12})/.exec(sig)?.[1];
    const v1 = /(?:^|,)\s*v1=([0-9a-f]{64})/.exec(sig)?.[1];
    if (!t || !v1) return 'signature';
    if (Math.abs(now().getTime() / 1000 - Number(t)) > LIMITS.toleranceSec) return 'stale';
    return values.some((v) => same(createHmac('sha256', v).update(`${t}.`).update(raw).digest('hex'), v1)) ? null : 'signature';
  }

  /** POST /v1/hooks/{hook}: answers { status, body } before any event when the signal is not verified, unique and in ceiling. */
  async function receive(hid, raw, headers) {
    if (!/^hk_[a-z2-7]{32}$/.test(String(hid))) throw notFound();
    const [h] = await db.system("select id, tenant, team, name, scheme, secret_name, prev_secret_name, prev_expires from hooks where id = $1 and state = 'active'", [hid]);
    if (!h) throw notFound();
    if (overLimit(hid)) { reject(h, 'rate'); return { status: 429, body: { error: 'too many requests for this hook; slow down' }, headers: { 'retry-after': '60' } }; }
    if (raw.length > LIMITS.bodyBytes) { reject(h, 'too-large'); return { status: 413, body: { error: 'a signal is at most 256 KB' } }; }
    const bad = await verify(h, raw, headers);
    if (bad) { reject(h, bad); return { status: 401, body: { error: bad === 'stale' ? 'the signature\'s timestamp is too old or too new' : 'the signature does not match' } }; }

    const body = raw.toString('utf8');
    const fields = fieldsOf(body);
    const idem = typeof headers['idempotency-key'] === 'string' ? headers['idempotency-key'].slice(0, 200) : null;
    const dedupeKey = idem ?? sha256(raw);
    const summary = String(fields.summary ?? fields.title ?? fields.subject ?? fields.text ?? `A webhook to ${h.name}`).replace(/\s+/g, ' ').slice(0, 300);
    const kind = 'webhook.received';
    const keep = new Date(now().getTime() + LIMITS.keepDays * 86_400_000).toISOString();

    const { result } = await m3.tx(h.tenant, async (ctx) => {
      const { q } = ctx;
      await q('update hooks set last_at = now() where id = $1', [h.id]);
      const [dup] = await q("update inbound set dupes = dupes + 1 where team = $1 and hook = $2 and dedupe_key = $3 and state <> 'rejected' and received_at > now() - interval '7 days' returning id", [h.team, h.id, dedupeKey]);
      if (dup) return { status: 200, body: { id: dup.id, duplicate: true } };
      // A key older than 7 days is free again.
      await q("delete from inbound where team = $1 and hook = $2 and dedupe_key = $3 and state <> 'rejected'", [h.team, h.id, dedupeKey]);
      const [{ n }] = await q("select count(*)::int as n from inbound where team = $1 and state in ('accepted', 'queued') and received_at > now() - interval '1 hour'", [h.team]);
      const iid = `in_${id('x').slice(2)}`;
      if (n >= LIMITS.ceilingPerHour) {
        await q("insert into inbound(id, tenant, team, hook, kind, dedupe_key, state, summary, keep_until) values ($1, $2, $3, $4, $5, $6, 'over-ceiling', $7, $8)", [iid, h.tenant, h.team, h.id, kind, dedupeKey, summary, keep]);
        await ceilingNotice(ctx, h);
        return { status: 200, body: { id: iid, held: 'ceiling' } };
      }
      const run = await runningRun(q, h.team);
      await q("insert into inbound(id, tenant, team, hook, kind, dedupe_key, state, summary, fields, body, keep_until) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
        [iid, h.tenant, h.team, h.id, kind, dedupeKey, run ? 'accepted' : 'queued', summary, JSON.stringify(fields), body, keep]);
      await ctx.emit(h.team, 'inbound.received', { hook: h.name, kind, dedupeKey, summary, fields, inbound: iid, ...(run ? {} : { queued: true }) },
        { id: iid, actor: { kind: 'system', id: `hook/${h.id}`, via: 'webhook' }, subject: `hook/${h.name}`, ...(run ? { run: run.id } : {}) });
      if (run) await matchSignal(ctx, run, { inbound: iid, hook: h.name, kind, fields });
      return { status: 202, body: { id: iid } };
    });
    return result;
  }

  async function ceilingNotice(ctx, h) {
    const [recent] = await ctx.q("select 1 from events where team = $1 and type = 'trigger.held' and envelope->'data'->>'reason' = 'ceiling' and received_at > now() - interval '1 hour' limit 1", [h.team]);
    if (recent) return;
    await ctx.emit(h.team, 'trigger.held', { trigger: null, hook: h.name, reason: 'ceiling', count: LIMITS.ceilingPerHour }, { actor: { kind: 'system', id: 'control-plane', via: 'webhook' }, subject: `hook/${h.name}` });
  }

  const runningRun = async (q, team) => (await q("select id, state, roster, triggers from runs where team = $1 and state = 'running' order by started_at desc limit 1", [team]))[0] ?? null;

  /** Section 1 step 10: the run's hook triggers against one signal. */
  async function matchSignal(ctx, run, { inbound, hook, kind, fields, late = false }) {
    for (const t of run.triggers ?? []) {
      if (!t.on || t.source?.hook !== hook || (t.source.kind && t.source.kind !== kind)) continue;
      const p = passes(t.filter, fields);
      if (!p.passes) { await outcome(ctx, inbound, t, 'filtered', `${p.failed?.field ?? 'any'} ${p.failed?.op ?? ''}`.trim()); continue; }
      const ev = await fire(ctx, run, t, { source: inbound, fields, root: inbound, depth: 0, late });
      await outcome(ctx, inbound, t, ev.fired ? 'fired' : 'held', ev.reason ?? null, ev.event);
    }
  }

  const outcome = (ctx, inbound, t, what, detail = null, event = null) => ctx.q(`insert into inbound_outcomes(inbound, trigger, tenant, team, outcome, detail, event) values ($1, $2, $3, (select team from inbound where id = $1), $4, $5, $6)
    on conflict (inbound, trigger) do update set outcome = excluded.outcome, detail = excluded.detail, event = excluded.event, at = now()`, [inbound, t.id, ctx.tenant, what, detail, event]);

  /**
   * One trigger fires once: its rate, the root cause's fan-out budget and the chain's depth first. Returns
   * { fired, event } or { fired: false, reason, event }. Held signals emit trigger.held, at most once per trigger per
   * 10 minutes for the rate (with the count so far).
   */
  async function fire(ctx, run, t, { source = null, fields = {}, root, depth, slot = null, late = false, eventId = null }) {
    const { q } = ctx;
    const team = (await q('select team from runs where id = $1', [run.id]))[0].team;
    const held = async (reason, extra = {}) => {
      const ev = await ctx.emit(team, 'trigger.held', { trigger: t.id, name: t.name, reason, source, root, ...extra }, { actor: { kind: 'system', id: 'control-plane', via: 'trigger' }, subject: `trigger/${t.id}`, run: run.id });
      return { fired: false, reason, event: ev.id };
    };
    if (!(run.roster?.roles ?? []).some((r) => r.slug === t.to)) return held('unavailable');
    if (depth >= LIMITS.depth) return held('depth', { depth });
    const [{ n }] = await q("select count(*)::int as n from events where team = $1 and type = 'trigger.fired' and envelope->'data'->>'root' = $2", [team, root]);
    if (n >= LIMITS.fanOut) return held('fan-out', { count: n });
    // The trigger's own rate, in a rolling hour.
    const at = ctx.now;
    await q(`insert into trigger_state(tenant, team, trigger, window_start, window_count) values ($1, $2, $3, $4, 0) on conflict (team, trigger) do update
             set window_start = case when trigger_state.window_start is null or trigger_state.window_start <= $4::timestamptz - interval '1 hour' then $4 else trigger_state.window_start end,
                 window_count = case when trigger_state.window_start is null or trigger_state.window_start <= $4::timestamptz - interval '1 hour' then 0 else trigger_state.window_count end,
                 held_count = case when trigger_state.window_start is null or trigger_state.window_start <= $4::timestamptz - interval '1 hour' then 0 else trigger_state.held_count end`, [ctx.tenant, team, t.id, at.toISOString()]);
    const [st] = await q('select window_count, held_count, held_noted from trigger_state where team = $1 and trigger = $2 for update', [team, t.id]);
    if (st.window_count >= t.rate.perHour) {
      await q('update trigger_state set held_count = held_count + 1 where team = $1 and trigger = $2', [team, t.id]);
      if (st.held_noted && at - new Date(st.held_noted) < 10 * 60_000) return { fired: false, reason: 'rate', event: null };
      await q('update trigger_state set held_noted = $3 where team = $1 and trigger = $2', [team, t.id, at.toISOString()]);
      return held('rate', { count: st.held_count + 1 });
    }
    await q('update trigger_state set window_count = window_count + 1, last_fired = $3 where team = $1 and trigger = $2', [team, t.id, at.toISOString()]);
    const ev = await ctx.emit(team, 'trigger.fired', { trigger: t.id, name: t.name, to: t.to, wake: renderWake(t.wake, fields), source, root, depth, ...(slot ? { slot } : {}), ...(late ? { late: true } : {}) },
      { ...(eventId ? { id: eventId } : {}), actor: { kind: 'system', id: 'control-plane', via: 'trigger' }, subject: `trigger/${t.id}`, run: run.id });
    return { fired: true, event: ev.id };
  }

  /**
   * Event triggers inside the team (bus projection, for every stored event): an event a trigger names wakes its
   * teammate. The chain carries its root and depth, so a ping-pong of triggers stops at 5 deep and 50 wakes.
   */
  async function project(ctx, event) {
    if (!event.team || !ROOT_EVENTS.includes(event.type)) return;
    const run = await runningRun(ctx.q, event.team);
    if (!run?.triggers?.length) return;
    // The chain: what a trigger woke counts as caused by it. The envelope's cause when the runner sends one, else the
    // last trigger wake delivered to the acting session (conservative: everything after a trigger wake is its chain).
    let fromTrigger = event.cause ? (await ctx.q("select envelope from events where team = $1 and id = $2 and type = 'trigger.fired'", [event.team, event.cause]))[0]?.envelope : null;
    if (!fromTrigger && event.actor?.session) {
      fromTrigger = (await ctx.q(`select e.envelope from deliveries d join events e on e.team = d.team and e.id = d.event
                                  where d.session = $1 and e.type = 'trigger.fired' order by d.created_at desc limit 1`, [event.actor.session]))[0]?.envelope ?? null;
    }
    const root = fromTrigger?.data?.root ?? event.id;
    const depth = fromTrigger ? Number(fromTrigger.data?.depth ?? 0) + 1 : 0;
    const fields = { type: event.type, from: event.actor?.id ?? '', ...Object.fromEntries(Object.entries(event.data ?? {}).filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v)).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 500) : v]).slice(0, 50)) };
    for (const t of run.triggers) {
      if (!t.on || t.source?.event !== event.type) continue;
      if (t.source.from && t.source.from !== event.actor?.id) continue;
      if (t.ignoreSelf && event.actor?.kind === 'role' && event.actor.id === t.to) continue;
      if (!passes(t.filter, fields).passes) continue;
      await fire(ctx, run, t, { source: event.id, fields, root, depth });
    }
  }

  /** At run.started: queued signals under 24 hours are matched against the new run's triggers, oldest first. */
  async function drain(tenant, team) {
    await m3.tx(tenant, async (ctx) => {
      const run = await runningRun(ctx.q, team);
      if (!run) return;
      const rows = await ctx.q("select i.id, i.kind, i.fields, h.name as hook from inbound i join hooks h on h.id = i.hook where i.team = $1 and i.state = 'queued' and i.received_at > now() - interval '24 hours' order by i.received_at limit 500 for update of i", [team]);
      for (const r of rows) {
        await ctx.q("update inbound set state = 'accepted' where id = $1", [r.id]);
        await matchSignal(ctx, run, { inbound: r.id, hook: r.hook, kind: r.kind, fields: r.fields ?? {}, late: true });
      }
    });
  }

  /** The tick: schedules, the rejected counts (one row per hook per minute), queue expiry, retention. */
  async function tick(tenant) {
    for (const [hid, r] of [...rejected]) {
      if (r.tenant !== tenant) continue;
      rejected.delete(hid);
      const minute = new Date(Math.floor(now().getTime() / 60_000) * 60_000);
      await db.tenant(tenant, ({ q }) => q(`insert into inbound(id, tenant, team, hook, state, reason, dupes, received_at, keep_until) values ($1, $2, $3, $4, 'rejected', $5, $6, $7, $8)
        on conflict (id) do update set dupes = inbound.dupes + excluded.dupes`, [`rej_${hid.slice(3, 15)}_${minute.getTime().toString(36)}`, tenant, r.team, hid, [...r.reasons].join(', '), r.n - 1, minute.toISOString(), new Date(now().getTime() + LIMITS.keepDays * 86_400_000).toISOString()]));
      await m3.tx(tenant, (ctx) => ctx.audit({ team: r.team, action: 'hook', target: hid, decision: 'refused', rule: 'verify', detail: { count: r.n, reasons: [...r.reasons] } }));
    }
    await db.tenant(tenant, ({ q }) => q("update inbound set state = 'expired' where state = 'queued' and received_at <= now() - interval '24 hours'"));
    await db.tenant(tenant, ({ q }) => q('delete from inbound where keep_until <= now()'));
    const runs = await db.tenant(tenant, ({ q }) => q("select id, team, state, roster, triggers from runs where state = 'running' and triggers is not null"));
    for (const run of runs) {
      for (const t of run.triggers ?? []) {
        if (!t.on || !t.source?.schedule) continue;
        await m3.tx(tenant, async (ctx) => {
          await ctx.q('insert into trigger_state(tenant, team, trigger) values ($1, $2, $3) on conflict do nothing', [tenant, run.team, t.id]);
          const [st] = await ctx.q('select last_slot from trigger_state where team = $1 and trigger = $2 for update', [run.team, t.id]);
          const slots = dueSlots(t.source.schedule, st.last_slot ? new Date(st.last_slot) : null, ctx.now);
          if (!slots.length) return;
          await ctx.q('update trigger_state set last_slot = $3 where team = $1 and trigger = $2', [run.team, t.id, slots.at(-1).toISOString()]);
          const nowMinute = Math.floor(ctx.now.getTime() / 60_000) * 60_000;
          const fireable = t.source.schedule.catchUp === 'one' ? [slots.at(-1)] : slots.filter((s) => s.getTime() === nowMinute);
          for (const s of fireable) {
            const slot = s.toISOString();
            // Exactly once per slot: the event id is the slot's own, and events are unique on (team, id).
            const eventId = `fired-${t.id}-${s.getTime().toString(36)}`;
            const [seen] = await ctx.q('select 1 from events where team = $1 and id = $2', [run.team, eventId]);
            if (!seen) await fire(ctx, run, t, { fields: { slot, timezone: t.source.schedule.timezone }, root: eventId, depth: 0, slot, eventId });
          }
        });
      }
    }
  }

  async function history(tenant, team, trigger, { cursor = null } = {}) {
    await getTeam(db, tenant, team);
    const before = cursor ? new Date(Buffer.from(String(cursor), 'base64url').toString()) : null;
    const rows = await db.tenant(tenant, ({ q }) => q(`select i.id, i.state, i.summary, i.received_at, o.outcome, o.detail, o.event from inbound_outcomes o join inbound i on i.id = o.inbound
      where o.team = $1 and o.trigger = $2 ${before && !Number.isNaN(before.getTime()) ? 'and o.at < $3' : ''} order by o.at desc limit 51`, before && !Number.isNaN(before.getTime()) ? [team, trigger, before.toISOString()] : [team, trigger]));
    const page = rows.slice(0, 50);
    return { history: page.map((r) => ({ inbound: r.id, summary: r.summary, at: new Date(r.received_at).toISOString(), outcome: r.outcome, detail: r.detail, event: r.event })), next: rows.length > 50 ? Buffer.from(new Date(rows[49].received_at).toISOString()).toString('base64url') : null };
  }

  /** POST .../triggers/test: pure; stores nothing and wakes nobody. */
  function test(body) {
    const roles = [{ slug: body?.trigger?.to ?? 'x' }];
    const [t] = checkTriggers([body?.trigger], roles);
    const fields = body?.sample?.fields && typeof body.sample.fields === 'object' ? body.sample.fields : {};
    const p = passes(t.filter, fields);
    return { passes: p.passes, ...(p.failed ? { failed: p.failed } : {}), wake: renderWake(t.wake, fields) };
  }

  /** The outside block for a trigger wake: the signal's fields and body (8 KB), fenced by the runner, never trusted. */
  async function outsideOf(q, team, source) {
    if (typeof source !== 'string' || !source.startsWith('in_')) return null;
    const [r] = await q('select fields, body from inbound where team = $1 and id = $2', [team, source]);
    return r ? { fields: r.fields ?? {}, body: String(r.body ?? '').slice(0, 8 * 1024) } : null;
  }

  return { listHooks, createHook, rotateHook, revokeHook, receive, project, drain, tick, history, test, outsideOf };
}
