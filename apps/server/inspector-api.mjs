// The run inspector's API (N1, ADR 0009, local PR L19s-b; plans/n8n/n1-run-inspector-architecture.md sections 4
// and 6): the task list, one task's timeline folded into steps, lanes and a branch graph, a step's input or output
// for editors, and an early delete for admins. Session tokens never reach any of it (person routes only), so no
// agent reads history and outside text stored here is no second way in.
import { Problem } from './store.mjs';
import { StepUpRequired } from './m3.mjs';

const PAGE = 50;
const READS = new Set(['read']);
const OK_END = new Set(['stopped', 'run-stopped', 'run-paused', 'idle', 'end', 'checkpoint', 'budget', 'runner-shutdown']);
const ASK = { 'approval.requested': ['approval.decided', 'approval'], 'decision.requested': ['decision.answered', 'cardId'] };
const ANSWER = { 'approval.decided': 'approval', 'decision.answered': 'cardId' };
export const STATES = ['needs-you', 'failed', 'out-of-budget', 'stopped', 'blocked', 'running', 'done'];

const lane = (e) => (e.actor?.kind === 'role' ? e.actor.id : e.actor?.kind === 'person' ? 'person' : 'system');
const iso = (v, name) => { const d = new Date(v); if (Number.isNaN(d.getTime())) throw new Problem(400, `${name} is an ISO date and time`); return d.toISOString(); };
const cut = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * One task's events (seq order) folded as section 4 says: tool steps from session.tool and session.result, runs of
 * reads by one session into one Read step, cost on the step before it, asks with their answers, wake-ups, messages.
 */
export function fold(events, { capture = 'all' } = {}) {
  const steps = [], byCall = new Map(), byAsk = new Map(), lastOf = new Map(), lanes = new Map(), stepOf = new Map();
  const add = (s, e) => { steps.push(s); lastOf.set(e.actor?.session ?? lane(e), s); stepOf.set(e.id, s); return s; };
  for (const e of events) {
    const l = lane(e);
    if (!lanes.has(l)) lanes.set(l, { id: l, instances: [], status: null, first: e.id });
    const ln = lanes.get(l);
    if (e.actor?.instance && !ln.instances.includes(e.actor.instance)) ln.instances.push(e.actor.instance);
    const d = e.data ?? {};
    const base = { lane: l, at: e.time, events: [e.id], ...(e.actor?.instance ? { instance: e.actor.instance } : {}) };
    switch (e.type) {
      case 'session.tool': {
        if (d.decision === 'needs-approval') { if (d.call) byCall.get(d.call)?.events.push(e.id); break; }
        const prev = d.call ? byCall.get(d.call) : null;
        if (prev) { prev.events.push(e.id); prev.decision = d.decision; if (d.decision === 'refused') { prev.ok = false; prev.why = cut(d.detail ?? d.rule, 300); } break; }
        const last = lastOf.get(e.actor?.session);
        const s = { ...base, kind: 'tool', tool: d.tool, call: d.call ?? null, effect: d.effect ?? null, decision: d.decision, target: cut(d.target, 300), ...(d.io ? { io: d.io } : {}), ...(d.retryOf ? { retryOf: d.retryOf } : {}), ...(d.decision === 'refused' ? { ok: false, why: cut(d.detail ?? d.rule, 300) } : {}) };
        // Consecutive reads by one session, nothing between them: one Read step listing its targets.
        // Another session's steps in between don't split them: lanes are drawn per role.
        if (READS.has(d.effect) && d.decision === 'allowed' && last?.kind === 'read') {
          last.targets.push(s.target); last.calls.push(s.call); last.events.push(e.id);
          if (d.call) byCall.set(d.call, last);
          break;
        }
        const step = READS.has(d.effect) && d.decision === 'allowed' ? { ...base, kind: 'read', targets: [s.target], calls: [s.call] } : s;
        if (d.call) byCall.set(d.call, step);
        add(step, e);
        break;
      }
      case 'session.result': {
        const s = d.call ? byCall.get(d.call) : null;
        if (!s) break;
        s.events.push(e.id);
        if (s.kind === 'read') { s.ok = d.ok === false ? false : s.ok ?? true; break; }
        Object.assign(s, { ok: d.ok !== false, durationMs: d.durationMs ?? null, summary: cut(d.summary, 300), ...(d.io ? { out: d.io } : {}), ...(d.outside ? { outside: true } : {}) });
        break;
      }
      case 'usage.recorded': {
        const last = lastOf.get(e.actor?.session ?? l);
        if (last) { last.cost = (last.cost ?? 0) + (Number.isSafeInteger(d.cost) ? d.cost : 0); last.currency ??= d.currency; }
        if (d.io && capture === 'all') add({ ...base, kind: 'thought', io: d.io, cost: 0 }, e);
        break;
      }
      case 'approval.requested': case 'decision.requested': {
        const s = add({ ...base, kind: 'asked', ask: e.type.split('.')[0], title: cut(d.question ?? d.why ?? d.action, 200), answered: false }, e);
        byAsk.set(`${ASK[e.type][0]}:${d[ASK[e.type][1]]}`, s);
        break;
      }
      case 'approval.decided': case 'decision.answered': {
        const s = byAsk.get(`${e.type}:${d[ANSWER[e.type]]}`);
        if (s) { s.events.push(e.id); s.answered = true; s.answer = d.decision ?? d.answer ?? null; s.by = d.by ?? null; stepOf.set(e.id, s); }
        break;
      }
      case 'session.started': add({ ...base, kind: 'woke', reason: d.reason ?? 'started' }, e); break;
      case 'report.status': ln.status = { status: d.status, task: cut(d.task, 200), at: e.time }; break;
      default:
        if (/^message\./.test(e.type) || e.type === 'chat.message') add({ ...base, kind: 'message', type: e.type, to: d.to ?? null, title: cut(d.task ?? d.text ?? d.detail, 200) }, e);
    }
  }
  // The branch graph from cause alone: a fork wakes a new lane, a merge wakes a lane that ran before, a wait asks a person.
  const edges = [];
  const seenLane = new Map(events.map((e, i) => [e.id, i]));
  const firstIn = new Map();
  events.forEach((e, i) => { const l = lane(e); if (!firstIn.has(l)) firstIn.set(l, i); });
  const done = new Set();
  for (const e of events) {
    const c = e.cause ? events[seenLane.get(e.cause)] : null;
    if (!c || lane(c) === lane(e)) continue;
    const key = `${c.id}>${lane(e)}`;
    if (done.has(key)) continue;
    done.add(key);
    const kind = ASK[c.type] ? 'wait' : firstIn.get(lane(e)) < seenLane.get(c.id) ? 'merge' : 'fork';
    edges.push({ from: c.id, to: e.id, kind });
  }
  return { steps, lanes: [...lanes.values()], edges };
}

