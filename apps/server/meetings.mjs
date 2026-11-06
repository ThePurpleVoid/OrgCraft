// Meetings (plans/m3-meetings-seams.md, with the architect's review A1 to A12). No new runner op: the control plane
// drives a meeting through the ordinary deliveries. Two formats: a written round (each attendee answers once) and a
// discussion (phase 4, CPO D23): the attendees answer in turn for up to `rounds` rounds (2 to 5), each turn carrying
// the whole transcript so they answer each other; an attendee that has nothing more to add says so (meeting_reply
// done: true) and gets no later rounds, and when nobody is left the facilitator closes early.
//
//   start   POST /v1/teams/{team}/meetings { meeting: <definition id> } opens an instance (mtg_…) of a definition the
//           run was started with (RunCreate.team.meetings, attendees already resolved by the Studio)
//   turns   one meeting.turn per attendee, in the order sent, carrying the replies so far; the attendee answers with
//           the team tool meeting_reply. A busy attendee is skipped when ifBusy is skip or proxy (meeting.skipped)
//   close   after the last turn, a closing meeting.turn to the facilitator, who calls meeting_close with the minutes:
//           meeting.closed, the minutes in the chat, a report.note on the board, action items as HANDOFFs and
//           decisions as cards (front door) or BLOCKEDs to the front door (anyone else). Nothing is committed.
//   cap     usage.recorded tagged with the meeting counts toward its cap, when the server agrees the session was
//           given a turn of it (A10). At the cap the rest of the round is skipped and the closing turn says capped.
//   time    a turn not answered by its deadline is skipped as missed (the tick); a meeting follows pause and resume,
//           and a stopped run closes it as abandoned.
import { Problem, id, SLUG } from './store.mjs';

export const MEETING_TURN_MINUTES = 30;
const MEETING_ID = /^[a-z0-9][a-z0-9-]*$/;
const IF_BUSY = ['next-pause', 'proxy', 'skip'];
const REPLIES_MAX = 40 * 1024;
const SYSTEM = { kind: 'system', id: 'control-plane', via: 'api' };
const LIVE = ['starting', 'running', 'idle', 'waiting'];

/**
 * RunCreate.team.meetings (A1): each entry as in meetings.json, with `attendees` already resolved to role slugs. Frozen
 * with the run like the roles. Returns the cleaned list. A missing facilitator means the front door (A11).
 */
export function checkMeetingDefs(list, roles, frontDoor) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > 50) throw new Problem(400, 'team.meetings is a list of at most 50 meetings');
  const slugs = new Set(roles.map((r) => r.slug));
  const seen = new Set();
  return list.map((m) => {
    if (!m || typeof m !== 'object' || !MEETING_ID.test(m.id ?? '') || m.id.length > 80) throw new Problem(400, 'every meeting has an id (lowercase letters, digits and dashes)');
    if (seen.has(m.id)) throw new Problem(400, `meeting ${m.id} is listed twice`);
    seen.add(m.id);
    const where = `meeting ${m.id}`;
    if (typeof m.title !== 'string' || !m.title.trim() || m.title.length > 200) throw new Problem(400, `${where}: title is text of at most 200 characters`);
    if (m.agenda !== undefined && (typeof m.agenda !== 'string' || m.agenda.length > 4000)) throw new Problem(400, `${where}: agenda is text of at most 4,000 characters`);
    const facilitator = m.facilitator ?? frontDoor;
    if (!SLUG.test(String(facilitator)) || !slugs.has(facilitator)) throw new Problem(400, `${where}: the facilitator ${facilitator} is not in the team`);
    if (!Array.isArray(m.attendees) || m.attendees.length > 200) throw new Problem(400, `${where}: attendees is the list of role slugs, resolved with meetingAttendees`);
    const attendees = [];
    for (const s of m.attendees) {
      if (typeof s !== 'string' || !slugs.has(s)) throw new Problem(400, `${where}: attendee ${s} is not in the team`);
      if (s !== facilitator && !attendees.includes(s)) attendees.push(s);
    }
    if (m.rule !== undefined && m.rule !== null && m.rule !== 'worked-since-last') throw new Problem(400, `${where}: rule is worked-since-last or nothing`);
    if (m.format !== undefined && !['round', 'discussion'].includes(m.format)) throw new Problem(400, `${where}: format is round or discussion`);
    if (m.format === 'discussion' && m.rounds !== undefined && !(Number.isInteger(m.rounds) && m.rounds >= 2 && m.rounds <= 5)) throw new Problem(400, `${where}: a discussion has 2 to 5 rounds`);
    if (m.ifBusy !== undefined && !IF_BUSY.includes(m.ifBusy)) throw new Problem(400, `${where}: ifBusy is ${IF_BUSY.join(', ')}`);
    if (!(typeof m.capUsd === 'number' && Number.isFinite(m.capUsd) && m.capUsd > 0 && m.capUsd <= 1_000_000)) throw new Problem(400, `${where}: capUsd is above zero`);
    if (!attendees.length && m.rule !== 'worked-since-last') throw new Problem(400, `${where}: has no attendees besides the facilitator`);
    return {
      id: m.id, title: m.title, agenda: m.agenda ?? '', facilitator, attendees, ...(m.rule ? { rule: m.rule } : {}),
      format: m.format ?? 'round', rounds: m.format === 'discussion' ? m.rounds ?? 3 : 1, ifBusy: m.ifBusy ?? 'next-pause', owner: { minutes: m.owner?.minutes !== false, speaks: m.owner?.speaks === true },
      capUsd: m.capUsd,
    };
  });
}

