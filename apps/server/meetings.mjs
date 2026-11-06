// Meetings in the written-round format (plans/m3-meetings-seams.md, with the architect's review A1 to A12). No new
// runner op: the control plane drives a meeting through the ordinary deliveries.
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
    if (m.ifBusy !== undefined && !IF_BUSY.includes(m.ifBusy)) throw new Problem(400, `${where}: ifBusy is ${IF_BUSY.join(', ')}`);
    if (!(typeof m.capUsd === 'number' && Number.isFinite(m.capUsd) && m.capUsd > 0 && m.capUsd <= 1_000_000)) throw new Problem(400, `${where}: capUsd is above zero`);
    if (!attendees.length && m.rule !== 'worked-since-last') throw new Problem(400, `${where}: has no attendees besides the facilitator`);
    return {
      id: m.id, title: m.title, agenda: m.agenda ?? '', facilitator, attendees, ...(m.rule ? { rule: m.rule } : {}),
      // A discussion runs as a written round for now (CPO D23).
      format: m.format ?? 'round', ifBusy: m.ifBusy ?? 'next-pause', owner: { minutes: m.owner?.minutes !== false, speaks: m.owner?.speaks === true },
      capUsd: m.capUsd,
    };
  });
}

/** Minor units, rounded up (A2): the cap is never below what the definition says. */
const minor = (usd) => Math.ceil(usd * 100 - 1e-9);

/** The replies a turn carries: the oldest dropped first so the list stays under 40 KB (A4). */
function carried(replies) {
  const out = [...replies];
  let dropped = 0;
  while (out.length && Buffer.byteLength(JSON.stringify(out)) > REPLIES_MAX) { out.shift(); dropped++; }
  return { replies: out, ...(dropped ? { dropped, note: `${dropped} earlier ${dropped === 1 ? 'reply was' : 'replies were'} left out to keep this turn small` } : {}) };
}