/** The task's state: the first rule of section 4's table that matches, and the event that set it (focus). */
export async function stateOf(q, task, events) {
  const asked = new Map();
  for (const e of events) {
    if (ASK[e.type]) asked.set(`${ASK[e.type][0]}:${e.data?.[ASK[e.type][1]]}`, e);
    if (ANSWER[e.type]) asked.delete(`${e.type}:${e.data?.[ANSWER[e.type]]}`);
  }
  if (asked.size) return { state: 'needs-you', focus: [...asked.values()][0].id };
  const deliveries = await q('select id, event, state, run, role from deliveries where team = $1 and task = $2', [task.team, task.id]);
  const dead = deliveries.find((d) => d.state === 'dead');
  if (dead) return { state: 'failed', focus: dead.event };
  const ended = events.find((e) => e.type === 'session.ended' && !OK_END.has(e.data?.reason));
  if (ended) return { state: 'failed', focus: ended.id };
  const waiting = deliveries.filter((d) => ['pending', 'held'].includes(d.state));
  if (waiting.length) {
    // Only while the budget still holds the run: a day that has rolled over (or a raised cap) resumed it.
    const [paused] = await q("select id from runs where team = $1 and state = 'paused' and reason = 'budget' limit 1", [task.team]);
    const [ex] = paused ? await q("select id from events where team = $1 and type = 'budget.exhausted' and time >= $2 order by seq desc limit 1", [task.team, task.started_at]) : [];
    if (ex) return { state: 'out-of-budget', focus: ex.id };
  }
  const runs = [...new Set(deliveries.map((d) => d.run).filter(Boolean))];
  if (runs.length && deliveries.some((d) => ['pending', 'held', 'sent'].includes(d.state))) {
    const [stopped] = await q("select id from runs where id = any($1) and state = 'stopped' limit 1", [runs]);
    if (stopped) return { state: 'stopped', focus: null };
  }
  const blocked = [...events].reverse().find((e) => e.type === 'message.blocked');
  if (blocked) {
    const [later] = await q("select 1 from events where team = $1 and task = $2 and seq > $3 and actor_kind = 'role' and actor_id = $4 and type <> 'report.heartbeat' limit 1", [task.team, task.id, blocked.seq, blocked.actor?.id ?? '']);
    if (!later) return { state: 'blocked', focus: blocked.id };
  }
  if (deliveries.some((d) => ['pending', 'held', 'sent'].includes(d.state))) return { state: 'running', focus: null };
  const [live] = await q("select id from sessions where team = $1 and task = $2 and state in ('starting', 'running', 'waiting') limit 1", [task.team, task.id]);
  if (live) return { state: 'running', focus: null };
  return { state: 'done', focus: null };
}