/**
 * An ad hoc meeting (G-15): { title, agenda?, attendees: [slug], cap?: { amount, currency } }. The facilitator is the
 * front door; a busy attendee answers after its current step (next-pause). Returns { input } or { problems }.
 */
export function checkAdhoc(a, roster, facilitator) {
  const problems = [];
  const slugs = new Set((roster?.roles ?? []).map((r) => r.slug));
  if (!a || typeof a !== 'object' || Array.isArray(a)) return { problems: ['send { title, agenda, attendees }'] };
  if (typeof a.title !== 'string' || !a.title.trim() || a.title.length > 200) problems.push('title is text of at most 200 characters');
  if (a.agenda !== undefined && (typeof a.agenda !== 'string' || a.agenda.length > 4000)) problems.push('agenda is text of at most 4,000 characters');
  const attendees = [];
  if (!Array.isArray(a.attendees) || !a.attendees.length || a.attendees.length > 20) problems.push('attendees is a list of 1 to 20 role slugs');
  else for (const s of a.attendees) {
    if (typeof s !== 'string' || !slugs.has(s)) problems.push(`${s} is not a role on this team`);
    else if (s === facilitator) continue;
    else if (!attendees.includes(s)) attendees.push(s);
  }
  if (!problems.length && !attendees.length) problems.push('a meeting needs someone besides the role that runs it');
  let cap;
  if (a.cap !== undefined && a.cap !== null) {
    if (typeof a.cap !== 'object' || !Number.isSafeInteger(a.cap.amount) || a.cap.amount <= 0 || typeof a.cap.currency !== 'string' || !/^[A-Z]{3}$/.test(a.cap.currency)) problems.push('cap is { amount: whole minor units above zero, currency: an ISO 4217 code }, like the budget');
    else cap = { amount: a.cap.amount, currency: a.cap.currency };
  }
  return problems.length ? { problems: [...new Set(problems)] } : { input: { title: a.title, agenda: a.agenda ?? '', attendees, ...(cap ? { cap } : {}), ifBusy: 'next-pause', format: 'round', owner: { minutes: true } } };
}

/** Minor units, rounded up (A2): the cap is never below what the definition says. */
const minor = (usd) => Math.ceil(usd * 100 - 1e-9);

/**
 * The replies a turn carries, under 40 KB (A4). Past it, an attendee's earlier-round replies go first, oldest first,
 * so every voice keeps its latest reply (architect, discussion meetings); only then the oldest of what is left.
 */
export function carried(replies) {
  const out = [...replies];
  let dropped = 0;
  while (out.length && Buffer.byteLength(JSON.stringify(out)) > REPLIES_MAX) {
    const older = out.findIndex((r, i) => out.slice(i + 1).some((x) => x.role === r.role));
    out.splice(older >= 0 ? older : 0, 1);
    dropped++;
  }
  return { replies: out, ...(dropped ? { dropped, note: `${dropped} earlier ${dropped === 1 ? 'reply was' : 'replies were'} left out to keep this turn small` } : {}) };
}

