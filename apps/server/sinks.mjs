// The sink worker: forwards each team's events to its sinks, in order, at least once. A sink in kit-report format
// gets report and message events in the kit's report shape (packages/events toKitRow), which is what a board a
// team already runs accepts, so connecting a team to the product never takes its own board away.
import { toKitRow } from '../../packages/events/index.mjs';
import { readSecret } from './store.mjs';
import { deliver } from './email.mjs';

const BATCH = 50;
const backoff = (failures) => Math.min(5 * 2 ** Math.max(failures - 1, 0), 3600);

/** One pass over every sink that is due. Returns how many events the sinks moved past. */
export async function drain(db, key, { fetch: send = fetch, timeoutMs = 15_000, email = {} } = {}) {
  const due = await db.system(`select id, tenant, team, next_at, false as email from sinks where next_at <= now()
    union all select id, tenant, team, next_at, true as email from email_sinks where next_at <= now() order by next_at limit 100`);
  let moved = 0;
  for (const s of due) moved += await drainOne(db, key, s, send, timeoutMs, email);
  return moved;
}

async function drainOne(db, key, { id, tenant, team, email: isEmail }, send, timeoutMs, email) {
  const [sink] = await db.tenant(tenant, ({ q }) => q(`select *${isEmail ? ", 'email' as format" : ''} from ${isEmail ? 'email_sinks' : 'sinks'} where id = $1`, [id]));
  if (!sink) return 0;
  const rows = await db.tenant(tenant, ({ q }) => q('select seq, envelope from events where team = $1 and seq > $2 order by seq limit $3', [team, sink.cursor, BATCH]));
  if (!rows.length) return 0;
  if (sink.format === 'email') return settle(db, tenant, sink, ...(await emailRows(db, key, sink, rows, { readSecret, fetch: send, ...email })));
  const headers = { 'content-type': 'application/json' };
  if (sink.header && sink.secret) {
    const value = await readSecret(db, key, tenant, sink.secret);
    if (value) headers[sink.header] = value;
  }
  let cursor = Number(sink.cursor), moved = 0, error = null;
  for (const r of rows) {
    const body = sink.format === 'kit-report' ? toKitRow(r.envelope) : r.envelope;
    if (body) {
      try {
        const res = await send(sink.url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
        const text = await res.text().catch(() => '');
        if (res.status >= 300) { error = `HTTP ${res.status}: ${text.slice(0, 200)}`; break; }
      } catch (e) { error = String(e.message ?? e).slice(0, 200); break; }
    }
    cursor = Number(r.seq);
    moved++;
  }
  return settle(db, tenant, sink, cursor, moved, error);
}

/** An email sink: each event goes to the team's opted-in, verified addresses (email.mjs deliver). */
async function emailRows(db, key, sink, rows, opts) {
  let cursor = Number(sink.cursor), moved = 0, error = null;
  for (const r of rows) {
    error = await deliver(db, key, sink, r, { ...opts, now: new Date() });
    if (error) break;
    cursor = Number(r.seq);
    moved++;
  }
  return [cursor, moved, error];
}

async function settle(db, tenant, sink, cursor, moved, error) {
  const table = sink.format === 'email' ? 'email_sinks' : 'sinks';
  await db.tenant(tenant, ({ q }) => (error
    ? q(`update ${table} set cursor = $2, failures = failures + 1, last_error = $3, next_at = now() + make_interval(secs => $4) where id = $1`, [sink.id, cursor, error, backoff(Number(sink.failures) + 1)])
    : q(`update ${table} set cursor = $2, failures = 0, last_error = null, next_at = now() where id = $1`, [sink.id, cursor])));
  return moved;
}

/** Runs drain every `everyMs` until stopped. Wake it early with wake() after an append. */
export function startSinks(db, key, { everyMs = 2000, ...opts } = {}) {
  let timer = null, running = false, again = false, stopped = false;
  const tick = async () => {
    if (stopped) return;
    if (running) { again = true; return; }
    running = true;
    try { while (!stopped && (await drain(db, key, opts)) > 0); } catch (e) { if (!stopped) console.error(`sinks: ${e.message}`); }
    running = false;
    if (again) { again = false; setImmediate(tick); }
  };
  timer = setInterval(tick, everyMs);
  timer.unref?.();
  return { wake: () => setImmediate(tick), stop: () => { stopped = true; clearInterval(timer); } };
}