// The event types the state table reads: the list reads only these, so a state costs a few rows, not a whole task.
const STATE_TYPES = ['approval.requested', 'approval.decided', 'decision.requested', 'decision.answered', 'session.ended', 'message.blocked'];
// A timeline shows at most this many events (the newest), and says so.
const TIMELINE_MAX = 5000;

async function taskEvents(q, team, id, { types = null, max = null } = {}) {
  const rows = types
    ? await q('select seq, envelope from events where team = $1 and task = $2 and type = any($3) order by seq', [team, id, types])
    : await q(`select seq, envelope from (select seq, envelope from events where team = $1 and task = $2 order by seq desc${max ? ` limit ${Number(max)}` : ''}) t order by seq`, [team, id]);
  return rows.map((r) => ({ ...r.envelope, seq: Number(r.seq) }));
}

const row = (t, s) => ({ id: t.id, title: t.title, state: s.state, startedBy: t.started_by, roles: t.roles, cost: Number(t.cost), currency: t.currency ?? null, startedAt: new Date(t.started_at).toISOString(), lastAt: new Date(t.last_at).toISOString(), workItem: t.work_item ?? null });

export function createInspector({ db, m3 }) {
  /** GET /teams/{team}/tasks: newest first, at most 50, filtered by state, role, trigger, time and title words. */
  async function list(tenant, team, p = {}) {
    if (p.state && !STATES.includes(p.state)) throw new Problem(400, `state is one of ${STATES.join(', ')}`);
    const limit = Math.min(Math.max(Number(p.limit) || PAGE, 1), PAGE);
    let after = null;
    if (p.cursor) {
      const [at, id] = Buffer.from(String(p.cursor), 'base64url').toString().split('|');
      if (!id || Number.isNaN(new Date(at).getTime())) throw new Problem(400, 'cursor is not one this server gave');
      after = { at: new Date(at).toISOString(), id };
    }
    const since = p.since ? iso(p.since, 'since') : null, until = p.until ? iso(p.until, 'until') : null;
    const filters = (args) => {
      const where = ['team = $1'];
      const arg = (v) => { args.push(v); return `$${args.length}`; };
      if (p.role) where.push(`${arg(String(p.role))} = any(roles)`);
      if (p.trigger) where.push(`started_by->>'kind' = 'trigger' and started_by->>'id' = ${arg(String(p.trigger))}`);
      if (since) where.push(`last_at >= ${arg(since)}::timestamptz`);
      if (until) where.push(`started_at <= ${arg(until)}::timestamptz`);
      if (p.q) where.push(`title ~* ${arg(`(^|\\W)${String(p.q).slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)}`);
      return { where, arg };
    };
    return db.tenant(tenant, async ({ q }) => {
      // The state is computed from the log on read, and kept on the row. A state filter reads on, page by page, until
      // it fills the page or has looked at ten pages; the cursor then says where to go on from.
      const out = [];
      let at = after, more = false;
      for (let round = 0; round < 4; round++) {
        const args = [team];
        const { where, arg } = filters(args);
        if (at) where.push(`(last_at, id) < (${arg(at.at)}::timestamptz, ${arg(at.id)})`);
        const rows = await q(`select * from tasks where ${where.join(' and ')} order by last_at desc, id desc limit ${PAGE + 1}`, args);
        const page = rows.slice(0, PAGE);
        more = rows.length > PAGE;
        for (const [i, t] of page.entries()) {
          at = { at: new Date(t.last_at).toISOString(), id: t.id };
          const s = await stateOf(q, t, await taskEvents(q, team, t.id, { types: STATE_TYPES }));
          if (s.state !== t.state || s.focus !== t.focus) await q('update tasks set state = $2, focus = $3 where id = $1', [t.id, s.state, s.focus]);
          if (!p.state || p.state === s.state) out.push(row(t, s));
          if (out.length >= limit) { more = more || i < page.length - 1; break; }
        }
        if (out.length >= limit || !more) break;
      }
      return { tasks: out, next: more && at ? Buffer.from(`${at.at}|${at.id}`).toString('base64url') : null };
    });
  }

  /** GET /teams/{team}/tasks/{task}: the timeline. Summaries and io ids only, never a body. */
  async function get(tenant, team, id) {
    return db.tenant(tenant, async ({ q }) => {
      const [t] = await q('select * from tasks where team = $1 and id = $2', [team, id]);
      if (!t) throw new Problem(404, `no task ${id} in team ${team}`);
      const s = await stateOf(q, t, await taskEvents(q, team, id, { types: STATE_TYPES }));
      const events = await taskEvents(q, team, id, { max: TIMELINE_MAX + 1 });
      const truncated = events.length > TIMELINE_MAX;
      const { steps, lanes, edges } = fold(truncated ? events.slice(1) : events);
      return { task: row(t, s), lanes, steps, edges, focus: s.focus, ...(truncated ? { truncated: true } : {}) };
    });
  }

  /** GET /teams/{team}/io/{io}, editors: one stored input or output. Every read is audited; a gone row is 410. */
  async function read(tenant, team, io, by) {
    const { result } = await m3.tx(tenant, async (ctx) => {
      const [r] = await ctx.q('select part, mime, body, truncated, bytes, redactions, outside, expires_at from step_io where team = $1 and id = $2', [team, io]);
      if (!r) {
        const [named] = await ctx.q("select time from events where team = $1 and (envelope->'data'->>'io' = $2) limit 1", [team, io]);
        if (named) {
          const [{ io_days: days } = { io_days: 30 }] = await ctx.q('select io_days from budgets where team = $1', [team]);
          const expiredAt = new Date(new Date(named.time).getTime() + days * 86400e3).toISOString();
          throw new Problem(410, 'this step\'s input and output are past the team\'s retention, or were deleted early', { body: { expiredAt } });
        }
        throw new Problem(404, `no step I/O ${io} in team ${team}`);
      }
      await ctx.audit({ team, actorKind: 'person', actorId: by, action: 'inspector.read', target: io, decision: 'read' });
      return { part: r.part, mime: r.mime, body: r.body, truncated: r.truncated, bytes: r.bytes, redactions: r.redactions, outside: r.outside, expiresAt: new Date(r.expires_at).toISOString() };
    });
    return result;
  }

  /** DELETE /teams/{team}/io?before=, admins with step-up: removes stored I/O early (a privacy request). Audited. */
  async function remove(tenant, team, before, by, stepUp) {
    const at = before ? new Date(before) : new Date();
    if (Number.isNaN(at.getTime())) throw new Problem(400, 'before is an ISO date and time');
    // A step-up bound to this one change (ADR 0013), so a token minted for anything else can't delete in bulk.
    const scope = `delete-io:${team}`;
    const { result: stepUpId } = await m3.tx(tenant, async (ctx) => {
      const used = await m3.useStepUp(ctx, by, stepUp, scope);
      if (!used) throw new StepUpRequired('Deleting step inputs and outputs', scope);
      return used;
    });
    // As the owner (the app role can't delete step I/O; only retention and this route do), and the audit row in the
    // same transaction: the rows never go without the record of who took them.
    const deleted = await db.systemTx(async ({ q }) => {
      const gone = await q('delete from step_io where tenant = $1 and team = $2 and created_at < $3 returning id', [tenant, team, at.toISOString()]);
      await q(`insert into audit(tenant, team, actor_kind, actor_id, action, decision, detail) values ($1, $2, 'person', $3, 'step-io.delete', 'deleted', $4)`,
        [tenant, team, by, JSON.stringify({ rows: gone.length, before: at.toISOString(), stepUp: stepUpId })]);
      return gone.length;
    });
    return { deleted };
  }

  return { list, get, read, remove };
}
