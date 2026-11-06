// The control plane's data: teams, report tokens, the event log, the board projection, sinks and secrets.
// Everything a tenant owns is read and written inside db.tenant(), so row-level security has the last word.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { summarize, toRow } from '../../tools/board.mjs';
import { checkEvent, fromKitRow, toKitRow } from '../../packages/events/index.mjs';
import { seal, unseal } from './vault.mjs';

export const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const sha = (s) => createHash('sha256').update(s).digest('hex');
export const id = (prefix) => `${prefix}_${randomBytes(9).toString('base64url')}`;
export { sha };

/** An answer to the caller: an HTTP status, a plain sentence, and optionally a problem `type` (RFC 9457) and body. */
export class Problem extends Error {
  constructor(status, message, { type = null, body = null } = {}) { super(message); this.status = status; this.type = type; this.body = body; }
}

export async function ensureTenant(db, tenant, name = tenant) {
  if (!SLUG.test(tenant)) throw new Problem(400, 'a tenant id is lowercase letters, digits and dashes');
  await db.system('insert into tenants(id, name) values ($1, $2) on conflict (id) do nothing', [tenant, name]);
}

export async function createTeam(db, tenant, { id: team, name }) {
  if (!SLUG.test(team ?? '')) throw new Problem(400, 'a team id is lowercase letters, digits and dashes, like coachspotter');
  // Team ids are global (they are in report URLs), so a clash with another tenant's team is checked as the owner.
  const [taken] = await db.system('select tenant from teams where id = $1', [team]);
  if (taken) throw new Problem(409, taken.tenant === tenant ? 'this team already exists' : 'that team id is taken; pick another');
  return db.tenant(tenant, async ({ q }) => (await q('insert into teams(id, tenant, name) values ($1, $2, $3) returning id, name, created_at', [team, tenant, name || team]))[0]);
}

export const listTeams = (db, tenant) => db.tenant(tenant, ({ q }) => q('select id, name, created_at from teams order by id'));

export async function getTeam(db, tenant, team) {
  const [row] = await db.tenant(tenant, ({ q }) => q('select id, name, created_at from teams where id = $1', [team]));
  if (!row) throw new Problem(404, 'no such team');
  return row;
}

/** A new report token. The whole token is returned once; only a hash of its secret part is kept. */
export async function mintReportToken(db, tenant, team) {
  await getTeam(db, tenant, team);
  const tid = id('rt');
  const secret = randomBytes(24).toString('base64url');
  await db.tenant(tenant, ({ q }) => q('insert into report_tokens(id, tenant, team, hash) values ($1, $2, $3, $4)', [tid, tenant, team, sha(secret)]));
  return { id: tid, token: `${tid}.${secret}` };
}

export async function revokeReportToken(db, tenant, team, tid) {
  const rows = await db.tenant(tenant, ({ q }) => q('update report_tokens set revoked_at = now() where id = $1 and team = $2 and revoked_at is null returning id', [tid, team]));
  if (!rows.length) throw new Problem(404, 'no such token');
}

/** The tenant a report token may write for, or null. Looked up as the owner: the tenant is not known yet. */
export async function authReport(db, team, token) {
  const [tid, secret] = String(token ?? '').split('.');
  if (!tid || !secret) return null;
  const [row] = await db.system('select tenant, hash from report_tokens where id = $1 and team = $2 and revoked_at is null', [tid, team]);
  if (!row) return null;
  const a = Buffer.from(row.hash, 'hex'), b = Buffer.from(sha(secret), 'hex');
  return a.length === b.length && timingSafeEqual(a, b) ? row.tenant : null;
}

/** Appends envelopes. Ids already stored are skipped, so a retry is safe. Returns the stored rows' { id, seq }. */
export async function append(db, tenant, team, events, { project = null } = {}) {
  return db.tenant(tenant, async ({ q }) => {
    if (!(await q('select 1 from teams where id = $1', [team])).length) throw new Problem(404, 'no such team');
    return appendIn(q, tenant, team, events, { project });
  });
}

/**
 * Appends envelopes inside a tenant transaction that is already open, so a projection row and the event that
 * explains it commit together (the outbox rule, m3-design section 0). `project(q, stored)` runs for each event
 * newly stored and may return more events to append in the same transaction.
 */
