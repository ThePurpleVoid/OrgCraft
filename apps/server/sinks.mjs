// The sink worker: forwards each team's events to its sinks, in order, at least once. A sink in kit-report format
// gets report and message events in the kit's report shape (packages/events toKitRow), which is what a board a
// team already runs accepts, so connecting a team to the product never takes its own board away.
import { toKitRow } from '../../packages/events/index.mjs';
import { readSecret } from './store.mjs';
import { deliver, digests } from './email.mjs';
import { deliverSlack } from './slack.mjs';

const BATCH = 50;
const backoff = (failures) => Math.min(5 * 2 ** Math.max(failures - 1, 0), 3600);

/** One pass over every sink that is due. Returns how many events the sinks moved past. */
export async function drain(db, key, { fetch: send = fetch, timeoutMs = 15_000, email = {}, slack = {} } = {}) {
  const due = await db.system(`select id, tenant, team, next_at, 'sinks' as tbl from sinks where next_at <= now()
    union all select id, tenant, team, next_at, 'email_sinks' as tbl from email_sinks where next_at <= now()
    union all select id, tenant, team, next_at, 'slack_sinks' as tbl from slack_sinks where next_at <= now() order by next_at limit 100`);
  let moved = 0;
  for (const s of due) moved += await drainOne(db, key, s, send, timeoutMs, email, slack);
  return moved;
}

const FORMAT = { email_sinks: 'email', slack_sinks: 'slack' };

async function drainOne(db, key, { id, tenant, team, tbl }, send, timeoutMs, email, slack) {
  const table = FORMAT[tbl] ? tbl : 'sinks';
  const [sink] = await db.tenant(tenant, ({ q }) => q(`select *${FORMAT[table] ? `, '${FORMAT[table]}' as format` : ''} from ${table} where id = $1`, [id]));
  if (!sink) return 0;
  const rows = await db.tenant(tenant, ({ q }) => q('select seq, envelope from events where team = $1 and seq > $2 order by seq limit $3', [team, sink.cursor, BATCH]));
  if (!rows.length) return 0;
  if (sink.format === 'email') return settle(db, tenant, sink, ...(await emailRows(db, key, sink, rows, { readSecret, fetch: send, ...email })));
  if (sink.format === 'slack') return settle(db, tenant, sink, ...(await slackRows(db, key, sink, rows, { readSecret, fetch: send, publicUrl: email.publicUrl, ...slack, email })));
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
    error = await deliver(db, key, sink, r, { ...opts, now: typeof opts.now === 'function' ? opts.now() : new Date() });
    if (error) break;
    cursor = Number(r.seq);
    moved++;
  }
  return [cursor, moved, error];
}

/**
 * A Slack sink: each event goes to the linked people and picked channels (slack.mjs deliverSlack). A post that
 * failed for good (a removed channel) is logged and passed; the health line still shows it.
 */
async function slackRows(db, key, sink, rows, opts) {
  let cursor = Number(sink.cursor), moved = 0, error = null, failed = null, posted = 0;
  for (const r of rows) {
    const out = await deliverSlack(db, key, sink, r, { ...opts, now: new Date() });
    posted += out.posted;
    if (out.failed) failed = out.retry ?? 'a Slack post failed; see the delivery log';
    if (out.retry) { error = out.retry; break; }
    cursor = Number(r.seq);
    moved++;
  }
  return [cursor, moved, error, failed, posted];
}

async function settle(db, tenant, sink, cursor, moved, error, failed = null, posted = 0) {
  const table = { email: 'email_sinks', slack: 'slack_sinks' }[sink.format] ?? 'sinks';
  // A Slack sink also keeps the health line (O1): failing from the first failed post until a pass posts with none.
  const health = table !== 'slack_sinks' ? '' : error || failed ? ', failing_since = coalesce(failing_since, now())' : posted ? ', failing_since = null' : '';
  await db.tenant(tenant, ({ q }) => (error
    ? q(`update ${table} set cursor = $2, failures = failures + 1, last_error = $3, next_at = now() + make_interval(secs => $4)${health} where id = $1`, [sink.id, cursor, error, backoff(Number(sink.failures) + 1)])
    : q(`update ${table} set cursor = $2, failures = 0, last_error = $3, next_at = now()${health} where id = $1`, [sink.id, cursor, failed ?? (table === 'slack_sinks' && !posted ? sink.last_error ?? null : null)])));
  return moved;
}

/** Runs drain every `everyMs` until stopped. Wake it early with wake() after an append. */
export function startSinks(db, key, { everyMs = 2000, digestEveryMs = 60_000, ...opts } = {}) {
  let timer = null, running = false, again = false, stopped = false, lastDigest = 0;
  const tick = async () => {
    if (stopped) return;
    if (running) { again = true; return; }
    running = true;
    try { while (!stopped && (await drain(db, key, opts)) > 0); } catch (e) { if (!stopped) console.error(`sinks: ${e.message}`); }
    // L25: the daily digests, at most once a minute (each goes out once per local day).
    if (!stopped && Date.now() - lastDigest >= digestEveryMs) {
      lastDigest = Date.now();
      try { await digests(db, key, { readSecret, fetch: opts.fetch ?? fetch, ...opts.email, now: typeof opts.email?.now === 'function' ? opts.email.now() : new Date() }); } catch (e) { if (!stopped) console.error(`digests: ${e.message}`); }
    }
    running = false;
    if (again) { again = false; setImmediate(tick); }
  };
  timer = setInterval(tick, everyMs);
  timer.unref?.();
  return { wake: () => setImmediate(tick), stop: () => { stopped = true; clearInterval(timer); } };
}
