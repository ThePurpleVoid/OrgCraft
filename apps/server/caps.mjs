// Caps, spend leases and cost estimates (local PR L24s; vision G15.1 caps Now, G15.2 cost warning; CTO review 2 R4 and
// R14). Money is in the budget's minor units and currency throughout, like budgets and budget_days.
//
// - The caps tree (GET /teams/{team}/caps): today's cap in the team's time zone with what happens at each step (warn at
//   80%, pause and ask at 100%), each live run's cap, and the meeting cap. Next adds caps per department, teammate and
//   task under the same shape.
// - Spend leases (runner op `spend.lease`): before a session spends, it is given an amount from what is left today and
//   on its run, for a few minutes. Open leases count as spent when the next one is granted, under a lock on the day's
//   row, so two sessions can't both be given the last cent, and a runner cut off from the control plane can overshoot
//   by at most what it holds. Usage it reports is counted against its lease (recordUsage); a lease ends when it expires,
//   when the session takes a new one, or when the session ends.
// - Estimates (GET /teams/{team}/estimate): what a meeting, a trial run of a role or a new teammate usually costs here,
//   from the last 30 days, against what is left today. Shown before the owner starts one; it never blocks.
import { randomBytes } from 'node:crypto';
import { Problem } from './store.mjs';
import { dayStart, localDay, nextDay } from './budget-day.mjs';

export const LEASE_SECONDS = 300;
const HISTORY_DAYS = 30;
const MIN_SAMPLES = 5;
const isInt = (v) => Number.isSafeInteger(v);
const ulid = () => randomBytes(10).toString('hex');
const COST = "case when jsonb_typeof(envelope->'data'->'cost') = 'number' then (envelope->'data'->>'cost')::numeric else 0 end";

async function budgetOf(q, team) {
  const [b] = await q('select currency, per_day, per_run, sessions, meeting_cap, time_zone from budgets where team = $1', [team]);
  if (!b) return null;
  const n = (v) => (v === null || v === undefined ? null : Number(v));
  return { currency: b.currency, perDay: n(b.per_day), perRun: n(b.per_run), meetingCap: n(b.meeting_cap), timeZone: b.time_zone ?? 'UTC' };
}

/** What open leases hold back, not yet reported as spent: for the team's day, or for one run. */
async function held(q, team, day, { run = null, except = null, at }) {
  const [r] = await q(`select coalesce(sum(greatest(amount - used, 0)), 0) as held from spend_leases
                       where team = $1 and day = $2::date and ended_at is null and expires_at > $3 ${run ? 'and run = $4' : ''} ${except ? `and session <> $${run ? 5 : 4}` : ''}`,
    [team, day, at.toISOString(), ...(run ? [run] : []), ...(except ? [except] : [])]);
  return Number(r.held);
}

/** A run's cap and spend: the team's perRun or the run's costPerRun (the lower), plus what was raised for it. */
async function runMoney(q, team, run, b) {
  const caps = run.caps ?? {};
  const cap = Math.min(b?.perRun ?? Infinity, isInt(caps.costPerRun) ? caps.costPerRun : Infinity);
  const [{ spent }] = await q(`select coalesce(sum(${COST}), 0) as spent from events where team = $1 and type = 'usage.recorded' and envelope->>'run' = $2`, [team, run.id]);
  return { cap: cap === Infinity ? null : cap + (isInt(caps.raised) ? caps.raised : 0), spent: Math.round(Number(spent)) };
}

/** The p25, median and p75 of a list of amounts, rounded to whole minor units. */
function spread(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p) => { const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return Math.round(s[lo] + (s[hi] - s[lo]) * (i - lo)); };
  return { low: at(0.25), typical: at(0.5), high: at(0.75) };
}