export async function appendIn(q, tenant, team, events, { project = null } = {}) {
  // One appender per tenant at a time, so seq is commit order: a stream reading "seq > last" never skips an event
  // that took a lower seq but committed later.
  await q('select pg_advisory_xact_lock(4849, hashtext($1))', [tenant]);
  const out = [];
  for (const e of events) {
    const problems = checkEvent(e);
    if (problems.length) throw new Problem(400, `event ${e?.id ?? '?'}: ${problems.join('; ')}`);
    if (e.tenant !== tenant || (e.team && e.team !== team) || !e.source.startsWith(`/tenants/${tenant}`)) throw new Problem(400, `event ${e.id} is for another tenant or team`);
    const env = { ...e, team };
    const [row] = await q(
      `insert into events(tenant, team, id, type, version, time, actor_kind, actor_id, envelope)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (team, id) do nothing returning seq`,
      [tenant, team, e.id, e.type, e.version, e.time, e.actor.kind, e.actor.id, JSON.stringify(env)]);
    if (!row) continue;
    const stored = { id: e.id, seq: Number(row.seq), event: env };
    out.push(stored);
    const more = project ? await project(q, stored) : null;
    if (more?.length) out.push(...(await appendIn(q, tenant, team, more, { project })));
  }
  return out;
}

/** One report in the kit's shape, exactly as team-status.sh and report.mjs send it. */
export async function appendReport(db, tenant, team, body, now = new Date()) {
  let row;
  try { row = toRow(body, now); } catch (e) { throw new Problem(400, e.message); }
  const stored = await append(db, tenant, team, [fromKitRow(row, { tenant, team })]);
  return { id: row.id, row, stored };
}

/** The seq of a stored event, for `after=<event id>` and Last-Event-ID. Throws 400 when the id is not in the log. */
export async function seqOf(db, tenant, team, eventId) {
  if (!eventId) return 0;
  const [row] = await db.tenant(tenant, ({ q }) => q('select seq from events where team = $1 and id = $2', [team, String(eventId)]));
  if (!row) throw new Problem(400, `no event ${eventId} in this team's log`);
  return Number(row.seq);
}

/** The newest stored event: { id, seq } (both null for an empty log). For asOf and ETag on projections. */
export async function head(db, tenant, team) {
  const [row] = await db.tenant(tenant, ({ q }) => q('select id, seq from events where team = $1 order by seq desc limit 1', [team]));
  return row ? { id: row.id, seq: Number(row.seq) } : { id: null, seq: 0 };
}

/**
 * The log, oldest first, filtered by a type prefix, an actor id and a time. `after` is a seq here; the API takes an
 * event id (after=) or the opaque `next` cursor it handed out, which clients must not parse.
 */
export async function listEvents(db, tenant, team, { type = '', actor = '', since = '', after = 0, limit = 200 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const rows = await db.tenant(tenant, ({ q }) => q(
    `select seq, envelope from events where team = $1 and seq > $2
       and ($3 = '' or starts_with(type, $3)) and ($4 = '' or actor_id = $4) and ($5 = '' or time >= $5::timestamptz)
     order by seq limit $6`,
    [team, Number(after) || 0, type, actor, since, n]));
  const events = rows.map((r) => ({ seq: Number(r.seq), event: r.envelope }));
  return { events, next: events.length === n ? String(events.at(-1).seq) : null };
}

/** The board (the same shape as tools/board.mjs summarize and the hosted board), projected from the log. */
export async function board(db, tenant, team, { days = 7, role = '', now = new Date() } = {}) {
  await getTeam(db, tenant, team);
  const last = await head(db, tenant, team);
  const rows = await db.tenant(tenant, ({ q }) => q(
    `select envelope from events where team = $1 and (starts_with(type, 'report.') or starts_with(type, 'message.'))
       and time >= $2::timestamptz order by time, seq limit 50000`,
    [team, new Date(now.getTime() - 30 * 86_400_000).toISOString()]));
  return { ...summarize(rows.map((r) => toKitRow(r.envelope)).filter(Boolean), { now, days: Number(days) || 7, role }), asOf: last.id, seq: last.seq };
}

export async function putSecret(db, key, tenant, name, value) {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name ?? '')) throw new Problem(400, 'a secret name is UPPER_SNAKE_CASE');
  if (typeof value !== 'string' || !value) throw new Problem(400, 'a secret needs a value');
  await db.tenant(tenant, ({ q }) => q(
    'insert into secrets(tenant, name, sealed) values ($1, $2, $3) on conflict (tenant, name) do update set sealed = excluded.sealed, updated_at = now()',
    [tenant, name, seal(key, tenant, name, value)]));
}

