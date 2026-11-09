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

const KEY = /^[A-Za-z0-9:._@/-]{1,200}$/;
const EFFECT_KEY = /^[A-Za-z0-9:._-]{8,200}$/;
const SLOWED_EVERY_MS = 60_000;
const RESULT_MAX = 16 * 1024;

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
});

/** The keys a call goes through, in lock order: account, installation, tenant share. */
export function keysFor({ provider, account = null, installation = null, tenant = null }) {
  if (!['github', 'model'].includes(provider)) throw new Problem(400, 'provider is github or model');
  const out = [];
  if (provider === 'github') {
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

export function createGateway({ db, m3 = null, now = () => new Date(), limits = DEFAULT_LIMITS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const lim = (kind) => limits[kind] ?? DEFAULT_LIMITS[kind];

  /**
   * Reserves a slot on every key of `call` and answers { waitMs, keys } (0 when it may go now). The reservation is
   * made whether it waits or not, so calls queue in the order they asked: a burst is paced, never dropped.
   */
  async function take(call) {
    return takeKeys(call, keysFor(call));
  }

  async function takeKeys(call, keys) {
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
      // The call goes when every key lets it. Each key counts the call at the time it let it go, so a tenant waiting
      // on its own share never pushes the shared account's clock into the future for other tenants (C1 fairness).
      for (const row of rows) {
        const { rate, burst } = lim(row.kind);
        row.interval = 1000 / rate;
        row.tat = new Date(row.r.tat).getTime();
        const blocked = row.r.blocked_until ? new Date(row.r.blocked_until).getTime() : 0;
        row.allowAt = Math.max(t, row.tat - (burst - 1) * row.interval, blocked);
        goAt = Math.max(goAt, row.allowAt);
      }
      for (const { key, kind, r, interval, tat, allowAt } of rows) {
        const next = Math.max(tat, allowAt) + interval;
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
  async function block(call, { retryAfterMs, reason = 'rate-limited', maxMs = 3600_000 }) {
    const keys = keysFor(call);
    const ms = Math.min(Math.max(Number(retryAfterMs) || 60_000, 1000), maxMs);
    const at = now();
    const until = new Date(at.getTime() + ms).toISOString();
    const why = String(reason).slice(0, 100);
    // An abuse or secondary limit is the account's; a plain rate limit holds every key the call went through.
    const which = /abuse|secondary/i.test(why) ? keys.slice(0, 1) : keys;
    for (const k of which) {
      await db.system(`insert into governor_buckets(key, tat, blocked_until, blocked_reason) values ($1, $4, $2, $3)
                       on conflict (key) do update set blocked_until = greatest(coalesce(governor_buckets.blocked_until, excluded.blocked_until), excluded.blocked_until), blocked_reason = excluded.blocked_reason, updated_at = now()`, [k.key, until, why, at.toISOString()]);
    }
    return { blockedUntil: until, keys: which.map((k) => k.key) };
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
      await pace(call);
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

  // ---- Effects (R5) -------------------------------------------------------------------------------------------------

  /**
   * Records an outward effect before it is sent. Answers { state: 'first' } when it should be sent now,
   * { state: 'repeat', result } when it was already done (send nothing; this is its result), and throws 409 while
   * the same key is in flight. A key that failed may be tried again.
   */
  async function begin(ctx, { key, team = null, session = null, tool, callHash = null }) {
    if (typeof key !== 'string' || !EFFECT_KEY.test(key)) throw new Problem(400, 'key is the effect\'s idempotency key: 8 to 200 letters, digits or :._-');
    if (typeof tool !== 'string' || !tool || tool.length > 200) throw new Problem(400, 'tool names the effect');
    if (callHash !== null && (typeof callHash !== 'string' || callHash.length > 200)) throw new Problem(400, 'callHash is text');
    const [row] = await ctx.q(`insert into effects(tenant, key, team, session, tool, call_hash) values ($1, $2, $3, $4, $5, $6)
                               on conflict (tenant, key) do nothing returning key`, [ctx.tenant, key, team, session, tool, callHash]);
    if (row) return { state: 'first' };
    const [e] = await ctx.q('select tool, call_hash, state, result from effects where tenant = $1 and key = $2 for update', [ctx.tenant, key]);
    // The same key for another call is a bug or an attack: never answer it with someone else's result.
    if (e.tool !== tool || (e.call_hash && callHash && e.call_hash !== callHash)) throw new Problem(409, `idempotency key ${key.slice(0, 40)} belongs to another call`, { type: 'effect-key' });
    if (e.state === 'done') return { state: 'repeat', result: e.result ?? null };
    if (e.state === 'started') throw new Problem(409, 'this effect is already being sent; wait for its result', { type: 'effect-in-flight' });
    await ctx.q("update effects set state = 'started', attempts = attempts + 1, done_at = null where tenant = $1 and key = $2", [ctx.tenant, key]);
    return { state: 'first', retry: true };
  }

  /** Records how an effect ended: ok with its (bounded) result, or failed (it may be tried again). */
  async function end(ctx, { key, ok, result = null, session = null }) {
    if (typeof key !== 'string' || !EFFECT_KEY.test(key)) throw new Problem(400, 'key is the effect\'s idempotency key');
    const json = result === null || result === undefined ? null : JSON.stringify(result);
    const kept = json && json.length > RESULT_MAX ? JSON.stringify({ truncated: true, bytes: json.length }) : json;
    const rows = await ctx.q(`update effects set state = $3, result = $4::jsonb, done_at = $5 where tenant = $1 and key = $2 and state = 'started' ${session ? 'and session = $6' : ''} returning key`,
      [ctx.tenant, key, ok ? 'done' : 'failed', kept, ctx.now.toISOString(), ...(session ? [session] : [])]);
    if (!rows.length) throw new Problem(409, 'no effect in flight with that key', { type: 'effect-key' });
    return { state: ok ? 'done' : 'failed' };
  }

  return { take, pace, block, wrapFetch, begin, end, keysFor };
}
