// The control plane's data: teams, report tokens, the event log, the board projection, sinks and secrets.
// Everything a tenant owns is read and written inside db.tenant(), so row-level security has the last word.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { summarize, toRow } from '../../tools/board.mjs';
import { checkEvent, fromKitRow, toKitRow } from '../../packages/events/index.mjs';
import { seal, unseal } from './vault.mjs';

export const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const sha = (s) => createHash('sha256').update(s).digest('hex');
const id = (prefix) => `${prefix}_${randomBytes(9).toString('base64url')}`;

export class Problem extends Error {
  constructor(status, message) { super(message); this.status = status; }
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
export async function append(db, tenant, team, events) {
  const out = [];
  await db.tenant(tenant, async ({ q }) => {
    if (!(await q('select 1 from teams where id = $1', [team])).length) throw new Problem(404, 'no such team');
    for (const e of events) {
      const problems = checkEvent(e);
      if (problems.length) throw new Problem(400, `event ${e?.id ?? '?'}: ${problems.join('; ')}`);
      if (e.tenant !== tenant || (e.team && e.team !== team) || !e.source.startsWith(`/tenants/${tenant}`)) throw new Problem(400, `event ${e.id} is for another tenant or team`);
      const env = { ...e, team };
      const [row] = await q(
        `insert into events(tenant, team, id, type, version, time, actor_kind, actor_id, envelope)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (team, id) do nothing returning seq`,
        [tenant, team, e.id, e.type, e.version, e.time, e.actor.kind, e.actor.id, JSON.stringify(env)]);
      if (row) out.push({ id: e.id, seq: Number(row.seq), event: env });
    }
  });
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
