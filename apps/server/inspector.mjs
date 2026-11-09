// The run inspector's server half, storage and attribution (N1, ADR 0009, local PR L19s-a;
// plans/n8n/n1-run-inspector-architecture.md sections 1 to 3 and 5).
//
// - attribute(): every event gets the `task` and `cause` the server decides, never the sender's. A root wake (a
//   person's chat, a meeting opening) starts a task; a session's events take the task and cause of the delivery that
//   woke it; a runner's `cause` hint is kept only when that event really was delivered to that session.
// - projectTask(): the `tasks` row, a projection of the log.
// - ingestStepIo(): a runner's `step.io` frame, redacted again with patterns, capped per session per day, stored
//   outside the log with an expiry.
// - checkIoRefs(): an event may name only its own session's step I/O; `session.result.outside` marks the row.
// - purgeIo(): the tick's retention job, as the owner, with one audit row per batch.
import { randomBytes } from 'node:crypto';

export const IO_MAX = 64 * 1024;
export const IO_DAY_CAP = 50 * 1024 * 1024;
// The original size a runner reports for a cut body is clamped to the column (int).
const INT_MAX = 2 ** 31 - 1;
export const PURGE_BATCH = 1000;
const IO_ID = /^io_[0-9A-HJKMNP-TV-Z]{26}$/;
const MIME = /^[a-z]+\/[a-z0-9.+-]{1,80}$/;

/** A task id, tsk_<26 base32 characters>: time first, so ids sort by when they started. */
export function taskId(now = Date.now()) {
  const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let t = '', n = now;
  for (let i = 0; i < 10; i++) { t = A[n % 32] + t; n = Math.floor(n / 32); }
  const r = randomBytes(16);
  let s = '';
  for (let i = 0; i < 16; i++) s += A[r[i] % 32];
  return `tsk_${t}${s}`;
}

