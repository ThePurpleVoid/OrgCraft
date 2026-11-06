// The sink worker: forwards each team's events to its sinks, in order, at least once. A sink in kit-report format
// gets report and message events in the kit's report shape (packages/events toKitRow), which is what a board a
// team already runs accepts, so connecting a team to the product never takes its own board away.
import { toKitRow } from '../../packages/events/index.mjs';
import { readSecret } from './store.mjs';

const BATCH = 50;
const backoff = (failures) => Math.min(5 * 2 ** Math.max(failures - 1, 0), 3600);

/** One pass over every sink that is due. Returns how many events the sinks moved past. */
export async function drain(db, key, { fetch: send = fetch, timeoutMs = 15_000 } = {}) {
  const due = await db.system('select id, tenant, team from sinks where next_at <= now() order by next_at limit 100');
  let moved = 0;
  for (const s of due) moved += await drainOne(db, key, s, send, timeoutMs);
  return moved;
}

async function drainOne(db, key, { id, tenant, team }, send, timeoutMs) {
  const [sink] = await db.tenant(tenant, ({ q }) => q('select * from sinks where id = $1', [id]));
  if (!sink) return 0;
  const rows = await db.tenant(tenant, ({ q }) => q('select seq, envelope from events where team = $1 and seq > $2 order by seq limit $3', [team, sink.cursor, BATCH]));
  if (!rows.length) return 0;
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
  await db.tenant(tenant, ({ q }) => (error
    ? q("update sinks set cursor = $2, failures = failures + 1, last_error = $3, next_at = now() + make_interval(secs => $4) where id = $1", [id, cursor, error, backoff(Number(sink.failures) + 1)])
    : q('update sinks set cursor = $2, failures = 0, last_error = null, next_at = now() where id = $1', [id, cursor])));
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