export const listSecrets = (db, tenant) => db.tenant(tenant, ({ q }) => q('select name, updated_at from secrets order by name'));

export async function readSecret(db, key, tenant, name) {
  const [row] = await db.tenant(tenant, ({ q }) => q('select sealed from secrets where name = $1', [name]));
  return row ? unseal(key, tenant, name, row.sealed) : null;
}

const SINK_COLS = 'id, url, format, header, secret, cursor, failures, next_at, last_error, created_at';

export async function addSink(db, tenant, team, { url, format = 'kit-report', header = '', secret = '', from = 'now' }) {
  await getTeam(db, tenant, team);
  let u;
  try { u = new URL(url); } catch { throw new Problem(400, 'a sink needs a URL'); }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) throw new Problem(400, 'a sink URL must be https (http only to this machine)');
  if (!['kit-report', 'event'].includes(format)) throw new Problem(400, 'format is kit-report or event');
  if (header && !/^[A-Za-z0-9-]{1,64}$/.test(header)) throw new Problem(400, 'header is a header name, like x-team-token');
  if (secret && !/^[A-Z][A-Z0-9_]{0,63}$/.test(secret)) throw new Problem(400, 'secret is the name of a stored secret');
  return db.tenant(tenant, async ({ q }) => {
    // A new sink starts at the end of the log unless asked to replay it from the start.
    const [{ max }] = await q('select coalesce(max(seq), 0) as max from events where team = $1', [team]);
    const cursor = from === 'start' ? 0 : Number(max);
    return (await q(`insert into sinks(id, tenant, team, url, format, header, secret, cursor) values ($1, $2, $3, $4, $5, $6, $7, $8) returning ${SINK_COLS}`,
      [id('sink'), tenant, team, u.toString(), format, header || null, secret || null, cursor]))[0];
  });
}

export const listSinks = (db, tenant, team) => db.tenant(tenant, ({ q }) => q(`select ${SINK_COLS} from sinks where team = $1 order by created_at`, [team]));

export async function removeSink(db, tenant, team, sid) {
  const rows = await db.tenant(tenant, ({ q }) => q('delete from sinks where id = $1 and team = $2 returning id', [sid, team]));
  if (!rows.length) throw new Problem(404, 'no such sink');
}

// ---- Idempotency-Key (api-v1.yaml: every write accepts one; clients.md section 7) ----------------------------------

export const IDEMPOTENCY_TTL_HOURS = 24;
export const IDEMPOTENCY_ABANDON_SECONDS = 60;

/**
 * Claims an idempotency key for one request. Returns { state: 'new' } when this request should run (the key is now
 * held), { state: 'replay', status, response } when an earlier request with the same key and body already answered,
 * and throws 409 while that earlier request is still running, or 422 when the key was used for a different request.
 */
export async function claimIdempotency(db, tenant, principal, key, { method, path, hash }) {
  if (!key || key.length > 255) throw new Problem(400, 'an Idempotency-Key is 1 to 255 characters');
  return db.tenant(tenant, async ({ q }) => {
    // Keys older than the window are forgotten, so the same key may be used again after it.
    // A claim never settled (the server died mid-request) is abandoned after a minute, so retries are not stuck.
    await q(`delete from idempotency_keys where principal = $1 and key = $2
               and (created_at < now() - make_interval(hours => $3) or (status is null and created_at < now() - make_interval(secs => $4)))`,
      [principal, key, IDEMPOTENCY_TTL_HOURS, IDEMPOTENCY_ABANDON_SECONDS]);
    const [mine] = await q(
      `insert into idempotency_keys(tenant, principal, key, method, path, request_hash) values ($1, $2, $3, $4, $5, $6)
       on conflict do nothing returning key`, [tenant, principal, key, method, path, hash]);
    if (mine) return { state: 'new' };
    const [row] = await q('select method, path, request_hash, status, response from idempotency_keys where principal = $1 and key = $2', [principal, key]);
    if (!row) return { state: 'new' };
    if (row.status === null) throw new Problem(409, 'a request with this Idempotency-Key is still in progress; retry shortly');
    if (row.method !== method || row.path !== path || row.request_hash !== hash) throw new Problem(422, 'this Idempotency-Key was already used for a different request');
    return { state: 'replay', status: Number(row.status), response: row.response };
  });
}