export function createMeetings({ db, m3, publicUrl = '', turnMinutes = MEETING_TURN_MINUTES }) {
  const base = String(publicUrl || '').replace(/\/+$/, '');
  const COLS = 'id, team, run, definition, title, agenda, facilitator, attendees, if_busy, minutes_to_chat, state, outcome, capped, turn, turn_event, turn_due, replies, skipped, minutes, cap, currency, spent, closed_by_session, close_billed, opened_by, opened_at, closed_at, version';
  const view = (m) => m && ({
    id: m.id, team: m.team, run: m.run, definition: m.definition, title: m.title, agenda: m.agenda, facilitator: m.facilitator, attendees: m.attendees, ifBusy: m.if_busy,
    state: m.state, outcome: m.outcome, capped: m.capped, turn: m.turn, replies: m.replies, skipped: m.skipped, minutes: m.minutes,
    cap: Number(m.cap), spent: Number(m.spent), currency: m.currency, openedBy: m.opened_by, openedAt: m.opened_at, closedAt: m.closed_at, version: Number(m.version),
  });
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

  /** POST /v1/teams/{team}/meetings: an instance of a definition of the run that is going (A3). */
  async function start(tenant, team, body, by) {
    const def = body?.meeting;
    if (typeof def !== 'string' || !MEETING_ID.test(def)) throw new Problem(400, 'send { "meeting": "<the meeting\'s id in meetings.json>" }');
    return m3.tx(tenant, async (ctx) => {
      const { q } = ctx;
      if (!(await q('select 1 from teams where id = $1', [team])).length) throw new Problem(404, 'no such team');
      const [run] = await q("select id, state, roster from runs where team = $1 and state <> 'stopped' order by started_at desc limit 1 for update", [team]);
      if (!run) throw new Problem(409, 'no run is going: start one first');
      if (run.state !== 'running') throw new Problem(409, `the run is ${run.state}; resume it first`);
      const d = (run.roster?.meetings ?? []).find((m) => m.id === def);
      if (!d) throw new Problem(404, `the run's team has no meeting ${def}; publish it and start a new run`);
      const [open] = await q("select id from meetings where team = $1 and definition = $2 and state <> 'closed'", [team, def]);
      if (open) throw new Problem(409, `meeting ${def} is already open (${open.id})`);
      const cap = minor(d.capUsd);
      const [b] = await q('select currency, per_day from budgets where team = $1', [team]);
      if (b?.per_day === null || b?.per_day === undefined) throw new Problem(409, 'set a daily cap first');
      if (cap > Number(b.per_day)) throw new Problem(409, `the meeting's cap (${cap}) is above the team's daily cap (${b.per_day})`);
      const [day] = await q('select spent, raised from budget_days where team = $1 and day = $2::date', [team, ctx.now.toISOString().slice(0, 10)]);
      const left = Number(b.per_day) + Number(day?.raised ?? 0) - Number(day?.spent ?? 0);
      if (left < cap) throw new Problem(409, `today's budget has ${Math.max(left, 0)} left, less than the meeting's cap of ${cap}`);
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
      const mid = id('mtg');
      const [row] = await q(`insert into meetings(id, tenant, team, run, definition, title, agenda, facilitator, attendees, if_busy, minutes_to_chat, cap, currency, opened_by)
                             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) on conflict (team, definition) where state <> 'closed' do nothing returning ${COLS}`,
        [mid, tenant, team, run.id, def, d.title, d.agenda, d.facilitator, JSON.stringify(attendees), d.ifBusy, d.owner?.minutes !== false, cap, b.currency ?? 'USD', by]);
      if (!row) throw new Problem(409, `meeting ${def} was opened just now`);
      await ctx.emit(team, 'meeting.opened', { meeting: mid, definition: def, title: d.title, agenda: d.agenda, facilitator: d.facilitator, attendees, format: d.format, ifBusy: d.ifBusy, cap, currency: b.currency ?? 'USD', by },
        { ...opts(row), actor: { kind: 'person', id: by, via: 'studio' } });
      await ctx.audit({ team, actorKind: 'person', actorId: by, action: 'meeting', target: mid, decision: 'allowed', detail: { op: 'start', definition: def } });
      const m = await advance(ctx, row);
      return view(m);
    });
  }

  /** Sends the next turn: to the next attendee who can take it, or the closing turn to the facilitator. */
  async function advance(ctx, m) {
    const { q } = ctx;
    for (;;) {
      if (m.capped || m.turn >= m.attendees.length) {
        const ev = await ctx.emit(m.team, 'meeting.turn', {
          meeting: m.id, definition: m.definition, title: m.title, agenda: m.agenda, to: m.facilitator, turn: m.attendees.length + 1, of: m.attendees.length,
          closing: true, capped: m.capped, ...carried(m.replies), skipped: m.skipped,
        }, opts(m));
        return save(q, m, { state: 'closing', turn_event: ev.id, turn_due: await due(q) });
      }
      const role = m.attendees[m.turn];
      if (m.if_busy !== 'next-pause') {
        const [busy] = await q("select 1 from sessions where run = $1 and role = $2 and state = 'running' limit 1", [m.run, role]);
        if (busy) { m = await skip(ctx, m, role, 'busy'); continue; }
      }
      const ev = await ctx.emit(m.team, 'meeting.turn', {
        meeting: m.id, definition: m.definition, title: m.title, agenda: m.agenda, to: role, turn: m.turn + 1, of: m.attendees.length,
        closing: false, capped: false, ...carried(m.replies),
      }, opts(m));
      return save(q, m, { turn_event: ev.id, turn_due: await due(q) });
    }
  }

  /** meeting.skipped for the attendee whose turn it is; its turn's deliveries still waiting are dropped. */
  async function skip(ctx, m, role, reason) {
    await ctx.emit(m.team, 'meeting.skipped', { meeting: m.id, definition: m.definition, role, reason, turn: m.turn + 1, ...(reason === 'busy' && m.if_busy === 'proxy' ? { proxy: true } : {}) }, opts(m));
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
      const ev = await ctx.emit(sess.team, 'meeting.replied', { meeting: m.id, definition: m.definition, role: sess.role, turn: m.turn + 1, text: i.text }, opts(m, { actor }));
      const next = await save(ctx.q, m, { turn: m.turn + 1, replies: [...m.replies, { role: sess.role, text: i.text }] });
      await advance(ctx, next);
      return { event: ev.id };
    }
    // meeting_close: the facilitator, on its closing turn.
    if (sess.role !== m.facilitator) return { problems: [`only ${m.facilitator}, who runs ${m.id}, closes it`] };
    if (m.state !== 'closing') return { problems: [m.state === 'closed' ? `meeting ${m.id} is closed` : `meeting ${m.id} is still going: close it on your closing turn`] };
    const outcome = m.capped ? 'capped' : 'completed';
    const closed = await save(ctx.q, m, { state: 'closed', outcome, minutes: i.minutes, closed_by_session: sess.id, closed_at: ctx.now.toISOString(), turn_due: null });
    const ev = await ctx.emit(sess.team, 'meeting.closed', {
      meeting: m.id, definition: m.definition, title: m.title, outcome, minutes: i.minutes, replies: m.replies.length, skipped: m.skipped,
      spent: Number(m.spent), cap: Number(m.cap), currency: m.currency, actionItems: (i.actionItems ?? []).length, decisions: (i.decisions ?? []).length, url: page(m),
    }, opts(m, { actor }));
    if (closed.minutes_to_chat) {
      const text = `Minutes of ${m.title}${m.capped ? ' (the meeting reached its cost cap, so not everyone spoke)' : ''}:\n\n${i.minutes}`.slice(0, 20_000);
      const chat = await ctx.emit(sess.team, 'chat.message', { from: sess.role, text, meeting: m.id }, { ...opts(m, { actor }), subject: 'chat' });
      await ctx.q('insert into chat_messages(tenant, team, event, from_kind, from_id, text, at) values ($1, $2, $3, $4, $5, $6, $7) on conflict do nothing', [ctx.tenant, sess.team, chat.id, 'role', sess.role, text, chat.time]);
    }
    await ctx.emit(sess.team, 'report.note', { detail: `Minutes: ${m.title} ${page(m)}`, meeting: m.id }, opts(m, { actor }));
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
      // The cap: the rest of the round is skipped, and the facilitator closes with what it has (partial minutes).
      next = await save(q, next, { capped: true });
      while (next.turn < next.attendees.length) next = await skip(ctx, next, next.attendees[next.turn], 'capped');
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

  return { start, get, list, tool, project, tick, sent, instanceFor };
}
