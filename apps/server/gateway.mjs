// The gateway's outbound governor and effect idempotency (local PR L20g; CTO review 2 R1a and R5; decision C1;
// plans/build/now-build-plan.md L20; migration 024).
//
// Governor. Every outward call to a provider is paced through one or more keys, always in the same order: the
// provider account (the shared GitHub App or model key), then the installation, then the tenant's share of that
// provider. Each key is a GCRA bucket in the database (`governor_buckets`), so every control plane instance shares it
// (R3). A call over the rate is delayed until its turn, never dropped; `take` reserves a slot on all keys at once and
// answers how long to wait, and `pace` waits, in two steps: the caller's own keys first, then the shared account when
// the call is about to go. That is what makes it fair under C1: one busy tenant waits on its own share and leaves the
// account's rate to everyone else. When a provider answers with a rate limit or an abuse response, `block` holds its
// keys until it says to retry, and the teams waiting get a `gateway.slowed` event, at most once a minute per key.
//
// Effects. Every outward effect carries an idempotency key (the sidecar's sha256(session, call id), or the gateway's
// task, step and call hash). `begin` records it; a repeat of a finished one is answered with the first result and
// never sent again; a repeat while it is in flight is refused (409). `end` records the result, or a failure that
// allows one more attempt (the provider said nothing happened).
import { Problem } from './store.mjs';
import { redactPatterns } from './inspector.mjs';
import { createHash } from 'node:crypto';
import { EXPORT_CONNECTORS, EXPORT_SERVICES, allowedHost } from './export-targets.mjs';

/** An effect's result with every string run through the inspector's credential patterns (L19), before it is kept. */
function scrub(v, depth = 0) {
  if (typeof v === 'string') return redactPatterns(v).text;
  if (depth > 20 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [redactPatterns(k).text, scrub(x, depth + 1)]));
}

const KEY = /^[A-Za-z0-9:._@/-]{1,200}$/;
const EFFECT_KEY = /^[A-Za-z0-9:._-]{8,200}$/;
const SLOWED_EVERY_MS = 60_000;
const RESULT_MAX = 16 * 1024;
/** An effect still `started` this long after it began was cut off (a crash, a lost link): nobody knows if it went. */
export const EFFECT_STALE_MS = 15 * 60_000;
/** The longest a request from the Studio or the API waits for a slot; past it, the answer is a 503 with retry-after. */
export const FETCH_WAIT_MAX_MS = 15_000;

/**
 * Pacing per kind of key: `rate` calls a second and `burst` calls at once, set below the providers' published limits.
 * GitHub Apps: 5,000 requests an hour per installation (we pace at 1.2/s) and a secondary limit near 900 points a
 * minute across the App (we pace the App at 10/s). The tenant share is a fraction of the account (C1: free and first
 * paid plans share the App and key; business plans bring their own, which gives them their own account key).
 */
export const DEFAULT_LIMITS = Object.freeze({
  'github-app': { rate: 10, burst: 40 },
  installation: { rate: 1.2, burst: 20 },
  'tenant-github': { rate: 2, burst: 15 },
  model: { rate: 8, burst: 20 },
  'tenant-model': { rate: 1, burst: 6 },
  // How often one tenant's runners may say "the provider slowed us down" (governor.report): 4 at once, then one in 30 s.
  report: { rate: 1 / 30, burst: 4 },
  // L9e: a storage connection (Google Drive, S3) is its own account (the tenant brings it), with the tenant's share
  // of all its storage writes behind it. A standing export writes at most one file per team a day or per publish.
  storage: { rate: 2, burst: 5 },
  'tenant-storage': { rate: 1, burst: 5 },
});

/** A runner's report holds keys for at most this long; a shared account key, only on two tenants' word, once in 30 minutes. */
export const REPORT_HOLD_MAX_MS = 5 * 60_000;
const REPORT_QUORUM = 2;
const REPORT_WINDOW_MS = 5 * 60_000;
const REPORT_ACCOUNT_EVERY_MS = 30 * 60_000;