/** Stores the answer for a claimed key; a server error releases the key instead, so a retry runs again. */
export async function settleIdempotency(db, tenant, principal, key, status, response) {
  await db.tenant(tenant, ({ q }) => (status >= 500 || status === undefined
    ? q('delete from idempotency_keys where principal = $1 and key = $2 and status is null', [principal, key])
    : q('update idempotency_keys set status = $3, response = $4 where principal = $1 and key = $2', [principal, key, status, JSON.stringify(response ?? null)])));
}

/** Drops keys past the window. Run now and then; claims ignore stale keys anyway. */
export const sweepIdempotency = (db) => db.system(`delete from idempotency_keys where created_at < now() - make_interval(hours => $1)`, [IDEMPOTENCY_TTL_HOURS]);

// ---- Runners (runner-protocol.md, Authentication) ------------------------------------------------------------------

export const RUNNER_CODE_MINUTES = 15;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
/** Codes are typed by people, so they are short, unambiguous and case-insensitive: XXXX-XXXX-XXXX. */
const normCode = (code) => String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** A one-time registration code, shown once. It expires in 15 minutes and works once. */
export async function mintRunnerCode(db, tenant, by, { name = '' } = {}) {
  const raw = Array.from({ length: 12 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
  const code = raw.match(/.{4}/g).join('-');
  const expires = new Date(Date.now() + RUNNER_CODE_MINUTES * 60_000);
  await db.tenant(tenant, ({ q }) => q('insert into runner_codes(hash, tenant, name, created_by, expires_at) values ($1, $2, $3, $4, $5)',
    [sha(normCode(code)), tenant, String(name || '').slice(0, 100) || null, by, expires.toISOString()]));
  return { code, expires: expires.toISOString() };
}

/** The hash a code is kept as. */
export const codeHash = (code) => sha(normCode(code));

/** The tenant a code was minted in, used or not (so a retried registration can be answered), or null. */
export async function runnerCodeTenant(db, code) {
  if (!normCode(code)) return null;
  const [row] = await db.system('select tenant from runner_codes where hash = $1', [codeHash(code)]);
  return row?.tenant ?? null;
}

const RUNNER_COLS = 'id, name, capabilities, version, created_at, last_seen, revoked_at';

/** Redeems a code for a runner key (shown once; only its hash is kept). The code's tenant owns the runner. */
export async function registerRunner(db, { code, name, capabilities = {}, version = null }) {
  if (typeof name !== 'string' || !name.trim() || name.length > 100) throw new Problem(400, 'a runner needs a name of at most 100 characters');
  if (capabilities === null || typeof capabilities !== 'object' || Array.isArray(capabilities)) throw new Problem(400, 'capabilities is an object');
  if (JSON.stringify(capabilities).length > 16 * 1024) throw new Problem(400, 'capabilities is at most 16 KiB');
  const hash = sha(normCode(code));
  const [found] = await db.system('select tenant from runner_codes where hash = $1 and used_at is null and expires_at > now()', [hash]);
  if (!found) throw new Problem(401, 'that code is unknown, used or expired; mint a new one in the Studio');
  const rid = id('rnr');
  const secret = randomBytes(32).toString('base64url');
  const runner = await db.tenant(found.tenant, async ({ q }) => {
    // The update is the lock: of two registrations racing on one code, only one gets the row.
    const [used] = await q('update runner_codes set used_at = now(), runner = $2 where hash = $1 and used_at is null and expires_at > now() returning hash', [hash, rid]);
    if (!used) throw new Problem(401, 'that code is unknown, used or expired; mint a new one in the Studio');
    return (await q(`insert into runners(id, tenant, name, hash, capabilities, version) values ($1, $2, $3, $4, $5, $6) returning ${RUNNER_COLS}`,
      [rid, found.tenant, name.trim(), sha(secret), JSON.stringify(capabilities), version ? String(version).slice(0, 50) : null]))[0];
  });
  return { ...runner, key: `${rid}.${secret}` };
}

/** The runner a runner key belongs to ({ tenant, id }), or null. Revoked runners get null. */
export async function authRunner(db, key) {
  const [rid, secret] = String(key ?? '').split('.');
  if (!rid || !secret) return null;
  const [row] = await db.system('select id, tenant, hash from runners where id = $1 and revoked_at is null', [rid]);
  if (!row) return null;
  const a = Buffer.from(row.hash, 'hex'), b = Buffer.from(sha(secret), 'hex');
  return a.length === b.length && timingSafeEqual(a, b) ? { tenant: row.tenant, id: row.id } : null;
}

export const listRunners = (db, tenant) => db.tenant(tenant, ({ q }) => q(`select ${RUNNER_COLS} from runners order by created_at`));

export async function revokeRunner(db, tenant, rid) {
  const rows = await db.tenant(tenant, ({ q }) => q('update runners set revoked_at = now() where id = $1 and revoked_at is null returning id', [rid]));
  if (!rows.length) throw new Problem(404, 'no such runner');
}

// ---- The person's view across teams (clients.md section 5) ---------------------------------------------------------

/** The newest event across the tenant's teams: { id, seq }, both null/0 for an empty log. asOf for /me projections. */
export async function tenantHead(db, tenant) {
  const [row] = await db.tenant(tenant, ({ q }) => q('select id, seq from events order by seq desc limit 1'));
  return row ? { id: row.id, seq: Number(row.seq) } : { id: null, seq: 0 };
}

/** The seq of an event anywhere in the tenant's log, for /me/stream's Last-Event-ID. 400 when unknown. */
export async function tenantSeqOf(db, tenant, eventId) {
  if (!eventId) return 0;
  const [row] = await db.tenant(tenant, ({ q }) => q('select max(seq) as seq from events where id = $1', [String(eventId)]));
  if (!row?.seq) throw new Problem(400, `no event ${eventId} in your teams' logs`);
  return Number(row.seq);
}

/** The tenant's log after a seq, oldest first, across teams. For /me/stream catch-up. */
export async function tenantEvents(db, tenant, { after = 0, limit = 500 } = {}) {
  const rows = await db.tenant(tenant, ({ q }) => q('select seq, envelope from events where seq > $1 order by seq limit $2', [Number(after) || 0, limit]));
  return rows.map((r) => ({ seq: Number(r.seq), event: r.envelope }));
}

const startOfDay = (now) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();

/**
 * Each team at a glance (api-v1.yaml Summary). Counts are numbers, money is in minor units with its currency.
 * Fields that later M3 tables fill (the live version, the run state, the daily cap, the inbox count) are null or 0
 * until those tables exist; their keys are already here so clients can rely on the shape.
 */
export async function summary(db, tenant, { now = new Date() } = {}) {
  const last = await tenantHead(db, tenant);
  const teams = await listTeams(db, tenant);
  const out = [];
  for (const t of teams) {
    const b = await board(db, tenant, t.id, { days: 1, now });
    const roles = { working: 0, waiting: 0, blocked: 0, idle: 0 };
    for (const r of b.current) {
      // review and done count as idle here: nobody is busy on them right now. The board has the detail.
      const k = r.status in roles ? r.status : r.status === 'review' || r.status === 'done' ? 'idle' : null;
      if (k) roles[k]++;
    }
    const spend = await db.tenant(tenant, ({ q }) => q(
      `select envelope->'data'->>'currency' as currency, coalesce(sum(case when jsonb_typeof(envelope->'data'->'cost') = 'number' then (envelope->'data'->>'cost')::numeric else 0 end), 0) as cost
         from events where team = $1 and type = 'usage.recorded' and time >= $2::timestamptz
        group by 1 order by 2 desc`, [t.id, startOfDay(now)]));
    out.push({
      team: t.id, name: t.name, version: null, run: null, roles,
      cost: { today: Math.round(Number(spend[0]?.cost ?? 0)), capPerDay: null, currency: spend[0]?.currency ?? null },
      inbox: 0,
    });
  }
  return { asOf: last.id, seq: last.seq, teams: out };
}
