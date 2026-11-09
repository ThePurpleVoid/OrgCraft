// The bus (docs/product/m3-design.md sections 2, 3, 4 and 7): what wakes whom, delivering to runners, the team tool
// endpoint, the runner ops after hello, and the tick that does everything time-based.
//
// A waking event writes a `deliveries` row in the transaction that appends it. After commit the delivery is sent:
// session.message to a live session, or session.start (a resume when the role already had a session in this run).
// The runner acks; with no ack the tick sends again with backoff, and after ten tries the delivery is dead and the
// front door hears about it. At-least-once: the runner dedupes by the waking event id.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Problem, id, sha } from './store.mjs';
import { checkTool, detailOf } from './tools.mjs';
import { personActor } from './m3.mjs';
import { boundCalls, redact } from './signed.mjs';
import { createMeetings } from './meetings.mjs';
import { canWork } from './deployment.mjs';
import { checkIoRefs, ingestStepIo, projectTask, purgeIo } from './inspector.mjs';
import { memberHeld } from './live.mjs';
import { resolveTo } from './routing.mjs';

/** How a message's `to` was resolved (section 5.3), on its event: only when it was not already a member id. */
const routedFields = (r) => (!r ? {} : { ...(r.how !== 'id' ? { toAsked: r.asked, routedBy: r.how } : {}), ...(r.offWiring ? { offWiring: true } : {}) });

export const SESSION_TOKEN_MINUTES = 15;
const ACK_SECONDS = 30;
const CHECKPOINT_MS = 10 * 60_000;
const BACKOFF = [5, 30, 120, 600];
const MAX_ATTEMPTS = 10;
const LIVE = ['starting', 'running', 'idle', 'waiting'];
const RUNNER_MAY_SEND = (type) => /^session\./.test(type) || ['usage.recorded', 'report.heartbeat', 'chat.message'].includes(type) || /^proposal\.(opened|updated|accepted|failed|previewed)$/.test(type);
const TOOL_EVENT = { report: 'report.status', handoff: 'message.handoff', bug: 'message.bug', signoff: 'message.signoff', blocked: 'message.blocked' };
const SESSION_STATE = { 'session.started': 'running', 'session.idle': 'idle', 'session.ended': 'ended' };

const utcDay = (d) => d.toISOString().slice(0, 10);
const backoff = (attempts) => BACKOFF[Math.min(Math.max(attempts - 1, 0), BACKOFF.length - 1)];

