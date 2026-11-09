// Runs, budgets, chat, cards, approvals and step-up (docs/product/m3-design.md sections 1, 4, 5 and 6).
//
// The rule that holds it together: every change is an event appended in the same transaction as the projection
// row it changes (runs, cards, approvals, chat_messages, budget_days), so the log stays the system of record. Each
// function here returns { result, stored }: `stored` is what was appended, for the live hub and the sinks.
import { atLeast } from './roles.mjs';
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Problem, appendIn, getTeam, id, sha, SLUG } from './store.mjs';
import { checkMeetingDefs } from './meetings.mjs';
import { approveScope, factsOf, redact as redactText, riskOf } from './signed.mjs';
import { checkSystems } from './credentials.mjs';
import { checkTriggers } from './triggers.mjs';
import { halted } from './live.mjs';

const scrypt = promisify(scryptCb);

export const CHAT_TYPES = ['chat.message', 'decision.requested', 'decision.answered', 'approval.requested', 'approval.decided', 'card.updated', 'ready.posted', 'ready.previewed',
  'run.started', 'run.paused', 'run.resumed', 'run.stopped', 'budget.warned', 'budget.exhausted'];
export const STEP_UP_MINUTES = 5;
export const APPROVAL_HOURS = 24;
const STEP_UP_LOCKOUT = { failures: 5, minutes: 15 };

/** A step-up is needed: 401 with problem type step-up-required (clients.md section 3), never a silent approval. */
export class StepUpRequired extends Problem {
  /** `scope`, when set, is what the step-up must be bound to: POST /v1/auth/step-up with { scope } (ADR 0013). */
  constructor(what, scope = null) {
    super(401, `${what} needs a fresh step-up${scope ? ` for ${scope}` : ''}: POST /v1/auth/step-up${scope ? ` with { scope: "${scope}" }` : ''}, then send x-step-up`, { type: 'step-up-required', ...(scope ? { body: { scope } } : {}) });
  }
}
/** A step-up scope: a short name for one change, e.g. resume:run_123. */
export const STEP_UP_SCOPE = /^[a-z][a-z-]{0,30}:[A-Za-z0-9_-]{1,120}$/;

let lastMs = 0, counter = 0;
/** Event ids we mint sort by time (events.md): milliseconds in base 36, a counter, then randomness. */
export function eventId() {
  const ms = Date.now();
  counter = ms === lastMs ? counter + 1 : 0;
  lastMs = ms;
  return `ev_${ms.toString(36).padStart(9, '0')}${counter.toString(36).padStart(3, '0')}${randomBytes(6).toString('base64url')}`;
}

const SYSTEM = { kind: 'system', id: 'control-plane', via: 'api' };
/** What a held call will do, in words for the card (QA M3 exit A): the exact call stays in the card's data. */
export function describeCall(call) {
  const cut = (t, n = 300) => (t.length > n ? `${t.slice(0, n)}…` : t);
  if (typeof call === 'string') return `It will run: ${cut(call)}`;
  if (call && typeof call === 'object') {
    if (call.pr) return `It will merge pull request #${call.pr}${call.headSha ? ` at commit ${String(call.headSha).slice(0, 7)}` : ''}${call.repo ? ` in ${call.repo}` : ''}.`;
    if (typeof call.command === 'string') return `It will run: ${cut(call.command)}`;
    if (typeof call.tool === 'string') return `It will call the tool ${call.tool}.`;
  }
  return 'The exact call is attached to this card.';
}

/** Minor units as money for a card's text ($6.14); the numbers stay in the card's data for clients to format. */
export function money(minor, currency = 'USD') {
  try {
    const f = new Intl.NumberFormat('en-US', { style: 'currency', currency });
    return f.format(Number(minor) / 10 ** f.resolvedOptions().maximumFractionDigits);
  } catch { return `${minor} ${currency} (minor units)`; }
}
export const personActor = (who) => ({ kind: 'person', id: who, via: 'studio' });

/** A new envelope minted by the control plane. */
export function mint(tenant, team, type, data, { actor = SYSTEM, subject, run, teamVersion, time = new Date(), id: given = null } = {}) {
  // A deterministic id (a schedule's slot, a webhook's inbound row) makes a second write of the same thing a no-op.
  const e = { specversion: '1.0', id: given ?? eventId(), type, version: 1, source: `/tenants/${tenant}/teams/${team}`, tenant, team, time: time.toISOString(), actor, data };
  if (subject) e.subject = subject;
  if (run) e.run = run;
  if (teamVersion) e.teamVersion = teamVersion;
  return e;
}

const utcDay = (d) => d.toISOString().slice(0, 10);
const nextUtcDay = (d) => utcDay(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)));
const isInt = (v) => Number.isSafeInteger(v);

/**
 * The context every write runs in: one tenant transaction, an `emit` that appends with the projections, and the
 * list of what was stored. `hooks.afterCommit` lets the bus send frames once the transaction is durable.
 */
