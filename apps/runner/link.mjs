// The runner's one outbound connection to the control plane (docs/contracts/runner-protocol.md). Nothing connects
// in to a runner. Frames are JSON { op, id, ref?, body }. Every request op is acknowledged with `ack`, ops are
// idempotent by id, so after a reconnect the runner resends what was not acknowledged and skips what it already saw.
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

/** Ops that are answers or acknowledgements themselves, so they are not acknowledged in turn. */
const NO_ACK = new Set(['ack', 'nack', 'pong', 'welcome']);
/** Ops whose ack carries an answer, so the handler acks once the work is done (frame.reply(body)). */
const LATE_ACK = new Set(['session.checkpoint', 'session.message']);
const SEEN = 2000;

let last = 0;
/** A time-sortable id (ULID-shaped: 10 time characters, 16 random), so the log sorts by when things happened. */
export function ulid(now = Date.now()) {
  const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const t = Math.max(now, last);
  last = t;
  let head = '';
  for (let n = t, i = 0; i < 10; i++, n = Math.floor(n / 32)) head = A[n % 32] + head;
  const r = randomBytes(16);
  let tail = '';
  for (let i = 0; i < 16; i++) tail += A[r[i] % 32];
  return head + tail;
}

// Hosts a runner may reach over plain http: this machine, and the host as Docker Desktop names it (M3 on a Mac).
// Anything else carries the runner key and the session tokens, so it must be https.
const LOCAL_HTTP = new Set(['localhost', '127.0.0.1', '[::1]', 'host.docker.internal']);

/** The control plane's base URL, checked: https anywhere, http only to a local host. Throws with the reason. */
export function checkServer(server) {
  let u;
  try { u = new URL(String(server)); } catch { throw new Error(`"${server}" is not a URL`); }
  if (u.username || u.password) throw new Error('the server URL must not carry a user or password');
  if (u.protocol === 'https:') return u.origin + u.pathname.replace(/\/+$/, '');
  if (u.protocol === 'http:' && LOCAL_HTTP.has(u.hostname)) return u.origin + u.pathname.replace(/\/+$/, '');
  if (u.protocol === 'http:') throw new Error(`refusing plain http to ${u.hostname}: the runner key and session tokens would cross the network unencrypted. Use https, or http only to localhost, 127.0.0.1, ::1 or host.docker.internal`);
  throw new Error(`the server URL must be https (or http to a local host), not ${u.protocol.replace(':', '')}`);
}

/**
 * Connect to `${server}/v1/runners/connect` with the runner key, and keep connected. Emits `frame` for every request
 * op from the control plane (already acknowledged and de-duplicated), `welcome`, `open` and `close`.
 * `send(op, body)` queues a request until it is acknowledged; it resolves with the ack.
 */
export function connect({ server, key, hello, backoff = [500, 1000, 2000, 5000, 15000, 30000], log = () => {} }) {
  const out = new EventEmitter();
  const url = `${checkServer(server).replace(/^http/, 'ws')}/v1/runners/connect`;
  const unacked = new Map(); // id -> { frame, resolve }
  const seen = new Set();
  const answers = new Map(); // late acks already given, for resends
  let ws = null, tries = 0, closed = false, beat = null, missed = 0;

  const write = (frame) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame)); };

  function open() {
    ws = new WebSocket(url, { headers: { authorization: `Bearer ${key}` } });
    ws.on('open', () => {
      tries = 0;
      // hello goes first on every connect, then everything not yet acknowledged, in order.
      write({ op: 'hello', id: ulid(), body: hello() });
      for (const { frame } of unacked.values()) write(frame);
      out.emit('open');
    });
    ws.on('message', (raw) => {
      let f;
      try { f = JSON.parse(String(raw)); } catch { return log('ignored a frame that is not JSON'); }
      if (!f || typeof f.op !== 'string') return;
      if (f.op === 'ack' || f.op === 'nack') {
        const u = unacked.get(f.ref ?? f.body?.ref);
        if (u) { unacked.delete(f.ref ?? f.body?.ref); u.resolve(f.op === 'nack' ? { nack: f.body?.problem ?? 'refused' } : f.body ?? {}); }
        if (f.op === 'nack') log(`the control plane refused a ${u?.frame.op ?? 'frame'}: ${f.body?.problem ?? 'no reason given'}`);
        return;
      }
      if (f.op === 'pong') { missed = 0; return; }
      if (f.op === 'ping') { write({ op: 'pong', id: ulid(), ref: f.id, body: { t: f.body?.t ?? Date.now() } }); return; }
      if (f.op === 'welcome') {
        clearInterval(beat);
        const every = Math.max(1, Number(f.body?.heartbeat) || 20) * 1000;
        beat = setInterval(() => {
          if (++missed > 3) { log('three heartbeats missed; reconnecting'); ws.terminate(); return; }
          write({ op: 'ping', id: ulid(), body: { t: Date.now() } });
        }, every);
        beat.unref?.();
        out.emit('welcome', f.body ?? {});
        return;
      }
      const late = LATE_ACK.has(f.op);
      if (!NO_ACK.has(f.op) && f.id && !late) write({ op: 'ack', id: ulid(), ref: f.id, body: {} });
      if (f.id) {
        if (seen.has(f.id)) { if (late && answers.has(f.id)) write(answers.get(f.id)(ulid())); return; } // a resend after a reconnect: already handled
        seen.add(f.id);
        if (seen.size > SEEN) seen.delete(seen.values().next().value);
      }
      if (late) {
        // The answer is kept, so a resend of the same frame gets the same ack (or nack) again.
        const answer = (frame) => { answers.set(f.id, frame); if (answers.size > 100) answers.delete(answers.keys().next().value); write(frame(ulid())); };
        f.reply = (body = {}) => answer((id) => ({ op: 'ack', id, ref: f.id, body }));
        f.refuse = (problem, error) => answer((id) => ({ op: 'nack', id, ref: f.id, body: { ref: f.id, problem, ...(error ? { error } : {}) } }));
      }
      out.emit('frame', f);
    });
    ws.on('close', (code) => {
      clearInterval(beat);
      missed = 0;
      out.emit('close', code);
      if (closed) return;
      const wait = backoff[Math.min(tries++, backoff.length - 1)];
      log(`disconnected (${code}); reconnecting in ${wait} ms`);
      setTimeout(open, wait).unref?.();
    });
    ws.on('error', (e) => log(`connection error: ${e.message}`));
  }

  out.send = (op, body) => {
    const frame = { op, id: ulid(), body };
    const acked = new Promise((resolve) => unacked.set(frame.id, { frame, resolve }));
    acked.id = frame.id;
    write(frame);
    return acked;
  };
  out.pending = () => unacked.size;
  out.close = () => { closed = true; clearInterval(beat); ws?.close(); };
  open();
  return out;
}