export function createMeetings({ db, m3, publicUrl = '', turnMinutes = MEETING_TURN_MINUTES }) {
  const base = String(publicUrl || '').replace(/\/+$/, '');
  const COLS = 'id, team, run, definition, title, agenda, facilitator, attendees, if_busy, minutes_to_chat, state, outcome, capped, turn, turn_event, turn_due, replies, skipped, minutes, cap, currency, spent, closed_by_session, close_billed, opened_by, opened_at, closed_at, version, adhoc, format, rounds, round, done, timed_out';
  const view = (m) => m && ({
    id: m.id, team: m.team, run: m.run, definition: m.definition, title: m.title, agenda: m.agenda, facilitator: m.facilitator, attendees: m.attendees, ifBusy: m.if_busy,
    state: m.state, outcome: m.outcome, capped: m.capped, turn: m.turn, replies: m.replies, skipped: m.skipped, minutes: m.minutes,
    cap: Number(m.cap), spent: Number(m.spent), currency: m.currency, adhoc: Boolean(m.adhoc), format: m.format, rounds: m.rounds, round: m.round, done: m.done, openedBy: m.opened_by, openedAt: m.opened_at, closedAt: m.closed_at, version: Number(m.version),
  });
  // The attendees asked in the meeting's current round: everyone but those who said they were done in an earlier one.
  const asked = (m) => m.attendees.filter((r) => !m.done.includes(r) || m.replies.some((x) => x.role === r && (x.round ?? 1) === m.round && x.done));
  const place = (m, role) => ({ turn: asked(m).indexOf(role) + 1, of: asked(m).length });
  const opts = (m, more = {}) => ({ subject: `meeting/${m.id}`, run: m.run, actor: SYSTEM, ...more });
  const page = (m) => `${base}/t/${encodeURIComponent(m.team)}/meetings/${m.id}`;

  async function lock(q, mid, team) {
    const [m] = await q(`select ${COLS} from meetings where id = $1 ${team ? 'and team = $2' : ''} for update`, team ? [mid, team] : [mid]);
    return m ?? null;
  }
  async function save(q, m, fields) {
    const keys = Object.keys(fields);
    const set = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const vals = keys.map((k) => (fields[k] !== null && typeof fields[k] === 'object' && !(fields[k] instanceof Date) ? JSON.stringify(fields[k]) : fields[k]));
    const [row] = await q(`update meetings set ${set}, version = version + 1 where id = $1 returning ${COLS}`, [m.id, ...vals]);
    return row;
  }
  const due = (q) => q(`select now() + make_interval(mins => $1) as t`, [turnMinutes]).then((r) => r[0].t);

  /** The meeting definition's cap in the budget's money, after the checks every start makes (A2; CTO, G-15). */
  async function capFor(q, team, now, { usd = null, cap = null } = {}) {
    const [b] = await q('select currency, per_day, meeting_cap from budgets where team = $1', [team]);
    if (b?.per_day === null || b?.per_day === undefined) throw new Problem(409, 'set a daily cap first');
    const currency = b.currency ?? 'USD';
    // The team's meeting cap: the owner's meeting_cap (raising it needs step-up), else a tenth of the daily cap.
    const teamCap = b.meeting_cap !== null && b.meeting_cap !== undefined ? Number(b.meeting_cap) : Math.max(1, Math.floor(Number(b.per_day) / 10));
    let amount;
    if (cap) {
      if (cap.currency !== currency) throw new Problem(409, `the meeting's cap is in ${cap.currency} and this team's budget is in ${currency}`);
      // An ad hoc cap (from chat or the Studio) cannot go around the step-up-protected meeting cap.
      if (cap.amount > teamCap) throw new Problem(409, `the meeting's cap (${cap.amount}) is above the team's meeting cap (${teamCap}); an owner can raise it in Budget`);
      amount = cap.amount;
    } else if (usd !== null) {
      // capUsd is in US dollars; until meetings.json says a currency, a team budgeted in another one cannot convert it.
      if (currency !== 'USD') throw new Problem(409, `meeting caps are in US dollars and this team's budget is in ${currency}; meetings need a USD budget for now`);
      amount = minor(usd);
    } else {
      // No cap given: the team's default meeting cap, else a tenth of the daily cap. Never open-ended.
      amount = teamCap;
    }
    if (amount > Number(b.per_day)) throw new Problem(409, `the meeting's cap (${amount}) is above the team's daily cap (${b.per_day})`);
    const [day] = await q('select spent, raised from budget_days where team = $1 and day = $2::date', [team, now.toISOString().slice(0, 10)]);
    // Meetings still open hold what is left of their caps, so several together cannot overrun today's budget.
    const [held] = await q("select coalesce(sum(greatest(cap - spent, 0)), 0) as held from meetings where team = $1 and state <> 'closed'", [team]);
    const heldNow = Number(held?.held ?? 0);
    const left = Number(b.per_day) + Number(day?.raised ?? 0) - Number(day?.spent ?? 0) - heldNow;
    if (left < amount) throw new Problem(409, `today's budget has ${Math.max(left, 0)} left${heldNow ? ` after ${heldNow} held by open meetings` : ''}, less than the meeting's cap of ${amount}`);
    return { amount, currency };
  }

  async function goingRun(q, team) {
    const [run] = await q("select id, state, roster from runs where team = $1 and state <> 'stopped' order by started_at desc limit 1 for update", [team]);
    if (!run) throw new Problem(409, 'no run is going: start one first');
    if (run.state !== 'running') throw new Problem(409, `the run is ${run.state}; resume it first`);
    return run;
  }

  /** Inserts the instance, says meeting.opened and sends the first turn. `d` is a checked definition. */
  async function open(ctx, team, run, d, { def, attendees, cap, by, actor, adhoc = false }) {
    const mid = id('mtg');
    const definition = def ?? `adhoc-${mid.slice(4)}`;
    const format = d.format === 'discussion' ? 'discussion' : 'round';
    const rounds = format === 'discussion' ? d.rounds ?? 3 : 1;
    const [row] = await ctx.q(`insert into meetings(id, tenant, team, run, definition, title, agenda, facilitator, attendees, if_busy, minutes_to_chat, cap, currency, opened_by, adhoc, format, rounds)
                           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) on conflict (team, definition) where state <> 'closed' do nothing returning ${COLS}`,
      [mid, ctx.tenant, team, run.id, definition, d.title, d.agenda ?? '', d.facilitator, JSON.stringify(attendees), d.ifBusy ?? 'next-pause', d.owner?.minutes !== false, cap.amount, cap.currency, by, adhoc, format, rounds]);
    if (!row) throw new Problem(409, `meeting ${definition} was opened just now`);
    await ctx.emit(team, 'meeting.opened', { meeting: mid, definition, title: d.title, agenda: d.agenda ?? '', facilitator: d.facilitator, attendees, format, rounds, ifBusy: d.ifBusy ?? 'next-pause', cap: cap.amount, currency: cap.currency, by, ...(adhoc ? { adhoc: true } : {}) },
      { ...opts(row), actor });
    await ctx.audit({ team, actorKind: actor.kind, actorId: actor.id, session: actor.session ?? null, action: 'meeting', target: mid, decision: 'allowed', detail: { op: 'start', definition, adhoc } });
    return advance(ctx, row);
  }

  /**
   * POST /v1/teams/{team}/meetings: an instance of a definition of the run that is going (A3), or, with { adhoc },
   * an unscheduled one ({ title, agenda, attendees, cap?: { amount, currency } }, run by the front door; G-15).
   */
  async function start(tenant, team, body, by) {
    const def = body?.meeting;
    if (body?.adhoc === undefined && (typeof def !== 'string' || !MEETING_ID.test(def))) throw new Problem(400, 'send { "meeting": "<the meeting\'s id in meetings.json>" } or { "adhoc": { title, agenda, attendees } }');
    return m3.tx(tenant, async (ctx) => {
      const { q } = ctx;
      if (!(await q('select 1 from teams where id = $1', [team])).length) throw new Problem(404, 'no such team');
      const run = await goingRun(q, team);
      const actor = { kind: 'person', id: by, via: 'studio' };
      if (body.adhoc !== undefined) {
        const a = checkAdhoc(body.adhoc, run.roster, run.roster.frontDoor);
        if (a.problems) throw new Problem(400, a.problems.join(' '));
        const cap = await capFor(q, team, ctx.now, { cap: a.input.cap });
        return view(await open(ctx, team, run, { ...a.input, facilitator: run.roster.frontDoor }, { attendees: a.input.attendees, cap, by, actor, adhoc: true }));
      }
      const d = (run.roster?.meetings ?? []).find((m) => m.id === def);
      if (!d) throw new Problem(404, `the run's team has no meeting ${def}; publish it and start a new run`);
      const [already] = await q("select id from meetings where team = $1 and definition = $2 and state <> 'closed'", [team, def]);
      if (already) throw new Problem(409, `meeting ${def} is already open (${already.id})`);
      const cap = await capFor(q, team, ctx.now, { usd: d.capUsd });
      const attendees = [...d.attendees];
      if (d.rule === 'worked-since-last') {
        // Who reported or sent a message since this meeting last closed (or since the run started).
        const [last] = await q("select max(closed_at) as at from meetings where team = $1 and definition = $2 and state = 'closed'", [team, def]);
        const since = last?.at ?? (await q('select started_at from runs where id = $1', [run.id]))[0].started_at;
        const rows = await q("select distinct actor_id from events where team = $1 and actor_kind = 'role' and (type like 'report.%' or type like 'message.%') and time > $2 order by actor_id", [team, since]);
        const slugs = new Set((run.roster.roles ?? []).map((r) => r.slug));
        for (const r of rows) if (slugs.has(r.actor_id) && r.actor_id !== d.facilitator && !attendees.includes(r.actor_id)) attendees.push(r.actor_id);
      }
      if (!attendees.length) throw new Problem(409, `nobody to meet: no attendee of ${def} has worked since it last met`);
      return view(await open(ctx, team, run, d, { def, attendees, cap, by, actor }));
    });
  }

  /** The front door's meeting_start (G-15): an unscheduled meeting it runs, from a chat request such as "X and Y on Z, now". */
  async function startAdhoc(ctx, sess, i, roster) {
    const run = await goingRun(ctx.q, sess.team);
    if (run.id !== sess.run) return { problems: ['this session is not in the run that is going'] };
    if (sess.role !== roster?.frontDoor) return { problems: ['only the front door starts meetings'] }; // tools.mjs refuses it first; kept here too
    const a = checkAdhoc(i, roster, sess.role);
    if (a.problems) return a;
    let cap;
    try { cap = await capFor(ctx.q, sess.team, ctx.now, { cap: a.input.cap }); } catch (e) { if (e instanceof Problem) return { problems: [e.message] }; throw e; }
    const actor = { kind: 'role', id: sess.role, instance: sess.instance ?? null, session: sess.id, via: 'tool' };
    const m = await open(ctx, sess.team, run, { ...a.input, facilitator: sess.role }, { attendees: a.input.attendees, cap, by: sess.role, actor, adhoc: true });
    return { meeting: m.id, attendees: m.attendees, cap: Number(m.cap), currency: m.currency };
  }

  /**
   * Sends the next turn: to the next attendee who can take it, the first of the next round when a discussion has
   * rounds left and someone still to speak, or the closing turn to the facilitator.
   */
  async function advance(ctx, m) {
    const { q } = ctx;
    for (;;) {
      const left = m.attendees.filter((r) => !m.done.includes(r));
      if (!m.capped && !m.timed_out && m.turn >= m.attendees.length && m.round < m.rounds && left.length) {
        m = await save(q, m, { round: m.round + 1, turn: 0 });
        continue;
      }
      if (m.capped || m.timed_out || m.turn >= m.attendees.length) {
        const of = asked(m).length;
        const ev = await ctx.emit(m.team, 'meeting.turn', {
          meeting: m.id, definition: m.definition, title: m.title, agenda: m.agenda, to: m.facilitator, turn: of + 1, of,
          round: m.round, rounds: m.rounds, closing: true, capped: m.capped, ...(m.timed_out ? { timedOut: true } : {}), ...carried(m.replies), skipped: m.skipped,
        }, opts(m));
        return save(q, m, { state: 'closing', turn_event: ev.id, turn_due: await due(q) });
      }
      const role = m.attendees[m.turn];
      // An attendee that said it has nothing more to add is not asked again (no event: it chose to stop).
      if (m.done.includes(role)) { m = await save(q, m, { turn: m.turn + 1 }); continue; }
      if (m.if_busy !== 'next-pause') {
        const [busy] = await q("select 1 from sessions where run = $1 and role = $2 and state = 'running' limit 1", [m.run, role]);
        if (busy) { m = await skip(ctx, m, role, 'busy'); continue; }
      }
      const ev = await ctx.emit(m.team, 'meeting.turn', {
        meeting: m.id, definition: m.definition, title: m.title, agenda: m.agenda, to: role, ...place(m, role),
        round: m.round, rounds: m.rounds, closing: false, capped: false, ...carried(m.replies),
      }, opts(m));
      return save(q, m, { turn_event: ev.id, turn_due: await due(q) });
    }
  }

  /** meeting.skipped for the attendee whose turn it is; its turn's deliveries still waiting are dropped. */
  async function skip(ctx, m, role, reason) {
    await ctx.emit(m.team, 'meeting.skipped', { meeting: m.id, definition: m.definition, role, reason, turn: place(m, role).turn, round: m.round, ...(reason === 'busy' && m.if_busy === 'proxy' ? { proxy: true } : {}) }, opts(m));
    if (m.turn_event) await ctx.q("update deliveries set state = 'dead' where event = $1 and state in ('pending', 'held')", [m.turn_event]);
    return save(ctx.q, m, { turn: m.turn + 1, skipped: [...m.skipped, { role, reason }] });
  }

  /** meeting_reply and meeting_close, after tools/1 passed (bus.toolCall). { problems } refuses with a 422. */
  async function tool(ctx, sess, name, i, roster) {
    const m = await lock(ctx.q, i.meeting, sess.team);
    if (!m || m.run !== sess.run) return { problems: [`there is no meeting ${i.meeting} in this run`] };
    const actor = { kind: 'role', id: sess.role, instance: sess.instance ?? null, session: sess.id, via: 'tool' };
    if (name === 'meeting_reply') {
      if (m.state !== 'open') return { problems: [`meeting ${m.id} is not taking replies (${m.state === 'closing' ? 'the facilitator is writing the minutes' : 'it is closed'})`] };
      if (m.attendees[m.turn] !== sess.role) return { problems: [`it is not your turn in ${m.id}${m.attendees[m.turn] ? `: it is ${m.attendees[m.turn]}'s` : ''}`] };
      const done = i.done === true && m.format === 'discussion';
      const ev = await ctx.emit(sess.team, 'meeting.replied', { meeting: m.id, definition: m.definition, role: sess.role, turn: place(m, sess.role).turn, round: m.round, text: i.text, ...(done ? { done: true } : {}) }, opts(m, { actor }));
      const next = await save(ctx.q, m, { turn: m.turn + 1, replies: [...m.replies, { role: sess.role, text: i.text, ...(m.format === 'discussion' ? { round: m.round } : {}), ...(done ? { done: true } : {}) }], ...(done ? { done: [...m.done, sess.role] } : {}) });
      await advance(ctx, next);
      return { event: ev.id };
    }
    // meeting_close: the facilitator, on its closing turn.
    if (sess.role !== m.facilitator) return { problems: [`only ${m.facilitator}, who runs ${m.id}, closes it`] };
    if (m.state !== 'closing') return { problems: [m.state === 'closed' ? `meeting ${m.id} is closed` : `meeting ${m.id} is still going: close it on your closing turn`] };
    // Action items stay inside the meeting: only its attendees get one, so a reply cannot steer work to anyone else.
    const outside = [...new Set((i.actionItems ?? []).map((a) => String(a.to ?? '').split('#')[0]).filter((r) => !m.attendees.includes(r)))];
    if (outside.length) return { problems: [`an action item goes to an attendee of ${m.id} (${m.attendees.join(', ')}); ${outside.join(', ')} did not attend`] };
    const outcome = m.capped ? 'capped' : 'completed';
    const closed = await save(ctx.q, m, { state: 'closed', outcome, minutes: i.minutes, closed_by_session: sess.id, closed_at: ctx.now.toISOString(), turn_due: null });
    const ev = await ctx.emit(sess.team, 'meeting.closed', {
      meeting: m.id, definition: m.definition, title: m.title, outcome, minutes: i.minutes, replies: m.replies.length, skipped: m.skipped, rounds: m.round, ...(m.timed_out ? { timedOut: true } : {}),
      spent: Number(m.spent), cap: Number(m.cap), currency: m.currency, actionItems: (i.actionItems ?? []).length, decisions: (i.decisions ?? []).length, url: page(m),
    }, opts(m, { actor }));
    if (closed.minutes_to_chat) {
      const text = `Minutes of ${m.title}${m.capped ? ' (the meeting reached its cost cap, so not everyone spoke)' : ''}:\n\n${i.minutes}`.slice(0, 20_000);
      const chat = await ctx.emit(sess.team, 'chat.message', { from: sess.role, text, meeting: m.id }, { ...opts(m, { actor }), subject: 'chat' });
      await ctx.q('insert into chat_messages(tenant, team, event, from_kind, from_id, text, at) values ($1, $2, $3, $4, $5, $6, $7) on conflict do nothing', [ctx.tenant, sess.team, chat.id, 'role', sess.role, text, chat.time]);
    }
    await ctx.emit(sess.team, 'report.note', { detail: `Minutes: ${m.title} ${page(m)}`, meeting: m.id }, opts(m, { actor }));
    // events.md meeting.minutes: what the email sink sends to people who switched on "Meeting minutes".
    await ctx.emit(sess.team, 'meeting.minutes', {
      meeting: m.title, meetingId: m.id, date: ctx.now.toISOString().slice(0, 10), decisions: (i.decisions ?? []).map((d) => ({ text: d.question })),
      actions: (i.actionItems ?? []).map((a) => ({ to: a.to, task: a.task })), needsYou: (i.decisions ?? []).length,
    }, opts(m, { actor }));
    for (const a of i.actionItems ?? []) {
      await ctx.emit(sess.team, 'message.handoff', { to: a.to, task: a.task, doneWhen: a.doneWhen, changed: `an action item from ${m.title}`, verify: 'the minutes', detail: `From ${m.title}: ${a.task}. Done when: ${a.doneWhen}`, meeting: m.id }, opts(m, { actor }));
    }
    const cards = [];
    for (const d of i.decisions ?? []) {
      if (roster.frontDoor === sess.role) {
        const card = await m3.createCard(ctx, sess.team, {
          kind: 'decision', subject: `decision/${sess.id}`, session: sess.id, run: sess.run, title: d.question, body: `From ${m.title}.`,
          recommendation: { option: d.recommended, ...(d.why ? { why: d.why } : {}) },
          options: d.options.map((o) => ({ id: o.id, label: o.label, consequence: o.consequence, style: o.id === d.recommended ? 'primary' : 'default', stepUp: false })),
          expiresAt: new Date(ctx.now.getTime() + 7 * 86_400_000),
        });
        await ctx.emit(sess.team, 'decision.requested', { question: d.question, options: d.options, recommended: d.recommended, ...(d.why ? { why: d.why } : {}), cardId: card.id, session: sess.id, meeting: m.id }, opts(m, { actor, subject: card.subject }));
        cards.push(card.id);
      } else {
        // A5: only the front door asks the owner; anyone else's decision goes to it as a BLOCKED.
        const rec = d.options.find((o) => o.id === d.recommended);
        await ctx.emit(sess.team, 'message.blocked', {
          to: roster.frontDoor, task: d.question.slice(0, 200), need: `the owner's answer: ${d.question} (${d.options.map((o) => `${o.id}: ${o.label}`).join('; ')})`, needFrom: 'owner',
          meanwhile: `the rest of the minutes of ${m.title} stand`, recommendation: `${d.recommended}${rec ? ` (${rec.label})` : ''}${d.why ? `: ${d.why}` : ''}`, meeting: m.id,
          detail: `From ${m.title}. Need: ${d.question} Recommendation: ${d.recommended}${d.why ? `, ${d.why}` : ''}`.slice(0, 4000),
        }, opts(m, { actor }));
      }
    }
    await ctx.audit({ team: sess.team, actorKind: 'role', actorId: sess.role, session: sess.id, action: 'tool', target: name, decision: 'allowed', rule: 'tools/1', event: ev.id });
    return { event: ev.id, ...(cards.length ? { cards } : {}) };
  }

  /** Run for every stored event (bus.project): cap accounting, and following the run's pause, resume and stop. */
  async function project(ctx, event) {
    if (!event.team) return;
    const { q } = ctx;
    if (event.type === 'usage.recorded' && typeof event.data?.meeting === 'string') return account(ctx, event);
    if (event.type === 'run.resumed' && event.run) {
      await q(`update meetings set turn_due = now() + make_interval(mins => $2) where run = $1 and state <> 'closed'`, [event.run, turnMinutes]);
    } else if (event.type === 'run.stopped' && event.run) {
      for (const r of await q("select id from meetings where run = $1 and state <> 'closed'", [event.run])) {
        const m = await lock(q, r.id);
        await abandon(ctx, m, 'the run was stopped');
      }
    }
  }

  async function abandon(ctx, m, why) {
    await save(ctx.q, m, { state: 'closed', outcome: 'abandoned', closed_at: ctx.now.toISOString(), turn_due: null });
    if (m.turn_event) await ctx.q("update deliveries set state = 'dead' where event = $1 and state in ('pending', 'held')", [m.turn_event]);
    await ctx.emit(m.team, 'meeting.closed', { meeting: m.id, definition: m.definition, title: m.title, outcome: 'abandoned', why, replies: m.replies.length, skipped: m.skipped, spent: Number(m.spent), cap: Number(m.cap), currency: m.currency, url: page(m) }, opts(m));
  }

  /**
   * A10: tagged usage counts toward the meeting only when that meeting is going and this session was given one of its
   * turns (or, once, the facilitator's closing turn just after it closed). Otherwise the tag is ignored; the usage
   * still counts toward the day and the run, which m3 has already done.
   */
  async function account(ctx, event) {
    const { q } = ctx;
    const cost = Number.isSafeInteger(event.data.cost) && event.data.cost > 0 ? event.data.cost : 0;
    const sid = event.actor?.session;
    if (!cost || !sid || event.actor?.kind !== 'role') return;
    const m = await lock(q, event.data.meeting, event.team);
    if (!m || m.run !== event.run) return;
    const [given] = await q("select 1 from deliveries d join events e on e.team = d.team and e.id = d.event where d.session = $1 and d.team = $2 and e.type = 'meeting.turn' and e.envelope->'data'->>'meeting' = $3 limit 1", [sid, m.team, m.id]);
    if (!given) return;
    let bill = m.state !== 'closed';
    if (!bill && m.closed_by_session === sid && !m.close_billed) bill = 'close';
    if (!bill) return;
    let next = await save(q, m, { spent: Number(m.spent) + cost, ...(bill === 'close' ? { close_billed: true } : {}) });
    if (next.state === 'open' && Number(next.spent) >= Number(next.cap)) {
      // The cap: the rest of the round is skipped, later rounds are not held, and the facilitator closes with what it
      // has (partial minutes).
      // One meeting.skipped per attendee still to speak (architect: not one per turn per round), from the round it
      // would have spoken in next.
      if (next.turn_event) await q("update deliveries set state = 'dead' where event = $1 and state in ('pending', 'held')", [next.turn_event]);
      const out = [];
      for (const [i, role] of next.attendees.entries()) {
        if (next.done.includes(role)) continue;
        const fromRound = i >= next.turn ? next.round : next.round + 1;
        if (fromRound > next.rounds) continue;
        await ctx.emit(next.team, 'meeting.skipped', { meeting: next.id, definition: next.definition, role, reason: 'capped', round: fromRound, fromRound, ...(fromRound === next.round ? { turn: place(next, role).turn } : {}) }, opts(next));
        out.push({ role, reason: 'capped' });
      }
      next = await save(q, next, { capped: true, turn: next.attendees.length, skipped: [...next.skipped, ...out] });
      await advance(ctx, next);
    }
  }

  /** The tick's job (A7): a turn past its deadline, in a running run, is skipped as missed; a closing turn abandons. */
  async function tick(tenant) {
    await m3.tx(tenant, async (ctx) => {
      const late = await ctx.q(`select m.id from meetings m join runs r on r.id = m.run where m.state <> 'closed' and r.state = 'running' and m.turn_due is not null and m.turn_due <= now() for update of m skip locked`);
      for (const r of late) {
        const m = await lock(ctx.q, r.id);
        if (m.state === 'closing') {
          await ctx.emit(m.team, 'meeting.skipped', { meeting: m.id, definition: m.definition, role: m.facilitator, reason: 'missed', closing: true }, opts(m));
          await abandon(ctx, m, `${m.facilitator} did not write the minutes in time`);
        } else {
          await advance(ctx, await skip(ctx, m, m.attendees[m.turn], 'missed'));
        }
      }
      // A discussion has an overall deadline: rounds x attendees x the turn deadline, at most four hours. Past it the
      // facilitator gets the closing turn early (timedOut), so a stalled discussion cannot hang for a day.
      const stalled = await ctx.q(`select m.id from meetings m join runs r on r.id = m.run where m.state = 'open' and m.format = 'discussion' and not m.timed_out and r.state = 'running'
                                     and m.opened_at + make_interval(mins => least(m.rounds * jsonb_array_length(m.attendees) * $1, 240)) <= now() for update of m skip locked`, [turnMinutes]);
      for (const r of stalled) {
        const m = await lock(ctx.q, r.id);
        if (m.turn_event) await ctx.q("update deliveries set state = 'dead' where event = $1 and state in ('pending', 'held')", [m.turn_event]);
        await advance(ctx, await save(ctx.q, m, { timed_out: true }));
      }
    });
  }

  /** A meeting.turn was sent to a session: with next-pause its deadline counts from now (A7). */
  async function sent(q, eventId) {
    await q(`update meetings set turn_due = now() + make_interval(mins => $2) where turn_event = $1 and state <> 'closed'`, [eventId, turnMinutes]);
  }

  /** The role instance a turn goes to (A8): its lowest-numbered live instance, otherwise the role itself. */
  async function instanceFor(q, run, role) {
    const [s] = await q("select instance from sessions where run = $1 and role = $2 and state = any($3) order by coalesce(instance, '') limit 1", [run, role, LIVE]);
    return s?.instance ?? null;
  }

  async function get(tenant, team, mid) {
    const [m] = await db.tenant(tenant, ({ q }) => q(`select ${COLS} from meetings where team = $1 and id = $2`, [team, mid]));
    if (!m) throw new Problem(404, 'no such meeting');
    return view(m);
  }

  async function list(tenant, team) {
    if (!(await db.tenant(tenant, ({ q }) => q('select 1 from teams where id = $1', [team]))).length) throw new Problem(404, 'no such team');
    return (await db.tenant(tenant, ({ q }) => q(`select ${COLS} from meetings where team = $1 order by opened_at desc limit 50`, [team]))).map(view);
  }

  return { start, startAdhoc, get, list, tool, project, tick, sent, instanceFor };
}