export function createCaps({ db, getTeam, now = () => new Date() }) {
  /** GET /teams/{team}/caps: the cap tree, each with its spend and what happens when it is reached. */
  async function tree(tenant, team) {
    await getTeam(db, tenant, team);
    return db.tenant(tenant, async ({ q }) => {
      const at = now();
      const b = (await budgetOf(q, team)) ?? { currency: 'USD', perDay: null, perRun: null, meetingCap: null, timeZone: 'UTC' };
      const day = localDay(at, b.timeZone);
      const [d] = await q('select spent, raised, warned_at, exhausted_at from budget_days where team = $1 and day = $2::date', [team, day]);
      const spent = Number(d?.spent ?? 0), raised = Number(d?.raised ?? 0);
      const leased = await held(q, team, day, { at });
      const dayCap = b.perDay === null ? null : b.perDay + raised;
      const caps = [{
        id: 'day', scope: 'team', period: 'day', day, timeZone: b.timeZone,
        startedAt: dayStart(day, b.timeZone).toISOString(), resetsAt: dayStart(nextDay(day), b.timeZone).toISOString(),
        cap: dayCap, set: b.perDay, raised, spent, leased, remaining: dayCap === null ? null : Math.max(dayCap - spent - leased, 0),
        state: d?.exhausted_at ? 'exhausted' : d?.warned_at ? 'warned' : dayCap === null ? 'unset' : 'ok',
        // No daily cap set means no run may start (never unlimited).
        steps: dayCap === null ? [{ at: 0, then: 'stop', why: 'no daily cap is set, so no run starts' }] : [{ at: 0.8, then: 'warn' }, { at: 1, then: 'pause', ask: 'owner' }],
      }];
      for (const r of await q("select id, state, caps from runs where team = $1 and state in ('running', 'paused') order by started_at", [team])) {
        const m = await runMoney(q, team, r, b);
        const runHeld = await held(q, team, day, { run: r.id, at });
        caps.push({
          id: `run/${r.id}`, scope: 'run', run: r.id, state: r.state, cap: m.cap, spent: m.spent, leased: runHeld,
          remaining: m.cap === null ? null : Math.max(m.cap - m.spent - runHeld, 0),
          ...(isInt(r.caps?.costPerDay) ? { perDay: r.caps.costPerDay } : {}),
          steps: m.cap === null ? [] : [{ at: 1, then: 'pause', ask: 'owner' }],
        });
      }
      const meetingCap = b.meetingCap ?? (b.perDay === null ? null : Math.max(1, Math.floor(b.perDay / 10)));
      caps.push({ id: 'meeting', scope: 'meeting', cap: meetingCap, default: b.meetingCap === null, steps: meetingCap === null ? [] : [{ at: 1, then: 'close' }] });
      return { currency: b.currency, timeZone: b.timeZone, caps };
    });
  }

  /**
   * Runner op `spend.lease` { session, amount? }: grants up to `amount` (default a twentieth of the daily cap) from
   * what is left today and on the session's run, minus what other sessions' open leases hold. Answers
   * { lease, amount, currency, day, expiresAt, remainingToday } or { amount: 0, reason } when nothing is left.
   */
  async function lease(ctx, sess, want) {
    const { q } = ctx;
    if (want !== undefined && want !== null && !(isInt(want) && want > 0)) throw new Problem(400, 'amount is a whole number of minor units above zero');
    const b = await budgetOf(q, sess.team);
    const day = localDay(ctx.now, b?.timeZone ?? 'UTC');
    if (!b || b.perDay === null) return { amount: 0, reason: 'no-cap', day };
    // The day's row, locked: every grant for this team and day goes one at a time.
    await q('insert into budget_days(tenant, team, day) values ($1, $2, $3::date) on conflict (team, day) do nothing', [ctx.tenant, sess.team, day]);
    const [d] = await q('select spent, raised, exhausted_at from budget_days where team = $1 and day = $2::date for update', [sess.team, day]);
    // This session's open lease is replaced by the new one; expired ones end.
    await q('update spend_leases set ended_at = $3 where team = $1 and ended_at is null and (session = $2 or expires_at <= $3)', [sess.team, sess.id, ctx.now.toISOString()]);
    const [run] = await q('select id, state, caps from runs where id = $1 and team = $2', [sess.run, sess.team]);
    if (!run || run.state !== 'running') return { amount: 0, reason: 'paused', day };
    if (d.exhausted_at) return { amount: 0, reason: 'day', day, remainingToday: 0 };
    const dayLeft = b.perDay + Number(d.raised) - Number(d.spent) - (await held(q, sess.team, day, { at: ctx.now }));
    const m = await runMoney(q, sess.team, run, b);
    const runLeft = m.cap === null ? Infinity : m.cap - m.spent - (await held(q, sess.team, day, { run: run.id, at: ctx.now }));
    const ask = want ?? Math.max(1, Math.floor(b.perDay / 20));
    const amount = Math.min(ask, dayLeft, runLeft);
    if (amount <= 0) return { amount: 0, reason: dayLeft <= runLeft ? 'day' : 'run', day, remainingToday: Math.max(dayLeft, 0) };
    const id = `lse_${ulid()}`;
    const expiresAt = new Date(ctx.now.getTime() + LEASE_SECONDS * 1000);
    await q('insert into spend_leases(id, tenant, team, run, session, day, currency, amount, expires_at) values ($1, $2, $3, $4, $5, $6::date, $7, $8, $9)',
      [id, ctx.tenant, sess.team, run.id, sess.id, day, b.currency, amount, expiresAt.toISOString()]);
    return { lease: id, amount, currency: b.currency, day, expiresAt: expiresAt.toISOString(), remainingToday: dayLeft - amount };
  }

  /** A session ended or stopped: its lease ends, so what it held is free again. */
  async function release(q, session, at) {
    await q('update spend_leases set ended_at = $2 where session = $1 and ended_at is null', [session, at.toISOString()]);
  }

  /**
   * GET /teams/{team}/estimate?kind=meeting&attendees=N | kind=trial&role=R | kind=teammate&role=R: the usual cost
   * here over the last 30 days (p25, median, p75), what it is based on, and whether it may not fit in what is left
   * today. A meeting: past meetings' spend per attendee, times the attendees. A trial run: one session of that role
   * (or of any role, when the role has fewer than 5). A new teammate: a working day of that role (or of any role).
   */
  async function estimate(tenant, team, query) {
    await getTeam(db, tenant, team);
    const kind = String(query?.kind ?? '');
    if (!['meeting', 'trial', 'teammate'].includes(kind)) throw new Problem(400, 'kind is meeting, trial or teammate');
    const role = query?.role === undefined ? null : String(query.role);
    if (role !== null && !/^[a-z0-9][a-z0-9_-]{0,59}$/.test(role)) throw new Problem(400, 'role is a member id, like web-dev');
    const attendees = query?.attendees === undefined ? null : Number(query.attendees);
    if (kind === 'meeting' && !(isInt(attendees) && attendees >= 1 && attendees <= 50)) throw new Problem(400, 'attendees is 1 to 50');
    if (kind !== 'meeting' && !role) throw new Problem(400, `a ${kind} estimate needs the role`);
    return db.tenant(tenant, async ({ q }) => {
      const at = now();
      const b = (await budgetOf(q, team)) ?? { currency: 'USD', perDay: null, timeZone: 'UTC' };
      const since = new Date(at.getTime() - HISTORY_DAYS * 86_400_000).toISOString();
      let samples = [], basis = 'none';
      if (kind === 'meeting') {
        const rows = await q(`select spent, jsonb_array_length(attendees) as n from meetings where team = $1 and state = 'closed' and outcome = 'completed' and opened_at >= $2 and jsonb_typeof(attendees) = 'array'`, [team, since]);
        samples = rows.filter((r) => Number(r.n) > 0).map((r) => (Number(r.spent) / Number(r.n)) * attendees);
        basis = samples.length ? 'meetings' : 'none';
      } else {
        // One sample: a session (a trial run), or a role's working day in the team's time zone (a teammate).
        const unit = kind === 'trial' ? "envelope->'actor'->>'session'" : "(time at time zone $3)::date::text || '/' || actor_id";
        const per = async (who) => (await q(`select ${unit} as k, sum(${COST}) as spent from events
                                             where team = $1 and type = 'usage.recorded' and time >= $2 and ($3::text is not null) ${who ? 'and actor_id = $4' : ''} group by 1 having sum(${COST}) > 0`,
          who ? [team, since, b.timeZone, who] : [team, since, b.timeZone])).map((r) => Number(r.spent));
        samples = await per(role);
        basis = 'role';
        if (samples.length < MIN_SAMPLES) { samples = await per(null); basis = samples.length ? 'team' : 'none'; }
      }
      const est = samples.length ? spread(samples) : null;
      const [d] = await q('select spent, raised from budget_days where team = $1 and day = $2::date', [team, localDay(at, b.timeZone)]);
      const left = b.perDay === null ? null : Math.max(b.perDay + Number(d?.raised ?? 0) - Number(d?.spent ?? 0) - (await held(q, team, localDay(at, b.timeZone), { at })), 0);
      const per = { meeting: 'for the meeting', trial: 'for one run of the role', teammate: 'a working day' }[kind];
      return {
        kind, ...(role ? { role } : {}), ...(attendees ? { attendees } : {}), currency: b.currency,
        estimate: est, basis: { from: basis, samples: samples.length, days: HISTORY_DAYS }, per,
        remainingToday: left,
        // A warning, never a block: the usual high end may not fit in what is left today.
        mayNotFit: Boolean(est && left !== null && est.high > left),
      };
    });
  }

  return { tree, lease, release, estimate };
}