/** The keys a call goes through, in lock order: account, installation, tenant share. */
export function keysFor({ provider, account = null, installation = null, tenant = null }) {
  if (!['github', 'model'].includes(provider) && !EXPORT_SERVICES.has(provider)) throw new Problem(400, 'provider is github or model, or a storage service (google-drive, s3)');
  const out = [];
  if (EXPORT_SERVICES.has(provider)) {
    // The connection is the account: there is no shared one, so a call names it.
    if (!account) throw new Problem(400, 'a storage call names its connection');
    out.push({ key: `storage:${provider}:${account}`, kind: 'storage' });
    if (tenant) out.push({ key: `tenant:${tenant}:storage`, kind: 'tenant-storage' });
  } else if (provider === 'github') {
    out.push({ key: `github-app:${account ?? 'shared'}`, kind: 'github-app' });
    if (installation !== null && installation !== undefined) out.push({ key: `installation:${installation}`, kind: 'installation' });
    if (tenant) out.push({ key: `tenant:${tenant}:github`, kind: 'tenant-github' });
  } else {
    out.push({ key: `model:${account ?? 'shared'}`, kind: 'model' });
    if (tenant) out.push({ key: `tenant:${tenant}:model`, kind: 'tenant-model' });
  }
  for (const k of out) if (!KEY.test(k.key)) throw new Problem(400, `bad governor key ${k.key.slice(0, 60)}`);
  return out;
}