export function createM3({ db, now, publicUrl = '', hooks = {} }) {
  now ??= () => new Date();
  const checking = new Set();
  const listeners = [];
  const base = String(publicUrl || '').replace(/\/+$/, '');

  async function tx(tenant, fn) {
    const stored = [];
    const after = [];
    const result = await db.tenant(tenant, async ({ q }) => {
      const ctx = {
        q, tenant, now: now(), after, stored,
        async emit(team, type, data, opts = {}) {
          const e = mint(tenant, team, type, data, { time: ctx.now, ...opts });
          stored.push(...(await appendIn(q, tenant, team, [e], { project: (qq, s) => project(ctx, s), now: ctx.now })));
          return e;
        },
        audit: (row) => q(`insert into audit(tenant, team, actor_kind, actor_id, session, action, target, decision, rule, event, detail)
                           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [tenant, row.team ?? null, row.actorKind ?? 'system', row.actorId ?? 'control-plane', row.session ?? null, row.action, row.target ?? null,
            row.decision ?? null, row.rule ?? null, row.event ?? null, row.detail ? JSON.stringify(row.detail) : null]),
      };
      return fn(ctx);
    });
    // Committed: tell the live hub and sinks, then run what waits for commit (sends to runners).
    if (stored.length) for (const fn of listeners) { try { fn(stored); } catch { /* a listener never fails a write */ } }
    for (const f of after) await Promise.resolve(f()).catch(() => {});
    return { result, stored };
  }

  /** Projections that run for every stored event, whatever path appended it (the API, a runner, the tick). */
  async function project(ctx, { event }) {
    if (event.type === 'usage.recorded' && event.team) await recordUsage(ctx, event);
    if (hooks.project) await hooks.project(ctx, { event });
    return [];
  }

  // ---- Budget (section 6) ---------------------------------------------------------------------------------------

  async function budgetRow(q, team) {
    const [b] = await q('select currency, per_day, per_run, sessions, meeting_cap from budgets where team = $1', [team]);
    return b ? { currency: b.currency, perDay: b.per_day === null ? null : Number(b.per_day), perRun: b.per_run === null ? null : Number(b.per_run), sessions: Number(b.sessions), meetingCap: b.meeting_cap === null || b.meeting_cap === undefined ? null : Number(b.meeting_cap) } : null;
  }

  async function today(q, team, at) {
    const [d] = await q('select day, spent, raised, warned_at, exhausted_at from budget_days where team = $1 and day = $2::date', [team, utcDay(at)]);
    const spent = Number(d?.spent ?? 0), raised = Number(d?.raised ?? 0);
    return { day: utcDay(at), spent, raised, state: d?.exhausted_at ? 'exhausted' : d?.warned_at ? 'warned' : 'ok' };
  }

  async function getBudget(tenant, team) {
    await getTeam(db, tenant, team);
    return db.tenant(tenant, async ({ q }) => {
      const b = (await budgetRow(q, team)) ?? { currency: 'USD', perDay: null, perRun: null, sessions: 3, meetingCap: null };
      return { ...b, today: await today(q, team, now()) };
    });
  }

  /** Sets the caps. Raising or clearing one needs step-up (issue #28 D4); lowering never does, so braking is fast. */
  async function putBudget(tenant, team, body, by, { stepUp = null } = {}) {
    await getTeam(db, tenant, team);
    const b = body ?? {};
    for (const k of ['perDay', 'perRun']) if (b[k] !== undefined && b[k] !== null && !(isInt(b[k]) && b[k] >= 0)) throw new Problem(400, `${k} is a whole number of minor units, or null`);
    if (b.meetingCap !== undefined && b.meetingCap !== null && !(isInt(b.meetingCap) && b.meetingCap > 0)) throw new Problem(400, 'meetingCap is a whole number of minor units above zero, or null (a tenth of perDay)');
    if (b.sessions !== undefined && !(isInt(b.sessions) && b.sessions >= 1 && b.sessions <= 100)) throw new Problem(400, 'sessions is 1 to 100');
    if (b.currency !== undefined && !/^[A-Z]{3}$/.test(b.currency)) throw new Problem(400, 'currency is an ISO 4217 code, like USD');
    return tx(tenant, async (ctx) => {
      const old = (await budgetRow(ctx.q, team)) ?? { currency: 'USD', perDay: null, perRun: null, sessions: 3, meetingCap: null };
      const next = { currency: b.currency ?? old.currency, perDay: b.perDay !== undefined ? b.perDay : old.perDay, perRun: b.perRun !== undefined ? b.perRun : old.perRun, sessions: b.sessions ?? old.sessions, meetingCap: b.meetingCap !== undefined ? b.meetingCap : old.meetingCap ?? null };
      // Lowering perDay below the stored meetingCap brings the meeting cap down with it (a lowering, so no step-up);
      // only a meetingCap sent in this request above perDay is refused.
      let clamped = false;
      if (next.meetingCap !== null && next.perDay !== null && next.meetingCap > next.perDay) {
        if (b.meetingCap !== undefined) throw new Problem(409, `meetingCap (${next.meetingCap}) is above perDay (${next.perDay})`);
        next.meetingCap = Math.max(1, next.perDay);
        clamped = true;
      }
      // No cap (null) means unlimited for perRun; for perDay it means no run may start. Either way, going from a number
      // to null, or to a bigger number, lets more be spent.
      const raises = (o, n, nullIsUnlimited) => (o === null ? (nullIsUnlimited ? false : n !== null) : n === null ? true : n > o);
      // A null meetingCap means a tenth of perDay, so going from a number to null may raise it too.
      const meetingDefault = (x) => (x.meetingCap ?? (x.perDay === null ? 0 : Math.max(1, Math.floor(x.perDay / 10))));
      const raising = raises(old.perDay, next.perDay, false) || raises(old.perRun, next.perRun, true) || next.sessions > old.sessions || meetingDefault(next) > meetingDefault(old);
      if (raising && !(await useStepUp(ctx, by, stepUp))) throw new StepUpRequired('Raising a budget');
      await ctx.q(`insert into budgets(tenant, team, currency, per_day, per_run, sessions, meeting_cap, updated_by) values ($1, $2, $3, $4, $5, $6, $7, $8)
                   on conflict (team) do update set currency = excluded.currency, per_day = excluded.per_day, per_run = excluded.per_run,
                   sessions = excluded.sessions, meeting_cap = excluded.meeting_cap, updated_by = excluded.updated_by, updated_at = now()`,
        [tenant, team, next.currency, next.perDay, next.perRun, next.sessions, next.meetingCap, by]);
      // A stepped-up raise of the daily cap is newer than today's spent mark (and any Resume tomorrow): when the new cap
      // is above today's spend, today is open again, so a resume goes through (QA #162). The warning stays if 80% is passed.
      if (next.perDay !== null && raises(old.perDay, next.perDay, false)) {
        await ctx.q(`update budget_days set exhausted_at = null, warned_at = case when spent >= ceil(($3::bigint + raised) * 0.8) then warned_at else null end
                     where team = $1 and day = $2::date and exhausted_at is not null and spent < $3::bigint + raised`, [team, utcDay(ctx.now), next.perDay]);
      }
      await ctx.audit({ team, actorKind: 'person', actorId: by, action: 'budget', target: team, decision: 'allowed', detail: { from: old, to: next, stepUp: raising, ...(clamped ? { meetingCapClamped: true } : {}) } });
      await ctx.emit(team, 'budget.updated', { ...next, by }, { actor: personActor(by), subject: 'budget' });
      return { ...next, today: await today(ctx.q, team, ctx.now) };
    });
  }

  /** usage.recorded: add to today's spend, warn at 80%, and at 100% pause the team's runs and ask the owner. */
  async function recordUsage(ctx, event) {
    const { q } = ctx;
    const team = event.team;
    const cost = isInt(event.data?.cost) && event.data.cost > 0 ? event.data.cost : 0;
    if (!cost) return;
    const day = utcDay(new Date(event.time));
    const [d] = await q(`insert into budget_days(tenant, team, day, spent) values ($1, $2, $3::date, $4)
                         on conflict (team, day) do update set spent = budget_days.spent + excluded.spent
                         returning spent, raised, warned_at, exhausted_at`, [ctx.tenant, team, day, cost]);
    const b = await budgetRow(q, team);
    if (b?.perDay !== null && b?.perDay !== undefined) {
      const cap = b.perDay + Number(d.raised);
      const spent = Number(d.spent);
      if (spent >= cap && !d.exhausted_at) {
        await q('update budget_days set exhausted_at = now(), warned_at = coalesce(warned_at, now()) where team = $1 and day = $2::date', [team, day]);
        await exhaust(ctx, team, { scope: 'day', day, spent, cap, currency: b.currency });
      } else if (spent >= cap) {
        // Already spent today and the card is out: anything still running stops spending too (issue #28 U2).
        for (const r of await q("select id from runs where team = $1 and state = 'running'", [team])) await setRunState(ctx, team, r.id, 'paused', 'budget', SYSTEM);
      } else if (spent >= Math.ceil(cap * 0.8) && !d.warned_at && !d.exhausted_at) {
        await q('update budget_days set warned_at = now() where team = $1 and day = $2::date', [team, day]);
        await ctx.emit(team, 'budget.warned', { scope: 'day', day, spent, cap, currency: b.currency });
      }
    }
    // The run's own caps: costPerRun (or the team's perRun) over the whole run, and costPerDay over the UTC day.
    if (event.run) {
      const [r] = await q("select id, state, caps from runs where id = $1 and team = $2", [event.run, team]);
      if (r?.state !== 'running') return;
      const over = await runOver(ctx, team, r, day, b);
      if (over) await exhaust(ctx, team, over);
    }
  }

  /**
   * Whether a run is past its own caps (costPerRun or the team's perRun over the run, costPerDay over the UTC day):
   * the run-scope exhaust info, or null.
   */
  async function runOver(ctx, team, r, day, b) {
    const { q } = ctx;
    {
      const caps = r.caps ?? {};
      const raised = isInt(caps.raised) ? caps.raised : 0;
      const runCap = Math.min(b?.perRun ?? Infinity, isInt(caps.costPerRun) ? caps.costPerRun : Infinity);
      const usage = async (sinceDay) => Math.round(Number((await q(`select coalesce(sum(case when jsonb_typeof(envelope->'data'->'cost') = 'number' then (envelope->'data'->>'cost')::numeric else 0 end), 0) as spent
                                     from events where team = $1 and type = 'usage.recorded' and envelope->>'run' = $2 ${sinceDay ? "and substr(envelope->>'time', 1, 10) = $3" : ''}`,
        sinceDay ? [team, r.id, day] : [team, r.id]))[0].spent));
      const currency = b?.currency ?? 'USD';
      if (runCap !== Infinity) {
        const spent = await usage(false);
        if (spent >= runCap + raised) return { scope: 'run', run: r.id, day, spent, cap: runCap + raised, currency };
      }
      if (isInt(caps.costPerDay)) {
        const spent = await usage(true);
        const cap = caps.costPerDay + (caps.raisedDay?.day === day && isInt(caps.raisedDay.amount) ? caps.raisedDay.amount : 0);
        if (spent >= cap) return { scope: 'run', run: r.id, day, spent, cap, currency, perDay: true };
      }
    }
    return null;
  }

  async function exhaust(ctx, team, info) {
    const runs = info.scope === 'run'
      ? await ctx.q("select id, mode from runs where id = $1 and state = 'running'", [info.run])
      : await ctx.q("select id, mode from runs where team = $1 and state = 'running'", [team]);
    for (const r of runs) await setRunState(ctx, team, r.id, 'paused', 'budget', SYSTEM);
    const card = await createCard(ctx, team, {
      kind: 'budget', subject: info.scope === 'run' ? `run/${info.run}` : `budget/${info.day}`, run: info.run ?? runs[0]?.id ?? null,
      title: info.scope === 'run' ? 'This run reached its budget' : "Today's budget is spent",
      body: `The team has spent ${money(info.spent, info.currency)} of ${money(info.cap, info.currency)} ${info.scope === 'run' ? 'on this run' : `on ${info.day} (UTC)`}. The run is paused; nothing spends until you choose.`,
      recommendation: { option: 'tomorrow', why: 'Nothing more is spent today.' },
      options: [
        { id: 'tomorrow', label: info.scope === 'run' ? 'Leave it paused' : 'Resume tomorrow', style: 'primary', stepUp: false },
        { id: 'raise', label: 'Add half again', style: 'danger', stepUp: true },
      ],
      risk: 'medium', expiresAt: null, data: info,
    });
    await ctx.emit(team, 'budget.exhausted', { ...info, cardId: card.id }, { subject: card.subject });
  }

  // ---- Runs ---------------------------------------------------------------------------------------------------------

  const RUN_COLS = 'id, team, mode, state, reason, caps, team_version, started_by, started_at, ended_at, version';
  const runView = (r) => r && ({ id: r.id, team: r.team, mode: r.mode, state: r.state, reason: r.reason, caps: r.caps, teamVersion: r.team_version, startedBy: r.started_by, startedAt: r.started_at, endedAt: r.ended_at, version: Number(r.version) });

  /** The roster a run is frozen on: who is in the team, who reports to whom, who owns what (m3-design, runs.roster). */
  function checkRoster(team) {
    if (!team || typeof team !== 'object' || !Array.isArray(team.roles) || !team.roles.length) throw new Problem(409, "send the team's roles: team: { version, roles: [{ slug, reportsTo, areas }] }");
    if (team.roles.length > 500) throw new Problem(400, 'at most 500 roles');
    const seen = new Set();
    const roles = team.roles.map((r) => {
      if (!r || !SLUG.test(r.slug ?? '')) throw new Problem(400, 'every role has a slug (lowercase letters, digits and dashes)');
      if (seen.has(r.slug)) throw new Problem(400, `role ${r.slug} is listed twice`);
      seen.add(r.slug);
      if (typeof r.reportsTo !== 'string' || !r.reportsTo) throw new Problem(400, `role ${r.slug} needs reportsTo (a role slug or owner)`);
      const areas = r.areas ?? [];
      if (!Array.isArray(areas) || areas.some((a) => typeof a !== 'string' || a.length > 500) || areas.length > 200) throw new Problem(400, `role ${r.slug}: areas is a list of paths`);
      if (r.pool !== undefined && !(isInt(r.pool) && r.pool >= 1 && r.pool <= 100)) throw new Problem(400, `role ${r.slug}: pool is 1 to 100`);
      if (r.brief !== undefined && r.brief !== null && (typeof r.brief !== 'string' || Buffer.byteLength(r.brief) > 20 * 1024)) throw new Problem(400, `role ${r.slug}: brief is the brief's text, at most 20 KB`);
      // ADR 0011 (additive): the type a member is based on, its display name, and its structured Hands to (member ids).
      if (r.type !== undefined && r.type !== null && !SLUG.test(r.type)) throw new Problem(400, `role ${r.slug}: type is a role slug`);
      if (r.name !== undefined && r.name !== null && (typeof r.name !== 'string' || !r.name.trim() || r.name.length > 60)) throw new Problem(400, `role ${r.slug}: name is text of at most 60 characters`);
      if (r.handsTo !== undefined && r.handsTo !== null && (!Array.isArray(r.handsTo) || r.handsTo.length > 50 || r.handsTo.some((x) => typeof x !== 'string' || !SLUG.test(x)))) throw new Problem(400, `role ${r.slug}: handsTo is a list of at most 50 member ids`);
      return { slug: r.slug, reportsTo: r.reportsTo, areas, ...(r.type && r.type !== r.slug ? { type: r.type } : {}), ...(r.name ? { name: r.name.trim() } : {}), ...(r.handsTo?.length ? { handsTo: r.handsTo } : {}), ...(r.pool ? { pool: r.pool } : {}), ...(typeof r.model === 'string' ? { model: r.model.slice(0, 100) } : {}), ...(r.brief ? { brief: r.brief } : {}) };
    });
    // A display name may not be another teammate's id, a role type or "owner", nor another's name: `to` resolves ids,
    // then names, then types (L17), so a clash would let a name catch messages meant for someone else (security L17).
    const key = (s) => String(s).trim().replace(/\s+/g, ' ').toLowerCase();
    const reserved = new Set(['owner', ...roles.map((r) => r.slug), ...roles.map((r) => r.type).filter(Boolean)]);
    const names = new Map();
    for (const r of roles) {
      if (!r.name) continue;
      const k = key(r.name);
      if (reserved.has(k) && k !== r.slug) throw new Problem(400, `role ${r.slug}: the name ${r.name} is already a teammate's id, a role or "owner"; pick another`);
      if (names.has(k)) throw new Problem(400, `role ${r.slug}: ${names.get(k)} is already called ${r.name}`);
      names.set(k, r.slug);
    }
    const doors = roles.filter((r) => r.reportsTo === 'owner');
    if (doors.length !== 1) throw new Problem(409, `exactly one role reports to the owner (the front door); this team has ${doors.length}`);
    for (const r of roles) if (r.reportsTo !== 'owner' && !seen.has(r.reportsTo)) throw new Problem(400, `role ${r.slug} reports to ${r.reportsTo}, which is not in the team`);
    const version = typeof team.version === 'string' && team.version ? team.version.slice(0, 100) : null;
    let repo = null;
    if (team.repo !== undefined && team.repo !== null) {
      const r = team.repo;
      if (!r || typeof r !== 'object' || typeof r.url !== 'string' || r.url.length > 500) throw new Problem(400, 'team.repo is { url, ref }');
      // https:// or ssh:// (git@host:path too), or a path or file:// URL for a runner on the same machine (local mode).
      const scp = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(r.url);
      const local = /^\/[^\s]*$/.test(r.url);
      if (!scp && !local) {
        let u;
        try { u = new URL(r.url); } catch { throw new Problem(400, 'team.repo.url is a URL'); }
        if (!['https:', 'ssh:', 'file:'].includes(u.protocol)) throw new Problem(400, 'team.repo.url is an https://, ssh:// or file:// URL, or a path');
        if (u.password || (u.protocol === 'https:' && u.username)) throw new Problem(400, 'team.repo.url must not carry credentials: the run reaches the repo through a connector');
      }
      if (r.ref !== undefined && (typeof r.ref !== 'string' || !/^[A-Za-z0-9._/-]{1,200}$/.test(r.ref) || r.ref.includes('..'))) throw new Problem(400, 'team.repo.ref is a branch name');
      repo = { url: r.url, ref: r.ref ?? 'main' };
    }
    if (team.summary !== undefined && team.summary !== null && (typeof team.summary !== 'string' || team.summary.length > 2000)) throw new Problem(400, 'team.summary is text of at most 2,000 characters');
    // The team's meetings, frozen with the run like the roles; attendees resolved by the Studio (meetings.mjs, A1).
    const meetings = checkMeetingDefs(team.meetings, roles, doors[0].slug);
    // L20: the team's systems (resources.json), frozen with the run: what each member's session may reach, and the
    // secret names the vault may release to it. Names only, never values.
    const systems = checkSystems(team, roles);
    return { version, roles, frontDoor: doors[0].slug, ...(repo ? { repo } : {}), ...(team.summary ? { summary: team.summary } : {}), ...(meetings.length ? { meetings } : {}), ...(systems ? { systems } : {}) };
  }

  async function startRun(tenant, team, body, by) {
    await getTeam(db, tenant, team);
    const b = body ?? {};
    const mode = b.mode ?? 'runner';
    if (!['runner', 'subagents', 'agent-teams'].includes(mode)) throw new Problem(400, 'mode is runner, subagents or agent-teams');
    const roster = checkRoster(b.team);
    // Triggers (N2, L21), frozen with the run like its roles and meetings.
    const triggers = checkTriggers(b.team?.triggers, roster.roles);
    return tx(tenant, async (ctx) => {
      const budget = await budgetRow(ctx.q, team);
      if (budget?.perDay === null || budget?.perDay === undefined) throw new Problem(409, 'set a daily cap first: PUT /v1/teams/{team}/budget with perDay');
      const caps = { ...(b.caps ?? {}) };
      for (const [k, cap] of [['costPerDay', budget.perDay], ['costPerRun', budget.perRun], ['sessions', budget.sessions]]) {
        if (caps[k] === undefined) continue;
        if (!isInt(caps[k]) || caps[k] < 0) throw new Problem(400, `caps.${k} is a whole number`);
        if (cap !== null && caps[k] > cap) throw new Problem(409, `a run can lower caps.${k} below the team's ${cap}, never raise it`);
      }
      const [going] = await ctx.q("select id from runs where team = $1 and state <> 'stopped' limit 1", [team]);
      if (going) throw new Problem(409, `run ${going.id} is still going; stop it first`);
      if (await halted(ctx.q, team)) throw new Problem(409, 'Stop everything is on for this team; lift it first (it needs a passkey)', { type: 'halted' });
      const t = await today(ctx.q, team, ctx.now);
      if (t.state === 'exhausted') throw new Problem(409, "today's budget is spent; raise it or start tomorrow", { type: 'budget-exhausted' });
      const rid = id('run');
      // runs_one_going decides when two starts race; the loser gets the same 409 as the check above.
      const [row] = await ctx.q(`insert into runs(id, tenant, team, mode, state, caps, roster, team_version, started_by, triggers) values ($1, $2, $3, $4, 'running', $5, $6, $7, $8, $9)
                                 on conflict (team) where state <> 'stopped' do nothing returning ${RUN_COLS}`,
        [rid, tenant, team, mode, JSON.stringify(caps), JSON.stringify(roster), roster.version, by, triggers.length ? JSON.stringify(triggers) : null]);
      if (!row) throw new Problem(409, 'another run of this team started just now; stop it first');
      await ctx.emit(team, 'run.started', { mode, by, caps, frontDoor: roster.frontDoor, roles: roster.roles.length }, { actor: personActor(by), subject: `run/${rid}`, run: rid, teamVersion: roster.version ?? undefined });
      await ctx.audit({ team, actorKind: 'person', actorId: by, action: 'run', target: rid, decision: 'allowed', detail: { op: 'start', mode } });
      hooks.runStarted && ctx.after.push(() => hooks.runStarted(tenant, team, rid));
      // Signals that arrived while no run was going are matched against this run's triggers (N2 section 6).
      hooks.drainTriggers && ctx.after.push(() => hooks.drainTriggers(tenant, team));
      return runView(row);
    });
  }

  async function setRunState(ctx, team, rid, state, reason, actor) {
    const [row] = await ctx.q(`update runs set state = $2, reason = $3, version = version + 1, ended_at = case when $2 = 'stopped' then now() else ended_at end,
                                 resume_on = case when $2 = 'paused' then resume_on else null end
                               where id = $1 returning ${RUN_COLS}`, [rid, state, reason]);
    const type = { paused: 'run.paused', running: 'run.resumed', stopped: 'run.stopped' }[state];
    await ctx.emit(team, type, { mode: row.mode, by: actor.kind === 'person' ? actor.id : null, reason, version: Number(row.version) }, { actor, subject: `run/${rid}`, run: rid });
    hooks.runChanged && ctx.after.push(() => hooks.runChanged(ctx.tenant, team, rid, state, reason));
    return row;
  }

  async function listRuns(tenant, team) {
    await getTeam(db, tenant, team);
    return (await db.tenant(tenant, ({ q }) => q(`select ${RUN_COLS} from runs where team = $1 order by started_at desc limit 100`, [team]))).map(runView);
  }

  /**
   * pause, resume or stop. Resuming needs step-up whoever paused the run (ADR 0013: stopping stays cheap, resuming does
   * not; issue #28 D4 had it for the budget's pauses only); pause and stop never do.
   */
  async function controlRun(tenant, rid, action, by, { stepUp = null } = {}) {
    if (!['pause', 'resume', 'stop'].includes(action)) throw new Problem(404, 'the actions are pause, resume and stop');
    return tx(tenant, async (ctx) => {
      const [r] = await ctx.q(`select ${RUN_COLS} from runs where id = $1 for update`, [rid]);
      if (!r) throw new Problem(404, 'no such run');
      const actor = personActor(by);
      if (action === 'stop') {
        if (r.state === 'stopped') return runView(r);
        const row = await setRunState(ctx, r.team, rid, 'stopped', 'owner', actor);
        await supersedeRunCards(ctx, r.team, rid);
        await ctx.audit({ team: r.team, actorKind: 'person', actorId: by, action: 'run', target: rid, decision: 'allowed', detail: { op: 'stop' } });
        return runView(row);
      }
      if (action === 'pause') {
        if (r.state !== 'running') throw new Problem(409, `the run is ${r.state}`);
        const row = await setRunState(ctx, r.team, rid, 'paused', 'owner', actor);
        await ctx.audit({ team: r.team, actorKind: 'person', actorId: by, action: 'run', target: rid, decision: 'allowed', detail: { op: 'pause' } });
        return runView(row);
      }
      if (r.state !== 'paused') throw new Problem(409, `the run is ${r.state}`);
      if (await halted(ctx.q, r.team)) throw new Problem(409, 'Stop everything is on for this team; lift it first (it needs a passkey)', { type: 'halted' });
      // Whoever paused it, nothing resumes while today's budget is spent (issue #28 U2).
      if ((await today(ctx.q, r.team, ctx.now)).state === 'exhausted') throw new Problem(409, "today's budget is spent; raise it (the budget card) or wait for tomorrow", { type: 'budget-exhausted' });
      if (!(await useStepUp(ctx, by, stepUp, `resume:${rid}`))) throw new StepUpRequired(r.reason === 'budget' ? 'Resuming a run the budget paused' : 'Resuming a paused run', `resume:${rid}`);
      const row = await setRunState(ctx, r.team, rid, 'running', 'owner', actor);
      await ctx.audit({ team: r.team, actorKind: 'person', actorId: by, action: 'run', target: rid, decision: 'allowed', detail: { op: 'resume', stepUp: true, pausedBy: r.reason } });
      return runView(row);
    });
  }

  /** A stopped run's open cards can no longer be acted on. */
  async function supersedeRunCards(ctx, team, rid) {
    const open = await ctx.q("select id from cards where team = $1 and run = $2 and state = 'open' for update", [team, rid]);
    for (const c of open) await changeCard(ctx, team, c.id, { state: 'superseded' });
    await ctx.q("update approvals set state = 'expired', decided_at = now() where team = $1 and run = $2 and state = 'pending'", [team, rid]);
  }

  // ---- Cards (clients.md section 6) ---------------------------------------------------------------------------------

  const cardUrl = (team, kind, cid, approval) => `${base}/t/${team}/${kind === 'approval' ? `approvals/${approval}` : `cards/${cid}`}`;

  async function createCard(ctx, team, { kind, subject, session = null, run = null, title, body = '', recommendation = null, options, risk = null, expiresAt = null, links = [], approval = null, data = null }) {
    const cid = id('card');
    const card = {
      id: cid, kind, team, subject, title, body, ...(recommendation ? { recommendation } : {}), options, ...(risk ? { risk } : {}),
      ...(expiresAt ? { expires: expiresAt.toISOString() } : {}), version: 1, links, url: cardUrl(team, kind, cid, approval), state: 'open',
      ...(data ? { data } : {}),
    };
    await ctx.q(`insert into cards(id, tenant, team, kind, subject, session, run, card, version, state, expires_at) values ($1, $2, $3, $4, $5, $6, $7, $8, 1, 'open', $9)`,
      [cid, ctx.tenant, team, kind, subject, session, run, JSON.stringify(card), expiresAt?.toISOString() ?? null]);
    await ctx.emit(team, 'card.updated', { card }, { subject });
    return card;
  }

  /** Moves a card to a new version and state, and emits card.updated with the whole card. */
  async function changeCard(ctx, team, cid, { state, answer = null }) {
    const [row] = await ctx.q(`update cards set version = version + 1, state = $2, answer = coalesce($3, answer),
                                 card = card || jsonb_build_object('version', version + 1, 'state', $2::text) || case when $3::jsonb is null then '{}'::jsonb else jsonb_build_object('answer', $3::jsonb) end
                               where id = $1 returning card`, [cid, state, answer ? JSON.stringify(answer) : null]);
    await ctx.emit(team, 'card.updated', { card: row.card }, { subject: row.card.subject });
    return row.card;
  }

  async function getCard(tenant, cid) {
    const [row] = await db.tenant(tenant, ({ q }) => q('select card from cards where id = $1', [cid]));
    if (!row) throw new Problem(404, 'no such card');
    return row.card;
  }

  /** The card as it is now, or a 409 carrying it when it is not the version the person saw or is no longer open. */
  async function lockOpenCard(ctx, cid, version) {
    const [row] = await ctx.q('select team, kind, state, version, session, run, card from cards where id = $1 for update', [cid]);
    if (!row) throw new Problem(404, 'no such card');
    if (row.state !== 'open') throw new Problem(409, `this card is ${row.state}`, { body: row.card });
    if (version !== undefined && version !== null && Number(version) !== Number(row.version)) throw new Problem(409, 'this card changed since you saw it', { body: row.card });
    if (row.card.expires && Date.parse(row.card.expires) <= ctx.now.getTime()) throw new Problem(409, 'this card expired', { body: { ...row.card, state: 'expired' } });
    return row;
  }

  /** Answers a decision or budget card (POST /v1/cards/{card}). Approval cards are answered through /approvals. */
  /** The least role that may answer each kind of card: a budget card raises spending, an admin's call like PUT budget. */
  const CARD_ROLE = { approval: 'approver', decision: 'approver', budget: 'admin', ready: 'approver' };

  async function answerCard(tenant, cid, body, by, { stepUp = null, role = 'owner' } = {}) {
    const { option, version, note } = body ?? {};
    if (!isInt(version)) throw new Problem(400, 'send the version of the card you saw');
    if (typeof option !== 'string' || !option) throw new Problem(400, 'send the option you chose');
    if (note !== undefined && (typeof note !== 'string' || note.length > 4000)) throw new Problem(400, 'a note is text of at most 4,000 characters');
    return tx(tenant, async (ctx) => {
      const row = await lockOpenCard(ctx, cid, version);
      // A kind not listed needs an admin, so a new kind is never answerable by less by accident.
      const need = CARD_ROLE[row.kind] ?? 'admin';
      if (!atLeast(role, need)) throw new Problem(403, `a ${row.kind} card needs the ${need} role or above; you are ${role}`, { type: 'forbidden' });
      if (row.kind === 'approval') {
        const [a] = await ctx.q('select id from approvals where card = $1', [cid]);
        return decideIn(ctx, a.id, { decision: option === 'approve' ? 'approved' : option === 'deny' ? 'denied' : null, note, version }, by, stepUp);
      }
      const chosen = row.card.options.find((o) => o.id === option);
      if (!chosen) throw new Problem(400, `option is one of ${row.card.options.map((o) => o.id).join(', ')}`);
      if (chosen.stepUp && !(await useStepUp(ctx, by, stepUp))) throw new StepUpRequired(`"${chosen.label}"`);
      const answer = { option, ...(note ? { note } : {}), by, at: ctx.now.toISOString() };
      const card = await changeCard(ctx, row.team, cid, { state: 'answered', answer });
      await ctx.audit({ team: row.team, actorKind: 'person', actorId: by, session: row.session, action: 'card', target: cid, decision: option, detail: { kind: row.kind, version: row.version } });
      let event;
      if (row.kind === 'budget') event = await budgetAnswer(ctx, row, option);
      // "Got it" on a Ready to try card only closes it: nothing waits on it, so it wakes nobody.
      else if (row.kind === 'ready') event = null;
      else event = await ctx.emit(row.team, 'decision.answered', { cardId: cid, session: row.session, answer: option, by, ...(note ? { note } : {}) }, { actor: personActor(by), subject: row.card.subject, ...(row.run ? { run: row.run } : {}) });
      return { card, event: event?.id ?? null };
    });
  }

  async function budgetAnswer(ctx, row, option) {
    const info = row.card.data ?? {};
    if (option === 'tomorrow') {
      if (info.scope !== 'run') await ctx.q("update runs set resume_on = $2::date where team = $1 and state = 'paused' and reason = 'budget'", [row.team, nextUtcDay(ctx.now)]);
      return null;
    }
    // raise: half the daily cap again for today, then the budget-paused runs carry on.
    const b = await budgetRow(ctx.q, row.team);
    if (info.scope === 'run') {
      // Only this run gets more: the team's caps stay as the owner set them.
      const add = Math.ceil((info.cap ?? b?.perRun ?? 0) / 2);
      if (info.perDay) {
        const [r] = await ctx.q('select caps from runs where id = $1', [info.run]);
        const prev = r?.caps?.raisedDay?.day === info.day && isInt(r.caps.raisedDay.amount) ? r.caps.raisedDay.amount : 0;
        await ctx.q(`update runs set caps = caps || jsonb_build_object('raisedDay', $2::jsonb) where id = $1`, [info.run, JSON.stringify({ day: info.day, amount: prev + add })]);
      } else {
        await ctx.q(`update runs set caps = caps || jsonb_build_object('raised', coalesce((caps->>'raised')::bigint, 0) + $2::bigint) where id = $1`, [info.run, add]);
      }
    } else {
      await ctx.q(`insert into budget_days(tenant, team, day, raised) values ($1, $2, $3::date, $4)
                   on conflict (team, day) do update set raised = budget_days.raised + excluded.raised, exhausted_at = null, warned_at = null`,
        [ctx.tenant, row.team, utcDay(ctx.now), Math.ceil((b?.perDay ?? 0) / 2)]);
    }
    const runs = await ctx.q(info.scope === 'run' ? "select id, caps from runs where id = $1 and state = 'paused' and reason = 'budget'" : "select id, caps from runs where team = $1 and state = 'paused' and reason = 'budget'", [info.scope === 'run' ? info.run : row.team]);
    for (const r of runs) {
      // A run also past its own cap stays paused, with its own card: the day's raise does not lift the run's cap.
      const over = await runOver(ctx, row.team, r, utcDay(ctx.now), b);
      if (over) {
        const [open] = await ctx.q("select 1 from cards where team = $1 and kind = 'budget' and state = 'open' and subject = $2", [row.team, `run/${r.id}`]);
        if (!open) await exhaust(ctx, row.team, over);
        continue;
      }
      await setRunState(ctx, row.team, r.id, 'running', 'budget', SYSTEM);
    }
    return null;
  }

  // ---- Approvals (section 4) ----------------------------------------------------------------------------------------

  /**
   * A session asks for an approval (request_approval, or the runner's policy through approval.wait). Writes the
   * approval and its card, and emits approval.requested and card.updated. `call` is stored as sent; callers redact it.
   */
  async function requestApproval(ctx, team, { action, call, why, links = [], session = null, run = null, role = null, hours = APPROVAL_HOURS, bound = null }) {
    if (typeof action !== 'string' || !action || action.length > 100) throw new Problem(400, 'action is a policy classification, like accept');
    if (call === undefined || call === null || JSON.stringify(call).length > 16 * 1024) throw new Problem(400, 'call is the exact command or tool call, at most 16 KiB');
    if (typeof why !== 'string' || !why || why.length > 4000) throw new Problem(400, 'why is required, at most 4,000 characters');
    // The risk class is the server's (ADR 0013, security criterion 7): a role's own `risk` is ignored.
    const r = riskOf({ bound });
    const apr = id('apr');
    const expiresAt = new Date(ctx.now.getTime() + hours * 3_600_000);
    const callText = typeof call === 'string' ? call : JSON.stringify(call);
    const card = await createCard(ctx, team, {
      kind: 'approval', subject: `approval/${apr}`, session, run, approval: apr,
      // The person sees exactly what a merge is bound to (D1): the PR and the short head sha, not lost in the body.
      title: call && typeof call === 'object' && call.pr && call.headSha
        ? `${role ?? 'A role'} asks to ${action === 'accept' ? 'merge' : action} #${call.pr} at ${String(call.headSha).slice(0, 7)}`
        : `${role ?? 'A role'} asks to ${action}`,
      // The held call is data, for the client to lay out (and wrap) as code; the body is the role's words only.
      // A bound card (ADR 0013) shows facts the server rendered from the signed calls, never the role's `call` text.
      data: {
        ...(call && typeof call === 'object' && call.pr ? { pr: call.pr, ...(call.headSha ? { headSha: call.headSha } : {}) } : {}),
        ...(bound ? { facts: factsOf(bound.calls, redactText), callsHash: bound.hash } : { call: callText.length > 2000 ? `${callText.slice(0, 2000)}…` : callText }),
      },
      body: bound ? why : `${why}\n\n${describeCall(call)}`,
      options: [{ id: 'approve', label: 'Approve', style: 'primary', stepUp: true }, { id: 'deny', label: 'Deny', style: 'danger', stepUp: false }],
      risk: r, expiresAt, links: links.filter((l) => l && typeof l.url === 'string').slice(0, 20),
    });
    await ctx.q(`insert into approvals(id, tenant, team, run, session, role, action, call, why, risk, card, expires_at, calls, calls_hash) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [apr, ctx.tenant, team, run, session, role, action, JSON.stringify(call), why, r, card.id, expiresAt.toISOString(), bound ? JSON.stringify(bound.calls) : null, bound?.hash ?? null]);
    // The calls themselves stay in the approval row (deletable with it), not in the permanent log: the event names the hash.
    const ev = await ctx.emit(team, 'approval.requested', { approval: apr, action, ...(bound ? {} : { call }), why, risk: r, expires: expiresAt.toISOString(), cardId: card.id, session, ...(bound ? { callsHash: bound.hash } : {}) },
      { subject: `approval/${apr}`, ...(run ? { run } : {}), ...(role ? { actor: { kind: 'role', id: role, session, via: 'tool' } } : {}) });
    await ctx.audit({ team, actorKind: role ? 'role' : 'system', actorId: role ?? 'control-plane', session, action: 'approval', target: apr, decision: 'needs-approval', rule: action, event: ev.id });
    return { approval: apr, card };
  }

  /** POST /v1/approvals/{id}: approving needs a fresh step-up; denying never does. */
  async function decideApproval(tenant, apr, body, by, { stepUp = null } = {}) {
    const { decision, note, version } = body ?? {};
    if (!['approved', 'denied'].includes(decision)) throw new Problem(400, 'decision is approved or denied');
    if (version !== undefined && !isInt(version)) throw new Problem(400, 'version is the card version you saw');
    if (note !== undefined && (typeof note !== 'string' || note.length > 4000)) throw new Problem(400, 'a note is text of at most 4,000 characters');
    return tx(tenant, (ctx) => decideIn(ctx, apr, { decision, note, version }, by, stepUp));
  }

  async function decideIn(ctx, apr, { decision, note, version }, by, stepUp) {
    if (!decision) throw new Problem(400, 'option is approve or deny');
    const [a] = await ctx.q('select id, team, run, session, card, state, expires_at, calls_hash from approvals where id = $1 for update', [apr]);
    if (!a) throw new Problem(404, 'no such approval');
    if (a.state === 'pending' && new Date(a.expires_at).getTime() <= ctx.now.getTime()) throw new Problem(409, 'this approval expired', { body: { ...(await currentCard(ctx, a.card)), state: 'expired' } });
    const open = await lockOpenCard(ctx, a.card, version);
    if (a.state !== 'pending') throw new Problem(409, `this approval is ${a.state}`, { body: await currentCard(ctx, a.card) });
    let stepUpId = null;
    // ADR 0013: approving a bound card needs a step-up bound to it: tenant, team, approval, card version and calls.
    const scope = a.calls_hash ? approveScope({ tenant: ctx.tenant, team: a.team, approval: apr, version: open.version, callsHash: a.calls_hash }) : null;
    if (decision === 'approved' && !(stepUpId = await useStepUp(ctx, by, stepUp, scope))) throw new StepUpRequired('An approval', scope);
    await ctx.q('update approvals set state = $2, decided_by = $3, decided_at = now() where id = $1', [apr, decision, by]);
    const card = await changeCard(ctx, a.team, a.card, { state: 'answered', answer: { option: decision === 'approved' ? 'approve' : 'deny', ...(note ? { note } : {}), by, at: ctx.now.toISOString() } });
    const ev = await ctx.emit(a.team, 'approval.decided', { approval: apr, decision, by, ...(note ? { note } : {}), session: a.session, cardId: a.card },
      { actor: personActor(by), subject: `approval/${apr}`, ...(a.run ? { run: a.run } : {}) });
    await ctx.audit({ team: a.team, actorKind: 'person', actorId: by, session: a.session, action: 'approval', target: apr, decision, event: ev.id, detail: stepUpId || a.calls_hash ? { ...(stepUpId ? { stepUp: stepUpId } : {}), ...(a.calls_hash ? { callsHash: a.calls_hash } : {}) } : null });
    hooks.approvalDecided && ctx.after.push(() => hooks.approvalDecided(ctx.tenant, a.team, { approval: apr, decision, by, note: note ?? null, session: a.session }));
    return { card, event: ev.id, approval: apr, decision };
  }

  async function currentCard(ctx, cid) { return (await ctx.q('select card from cards where id = $1', [cid]))[0]?.card; }

  // ---- Step-up (section 4; issue #28 D3, D5) ------------------------------------------------------------------------

  /** Consumes a step-up token for `by`: its id when valid (it then cannot be used again), else null. */
  /**
   * Spends a step-up token. A token bound to a scope is spent only on that scope; a route that passes `scope` also
   * refuses a token without one (ADR 0013: the step-up is bound to the change). A refused token stays unspent.
   */
  async function useStepUp(ctx, by, token, scope = null) {
    const [tid, secret] = String(token ?? '').split('.');
    if (!tid || !secret) return null;
    const [row] = await ctx.q("select id, hash, scope from step_up_tokens where id = $1 and principal = $2 and used_at is null and expires_at > now() for update", [tid, by]);
    if (!row) return null;
    if ((row.scope ?? null) !== scope) return null;
    const x = Buffer.from(row.hash, 'hex'), y = Buffer.from(sha(secret), 'hex');
    if (x.length !== y.length || !timingSafeEqual(x, y)) return null;
    await ctx.q('update step_up_tokens set used_at = now() where id = $1', [tid]);
    return tid;
  }

  /**
   * POST /v1/auth/step-up. `verifier` checks the typed secret (a slow hash). Five wrong tries in 15 minutes lock the
   * tenant out with 429, each audited. The token is single use, bound to the person, and kept only as a hash.
   */
  async function stepUp(tenant, by, secret, { verifier, bearer, scope = null }) {
    if (!verifier) throw new Problem(401, 'step-up is not set up on this server (AGENT_TEAM_STEP_UP_SECRET_HASH), so nothing that needs it can be done', { type: 'step-up-required' });
    if (typeof secret !== 'string' || !secret || secret.length > 1024) throw new Problem(400, 'send { secret }');
    if (scope !== null && (typeof scope !== 'string' || !STEP_UP_SCOPE.test(scope))) throw new Problem(400, 'scope names one change, like resume:<run id>');
    // One slow check per tenant at a time on this instance; the others wait their turn by retrying (issue #28 U1).
    if (checking.has(tenant)) throw new Problem(429, 'a step-up check is already running; try again in a moment');
    checking.add(tenant);
    try {
      // The attempt is written before the check, under a per-tenant lock, so parallel guesses (on any instance) are
      // counted before any of them is checked: at most five get through in the window.
      const attempt = id('sua');
      const allowed = await db.tenant(tenant, async ({ q }) => {
        await q('select pg_advisory_xact_lock(4850, hashtext($1))', [tenant]);
        const [{ n }] = await q('select count(*)::int as n from step_up_failures where at > now() - make_interval(mins => $1)', [STEP_UP_LOCKOUT.minutes]);
        if (n >= STEP_UP_LOCKOUT.failures) {
          await q("insert into audit(tenant, actor_kind, actor_id, action, decision, rule) values ($1, 'person', $2, 'step-up', 'refused', 'lockout')", [tenant, by]);
          return false;
        }
        await q('insert into step_up_failures(id, tenant) values ($1, $2)', [attempt, tenant]);
        return true;
      });
      if (!allowed) throw new Problem(429, `too many wrong step-up secrets; try again in ${STEP_UP_LOCKOUT.minutes} minutes`);
      // Compared as hashes, so the lengths always match whatever characters were typed.
      const sameAsBearer = Boolean(bearer) && timingSafeEqual(Buffer.from(sha(secret), 'hex'), Buffer.from(sha(String(bearer)), 'hex'));
      const right = !sameAsBearer && (await verifier(secret).catch(() => false));
      if (!right) {
        await db.tenant(tenant, ({ q }) => q("insert into audit(tenant, actor_kind, actor_id, action, decision, rule) values ($1, 'person', $2, 'step-up', 'refused', $3)", [tenant, by, sameAsBearer ? 'bearer-token-is-not-the-secret' : 'wrong-secret']));
        throw new Problem(401, sameAsBearer ? 'that is the sign-in token, not the step-up secret' : 'that is not the step-up secret', { type: 'step-up-failed' });
      }
      await db.tenant(tenant, ({ q }) => q('delete from step_up_failures where id = $1', [attempt]));
    } finally {
      checking.delete(tenant);
    }
    return mintStepUp(tenant, by, { method: 'secret' }, scope);
  }

  /** A single-use su_ token for `by` in `tenant`, 5 minutes, kept only as a hash; minted after a proof of presence
   *  (the local step-up secret, or a passkey assertion in passkeys.mjs). Never from a session alone (K2). */
  async function mintStepUp(tenant, by, detail = {}, scope = null) {
    const tid = id('su');
    const raw = randomBytes(24).toString('base64url');
    const expires = new Date(Date.now() + STEP_UP_MINUTES * 60_000);
    await db.tenant(tenant, async ({ q }) => {
      await q('insert into step_up_tokens(id, tenant, principal, hash, expires_at, scope) values ($1, $2, $3, $4, $5, $6)', [tid, tenant, by, sha(raw), expires.toISOString(), scope]);
      await q("insert into audit(tenant, actor_kind, actor_id, action, target, decision, detail) values ($1, 'person', $2, 'step-up', $3, 'allowed', $4)", [tenant, by, tid, JSON.stringify({ ...detail, ...(scope ? { scope } : {}) })]);
    });
    return { token: `${tid}.${raw}`, expires: expires.toISOString(), ...(scope ? { scope } : {}) };
  }

  // ---- Chat (section 5) ---------------------------------------------------------------------------------------------

  /** The owner says something. Stored byte for byte; a repeated clientId returns the first message (200, not 201). */
  async function postChat(tenant, team, body, by) {
    await getTeam(db, tenant, team);
    const { text, replyTo, clientId } = body ?? {};
    if (typeof text !== 'string' || !text.length || text.length > 20_000) throw new Problem(400, 'text is required, at most 20,000 characters');
    if (replyTo !== undefined && replyTo !== null && (typeof replyTo !== 'string' || replyTo.length > 100)) throw new Problem(400, 'replyTo is an event id');
    if (clientId !== undefined && clientId !== null && (typeof clientId !== 'string' || !clientId || clientId.length > 80)) throw new Problem(400, 'clientId is at most 80 characters');
    const found = async (q) => {
      if (!clientId) return null;
      const [m] = await q("select e.envelope from chat_messages c join events e on e.team = c.team and e.id = c.event where c.team = $1 and c.client_id = $2", [team, clientId]);
      return m?.envelope ?? null;
    };
    const prior = await db.tenant(tenant, ({ q }) => found(q));
    if (prior) return { result: { created: false, event: prior }, stored: [] };
    return tx(tenant, write).catch(async (e) => {
      // Two sends of one clientId at once: the second loses on the unique index and answers like a resend.
      if (e?.code !== '23505' || !clientId) throw e;
      const first = await db.tenant(tenant, ({ q }) => found(q));
      if (!first) throw e;
      return { result: { created: false, event: first }, stored: [] };
    });
    async function write(ctx) {
      const again = await found(ctx.q);
      if (again) return { created: false, event: again };
      const data = { from: by, text, ...(replyTo ? { replyTo } : {}), ...(clientId ? { clientId } : {}) };
      const e = await ctx.emit(team, 'chat.message', data, { actor: personActor(by), subject: 'chat' });
      await ctx.q('insert into chat_messages(tenant, team, event, client_id, from_kind, from_id, text, reply_to, at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [tenant, team, e.id, clientId ?? null, 'person', by, text, replyTo ?? null, e.time]);
      hooks.chatPosted && ctx.after.push(() => hooks.chatPosted(tenant, team, e));
      return { created: true, event: { ...e, team } };
    }
  }

  /** The chat page (api-v1.yaml ChatPage): newest page first, items oldest first, the cards they mention, the run, cost. */
  async function getChat(tenant, team, { before = '', cursor = '', limit = 100 } = {}) {
    await getTeam(db, tenant, team);
    const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
    return db.tenant(tenant, async ({ q }) => {
      let upTo = Number.MAX_SAFE_INTEGER;
      if (cursor) upTo = Number(Buffer.from(String(cursor), 'base64url').toString()) || 0;
      else if (before) {
        const [r] = await q('select seq from events where team = $1 and id = $2', [team, String(before)]);
        if (!r) throw new Problem(400, `no event ${before} in this team's log`);
        upTo = Number(r.seq);
      }
      const rows = await q('select seq, envelope from events where team = $1 and seq < $2 and type = any($3) order by seq desc limit $4', [team, upTo, CHAT_TYPES, n]);
      const oldest = rows.length ? Number(rows.at(-1).seq) : null;
      const items = [...rows].reverse().map((r) => r.envelope);
      const ids = new Set();
      for (const e of items) {
        if (e.data?.cardId) ids.add(e.data.cardId);
        if (e.type === 'card.updated' && e.data?.card?.id) ids.add(e.data.card.id);
      }
      const cards = {};
      if (ids.size) for (const c of await q('select id, card from cards where id = any($1)', [[...ids]])) cards[c.id] = c.card;
      const [run] = await q("select id, state, version from runs where team = $1 order by (state <> 'stopped') desc, started_at desc limit 1", [team]);
      const b = await budgetRow(q, team);
      const t = await today(q, team, now());
      const [h] = await q('select id from events where team = $1 order by seq desc limit 1', [team]);
      return {
        asOf: h?.id ?? null, items, cards,
        run: run ? { id: run.id, state: run.state, version: Number(run.version) } : null,
        cost: { today: t.spent, capPerDay: b?.perDay === null || b?.perDay === undefined ? null : b.perDay + t.raised, currency: b?.currency ?? 'USD', state: t.state },
        next: rows.length === n ? Buffer.from(String(oldest)).toString('base64url') : null,
      };
    });
  }

  // ---- Ready to try (demo step 12, G-12) ----------------------------------------------------------------------------

  /**
   * The front door's ready_to_try, after tools/1 passed: only for a PR this team merged with an approval (the
   * runner's proposal.accepted), with the preview the runner found (proposal.previewed), never a link the model wrote.
   * A later preview is added to the open card by previewArrived. Returns { card, event, preview } or { problems }.
   */
  async function readyToTry(ctx, sess, i, { opts }) {
    const [acc] = await ctx.q("select envelope from events where team = $1 and type = 'proposal.accepted' and envelope->'data'->>'ref' = $2 order by seq desc limit 1", [sess.team, String(i.pr)]);
    if (!acc) return { problems: [`PR ${i.pr} has not merged with an approval on this team, so it is not ready to try yet. Call ready_to_try after the merge.`] };
    const a = acc.envelope.data ?? {};
    const commit = typeof a.result === 'string' ? a.result : null;
    const p = await latestPreview(ctx, sess.team, i.pr);
    const subject = `ready/${i.pr}`;
    // One open card per PR: telling the owner again replaces the old card.
    for (const old of await ctx.q("select id from cards where team = $1 and subject = $2 and state = 'open' for update", [sess.team, subject])) await changeCard(ctx, sess.team, old.id, { state: 'superseded' });
    const links = [...(httpsUrl(a.url) ? [{ rel: 'pull-request', url: a.url }] : []), ...(p ? [{ rel: 'preview', url: p.url }] : [])];
    const card = await createCard(ctx, sess.team, {
      kind: 'ready', subject, session: sess.id, run: sess.run, title: i.title, body: [i.summary, p ? null : PREVIEW_PENDING].filter(Boolean).join('\n\n'),
      options: [{ id: 'seen', label: 'Got it', style: 'primary', stepUp: false }], expiresAt: new Date(ctx.now.getTime() + 7 * 86_400_000), links,
      data: { pr: i.pr, commit, preview: p?.url ?? null, environment: p?.environment ?? null },
    });
    const ev = await ctx.emit(sess.team, 'ready.posted', clean({ pr: i.pr, title: i.title, summary: i.summary, commit, preview: p?.url, environment: p?.environment, issue: i.issue, task: i.task, cardId: card.id, session: sess.id }), { ...opts, subject });
    const text = `${i.title}: ready to try.${p ? ` Preview: ${p.url}` : ' The preview link follows when the deployment is up.'}${httpsUrl(a.url) ? ` Merged in ${a.url}` : ''}`;
    const chat = await ctx.emit(sess.team, 'chat.message', { from: sess.role, text, attachments: [card.url] }, { ...opts, subject: 'chat' });
    await ctx.q('insert into chat_messages(tenant, team, event, from_kind, from_id, text, at) values ($1, $2, $3, $4, $5, $6, $7) on conflict do nothing', [ctx.tenant, sess.team, chat.id, 'role', sess.role, text, chat.time]);
    return { card: card.id, event: ev.id, preview: p?.url ?? null };
  }

  async function latestPreview(ctx, team, pr) {
    const [row] = await ctx.q("select envelope from events where team = $1 and type = 'proposal.previewed' and envelope->'data'->>'ref' = $2 order by seq desc limit 1", [team, String(pr)]);
    return row ? row.envelope.data : null;
  }

  /** Security (G-12, 4): a preview is only for the merge commit of that PR's approved merge (its proposal.accepted). */
  async function previewForMerge(ctx, team, d) {
    const [acc] = await ctx.q("select envelope from events where team = $1 and type = 'proposal.accepted' and envelope->'data'->>'ref' = $2 order by seq desc limit 1", [team, String(d.ref)]);
    if (!acc) throw new Problem(400, `proposal.previewed for PR ${d.ref}, which has no proposal.accepted on this team`);
    if (acc.envelope.data?.result !== d.sha) throw new Problem(400, `proposal.previewed sha ${d.sha} is not the merge commit of PR ${d.ref}`);
  }

  /** A proposal.previewed the runner sent: added to the PR's open Ready to try card, with ready.previewed. */
  async function previewArrived(ctx, team, d) {
    const [row] = await ctx.q("select id, version, card from cards where team = $1 and subject = $2 and kind = 'ready' and state = 'open' for update", [team, `ready/${d.ref}`]);
    if (!row || row.card.data?.preview === d.url) return null;
    const c = row.card;
    const next = {
      ...c, version: row.version + 1, body: String(c.body ?? '').replace(PREVIEW_PENDING, '').trim(),
      links: [...(c.links ?? []).filter((l) => l.rel !== 'preview'), { rel: 'preview', url: d.url }],
      data: { ...c.data, preview: d.url, environment: d.environment ?? null },
    };
    await ctx.q('update cards set version = $2, card = $3 where id = $1', [row.id, next.version, JSON.stringify(next)]);
    await ctx.emit(team, 'card.updated', { card: next }, { subject: c.subject });
    return ctx.emit(team, 'ready.previewed', clean({ pr: c.data?.pr ?? d.ref, cardId: row.id, url: d.url, environment: d.environment }), { subject: c.subject });
  }

  // ---- The person's inbox and summary extras (clients.md section 5) ------------------------------------------------

  const URGENCY = "case kind when 'approval' then 0 when 'budget' then 1 when 'decision' then 2 when 'ready' then 4 else 3 end";

  async function inbox(tenant, { cursor = '', limit = 100 } = {}) {
    const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const off = cursor ? Number(Buffer.from(String(cursor), 'base64url').toString()) || 0 : 0;
    return db.tenant(tenant, async ({ q }) => {
      const rows = await q(`select card from cards where state = 'open' order by ${URGENCY}, case card->>'risk' when 'high' then 0 when 'medium' then 1 else 2 end, created_at limit $1 offset $2`, [n + 1, off]);
      const [h] = await q('select id, seq from events order by seq desc limit 1');
      return { asOf: h?.id ?? null, seq: Number(h?.seq ?? 0), cards: rows.slice(0, n).map((r) => r.card), next: rows.length > n ? Buffer.from(String(off + n)).toString('base64url') : null };
    });
  }

  /** Per team: the live run state, the daily cap with today's spend, and open cards. Merged into store.summary. */
  async function teamExtras(tenant) {
    return db.tenant(tenant, async ({ q }) => {
      const out = {};
      const day = utcDay(now());
      for (const r of await q(`select t.id as team,
                                  (select state from runs where team = t.id order by (state <> 'stopped') desc, started_at desc limit 1) as run,
                                  b.per_day, b.currency, d.spent, d.raised,
                                  (select count(*)::int from cards where team = t.id and state = 'open') as inbox
                                from teams t left join budgets b on b.team = t.id left join budget_days d on d.team = t.id and d.day = $1::date`, [day])) {
        out[r.team] = {
          run: r.run ?? null,
          capPerDay: r.per_day === null || r.per_day === undefined ? null : Number(r.per_day) + Number(r.raised ?? 0),
          currency: r.currency ?? null, spent: r.spent === null || r.spent === undefined ? null : Number(r.spent), inbox: r.inbox,
        };
      }
      return out;
    });
  }

  /** Appends envelopes sent through the API (POST /teams/{team}/events), with the projections (usage → budget). */
  async function appendEvents(tenant, team, events) {
    await getTeam(db, tenant, team);
    return tx(tenant, async (ctx) => {
      // outside: the sender's actor and data are its own words, so no session it names gives the event a task.
      const s = await appendIn(ctx.q, tenant, team, events, { project: (qq, x) => project(ctx, x), now: ctx.now, outside: true });
      ctx.stored.push(...s);
      return s;
    });
  }

  /** For writes outside this module that need step-up (runner codes, secrets: issue #28 D4). Throws when absent. */
  /** `scope` (optional) names the one change the token was minted for (ADR 0013): then only such a token counts. */
  async function requireStepUp(tenant, by, token, what, scope = null) {
    const { result } = await tx(tenant, async (ctx) => {
      const used = await useStepUp(ctx, by, token, scope);
      if (used) await ctx.audit({ actorKind: 'person', actorId: by, action: 'step-up', target: used, decision: 'used', rule: what });
      return used;
    });
    if (!result) throw new StepUpRequired(what, scope);
    return result;
  }

  /** Appends envelopes inside a transaction of this module, with the projections; for the bus. */
  async function appendInTx(ctx, team, events) {
    const s = await appendIn(ctx.q, ctx.tenant, team, events, { project: (qq, x) => project(ctx, x), now: ctx.now });
    ctx.stored.push(...s);
    return s;
  }

  return {
    appendIn: appendInTx, onStored: (fn) => listeners.push(fn), hooks,
    requireStepUp, useStepUp, appendEvents, tx, mint: (tenant, team, type, data, opts) => mint(tenant, team, type, data, opts), project,
    getBudget, putBudget, startRun, listRuns, controlRun, setRunState,
    createCard, changeCard, getCard, answerCard, requestApproval, decideApproval, readyToTry, previewArrived, checkPreviewed, previewForMerge,
    stepUp, mintStepUp, postChat, getChat, inbox, teamExtras, useStepUp, today,
  };
}