export function createBus({ db, m3, runners = () => null, now = () => new Date(), publicUrl = '', log = console, meetingTurnMinutes, installationsFor = null, triggers = null, gateway = null }) {
  const reg = () => (typeof runners === 'function' ? runners() : runners);
  const meetings = createMeetings({ db, m3, publicUrl, ...(meetingTurnMinutes ? { turnMinutes: meetingTurnMinutes } : {}) });
  const toolsUrl = () => String(publicUrl || '').replace(/\/+$/, '');

  // ---- What wakes whom ----------------------------------------------------------------------------------------------

  const activeRun = async (q, team) => (await q("select id, state, roster, caps, team_version from runs where team = $1 and state <> 'stopped' order by started_at desc limit 1", [team]))[0] ?? null;
  const roleOf = (roster, slug) => roster?.roles?.find((r) => r.slug === slug) ?? null;

  /** The roles an event wakes (section 2), as [{ role, instance }]. */
  async function targets(q, run, event) {
    const roster = run.roster ?? {};
    const out = [];
    const add = (role, instance = null) => {
      if (!role || !roleOf(roster, role)) return;
      if (event.actor?.kind === 'role' && event.actor.id === role && (event.actor.instance ?? null) === instance) return;
      out.push({ role, instance });
    };
    if (event.type === 'chat.message' && event.actor?.kind === 'person') add(roster.frontDoor);
    else if (/^message\.(handoff|bug|signoff|blocked)$/.test(event.type)) {
      let to = event.data?.to;
      if (!to && event.type === 'message.blocked') {
        const up = roleOf(roster, event.actor?.id)?.reportsTo;
        to = up === 'owner' ? roster.frontDoor : up;
      }
      if (to === 'owner') to = roster.frontDoor;
      const [role, instance] = String(to ?? '').split('#');
      add(role, instance || null);
    } else if (event.type === 'trigger.fired') {
      // A trigger wakes its teammate like a handoff (N2 section 6); the server named it from the frozen triggers.
      add(event.data?.to);
    } else if (event.type === 'meeting.turn') {
      // A turn goes to the role; a pool role's lowest-numbered live instance takes it (meetings, A8).
      add(event.data?.to, await meetings.instanceFor(q, run.id, event.data?.to));
    } else if ((event.type === 'decision.answered' || event.type === 'approval.decided') && event.data?.session) {
      const [s] = await q('select role, instance from sessions where id = $1', [event.data.session]);
      if (s) add(s.role, s.instance);
    }
    return out;
  }

  /** The projection m3 runs for every stored event: deliveries for whoever it wakes, and session states. */
  async function project(ctx, { event }) {
    if (!event.team) return;
    const { q } = ctx;
    await meetings.project(ctx, event);
    await projectTask(q, ctx.tenant, event);
    // Event triggers inside the team (N2, L21): may emit trigger.fired, which this projection then delivers.
    if (triggers) await triggers.project(ctx, event);
    if (SESSION_STATE[event.type] && event.actor?.session) {
      await q('update sessions set state = $2, last_seen = now() where id = $1 and state <> $2', [event.actor.session, SESSION_STATE[event.type]]);
      if (event.type === 'session.ended') ctx.after.push(() => startQueued(ctx.tenant, event.team));
    }
    if (!['chat.message', 'message.handoff', 'message.bug', 'message.signoff', 'message.blocked', 'decision.answered', 'approval.decided', 'meeting.turn', 'trigger.fired'].includes(event.type)) return;
    const run = await activeRun(q, event.team);
    if (!run) return;
    for (const t of await targets(q, run, event)) {
      const [d] = await q(`insert into deliveries(id, tenant, team, event, run, role, instance, task) values ($1, $2, $3, $4, $5, $6, $7, $8)
                           on conflict do nothing returning id`, [id('dlv'), ctx.tenant, event.team, event.id, run.id, t.role, t.instance, event.task ?? null]);
      if (d) ctx.after.push(() => deliver(ctx.tenant, d.id));
    }
  }

  // ---- Delivering ---------------------------------------------------------------------------------------------------

  const sessionCap = (run, budget) => Math.min(budget?.sessions ?? 3, Number.isSafeInteger(run.caps?.sessions) ? run.caps.sessions : Infinity);

  async function remaining(q, run) {
    const [b] = await q('select per_day, per_run, sessions from budgets where team = (select team from runs where id = $1)', [run.id]);
    const [d] = await q('select spent, raised, exhausted_at from budget_days where team = (select team from runs where id = $1) and day = $2::date', [run.id, utcDay(now())]);
    const [{ spent: runSpent }] = await q(`select coalesce(sum(case when jsonb_typeof(envelope->'data'->'cost') = 'number' then (envelope->'data'->>'cost')::numeric else 0 end), 0) as spent
                                           from events where type = 'usage.recorded' and envelope->>'run' = $1`, [run.id]);
    const perDay = b?.per_day === null || b?.per_day === undefined ? null : Number(b.per_day) + Number(d?.raised ?? 0);
    const perRun = Math.min(b?.per_run === null || b?.per_run === undefined ? Infinity : Number(b.per_run), Number.isSafeInteger(run.caps?.costPerRun) ? run.caps.costPerRun : Infinity);
    return {
      budget: b ? { sessions: Number(b.sessions) } : null,
      exhausted: Boolean(d?.exhausted_at),
      remainingToday: perDay === null ? null : Math.max(perDay - Number(d?.spent ?? 0), 0),
      remainingRun: perRun === Infinity ? null : Math.max(perRun - Math.round(Number(runSpent)), 0),
    };
  }

  function mintToken(sid) {
    const secret = randomBytes(24).toString('base64url');
    return { token: `st_${sid}.${secret}`, hash: sha(secret), expires: new Date(now().getTime() + SESSION_TOKEN_MINUTES * 60_000) };
  }

  /**
   * Sends one delivery if it can go now. Decides inside a transaction (with the row locked, skip locked, so two
   * ticks never send it twice), then sends after commit and records the ack.
   */
  async function deliver(tenant, dlv) {
    const plan = await db.tenant(tenant, async ({ q }) => {
      const [d] = await q("select * from deliveries where id = $1 and state = 'pending' and next_at <= now() for update skip locked", [dlv]);
      if (!d) return null;
      const [run] = await q('select id, team, state, roster, caps, team_version from runs where id = $1', [d.run]);
      const [ev] = await q('select envelope from events where team = $1 and id = $2', [d.team, d.event]);
      if (!run || run.state === 'stopped' || !ev) { await q("update deliveries set state = 'dead' where id = $1", [d.id]); return null; }
      const money = await remaining(q, run);
      if (run.state !== 'running' || money.exhausted) { await q("update deliveries set state = 'held' where id = $1", [d.id]); return null; }
      // A teammate paused or switched off live (L18): its work waits, held, until the live change is lifted.
      if (await memberHeld(q, d.team, d.role, d.instance)) { await q("update deliveries set state = 'held' where id = $1", [d.id]); return null; }
      const wake = ev.envelope;
      const [s] = await q("select * from sessions where run = $1 and role = $2 and coalesce(instance, '') = coalesce($3, '') for update", [run.id, d.role, d.instance]);
      const conn = s?.runner ? reg()?.get(s.runner) : null;
      if (s?.state === 'unknown') {
        // Its runner went quiet but may still run it: wait for it to come back (or the tick to give it up).
        await q('update deliveries set next_at = now() + make_interval(secs => 10) where id = $1', [d.id]);
        return null;
      }
      if (s && LIVE.includes(s.state) && conn && !canWork(conn)) {
        // Outage mode (L29, O37.8): its runner can't reach the model provider. The wake waits here, unspent, until it can.
        await q('update deliveries set next_at = now() + make_interval(secs => 10) where id = $1', [d.id]);
        return null;
      }
      if (wake.type === 'meeting.turn') await meetings.sent(q, wake.id, d.team);
      // A trigger's outside data (N2 section 6): fields and the body, for the runner to fence; never in the brief.
      const outside = wake.type === 'trigger.fired' && triggers ? await triggers.outsideOf(q, d.team, wake.data?.source) : null;
      if (s && LIVE.includes(s.state) && conn) {
        await q("update deliveries set state = 'sent', session = $2, attempts = attempts + 1, next_at = now() + make_interval(secs => $3) where id = $1", [d.id, s.id, ACK_SECONDS]);
        // The session's events now belong to this delivery's task, caused by its wake (ADR 0009).
        await q('update sessions set task = $2, cause = $3 where id = $1', [s.id, d.task ?? null, wake.id]);
        return { d, conn, op: 'session.message', body: { session: s.id, message: wake, delivery: d.id, ...(outside ? { outside } : {}), ...(d.task ? { task: d.task } : {}), cause: wake.id } };
      }
      // No live session: start one, unless the run is at its session cap.
      const [{ n }] = await q('select count(*)::int as n from sessions where run = $1 and state = any($2)', [run.id, [...LIVE, 'unknown']]);
      if (n >= sessionCap(run, money.budget)) {
        if (!s || s.state !== 'queued') {
          const sid = s?.id ?? id('ses');
          if (s) await q("update sessions set state = 'queued' where id = $1", [sid]);
          else await q("insert into sessions(id, tenant, team, run, role, instance, state, team_version) values ($1, $2, $3, $4, $5, $6, 'queued', $7)", [sid, tenant, run.team, run.id, d.role, d.instance, run.team_version]);
          const [{ pos }] = await q("select count(*)::int as pos from sessions where run = $1 and state = 'queued'", [run.id]);
          return { queued: { sid, role: d.role, instance: d.instance, run: run.id, team: run.team, position: pos }, d };
        }
        await q('update deliveries set next_at = now() + make_interval(secs => 10) where id = $1', [d.id]);
        return null;
      }
      const choice = pickRunner(tenant, await q("select runner, count(*)::int as n from sessions where state = any($1) and runner is not null group by runner", [LIVE]));
      if (!choice) { await q('update deliveries set attempts = attempts, next_at = now() + make_interval(secs => 10) where id = $1', [d.id]); return null; }
      const sid = s?.id ?? id('ses');
      const tok = mintToken(sid);
      const role = roleOf(run.roster, d.role) ?? {};
      const branch = branchFor(wake, d.role, run.id);
      if (s) await q("update sessions set state = 'starting', runner = $2, token_hash = $3, token_expires = $4, branch = coalesce(branch, $5), last_seen = now() where id = $1", [sid, choice.runner, tok.hash, tok.expires.toISOString(), branch]);
      else await q("insert into sessions(id, tenant, team, run, role, instance, state, runner, team_version, branch, token_hash, token_expires) values ($1, $2, $3, $4, $5, $6, 'starting', $7, $8, $9, $10, $11)",
        [sid, tenant, run.team, run.id, d.role, d.instance, choice.runner, run.team_version, branch, tok.hash, tok.expires.toISOString()]);
      await q("update deliveries set state = 'sent', session = $2, attempts = attempts + 1, next_at = now() + make_interval(secs => $3) where id = $1", [d.id, sid, ACK_SECONDS]);
      await q('update sessions set task = $2, cause = $3 where id = $1', [sid, d.task ?? null, wake.id]);
      const roster = run.roster ?? {};
      const body = {
        session: sid, run: run.id, team: run.team, teamVersion: run.team_version, role: d.role, instance: d.instance,
        repo: roster.repo ?? null, worktree: { branch, base: roster.repo?.ref ?? 'main' },
        prompt: { brief: role.brief ?? '', memory: s?.checkpoint?.memory ?? null },
        tools: { url: toolsUrl() ? `${toolsUrl()}/v1/sessions/${sid}/tools` : null },
        secrets: [], caps: { remainingToday: money.remainingToday, remainingRun: money.remainingRun },
        areas: role.areas ?? [], roster: (roster.roles ?? []).map((r) => r.slug), frontDoor: roster.frontDoor === d.role, frontDoorRole: roster.frontDoor,
        ...(role.model ? { model: role.model } : {}),
        // ADR 0011 (L17): a teammate's type and display name, for its prompt; it is still addressed by its member id.
        ...(role.type ? { type: role.type } : {}), ...(role.name ? { name: role.name } : {}),
        wake, ...(outside ? { outside } : {}), resume: Boolean(s), ...(s?.checkpoint ? { checkpoint: s.checkpoint } : {}),
        token: tok.token, tokenExpires: tok.expires.toISOString(), delivery: d.id, ...(d.task ? { task: d.task } : {}), cause: wake.id,
      };
      return { d, conn: choice.conn, op: 'session.start', body };
    });
    if (!plan) return;
    if (plan.queued) {
      const { sid, role, instance, run, team, position } = plan.queued;
      await m3.tx(tenant, (ctx) => ctx.emit(team, 'session.queued', { role, instance, reason: 'the run is at its session cap', position }, { subject: `role/${role}`, run, actor: { kind: 'system', id: 'control-plane', session: sid, via: 'api' } }));
      await db.tenant(tenant, ({ q }) => q('update deliveries set next_at = now() + make_interval(secs => 10) where id = $1', [plan.d.id]));
      return;
    }
    // The GitHub App installations this workspace proved it owns for the repository's account (S9), set by the server
    // only and left off when there is none: the runner mints tokens for these and no other (#139).
    if (installationsFor && plan.body.repo?.url) {
      const ids = await installationsFor(tenant, plan.body.repo.url).catch(() => null);
      if (ids?.length) plan.body.repo = { ...plan.body.repo, installations: ids };
    }
    try {
      await plan.conn.send(plan.op, plan.body, { timeoutMs: ACK_SECONDS * 1000 });
      await db.tenant(tenant, ({ q }) => q("update deliveries set state = 'acked' where id = $1 and state = 'sent'", [plan.d.id]));
    } catch (e) {
      // The runner says it no longer runs that session (it restarted): the session stops, and the retry starts it.
      if (plan.op === 'session.message' && e.nack?.error === 'no-session') {
        await db.tenant(tenant, ({ q }) => q("update sessions set state = 'stopped' where id = $1 and runner = $2 and state = any($3)", [plan.body.session, plan.conn.runner, LIVE]));
        await db.tenant(tenant, ({ q }) => q("update deliveries set state = 'pending', next_at = now() where id = $1 and state = 'sent'", [plan.d.id]));
        return deliver(tenant, plan.d.id);
      }
      await retryLater(tenant, plan.d.id, e.message);
    }
  }

  /** The connected runner of the tenant with the fewest live sessions, below its maxSessions, that can reach the model. */
  function pickRunner(tenant, counts) {
    const busy = new Map(counts.map((c) => [c.runner, c.n]));
    let best = null;
    for (const conn of reg()?.connected(tenant) ?? []) {
      if (!canWork(conn)) continue; // outage mode: it says it can't reach the model provider
      const n = busy.get(conn.runner) ?? 0;
      const max = Number(conn.hello?.capabilities?.maxSessions) || 8;
      if (n >= max) continue;
      if (!best || n < best.n) best = { runner: conn.runner, conn, n };
    }
    return best;
  }

  async function retryLater(tenant, dlv, why) {
    const dead = await db.tenant(tenant, async ({ q }) => {
      const [d] = await q("update deliveries set state = case when attempts >= $2 then 'dead' else 'pending' end, next_at = now() + make_interval(secs => $3) where id = $1 and state = 'sent' returning state, team, run, role, event, attempts",
        [dlv, MAX_ATTEMPTS, backoff((await q('select attempts from deliveries where id = $1', [dlv]))[0]?.attempts ?? 1)]);
      return d?.state === 'dead' ? d : null;
    });
    if (dead) {
      await m3.tx(tenant, async (ctx) => {
        await ctx.audit({ team: dead.team, action: 'delivery', target: dlv, decision: 'dead', detail: { role: dead.role, event: dead.event, attempts: dead.attempts, why } });
        const [run] = await ctx.q('select roster from runs where id = $1', [dead.run]);
        const front = run?.roster?.frontDoor;
        if (front && front !== dead.role) {
          await ctx.emit(dead.team, 'message.blocked', { to: front, task: `Reach ${dead.role}`, detail: `A message for ${dead.role} (event ${dead.event}) could not be delivered after ${dead.attempts} tries: ${why}`, need: `a runner that can run ${dead.role}`, needFrom: 'owner', meanwhile: 'the message is kept; it is not retried' },
            { run: dead.run, subject: `role/${dead.role}` });
        }
      });
    }
  }

  /** Starts queued sessions of a team while its run has free slots (fix-in-production first is the runner's order). */
  async function startQueued(tenant, team) {
    const due = await db.tenant(tenant, ({ q }) => q(`select d.id from deliveries d join sessions s on s.run = d.run and s.role = d.role and coalesce(s.instance, '') = coalesce(d.instance, '')
                                                     where d.team = $1 and d.state = 'pending' and s.state = 'queued' order by d.created_at`, [team]));
    for (const d of due) {
      await db.tenant(tenant, ({ q }) => q('update deliveries set next_at = now() where id = $1', [d.id]));
      await deliver(tenant, d.id);
    }
  }

  // ---- Run changes reach the runners (section 4) --------------------------------------------------------------------

  async function runChanged(tenant, team, rid, state, reason) {
    // The version this change made (m3-design 2 and 6): a handler acts only while the run is still at it, so a late
    // pause stops nothing and a late resume restarts nothing.
    const [{ version } = {}] = await db.tenant(tenant, ({ q }) => q('select version from runs where id = $1 and state = $2', [rid, state]));
    if (version === undefined) return;
    const live = await db.tenant(tenant, ({ q }) => q('select id, runner from sessions where run = $1 and state = any($2) and runner is not null', [rid, [...LIVE, 'unknown']]));
    if (state === 'running') {
      // Sessions the pause stopped start again from their checkpoint, woken by run.resumed; then the held messages.
      const due = await db.tenant(tenant, async ({ q }) => {
        const [still] = await q("select 1 from runs where id = $1 and state = 'running' and version = $2 for update", [rid, version]);
        if (!still) return [];
        const [ev] = await q("select id from events where team = $1 and type = 'run.resumed' and envelope->>'run' = $2 order by seq desc limit 1", [team, rid]);
        const out = [];
        if (ev) {
          for (const s of await q("select role, instance from sessions where run = $1 and state = 'stopped'", [rid])) {
            const [d] = await q('insert into deliveries(id, tenant, team, event, run, role, instance) values ($1, $2, $3, $4, $5, $6, $7) on conflict do nothing returning id',
              [id('dlv'), tenant, team, ev.id, rid, s.role, s.instance]);
            if (d) out.push(d);
          }
        }
        out.push(...(await q("update deliveries set state = 'pending', next_at = now() where run = $1 and state = 'held' returning id", [rid])));
        return out;
      });
      for (const d of due) await deliver(tenant, d.id);
      return;
    }
    for (const s of live) {
      const conn = reg()?.get(s.runner);
      if (!conn) {
        // Its runner is away: the session stops here now, and the runner is told so when it is back (welcome).
        await db.tenant(tenant, ({ q }) => q("update sessions set state = 'stopped' where id = $1 and state = any($2) and exists (select 1 from runs where id = $3 and state = $4 and version = $5)", [s.id, [...LIVE, 'unknown'], rid, state, version]));
        continue;
      }
      (async () => {
        if (state === 'paused') {
          // Bring it to a safe point first: the branch pushed and the memory file sent (ADR 0004, budget).
          const cp = await conn.send('session.checkpoint', { session: s.id, reason }, { timeoutMs: CHECKPOINT_MS }).catch(() => null);
          if (cp && (cp.commit || cp.memory !== undefined)) await saveCheckpoint(tenant, s.id, cp);
          // The checkpoint can take minutes: if the run was resumed meanwhile, the session carries on.
          const stopped = await db.tenant(tenant, ({ q }) => q("update sessions set state = 'stopped' where id = $1 and state = any($2) and exists (select 1 from runs where id = $3 and state = 'paused' and version = $4) returning id", [s.id, LIVE, rid, version]));
          if (stopped.length) await conn.send('session.stop', { session: s.id, mode: 'finish-step', reason }).catch(() => {});
        } else {
          await db.tenant(tenant, ({ q }) => q("update sessions set state = 'stopped' where id = $1 and state = any($2)", [s.id, LIVE]));
          await conn.send('session.stop', { session: s.id, mode: 'now', reason }).catch(() => {});
        }
      })().catch((e) => log.error?.(`bus: stopping ${s.id}: ${e.message}`));
    }
  }

  /**
   * A live change to one teammate (L18). paused: its live sessions come to a safe point (checkpoint) and stop;
   * off: they stop now; on (lifted): what the pause stopped starts again from its checkpoint, then its held work goes.
   * Each step re-checks the override, so a lift that lands meanwhile wins.
   */
  async function memberChanged(tenant, team, role, instance, state, override = null) {
    const run = await db.tenant(tenant, ({ q }) => activeRun(q, team));
    if (!run) return;
    const mine = "role = $2 and ($3::text is null or coalesce(instance, '') = $3)";
    if (state === 'on') {
      if (run.state !== 'running') return; // the run's own resume releases it
      const due = await db.tenant(tenant, async ({ q }) => {
        if (await memberHeld(q, team, role, instance)) return [];
        const [ev] = await q("select id from events where team = $1 and type = 'live.changed' and envelope->'data'->>'op' = 'lifted' and envelope->'data'->>'override' = $2 order by seq desc limit 1", [team, override]);
        const out = [];
        if (ev) {
          for (const s of await q(`select role, instance from sessions where run = $1 and state = 'stopped' and ${mine}`, [run.id, role, instance])) {
            const [d] = await q('insert into deliveries(id, tenant, team, event, run, role, instance) values ($1, $2, $3, $4, $5, $6, $7) on conflict do nothing returning id',
              [id('dlv'), tenant, team, ev.id, run.id, s.role, s.instance]);
            if (d) out.push(d);
          }
        }
        out.push(...(await q(`update deliveries set state = 'pending', next_at = now() where run = $1 and state = 'held' and ${mine} returning id`, [run.id, role, instance])));
        return out;
      });
      for (const d of due) await deliver(tenant, d.id);
      return;
    }
    const live = await db.tenant(tenant, ({ q }) => q(`select id, runner from sessions where run = $1 and state = any($4) and runner is not null and ${mine}`, [run.id, role, instance, [...LIVE, 'unknown']]));
    const stillHeld = (q) => memberHeld(q, team, role, instance);
    for (const s of live) {
      const conn = reg()?.get(s.runner);
      if (!conn) {
        await db.tenant(tenant, async ({ q }) => { if (await stillHeld(q)) await q("update sessions set state = 'stopped' where id = $1 and state = any($2)", [s.id, [...LIVE, 'unknown']]); });
        continue;
      }
      (async () => {
        if (state === 'paused') {
          const cp = await conn.send('session.checkpoint', { session: s.id, reason: 'member-paused' }, { timeoutMs: CHECKPOINT_MS }).catch(() => null);
          if (cp && (cp.commit || cp.memory !== undefined)) await saveCheckpoint(tenant, s.id, cp);
        }
        const stopped = await db.tenant(tenant, async ({ q }) => ((await stillHeld(q)) ? q("update sessions set state = 'stopped' where id = $1 and state = any($2) returning id", [s.id, LIVE]) : []));
        if (stopped.length) await conn.send('session.stop', { session: s.id, mode: state === 'paused' ? 'finish-step' : 'now', reason: state === 'paused' ? 'member-paused' : 'member-off' }).catch(() => {});
      })().catch((e) => log.error?.(`bus: stopping ${s.id}: ${e.message}`));
    }
  }

  async function saveCheckpoint(tenant, sid, { commit = null, memory = null }) {
    const m = typeof memory === 'string' ? memory.slice(0, 64 * 1024) : null;
    await db.tenant(tenant, ({ q }) => q('update sessions set checkpoint = $2 where id = $1', [sid, JSON.stringify({ commit: typeof commit === 'string' ? commit.slice(0, 64) : null, memory: m, at: now().toISOString() })]));
  }

  /** An approval was answered: tell the runner holding that session (D6: approval.result only ever comes from here). */
  async function approvalDecided(tenant, team, { approval, decision, by, note, session }) {
    if (!session) return;
    const [s] = await db.tenant(tenant, ({ q }) => q('select runner, role, instance from sessions where id = $1', [session]));
    const [a] = await db.tenant(tenant, ({ q }) => q('select a.call, a.action, a.calls_hash, r.state as run_state from approvals a left join runs r on r.id = a.run where a.id = $1', [approval]));
    // A merge is only ever let go while its run is running: a stopped or paused run lands nothing, whatever the runner does.
    if (decision === 'approved' && a?.action === 'accept' && a.run_state && a.run_state !== 'running') return;
    // A teammate paused or switched off live (L18) gets no result either; the resend after a lift delivers it.
    if (s && (await db.tenant(tenant, ({ q }) => memberHeld(q, team, s.role, s.instance)))) return;
    const conn = s?.runner ? reg()?.get(s.runner) : null;
    const headSha = a?.call && typeof a.call === 'object' ? a.call.headSha ?? null : null;
    // ADR 0013: the hash this card was bound to, so the runner runs only the calls the person signed.
    if (conn) await conn.send('approval.result', { approval, decision, by, note, ...(headSha ? { headSha } : {}), ...(a?.calls_hash ? { callsHash: a.calls_hash } : {}) }).catch(() => {});
  }

  // ---- Session tokens and the team tool endpoint (section 3) --------------------------------------------------------

  /** The session a session token belongs to, or null. Looked up as the owner: the tenant is not known yet. */
  async function authSession(sid, token) {
    const m = /^st_([^.]+)\.(.+)$/.exec(String(token ?? ''));
    if (!m || m[1] !== sid) return null;
    const [row] = await db.system("select id, tenant, team, run, role, instance, state, token_hash, token_expires, team_version from sessions where id = $1", [sid]);
    if (!row?.token_hash || !(new Date(row.token_expires) > now()) || ['ended', 'stopped'].includes(row.state)) return null;
    const x = Buffer.from(row.token_hash, 'hex'), y = Buffer.from(sha(m[2]), 'hex');
    return x.length === y.length && timingSafeEqual(x, y) ? row : null;
  }

  /**
   * POST /v1/sessions/{session}/tools/{tool}: checked again here (tools/1), the actor minted from the token, never
   * from the body; the event appended with its deliveries, and audited. A refusal stores no message event.
   */
  async function toolCall(sess, tool, input) {
    const { result } = await m3.tx(sess.tenant, async (ctx) => {
      const [run] = await ctx.q('select id, state, roster from runs where id = $1', [sess.run]);
      const roster = run?.roster ?? {};
      const me = roster.roles?.find((r) => r.slug === sess.role);
      const check = checkTool(tool, input, { role: sess.role, frontDoor: roster.frontDoor === sess.role, frontDoorRole: roster.frontDoor, roster: (roster.roles ?? []).map((r) => r.slug), reportsTo: me?.reportsTo, resolve: (to, msg) => resolveTo(roster, to, sess.role, msg) });
      const actor = { kind: 'role', id: sess.role, instance: sess.instance ?? null, session: sess.id, via: 'tool' };
      const opts = { actor, run: sess.run, teamVersion: sess.team_version ?? undefined, subject: `role/${sess.role}` };
      if (check.problems) {
        const ev = await ctx.emit(sess.team, 'session.tool', { tool: `team.${tool}`, decision: 'refused', rule: 'tools/1', detail: check.problems.join(' ') }, opts);
        await ctx.audit({ team: sess.team, actorKind: 'role', actorId: sess.role, session: sess.id, action: 'tool', target: tool, decision: 'refused', rule: 'tools/1', event: ev.id, detail: { problems: check.problems } });
        return { refused: check.problems, forbidden: check.forbidden };
      }
      const i = check.input;
      let out;
      if (TOOL_EVENT[tool]) {
        const data = tool === 'report'
          ? { status: i.status, task: i.task, issue: i.issue, pr: i.pr, branch: i.branch, commit: i.commit, detail: i.detail, ...(i.waitingOn && roster.roles?.some((r) => r.slug === i.waitingOn) ? { to: i.waitingOn } : {}), ...(i.waitingOn ? { waitingOn: i.waitingOn } : {}) }
          : { ...i, ...(tool === 'blocked' && !i.to ? { to: i.needFrom === 'owner' ? roster.frontDoor : i.needFrom !== sess.role ? i.needFrom : undefined } : {}), detail: detailOf(tool, i), ...(i.artifact ? { evidence: [i.artifact] } : {}), ...routedFields(check.routed) };
        const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
        const ev = await ctx.emit(sess.team, TOOL_EVENT[tool], clean, opts);
        if (tool === 'blocked') await ctx.emit(sess.team, 'report.status', { status: 'blocked', task: i.task, issue: i.issue, detail: i.need }, opts);
        out = { event: ev.id, ...(check.routed ? { to: check.routed.to, routedBy: check.routed.how, ...(check.routed.offWiring ? { offWiring: true } : {}) } : {}) };
        await ctx.audit({ team: sess.team, actorKind: 'role', actorId: sess.role, session: sess.id, action: 'tool', target: tool, decision: 'allowed', rule: 'tools/1', event: ev.id });
      } else if (tool === 'meeting_reply' || tool === 'meeting_close' || tool === 'meeting_start') {
        const r = tool === 'meeting_start' ? await meetings.startAdhoc(ctx, sess, i, roster) : await meetings.tool(ctx, sess, tool, i, roster);
        if (r.problems) {
          const ev = await ctx.emit(sess.team, 'session.tool', { tool: `team.${tool}`, decision: 'refused', rule: 'meetings', detail: r.problems.join(' ') }, opts);
          await ctx.audit({ team: sess.team, actorKind: 'role', actorId: sess.role, session: sess.id, action: 'tool', target: tool, decision: 'refused', rule: 'meetings', event: ev.id, detail: { problems: r.problems } });
          return { refused: r.problems };
        }
        if (tool === 'meeting_reply') await ctx.audit({ team: sess.team, actorKind: 'role', actorId: sess.role, session: sess.id, action: 'tool', target: tool, decision: 'allowed', rule: 'tools/1', event: r.event });
        out = r;
      } else if (tool === 'ready_to_try') {
        const r = await m3.readyToTry(ctx, sess, i, { roster, opts });
        if (r.problems) {
          const ev = await ctx.emit(sess.team, 'session.tool', { tool: `team.${tool}`, decision: 'refused', rule: 'ready', detail: r.problems.join(' ') }, opts);
          await ctx.audit({ team: sess.team, actorKind: 'role', actorId: sess.role, session: sess.id, action: 'tool', target: tool, decision: 'refused', rule: 'ready', event: ev.id, detail: { problems: r.problems } });
          return { refused: r.problems };
        }
        await ctx.audit({ team: sess.team, actorKind: 'role', actorId: sess.role, session: sess.id, action: 'tool', target: tool, decision: 'allowed', rule: 'tools/1', event: r.event });
        out = r;
      } else if (tool === 'ask_owner') {
        const expiresAt = i.expires ? new Date(i.expires) : new Date(ctx.now.getTime() + 7 * 86_400_000);
        const card = await m3.createCard(ctx, sess.team, {
          kind: 'decision', subject: `decision/${sess.id}`, session: sess.id, run: sess.run, title: i.question, body: i.context ?? '',
          recommendation: { option: i.recommended, ...(i.why ? { why: i.why } : {}) },
          options: i.options.map((o) => ({ id: o.id, label: o.label, consequence: o.consequence, style: o.id === i.recommended ? 'primary' : 'default', stepUp: false })),
          expiresAt,
        });
        const ev = await ctx.emit(sess.team, 'decision.requested', { question: i.question, options: i.options, recommended: i.recommended, ...(i.why ? { why: i.why } : {}), cardId: card.id, session: sess.id }, { ...opts, subject: card.subject });
        await ctx.audit({ team: sess.team, actorKind: 'role', actorId: sess.role, session: sess.id, action: 'tool', target: tool, decision: 'allowed', rule: 'tools/1', event: ev.id });
        out = { card: card.id };
      } else {
        await ctx.q("update sessions set state = 'waiting' where id = $1", [sess.id]);
        const call = { command: redact(i.call), ...(i.pr ? { pr: i.pr } : {}), ...(i.headSha ? { headSha: i.headSha } : {}) };
        const links = [...(prLink(roster.repo, i.pr) ? [{ rel: 'pull-request', url: prLink(roster.repo, i.pr) }] : []), ...(i.links ?? []).filter((u) => /^https:\/\//.test(u)).map((url) => ({ rel: 'link', url }))];
        const r = await m3.requestApproval(ctx, sess.team, { action: i.action, call, why: i.why, links, session: sess.id, run: sess.run, role: sess.role, bound: i.bound ?? null });
        out = { approval: r.approval, card: r.card.id };
      }
      return out;
    });
    if (result.refused) throw new Problem(result.forbidden ? 403 : 422, result.refused.join(' '), { body: { problems: result.refused } });
    return result;
  }

  // ---- Runner ops after hello (section 4) ---------------------------------------------------------------------------

  /**
   * An installation a runner names (pace, governor.report) must be one its own tenant proved it owns (S9), so a
   * runner can never pace on, or hold, another tenant's installation. Answers the id as text, or null for none.
   */
  async function ownInstallation(conn, given) {
    if (given === undefined || given === null) return null;
    const installation = String(given);
    if (!/^\d{1,20}$/.test(installation)) throw new Problem(400, 'installation is a GitHub App installation id');
    const rows = await db.system('select 1 from github_installations where installation_id = $1::bigint and tenant = $2', [installation, conn.tenant]);
    if (!rows.length) throw new Problem(403, 'that installation was not proved by this account');
    return installation;
  }

  async function ownSession(q, conn, sid) {
    const [s] = await q('select id, team, run, role, instance, runner, state, team_version from sessions where id = $1', [sid]);
    if (!s || s.runner !== conn.runner) throw new Problem(403, `session ${sid} is not run by this runner`);
    return s;
  }

  const ops = {
    /** Events the runner key may send, for sessions it runs. A chat.message is the front door's, whatever it says. */
    async events(conn, body) {
      const list = Array.isArray(body.events) ? body.events : null;
      if (!list || list.length > 100) throw new Problem(400, 'events is a list of at most 100 envelopes');
      const stored = [];
      for (const e of list) {
        if (!e || typeof e !== 'object' || !RUNNER_MAY_SEND(e.type)) {
          await m3.tx(conn.tenant, (ctx) => ctx.audit({ actorKind: 'runner', actorId: conn.runner, action: 'event', target: String(e?.type ?? '?'), decision: 'refused', rule: 'runner-allowlist' }));
          throw new Problem(403, `a runner key may not send ${e?.type ?? 'that'} events`);
        }
        const sid = e.actor?.session;
        const { stored: s } = await m3.tx(conn.tenant, async (ctx) => {
          const sess = await ownSession(ctx.q, conn, sid);
          const [run] = await ctx.q('select roster from runs where id = $1', [sess.run]);
          if (e.type === 'chat.message' && run?.roster?.frontDoor !== sess.role) throw new Problem(403, 'only the front door posts in the chat');
          // The actor, run and team come from the session the runner runs, never from the frame.
          const env = { ...e, tenant: conn.tenant, team: sess.team, source: `/tenants/${conn.tenant}/teams/${sess.team}`, run: sess.run, teamVersion: sess.team_version ?? e.teamVersion,
            actor: { kind: 'role', id: sess.role, instance: sess.instance ?? null, session: sess.id, via: e.actor?.via === 'tool' ? 'tool' : 'hook' } };
          if (e.type === 'chat.message') env.data = { ...(e.data ?? {}), from: sess.role };
          // Step I/O named by this event must be this session's own (N1); outside output is marked on its row.
          await checkIoRefs(ctx.q, sess.id, env);
          // One stored event per deployment, whatever id the frame had, so a repeat after a reconnect is a no-op.
          if (e.type === 'proposal.previewed') { env.data = m3.checkPreviewed(e.data); env.id = `previewed-${env.data.ref}-${env.data.deployment}`; await m3.previewForMerge(ctx, sess.team, env.data); }
          const out = await m3.appendIn(ctx, sess.team, [env]);
          if (e.type === 'proposal.previewed' && out.length) await m3.previewArrived(ctx, sess.team, env.data);
          if (e.type === 'chat.message' && out.length) {
            await ctx.q('insert into chat_messages(tenant, team, event, from_kind, from_id, text, reply_to, at) values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict do nothing',
              [conn.tenant, sess.team, env.id, 'role', sess.role, String(env.data.text ?? ''), env.data.replyTo ?? null, env.time]);
          }
          if (e.type === 'proposal.failed' && e.data?.reason === 'head-moved' && e.data?.approval) await supersedeApproval(ctx, sess, e.data);
          return out;
        });
        stored.push(...s);
      }
      return { stored: stored.map((x) => x.id) };
    },

    /** The policy path. A resend (after a reconnect) names its approval and never makes a second card. */
    async 'approval.wait'(conn, body) {
      const a = body.approval ?? {};
      if (body.resend && typeof a.id === 'string') {
        const [row] = await db.tenant(conn.tenant, ({ q }) => q(`select a.id, a.card, a.state, a.session, a.decided_by, a.call, a.action, a.calls_hash, r.state as run_state,
                                                                  exists (select 1 from sessions s join live_overrides o on o.team = s.team and o.kind = 'member' and o.cleared_at is null and o.role = s.role
                                                                          and (o.instance is null or o.instance = coalesce(s.instance, '')) where s.id = a.session) as member_held
                                                                from approvals a left join runs r on r.id = a.run where a.id = $1`, [a.id]));
        if (!row) throw new Problem(404, `no approval ${a.id}`);
        if (!row.session) throw new Problem(403, `approval ${a.id} is not a session's`);
        await db.tenant(conn.tenant, ({ q }) => ownSession(q, conn, row.session));
        if (body.session && body.session !== row.session) throw new Problem(403, `approval ${a.id} belongs to another session`);
        const held = (row.state === 'approved' && row.action === 'accept' && row.run_state && row.run_state !== 'running') || row.member_held; // as in approvalDecided
        if (row.state !== 'pending' && !held) setImmediate(() => conn.send('approval.result', { approval: row.id, decision: row.state, by: row.decided_by, ...(row.call?.headSha ? { headSha: row.call.headSha } : {}), ...(row.calls_hash ? { callsHash: row.calls_hash } : {}) }).catch(() => {}));
        return { approval: row.id, card: row.card };
      }
      const { result } = await m3.tx(conn.tenant, async (ctx) => {
        const sess = await ownSession(ctx.q, conn, body.session);
        // D1 on the policy path too: a merge approval is bound to a PR and the exact head sha.
        const pr = Number.isSafeInteger(a.pr) && a.pr > 0 ? a.pr : null;
        const headSha = typeof a.headSha === 'string' && /^[0-9a-f]{7,64}$/.test(a.headSha) ? a.headSha : null;
        if (a.action === 'accept' && headSha && !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(headSha)) throw new Problem(422, 'an accept approval needs the full head sha (40 or 64 hex characters)');
        if (a.action === 'accept' && (!pr || !headSha)) throw new Problem(422, 'an accept approval needs pr and headSha, so the merge can only land on the commit that was approved');
        // ADR 0013: the held call, signed. A malformed list or a hash that is not theirs is refused, never shown.
        const bound = boundCalls(a.calls, a.callsHash);
        if (bound?.problem) throw new Problem(422, bound.problem);
        await ctx.q("update sessions set state = 'waiting' where id = $1", [sess.id]);
        const call = { command: redact(typeof a.call === 'string' ? a.call : JSON.stringify(a.call ?? '')), ...(pr ? { pr } : {}), ...(headSha ? { headSha } : {}) };
        const [run] = await ctx.q('select roster from runs where id = $1', [sess.run]);
        const link = prLink(run?.roster?.repo, pr);
        const r = await m3.requestApproval(ctx, sess.team, { action: String(a.action ?? 'unclassified'), call, why: String(a.why ?? 'The team policy keeps this for a person.'), links: link ? [{ rel: 'pull-request', url: link }] : [], session: sess.id, run: sess.run, role: sess.role, bound });
        return { approval: r.approval, card: r.card.id };
      });
      return result;
    },

    /** A tool call's input or output, or a turn's own text, for the run inspector (N1): stored outside the log. */
    async 'step.io'(conn, body) {
      return db.tenant(conn.tenant, async ({ q }) => {
        const sess = await ownSession(q, conn, body.session);
        return ingestStepIo(q, conn.tenant, sess, body, { now: now(), problem: (m) => new Problem(400, m) });
      });
    },

    /**
     * The outbound governor (L20g, R1a): a slot for one call to a provider on this session's behalf, in two stages so
     * it is answered at once and never holds the runner's other requests (they run one at a time per connection).
     * Stage `own` (the default) answers { waitMs, next: 'account' }: wait, then ask stage `account`, whose waitMs is
     * the last wait before the call goes. A busy key never refuses, it only delays. `installation` names a GitHub App
     * installation the call uses.
     */
    async pace(conn, body) {
      if (!gateway) throw new Problem(501, 'this control plane has no gateway');
      const sess = await db.tenant(conn.tenant, ({ q }) => ownSession(q, conn, body?.session));
      const installation = await ownInstallation(conn, body?.installation);
      return gateway.stage({ provider: body?.provider, installation, tenant: conn.tenant, team: sess.team, session: sess.id }, body?.stage ?? 'own');
    },

    /**
     * A provider told the runner to slow down (a 429, a secondary rate limit, an abuse response). Its word holds only
     * its own tenant's keys, for at most 5 minutes; the shared App or key only when two tenants say so (gateway
     * `reported`). Rate limited per tenant.
     */
    async 'governor.report'(conn, body) {
      if (!gateway) throw new Problem(501, 'this control plane has no gateway');
      await db.tenant(conn.tenant, ({ q }) => ownSession(q, conn, body?.session));
      const installation = await ownInstallation(conn, body?.installation);
      return gateway.reported({ provider: body?.provider, installation, tenant: conn.tenant }, { retryAfterMs: body?.retryAfterMs, reason: body?.reason });
    },

    /**
     * An outward effect is about to be sent (R5): its idempotency key is recorded first. The ack is { state: 'first' }
     * (send it), { state: 'repeat', result } (it was done already: send nothing, use this result), or
     * { state: 'unknown' } (it was cut off 15 minutes or more ago: ask a person, approval action effect-resend with the
     * key as its call, and begin again with `approval`); a key in flight is refused.
     */
    async 'effect.begin'(conn, body) {
      if (!gateway) throw new Problem(501, 'this control plane has no gateway');
      const { result } = await m3.tx(conn.tenant, async (ctx) => {
        const sess = await ownSession(ctx.q, conn, body?.session);
        return gateway.begin(ctx, { key: body?.key, team: sess.team, session: sess.id, tool: body?.tool, callHash: body?.callHash ?? null, approval: body?.approval ?? null });
      });
      return result;
    },

    /** How an outward effect ended: { key, ok, result }. A failed one may be tried again with the same key. */
    async 'effect.end'(conn, body) {
      if (!gateway) throw new Problem(501, 'this control plane has no gateway');
      const { result } = await m3.tx(conn.tenant, async (ctx) => {
        const sess = await ownSession(ctx.q, conn, body?.session);
        return gateway.end(ctx, { key: body?.key, ok: body?.ok === true, result: body?.result ?? null, session: sess.id, approval: body?.approval ?? null });
      });
      return result;
    },

    /** A fresh session token, sent as session.token. */
    async 'session.renew'(conn, body) {
      const tok = await db.tenant(conn.tenant, async ({ q }) => {
        const s = await ownSession(q, conn, body.session);
        if (!LIVE.includes(s.state)) throw new Problem(409, `session ${s.id} is ${s.state}`);
        const t = mintToken(s.id);
        await q('update sessions set token_hash = $2, token_expires = $3, last_seen = now() where id = $1', [s.id, t.hash, t.expires.toISOString()]);
        return t;
      });
      setImmediate(() => conn.send('session.token', { session: body.session, token: tok.token, tokenExpires: tok.expires.toISOString() }).catch(() => {}));
      return {};
    },
  };

  /** A merge refused because the head moved: the old approval is superseded; the runner asks again with the new head (D1). */
  async function supersedeApproval(ctx, sess, data) {
    const [a] = await ctx.q("select id, card, action, call, why, risk, state from approvals where id = $1 and session = $2 for update", [data.approval, sess.id]);
    if (!a) return;
    if (a.state === 'pending' || a.state === 'approved') {
      await ctx.q("update approvals set state = 'expired', decided_at = now() where id = $1", [a.id]);
      const [c] = await ctx.q("select state from cards where id = $1", [a.card]);
      // Open or already answered: either way the card must stop reading as the person's approval (D1).
      if (c?.state === 'open' || c?.state === 'answered') await m3.changeCard(ctx, sess.team, a.card, { state: 'superseded' });
      await ctx.emit(sess.team, 'approval.decided', { approval: a.id, decision: 'superseded', by: null, note: 'the pull request changed after it was approved', session: sess.id, cardId: a.card }, { subject: `approval/${a.id}`, run: sess.run });
    }
  }

  /** The runner went quiet: its live sessions are unknown until it reconnects (runner-protocol, ping). */
  async function onLost(conn) {
    await db.tenant(conn.tenant, ({ q }) => q("update sessions set state = 'unknown', last_seen = now() where runner = $1 and state = any($2)", [conn.runner, LIVE])).catch(() => {});
  }

  /**
   * welcome.sessions: what this runner should resume after a reconnect. Only the sessions it says in hello it still
   * runs carry on there. The others it lost (it restarted, or crashed): they stop, and what they were woken for since
   * they were last idle is delivered again, so they start afresh from their checkpoint (resilience pass, #28).
   */
  async function welcome(conn) {
    const still = new Set(conn.hello?.sessions ?? []);
    const { kept, lost } = await db.tenant(conn.tenant, async ({ q }) => {
      const rows = await q('select id, team from sessions where runner = $1 and state = any($2) for update', [conn.runner, [...LIVE, 'unknown']]);
      const kept = rows.filter((r) => still.has(r.id)).map((r) => r.id);
      const lost = rows.filter((r) => !still.has(r.id));
      if (kept.length) await q("update sessions set state = 'running', last_seen = now() where id = any($1) and state = 'unknown'", [kept]);
      for (const s of lost) {
        await q("update sessions set state = 'stopped', last_seen = now() where id = $1", [s.id]);
        // Its last rest: the newest session.idle or session.ended it sent. Anything woken after that is redone.
        const [{ seq } = {}] = await q("select max(seq) as seq from events where team = $1 and type in ('session.idle', 'session.ended') and envelope->'actor'->>'session' = $2", [s.team, s.id]);
        await q(`update deliveries d set state = 'pending', next_at = now() from events e
                 where d.session = $1 and d.state in ('sent', 'acked') and e.team = d.team and e.id = d.event and e.seq > $2`, [s.id, seq ?? 0]);
      }
      return { kept, lost: lost.map((r) => r.id) };
    });
    if (lost.length) log.info?.(`bus: runner ${conn.runner} no longer runs ${lost.join(', ')}; they start again from their checkpoints`);
    // And the other way round: sessions it still runs that were stopped while it was away (the run stopped or
    // paused, or the session was given up) stop now, before anything else it sends is handled.
    const gone = [...still].filter((x) => !kept.includes(x));
    // The reason is the run's, so the session.ended the runner sends says why (run-stopped, run-paused).
    const runOf = gone.length ? new Map((await db.tenant(conn.tenant, ({ q }) => q('select s.id, s.run, r.state, r.version from sessions s join runs r on r.id = s.run where s.id = any($1) and s.runner = $2', [gone, conn.runner]))).map((r) => [r.id, r])) : new Map();
    for (const sid of gone) {
      const r = runOf.get(sid);
      if (r?.state === 'paused') {
        // A pause goes through the pause path, so the resume starts from the newest work: checkpoint, then stop.
        setImmediate(() => (async () => {
          const cp = await conn.send('session.checkpoint', { session: sid, reason: 'run-paused' }, { timeoutMs: CHECKPOINT_MS }).catch(() => null);
          if (cp && (cp.commit || cp.memory !== undefined)) await saveCheckpoint(conn.tenant, sid, cp);
          // The checkpoint's session.idle marked it idle: stopped again, while the run is still paused.
          // As in runChanged: if the run was resumed meanwhile, the session carries on (its wake may already be here).
          const stopped = await db.tenant(conn.tenant, ({ q }) => q("update sessions set state = 'stopped' where id = $1 and exists (select 1 from runs where id = $2 and state = 'paused' and version = $3) returning id", [sid, r.run, r.version]));
          if (stopped.length) await conn.send('session.stop', { session: sid, mode: 'finish-step', reason: 'run-paused' }).catch(() => {});
        })().catch((e) => log.error?.(`bus: pausing ${sid}: ${e.message}`)));
        continue;
      }
      const reason = r?.state === 'stopped' ? 'run-stopped' : 'stopped';
      setImmediate(() => conn.send('session.stop', { session: sid, mode: 'now', reason }).catch(() => {}));
    }
    // Whatever waited for a runner can go now.
    setTimeout(() => kick(conn.tenant).catch((e) => log.error?.(`bus: ${e.message}`)), 0);
    return { tenant: conn.tenant, sessions: kept };
  }

  async function kick(tenant) {
    const due = await db.tenant(tenant, ({ q }) => q("update deliveries set next_at = now() where state = 'pending' and attempts < $1 returning id", [MAX_ATTEMPTS]));
    for (const d of due) await deliver(tenant, d.id);
  }

  // ---- The tick (section 7) -----------------------------------------------------------------------------------------

  /**
   * Everything time-based, idempotent, safe to run twice at once (rows are taken with skip locked):
   * deliveries due or unacked, cards and approvals past expiry, the UTC day for budget-paused runs, runner sockets of
   * revoked runners, and queued sessions.
   */
  async function tick() {
    const tenants = (await db.system('select id from tenants')).map((r) => r.id);
    for (const tenant of tenants) {
      // Unacked sends go back to pending with backoff.
      const stale = await db.tenant(tenant, ({ q }) => q("select id from deliveries where state = 'sent' and next_at <= now() for update skip locked", []));
      for (const d of stale) await retryLater(tenant, d.id, 'no ack');
      const due = await db.tenant(tenant, ({ q }) => q("select id from deliveries where state = 'pending' and next_at <= now() order by created_at limit 100"));
      for (const d of due) await deliver(tenant, d.id);
      await expire(tenant);
      await rollover(tenant);
      await meetings.tick(tenant);
      if (triggers) await triggers.tick(tenant).catch((e) => log.error?.(`bus: triggers tick: ${e.message}`));
      // A runner gone for ten minutes is not coming back for its sessions: they can start elsewhere.
      await db.tenant(tenant, ({ q }) => q("update sessions set state = 'stopped' where state = 'unknown' and last_seen < now() - interval '10 minutes'"));
    }
    // Step I/O past its retention goes for real (N1), as the owner, with an audit row per batch.
    await purgeIo(db).catch((e) => log.error?.(`step io purge: ${e.message}`));
    // A revoke on any instance closes the socket here.
    const live = reg();
    if (live?.all) {
      const ids = live.all().map((c) => c.runner);
      if (ids.length) for (const r of await db.system('select id from runners where id = any($1) and revoked_at is not null', [ids])) live.close(r.id, 'revoked');
    }
  }

  async function expire(tenant) {
    const { stored } = await m3.tx(tenant, async (ctx) => {
      const late = await ctx.q("select id, team, card, session, run from approvals where state = 'pending' and expires_at <= now() for update skip locked");
      for (const a of late) {
        await ctx.q("update approvals set state = 'expired', decided_at = now() where id = $1", [a.id]);
        await m3.changeCard(ctx, a.team, a.card, { state: 'expired' });
        await ctx.emit(a.team, 'approval.decided', { approval: a.id, decision: 'expired', by: null, session: a.session, cardId: a.card }, { subject: `approval/${a.id}`, ...(a.run ? { run: a.run } : {}) });
        ctx.after.push(() => approvalDecided(tenant, a.team, { approval: a.id, decision: 'expired', by: null, note: 'nobody answered in time', session: a.session }));
      }
      const cards = await ctx.q("select id, team from cards where state = 'open' and kind <> 'approval' and expires_at is not null and expires_at <= now() for update skip locked");
      for (const c of cards) await m3.changeCard(ctx, c.team, c.id, { state: 'expired' });
    });
    return stored;
  }

  async function rollover(tenant) {
    const today = utcDay(now());
    await m3.tx(tenant, async (ctx) => {
      const runs = await ctx.q("select id, team from runs where state = 'paused' and reason = 'budget' and resume_on is not null and resume_on <= $1::date for update skip locked", [today]);
      for (const r of runs) {
        const [d] = await ctx.q('select exhausted_at from budget_days where team = $1 and day = $2::date', [r.team, today]);
        if (d?.exhausted_at) continue;
        await m3.setRunState(ctx, r.team, r.id, 'running', 'budget', { kind: 'system', id: 'control-plane', via: 'api' });
      }
    });
  }

  return { project, deliver, tick, toolCall, authSession, ops, onLost, welcome, runChanged, memberChanged, approvalDecided, saveCheckpoint, meetings };
}

/**
 * The worktree branch a session works on. An agent wrote the waking message, so its data.branch is used only when it
 * is this role's own team/ branch; never main, a claude/** branch or another role's branch (architect, m3 2b).
 */
export function branchFor(wake, role, run) {
  const b = wake?.data?.branch;
  const own = `team/${role}/`;
  return typeof b === 'string' && b.startsWith(own) && b.length > own.length && b.length <= 200 && /^[A-Za-z0-9._/-]+$/.test(b) && !b.includes('..') && !b.endsWith('/') && !b.endsWith('.lock')
    ? b : `team/${role}/${run}`;
}

/** The web page of a pull request, for GitHub-style https repos; null otherwise. */
export function prLink(repo, pr) {
  if (!pr || typeof repo?.url !== 'string' || !/^https:\/\//.test(repo.url)) return null;
  return `${repo.url.replace(/\.git$/, '').replace(/\/+$/, '')}/pull/${pr}`;
}

export { personActor, redact };