export function createGateway({ db, m3 = null, now = () => new Date(), limits = DEFAULT_LIMITS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), fetchWaitMaxMs = FETCH_WAIT_MAX_MS, effectStaleMs = EFFECT_STALE_MS }) {
  const lim = (kind) => limits[kind] ?? DEFAULT_LIMITS[kind];

  /**
   * Reserves a slot on every key of `call` at once and answers { waitMs, keys } (0 when it may go now). The reservation
   * is made whether it waits or not, so calls queue in the order they asked: a burst is paced, never dropped. Calls
   * that span a tenant share and a shared account go through `stage` (or `pace`) instead, which is what keeps C1 fair.
   */
  async function take(call) {
    return takeKeys(call, keysFor(call));
  }

  async function takeKeys(call, keys, { onlyNow = false } = {}) {
    const at = now();
    const t = at.getTime();
    const slowed = [];
    const out = await db.systemTx(async ({ q }) => {
      let goAt = t;
      const rows = [];
      for (const k of keys) {
        await q('insert into governor_buckets(key, tat) values ($1, $2) on conflict (key) do nothing', [k.key, at.toISOString()]);
        const [r] = await q('select tat, blocked_until, blocked_reason, slowed_at from governor_buckets where key = $1 for update', [k.key]);
        rows.push({ ...k, r });
      }
      // GCRA per key: the key lets the call go at max(now, tat - (burst - 1) * interval); a block holds it longer.
      // The call goes when every key lets it, and every key counts it at that time. Keys taken together are only ever
      // one stage (the caller's own keys, or the shared account alone; see `stage`), so a tenant waiting on its own
      // share never pushes the shared account's clock into the future for other tenants (C1 fairness).
      for (const row of rows) {
        const { rate, burst } = lim(row.kind);
        row.interval = 1000 / rate;
        row.tat = new Date(row.r.tat).getTime();
        const blocked = row.r.blocked_until ? new Date(row.r.blocked_until).getTime() : 0;
        row.allowAt = Math.max(t, row.tat - (burst - 1) * row.interval, blocked);
        goAt = Math.max(goAt, row.allowAt);
      }
      // A limiter (onlyNow) takes the slot only when it is free now: a refused report is not counted.
      if (onlyNow && goAt > t) return { waitMs: Math.round(goAt - t), keys: keys.map((k) => k.key) };
      for (const { key, kind, r, interval, tat } of rows) {
        const next = Math.max(tat, goAt) + interval;
        const slow = goAt - t >= 2000 && (!r.slowed_at || t - new Date(r.slowed_at).getTime() >= SLOWED_EVERY_MS);
        if (slow) slowed.push({ key, kind, reason: r.blocked_until && new Date(r.blocked_until).getTime() > t ? r.blocked_reason ?? 'blocked' : 'rate' });
        await q('update governor_buckets set tat = $2, updated_at = $3' + (slow ? ', slowed_at = $3' : '') + ' where key = $1', [key, new Date(next).toISOString(), at.toISOString()]);
      }
      return { waitMs: Math.max(0, Math.round(goAt - t)), keys: keys.map((k) => k.key) };
    });
    if (slowed.length && call.tenant && call.team && m3) await tellSlowed(call, out.waitMs, slowed).catch(() => {});
    return out;
  }

  /** `gateway.slowed` on the team that waits, so the Studio can say why things are slow. Never more than once a minute per key. */
  async function tellSlowed(call, waitMs, slowed) {
    await m3.tx(call.tenant, (ctx) => ctx.emit(call.team, 'gateway.slowed', {
      provider: call.provider, waitMs, keys: slowed.map((s) => ({ scope: s.kind, reason: s.reason })),
      ...(call.session ? { session: call.session } : {}),
      detail: `Calls to ${call.provider === 'github' ? 'GitHub' : 'the model provider'} are being paced: this one waits about ${Math.ceil(waitMs / 1000)} s. Nothing is dropped.`,
    }, { subject: `gateway/${call.provider}` }));
  }

  /**
   * One stage of a paced call, answered at once (never slept on, so a runner's other requests never wait behind it).
   * Stage `own` reserves the caller's own keys (its installation and its tenant's share) and answers
   * { waitMs, next: 'account' } (or next null for a call with no own keys left to take); the caller waits waitMs, then
   * asks stage `account`, which reserves the shared App or key and answers { waitMs, next: null }. The call goes when
   * that wait is over.
   */
  async function stage(call, which = 'own') {
    const keys = keysFor(call);
    if (which === 'account') return { ...(await takeKeys(call, keys.slice(0, 1))), stage: 'account', next: null };
    if (which !== 'own') throw new Problem(400, 'stage is own or account');
    if (keys.length === 1) return { ...(await takeKeys(call, keys)), stage: 'account', next: null };
    return { ...(await takeKeys(call, keys.slice(1))), stage: 'own', next: 'account' };
  }

  /**
   * Takes a slot and waits for it, in two steps (C1 fairness): first the caller's own keys (its installation and its
   * tenant's share), then the shared account, only once the call is really about to go. So a tenant that queues a
   * thousand calls waits on its own share, and the shared App or key only ever sees them at that share's pace.
   * Answers { waitedMs, keys }.
   */
  async function pace(call) {
    const keys = keysFor(call);
    let waited = 0;
    for (const part of [keys.slice(1), keys.slice(0, 1)]) {
      if (!part.length) continue;
      const r = await takeKeys(call, part);
      if (r.waitMs > 0) { await sleep(r.waitMs); waited += r.waitMs; }
    }
    return { waitedMs: waited, keys: keys.map((k) => k.key) };
  }

  /**
   * A provider answered with a rate limit or an abuse response: hold its keys until `retryAfterMs` from now (at
   * least a second, at most an hour), whichever key it was. `scope`: account (the App or key), installation or tenant.
   */
  async function block(call, { retryAfterMs, reason = 'rate-limited', maxMs = 3600_000, keys: only = null }) {
    const keys = only ?? keysFor(call);
    const ms = Math.min(Math.max(Number(retryAfterMs) || 60_000, 1000), maxMs);
    const at = now();
    const until = new Date(at.getTime() + ms).toISOString();
    const why = String(reason).slice(0, 100);
    // An abuse or secondary limit is the account's; a plain rate limit holds every key the call went through.
    const which = only ? keys : /abuse|secondary/i.test(why) ? keys.slice(0, 1) : keys;
    for (const k of which) {
      await db.system(`insert into governor_buckets(key, tat, blocked_until, blocked_reason) values ($1, $4, $2, $3)
                       on conflict (key) do update set blocked_until = greatest(coalesce(governor_buckets.blocked_until, excluded.blocked_until), excluded.blocked_until), blocked_reason = excluded.blocked_reason, updated_at = now()`, [k.key, until, why, at.toISOString()]);
    }
    return { blockedUntil: until, keys: which.map((k) => k.key) };
  }

  /**
   * A runner says a provider slowed it down (governor.report). Its word is a tenant's, so it holds only that tenant's
   * own keys (its share and its installation, which the caller has checked is the tenant's) for at most 5 minutes.
   * The shared account key is held on the server's own observation (wrapFetch), or when runners of two tenants report
   * it within 5 minutes; that hold lasts at most 5 minutes and is not renewed for 30, however often anyone reports.
   * A tenant may report 4 times at once, then once in 30 s; past that it is refused (429).
   */
  async function reported(call, { retryAfterMs, reason = 'rate-limited' }) {
    if (!call.tenant) throw new Problem(400, 'a report is a tenant\'s');
    const keys = keysFor(call);
    const limit = await takeKeys({ provider: call.provider }, [{ key: `report:${call.tenant}`, kind: 'report' }], { onlyNow: true });
    if (limit.waitMs > 0) throw new Problem(429, `too many slow-down reports; the next one in about ${Math.ceil(limit.waitMs / 1000)} s`, { type: 'report-rate' });
    const own = await block({ ...call, own: true }, { retryAfterMs, reason, maxMs: REPORT_HOLD_MAX_MS, keys: keys.slice(1) });
    const account = keys[0];
    const t = now().getTime();
    const held = await db.systemTx(async ({ q }) => {
      await q('insert into governor_buckets(key, tat) values ($1, $2) on conflict (key) do nothing', [account.key, new Date(t).toISOString()]);
      const [r] = await q('select reports, report_held_at from governor_buckets where key = $1 for update', [account.key]);
      const reports = Object.fromEntries(Object.entries(r.reports ?? {}).filter(([, at]) => t - Date.parse(at) < REPORT_WINDOW_MS));
      reports[call.tenant] = new Date(t).toISOString();
      const quorum = Object.keys(reports).length >= REPORT_QUORUM;
      const recent = r.report_held_at && t - new Date(r.report_held_at).getTime() < REPORT_ACCOUNT_EVERY_MS;
      await q('update governor_buckets set reports = $2::jsonb, report_held_at = case when $3::boolean then $4::timestamptz else report_held_at end where key = $1',
        [account.key, JSON.stringify(reports), quorum && !recent, new Date(t).toISOString()]);
      return quorum && !recent;
    });
    if (!held) return own;
    const acct = await block(call, { retryAfterMs, reason, maxMs: REPORT_HOLD_MAX_MS, keys: [account] });
    return { blockedUntil: own.blockedUntil, keys: [...acct.keys, ...own.keys] };
  }

  /**
   * Wraps a fetch for the code host: every request is paced on the App (and the installation, when the URL names
   * one), and a 403 or 429 that says to slow down blocks the keys for as long as GitHub asks. Responses go back
   * as they came; nothing is retried here, since a write must not happen twice.
   */
  function wrapFetch(f, context = () => ({})) {
    return async (url, init) => {
      const installation = /\/app\/installations\/(\d+)\//.exec(String(url))?.[1] ?? null;
      const call = { provider: 'github', installation, ...context(url, init) };
      // A person's request waits at most fetchWaitMaxMs for a slot; past it, it is answered with a 503 that says when
      // to try again, never held for the length of a provider's hold. (The slot it took is spent; the cost is one
      // interval on the keys, not a call.)
      for (let which = 'own'; which;) {
        const r = await stage(call, which);
        if (r.waitMs > fetchWaitMaxMs) return busy(r.waitMs);
        if (r.waitMs > 0) await sleep(r.waitMs);
        which = r.next;
      }
      const res = await f(url, init);
      if (res.status === 429 || res.status === 403) {
        const h = (n) => res.headers?.get?.(n);
        const after = Number(h('retry-after'));
        const reset = Number(h('x-ratelimit-reset'));
        const exhausted = h('x-ratelimit-remaining') === '0';
        let text = '';
        try { text = await res.clone().text(); } catch { /* no body */ }
        const secondary = /secondary rate limit|abuse/i.test(text);
        if (res.status === 429 || exhausted || secondary || Number.isFinite(after) && after > 0) {
          const ms = Number.isFinite(after) && after > 0 ? after * 1000 : exhausted && Number.isFinite(reset) ? reset * 1000 - now().getTime() : 60_000;
          await block(call, { retryAfterMs: ms, reason: secondary ? 'secondary rate limit' : 'rate-limited' }).catch(() => {});
        }
      }
      return res;
    };
  }

  function busy(waitMs) {
    const s = Math.ceil(waitMs / 1000);
    return new Response(JSON.stringify({ type: 'paced', message: `GitHub calls are being paced: try again in about ${s} s. Nothing was sent.`, retryAfter: s }),
      { status: 503, headers: { 'content-type': 'application/json', 'retry-after': String(s) } });
  }

  // ---- Effects (R5) -------------------------------------------------------------------------------------------------

  /**
   * Records an outward effect before it is sent. Answers { state: 'first' } when it should be sent now,
   * { state: 'repeat', result } when it was already done (send nothing; this is its result), and throws 409 while
   * the same key is in flight. A key that failed may be tried again.
   */
  async function begin(ctx, { key, team = null, session = null, tool, callHash = null, approval = null }) {
    if (typeof key !== 'string' || !EFFECT_KEY.test(key)) throw new Problem(400, 'key is the effect\'s idempotency key: 8 to 200 letters, digits or :._-');
    if (typeof tool !== 'string' || !tool || tool.length > 200) throw new Problem(400, 'tool names the effect');
    if (callHash !== null && (typeof callHash !== 'string' || callHash.length > 200)) throw new Problem(400, 'callHash is text');
    const [row] = await ctx.q(`insert into effects(tenant, key, team, session, tool, call_hash, started_at) values ($1, $2, $3, $4, $5, $6, $7)
                               on conflict (tenant, key) do nothing returning key`, [ctx.tenant, key, team, session, tool, callHash, ctx.now.toISOString()]);
    if (row) return { state: 'first' };
    const [e] = await ctx.q('select tool, call_hash, team, state, result, started_at, approval as used from effects where tenant = $1 and key = $2 for update', [ctx.tenant, key]);
    // The same key for another call is a bug or an attack: never answer it with someone else's result.
    if (e.tool !== tool || (e.call_hash && callHash && e.call_hash !== callHash) || (e.team && team && e.team !== team)) throw new Problem(409, `idempotency key ${key.slice(0, 40)} belongs to another call`, { type: 'effect-key' });
    if (e.state === 'done') return { state: 'repeat', result: e.result ?? null };
    // Still started long after it began: whoever sent it was cut off, and nobody knows whether it went. It becomes
    // `unknown`, and is never sent again on a runner's word: only with a person's approval to resend it (action
    // `effect-resend`, its call the key), or ended by effect.end once a person has said what happened.
    if (e.state === 'started' && ctx.now.getTime() - new Date(e.started_at).getTime() >= effectStaleMs) {
      await ctx.q("update effects set state = 'unknown' where tenant = $1 and key = $2", [ctx.tenant, key]);
      e.state = 'unknown';
    }
    if (e.state === 'started') throw new Problem(409, 'this effect is already being sent; wait for its result', { type: 'effect-in-flight' });
    if (e.state === 'unknown') {
      if (approval && approval === e.used) throw new Problem(409, 'that approval was already used to resend this effect; a person decides again', { type: 'effect-approval-used' });
      if (!(await approved(ctx, approval, e.team, key, e.started_at))) return { state: 'unknown', startedAt: new Date(e.started_at).toISOString(), detail: 'It may or may not have been sent. Ask a person (approval action effect-resend, call the key) before sending it again.' };
    }
    await ctx.q("update effects set state = 'started', attempts = attempts + 1, started_at = $3, done_at = null, approval = coalesce($4, approval) where tenant = $1 and key = $2",
      [ctx.tenant, key, ctx.now.toISOString(), e.state === 'unknown' ? approval : null]);
    return { state: 'first', retry: true };
  }

  /**
   * Records how an effect ended: ok with its (bounded) result, or failed (it may be tried again). A started effect is
   * ended by the session that began it. An unknown one only with a person's approval (action effect-resend, call the
   * key), since marking it failed would let it be sent again: ok when they say it went, failed when it did not.
   */
  async function end(ctx, { key, ok, result = null, session = null, approval = null }) {
    if (typeof key !== 'string' || !EFFECT_KEY.test(key)) throw new Problem(400, 'key is the effect\'s idempotency key');
    const json = result === null || result === undefined ? null : JSON.stringify(scrub(result));
    const kept = json && json.length > RESULT_MAX ? JSON.stringify({ truncated: true, bytes: json.length }) : json;
    const [e] = await ctx.q('select state, session, team, started_at, approval as used from effects where tenant = $1 and key = $2 for update', [ctx.tenant, key]);
    if (e?.state === 'unknown' && approval && approval === e.used) throw new Problem(409, 'that approval was already used to resend this effect; a person decides again', { type: 'effect-approval-used' });
    const mine = e?.state === 'started' && (!session || e.session === session);
    const decided = e?.state === 'unknown' && await approved(ctx, approval, e.team, key, e.started_at);
    if (!mine && !decided) throw new Problem(409, e?.state === 'unknown' ? 'this effect may or may not have gone: a person decides (approval effect-resend)' : 'no effect in flight with that key', { type: 'effect-key' });
    await ctx.q('update effects set state = $3, result = $4::jsonb, done_at = $5 where tenant = $1 and key = $2', [ctx.tenant, key, ok ? 'done' : 'failed', kept, ctx.now.toISOString()]);
    return { state: ok ? 'done' : 'failed' };
  }

  /**
   * A person approved resending (or settling) this unknown effect: action effect-resend, its call the key, on its
   * team, decided after the attempt that was cut off began. A resend starts a new attempt, so an approval counts once:
   * if that one is cut off too, a person decides again.
   */
  async function approved(ctx, approval, team, key, startedAt) {
    if (typeof approval !== 'string' || !approval) return false;
    return (await ctx.q(`select 1 from approvals where id = $1 and tenant = $2 and team = $3 and state = 'approved' and action = 'effect-resend' and call->>'command' = $4
                         and decided_at > $5`, [approval, ctx.tenant, team, key, new Date(startedAt).toISOString()])).length > 0;
  }

  // ---- put-file (L9e) ---------------------------------------------------------------------------------------------

  /**
   * The put-file effect: writes one file (a standing export's zip) to a storage connection, as an effect keyed on
   * team, connection, target, file name and commit, so a repeat of a written file is answered with the first result
   * and never written twice, and one cut off midway is not sent again without a person (effect-resend). The secret is
   * released by the vault (`release`, purpose standing-export) inside this call, handed to the connector's put, and
   * dropped: the caller never sees it, and nothing here keeps or logs it. Calls are paced on the connection and the
   * tenant's share; a 429 or 503 holds them for as long as the service asks. The connector may reach only its own
   * hosts, over https. Answers { service, id, bytes, repeat? }; throws an Error whose message is safe to show.
   */
  async function putFile({ tenant, team, connection, service, target, name, bytes, sha = null }, { release, connectors = EXPORT_CONNECTORS, fetch: send = fetch, timeoutMs = 120_000 } = {}) {
    if (!m3) throw new Error('put-file needs the gateway wired to the event store');
    if (typeof release !== 'function') throw new Error('put-file needs the vault');
    const conn = connectors[service];
    if (!conn || !EXPORT_SERVICES.has(service)) throw new Error(`OrgCraft can't write files to ${String(service).slice(0, 40)}`);
    if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw new Error('put-file writes bytes');
    const where = conn.where(target);
    const key = `put-file:${createHash('sha256').update(JSON.stringify([team, connection, service, target, name, sha])).digest('hex').slice(0, 48)}`;
    const callHash = createHash('sha256').update(bytes).digest('hex');
    const tool = `put-file:${service}`;
    const b = (await m3.tx(tenant, (ctx) => begin(ctx, { key, team, tool, callHash }))).result;
    if (b.state === 'repeat') return { ...(b.result ?? {}), repeat: true };
    if (b.state === 'unknown') throw new Error('the last copy may or may not have been written; a person decides before it is sent again (approval effect-resend)');
    const call = { provider: service, account: connection, tenant, team };
    let value = null;
    try {
      const secret = await release({ tenant, team, connection, purpose: 'standing-export' });
      value = secret?.value ?? null;
      if (!value) throw new Error('the vault did not release this connection for the team; check that it is still granted to the team');
      await pace(call);
      const paced = async (url, init = {}) => {
        if (!allowedHost(conn, url)) throw new Error(`the ${service} connector tried to reach a host it may not`);
        const res = await send(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
        if (res.status === 429 || res.status === 503) {
          const after = Number(res.headers?.get?.('retry-after'));
          await block(call, { retryAfterMs: Number.isFinite(after) && after > 0 ? after * 1000 : 60_000, reason: 'rate-limited', keys: keysFor(call) }).catch(() => {});
        }
        return res;
      };
      const out = await conn.put({ secret: value, where, name, bytes: Buffer.from(bytes), send: paced, now: now() });
      const result = { service, id: out.id, ...(out.etag ? { etag: out.etag } : {}), bytes: bytes.length };
      value = null;
      await m3.tx(tenant, (ctx) => end(ctx, { key, ok: true, result }));
      return result;
    } catch (e) {
      let text = String(e?.name === 'TimeoutError' ? `${service} did not answer in time` : e?.message ?? e).replace(/\s+/g, ' ');
      // Belt and braces: whatever a service or connector said, the value itself never leaves in an error.
      if (value) for (const part of [value, ...String(value).split(/["\s,:{}]+/).filter((x) => x.length >= 12)]) text = text.split(part).join('[secret]');
      const why = redactPatterns(text).text.slice(0, 240);
      await m3.tx(tenant, (ctx) => end(ctx, { key, ok: false, result: { service, error: why } })).catch(() => {});
      throw new Error(why);
    }
  }

  return { take, stage, pace, block, reported, wrapFetch, begin, end, keysFor, putFile };
}