// ---- Ready to try helpers ------------------------------------------------------------------------------------------

const PREVIEW_PENDING = 'The preview link is not up yet. It appears here when the deployment is ready.';
/** An https URL a person may be sent to: no spaces, and no user or password in it (a link that hides its host). */
const httpsUrl = (u) => {
  if (typeof u !== 'string' || u.length > 2000 || !/^https:\/\/[^\s/@]+(\/\S*)?$/.test(u)) return false;
  try { const x = new URL(u); return x.protocol === 'https:' && !x.username && !x.password; } catch { return false; }
};
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));

/**
 * A runner's proposal.previewed (events.md): the deployment that is up for a merged PR. Only a successful deployment
 * with an https URL is stored, cleaned to the catalogue's fields. The event id is the bus's: one per deployment.
 */
export function checkPreviewed(data) {
  const d = data ?? {};
  const ref = typeof d.ref === 'string' && /^[1-9]\d{0,9}$/.test(d.ref) ? Number(d.ref) : d.ref;
  if (!Number.isSafeInteger(ref) || ref < 1) throw new Problem(400, 'proposal.previewed needs ref, the pull request number');
  if (!httpsUrl(d.url)) throw new Problem(400, 'proposal.previewed needs url, an https:// address');
  if (d.state !== 'success') throw new Problem(400, 'proposal.previewed is sent only for a successful deployment (state success)');
  const dep = typeof d.deployment === 'number' ? String(d.deployment) : d.deployment;
  if (typeof dep !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(dep)) throw new Problem(400, 'proposal.previewed needs deployment, the deployment id');
  if (!(typeof d.sha === 'string' && /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(d.sha))) throw new Problem(400, 'proposal.previewed needs sha, the full merge commit that was deployed');
  if (d.environment !== undefined && !(typeof d.environment === 'string' && d.environment.length <= 100)) throw new Problem(400, 'environment is text of at most 100 characters');
  return clean({ connector: typeof d.connector === 'string' ? d.connector.slice(0, 60) : undefined, ref, sha: d.sha, url: d.url, environment: d.environment, state: 'success', deployment: dep });
}