/** Credential shapes the server finds on its own (it can't know their vault names): each becomes `[secret]`. */
const PATTERNS = [
  /\brnr_[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{32,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b[rs]k_live_[A-Za-z0-9]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bst_ses_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{20,}/g,
];
export function redactPatterns(text) {
  let out = String(text ?? ''), hit = false;
  for (const re of PATTERNS) out = out.replace(re, () => { hit = true; return '[secret]'; });
  return { text: out, hit };
}

const ROOT = (e) => (e.type === 'chat.message' && e.actor?.kind === 'person') || e.type === 'meeting.opened';
const ANSWER_OF = { 'approval.decided': ['approval.requested', 'approval'], 'decision.answered': ['decision.requested', 'cardId'] };

/**
 * Sets `env.task` and `env.cause` as the server decides (in place), before the event is stored. A sender's own
 * values are dropped; a runner's `cause` is kept only for an event delivered to that session.
 *
 * `outside`: the event came through the API or a report token, so its actor and data are the sender's words. It gets
 * no task: a session it names (actor.session or data.session) is never looked up. Only the runner path, which sets
 * actor.session from the session it runs, and the server's own writes name a session that is trusted.
 */
export async function attribute(q, env, { outside = false } = {}) {
  const hint = typeof env.cause === 'string' && env.cause.length <= 80 ? env.cause : null;
  delete env.task;
  delete env.cause;
  if (!env.team || outside) return;
  const set = (task, cause) => { if (task) env.task = task; if (cause) env.cause = cause; };
  if (ROOT(env)) return set(taskId(Date.parse(env.time) || Date.now()), null);
  const sid = env.actor?.kind === 'role' ? env.actor.session : null;
  if (sid) {
    // The team too: a session id named by another team's event (a report token can name any) gives nothing.
    const [s] = await q('select task, cause from sessions where id = $1 and team = $2', [sid, env.team]);
    let task = s?.task ?? null, cause = s?.cause ?? null;
    if (hint && hint !== cause) {
      const [d] = await q('select task from deliveries where team = $1 and session = $2 and event = $3 limit 1', [env.team, sid, hint]);
      if (d) { cause = hint; task = d.task ?? task; }
    }
    return set(task, cause);
  }
  // An answer stays in the task of the session that asked, and its cause is the request (the branch graph's merge).
  const answer = ANSWER_OF[env.type];
  if (answer && typeof env.data?.[answer[1]] === 'string') {
    const [r] = await q(`select id, task from events where team = $1 and type = $2 and envelope->'data'->>'${answer[1]}' = $3 order by seq desc limit 1`, [env.team, answer[0], env.data[answer[1]]]);
    if (r) return set(r.task, r.id);
  }
  // A meeting's own events stay in the meeting's task.
  if (/^meeting\./.test(env.type) && typeof env.data?.meeting === 'string') {
    const [m] = await q("select id, task from events where team = $1 and type = 'meeting.opened' and envelope->'data'->>'meeting' = $2 limit 1", [env.team, env.data.meeting]);
    if (m) return set(m.task, m.id);
  }
  // Written by the server for a session (a card it asked for, an approval): that session's task.
  const forSession = env.actor?.session ?? env.data?.session;
  if (typeof forSession === 'string') {
    const [s] = await q('select task, cause from sessions where id = $1 and team = $2', [forSession, env.team]);
    if (s) set(s.task, s.cause);
  }
}

const startedBy = (e) => (e.type === 'meeting.opened'
  ? { kind: 'meeting', id: e.data?.meeting ?? null, label: `Meeting: ${String(e.data?.title ?? '').slice(0, 100)}` }
  : { kind: 'chat', id: e.actor?.id ?? null, label: e.actor?.kind === 'person' ? 'Owner in chat' : 'Chat' });
const firstLine = (s, n = 120) => String(s ?? '').split('\n').find((l) => l.trim())?.trim().slice(0, n) ?? '';

/** The tasks row for one stored event (a projection: rebuilding it from the log gives the same rows). */
export async function projectTask(q, tenant, event) {
  if (!event.task || !event.team) return;
  if (ROOT(event)) {
    const title = event.type === 'meeting.opened' ? firstLine(event.data?.title) : firstLine(event.data?.text);
    await q(`insert into tasks(id, tenant, team, run, root_event, started_by, title, started_at, last_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $8)
             on conflict (id) do nothing`, [event.task, tenant, event.team, event.run ?? null, event.id, JSON.stringify(startedBy(event)), title || 'Untitled', event.time]);
    return;
  }
  const role = event.actor?.kind === 'role' ? event.actor.id : null;
  const cost = event.type === 'usage.recorded' && Number.isSafeInteger(event.data?.cost) && event.data.cost > 0 ? event.data.cost : 0;
  const title = event.type === 'report.status' ? firstLine(event.data?.task) : '';
  const work = event.type === 'report.status' && Number.isSafeInteger(event.data?.issue) ? `issue/${event.data.issue}` : null;
  await q(`update tasks set last_at = greatest(last_at, $2::timestamptz),
             roles = case when $3::text is null or $3 = any(roles) then roles else roles || $3::text end,
             cost = cost + $4, currency = coalesce(currency, $5),
             title = case when $6 <> '' then $6 else title end,
             work_item = coalesce(work_item, $7)
           where id = $1 and team = $8`, [event.task, event.time, role, cost, cost ? String(event.data.currency ?? 'USD') : null, title, work, event.team]);
}

/**
 * A runner's step.io frame for session `sess` (the runner's own, checked by the caller). Returns { kept } and stores
 * the row unless the session is past its daily cap. Throws a problem (message) for a malformed frame or an id that
 * is another session's.
 */
export async function ingestStepIo(q, tenant, sess, b, { now = new Date(), problem = (m) => new Error(m) } = {}) {
  if (typeof b.id !== 'string' || !IO_ID.test(b.id)) throw problem('id is io_ and a ULID');
  if (!['input', 'output'].includes(b.part)) throw problem('part is input or output');
  if (typeof b.body !== 'string') throw problem('body is text');
  if (Buffer.byteLength(b.body, 'utf8') > IO_MAX) throw problem(`body is at most ${IO_MAX} bytes after redaction; cut it and say truncated`);
  const mime = typeof b.mime === 'string' && MIME.test(b.mime) ? b.mime : 'text/plain';
  const names = Array.isArray(b.redactions) ? b.redactions.filter((x) => typeof x === 'string' && x.length <= 64).slice(0, 50) : [];
  const [seen] = await q('select session from step_io where id = $1', [b.id]);
  if (seen) { if (seen.session !== sess.id) throw problem(`${b.id} belongs to another session`); return { kept: true }; }
  const { text, hit } = redactPatterns(b.body);
  const bytes = Buffer.byteLength(text, 'utf8');
  const day = now.toISOString().slice(0, 10);
  const [used] = await q(`insert into step_io_days(tenant, session, day, bytes) values ($1, $2, $3::date, $4)
                          on conflict (session, day) do update set bytes = step_io_days.bytes + excluded.bytes
                          where step_io_days.bytes + excluded.bytes <= $5 returning bytes`, [tenant, sess.id, day, bytes, IO_DAY_CAP]);
  if (!used || Number(used.bytes) > IO_DAY_CAP) return { kept: false, reason: 'daily-limit' };
  const [{ io_days: days } = { io_days: 30 }] = await q('select io_days from budgets where team = $1', [sess.team]);
  const expires = new Date(now.getTime() + Number(days ?? 30) * 86_400_000);
  // An id another tenant already used is invisible here (RLS) and the insert does nothing: refuse it, so the runner
  // never hears kept for a row that is not this session's.
  const [put] = await q(`insert into step_io(id, tenant, team, session, task, part, mime, body, bytes, truncated, redactions, expires_at)
           values ($1, $2, $3, $4, (select task from sessions where id = $4 and team = $3), $5, $6, $7, $8, $9, $10, $11) on conflict (id) do nothing returning id`,
    [b.id, tenant, sess.team, sess.id, b.part, mime, text, Number.isSafeInteger(b.bytes) && b.bytes >= bytes ? Math.min(b.bytes, INT_MAX) : bytes, b.truncated === true,
      hit ? [...new Set([...names, 'secret'])] : names, expires.toISOString()]);
  if (!put) throw problem(`${b.id} is taken; send a new id`);
  return { kept: true };
}

/**
 * An event from session `sid` may name only that session's step I/O: an `io` that is another session's, or that was
 * never stored (capture off, the daily limit), is taken off. `session.result` with `outside` marks its output row.
 */
export async function checkIoRefs(q, sid, env) {
  const io = env.data?.io;
  if (io === undefined) return;
  const [row] = typeof io === 'string' ? await q('select session from step_io where id = $1', [io]) : [];
  if (!row || row.session !== sid) { const { io: _, ...rest } = env.data; env.data = { ...rest, ioNotKept: true }; return; }
  if (env.type === 'session.result' && env.data.outside === true) await q('update step_io set outside = true where id = $1 and session = $2', [io, sid]);
}

/**
 * Retention (the tick, as the owner): rows past their expiry, or older than the team's io_days now (shortening
 * applies to stored rows), go for real, in batches, with one audit row per tenant and batch. Returns the count.
 */
export async function purgeIo(db, { batch = PURGE_BATCH } = {}) {
  let total = 0;
  for (;;) {
    const gone = await db.system(`delete from step_io where id in (
        select s.id from step_io s left join budgets b on b.team = s.team
        where s.expires_at <= now() or s.created_at <= now() - make_interval(days => coalesce(b.io_days, 30))
        limit $1 for update of s skip locked)
      returning tenant, team`, [batch]);
    if (!gone.length) break;
    total += gone.length;
    const by = new Map();
    for (const g of gone) by.set(`${g.tenant}\n${g.team}`, (by.get(`${g.tenant}\n${g.team}`) ?? 0) + 1);
    for (const [k, n] of by) {
      const [tenant, team] = k.split('\n');
      await db.system(`insert into audit(tenant, team, actor_kind, actor_id, action, decision, detail) values ($1, $2, 'system', 'control-plane', 'step-io.purge', 'deleted', $3)`,
        [tenant, team, JSON.stringify({ rows: n })]);
    }
    if (gone.length < batch) break;
  }
  await db.system("delete from step_io_days where day < (now() - interval '2 days')::date");
  return total;
}