// ---- The step-up secret (issue #28 D3) ----------------------------------------------------------------------------

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** The stored form of a step-up secret: scrypt$N$r$p$salt$hash (base64url). Never a fast hash. */
export async function hashStepUpSecret(secret) {
  if (typeof secret !== 'string' || secret.length < 12) throw new Error('the step-up secret is at least 12 characters');
  const salt = randomBytes(16);
  const out = await scrypt(secret, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${out.toString('base64url')}`;
}

/** A verifier for a stored hash: async (typed) => boolean, in constant time. */
export function stepUpVerifier(stored) {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([\w-]+)\$([\w-]+)$/.exec(String(stored ?? ''));
  if (!m) throw new Error('AGENT_TEAM_STEP_UP_SECRET_HASH is not a scrypt hash (make one with: agent-team-server --hash-step-up)');
  const [, N, r, p, salt, hash] = m;
  const n = Number(N), rr = Number(r), pp = Number(p);
  // Bounded both ways: slow enough to guess, and at most 128 MiB a check (N 2^17, r 8), so a check cannot exhaust memory.
  if (n < 2 ** 15 || n > 2 ** 17 || (n & (n - 1)) !== 0) throw new Error('the step-up hash must use scrypt N, a power of two from 2^15 to 2^17');
  if (rr < 1 || rr > 8 || pp < 1 || pp > 4) throw new Error('the step-up hash has an out-of-range scrypt r (1 to 8) or p (1 to 4)');
  const want = Buffer.from(hash, 'base64url');
  if (want.length < 16 || Buffer.from(salt, 'base64url').length < 16) throw new Error('the step-up hash needs a salt and a key of at least 16 bytes');
  const maxmem = 128 * n * rr * pp + 32 * 1024 * 1024;
  return async (typed) => {
    if (typeof typed !== 'string' || typed.length > 1024) return false;
    const got = await scrypt(String(typed), Buffer.from(salt, 'base64url'), want.length, { N: n, r: rr, p: pp, maxmem });
    return got.length === want.length && timingSafeEqual(got, want);
  };
}
