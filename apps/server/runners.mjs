// The runner side of runner/1 (docs/contracts/runner-protocol.md): runners connect outbound to
// wss://<control plane>/v1/runners/connect with their runner key, say hello, and then trade JSON frames
// { op, id, ref?, body }. This module owns the transport: the upgrade and its auth, hello and welcome, acks and
// nacks, idempotency by frame id, heartbeats, and what happens when a runner goes quiet or is revoked. What each op
// does is handed to `ops`, so the bus, approvals and the tool server plug in without touching the transport.
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import * as store from './store.mjs';

export const PROTOCOL = 'runner/1';
const PATH = '/v1/runners/connect';
const MAX_FRAME = 1024 * 1024;
const SEEN = 1000;

const frameId = () => `f_${randomBytes(9).toString('base64url')}`;

/**
 * Attaches the runner endpoint to an HTTP server and returns the registry of live runners.
 *
 *   ops:        { [op]: async (conn, body, frame) => ackBody }  requests a runner may send after hello. Throw a
 *               store.Problem to nack it. Anything not listed is nacked as not supported here.
 *   welcome:    async (conn) => extra welcome body fields (sessions to resume, once sessions exist)
 *   onLost:     async (conn, why) => void, when a runner misses three beats or drops (sessions -> unknown)
 *   heartbeat:  seconds between pings (welcome tells the runner); three missed beats and the runner is lost
 */
export function attachRunners(server, { db, ops = {}, welcome = async () => ({}), onLost = async () => {}, heartbeat = 20, helloMs = 10_000, log = console } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
  const live = new Map(); // runner id -> conn

  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.replace(/\/+$/, '') !== PATH) return; // not ours: leave it for anyone else listening
    const deny = (status, text) => { socket.end(`HTTP/1.1 ${status} ${text}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`); };
    try {
      const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
      const who = m ? await store.authRunner(db, m[1]) : null;
      if (!who) return deny(401, 'Unauthorized');
      wss.handleUpgrade(req, socket, head, (ws) => accept(ws, who));
    } catch (e) {
      log.error?.(`runners: upgrade failed: ${e.message}`);
      deny(500, 'Internal Server Error');
    }
  });

  function accept(ws, { tenant, id: runner }) {
    const conn = {
      tenant, runner, ws, hello: null, seen: new Map(), chain: Promise.resolve(), pending: new Map(), lastHeard: Date.now(), closed: false,
      /** Sends a frame. A request (anything but ack, nack, pong) resolves with the runner's ack body. */
      send(op, body = {}, { ref, timeoutMs = 30_000 } = {}) {
        const id = frameId();
        const frame = { op, id, ...(ref ? { ref } : {}), body };
        if (ws.readyState !== ws.OPEN) return Promise.reject(new Error('runner is not connected'));
        ws.send(JSON.stringify(frame));
        if (['ack', 'nack', 'pong', 'ping', 'welcome'].includes(op)) return Promise.resolve(null);
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { conn.pending.delete(id); reject(new Error(`no ack for ${op} within ${timeoutMs} ms`)); }, timeoutMs);
          timer.unref?.();
          conn.pending.set(id, { resolve, reject, timer });
        });
      },
    };
    // One connection per runner: a reconnect replaces the old socket.
    const old = live.get(runner);
    if (old) { old.replaced = true; old.ws.close(4000, 'replaced by a new connection'); }
    live.set(runner, conn);

    const ack = (ref, body = {}) => conn.send('ack', body, { ref });
    const nack = (ref, problem) => conn.send('nack', { ref, problem }, { ref });
    const helloTimer = setTimeout(() => { if (!conn.hello) ws.close(4001, 'say hello first'); }, helloMs);
    helloTimer.unref?.();

    // Ping every beat; a runner that has said nothing for three beats is lost.
    const beat = setInterval(() => {
      if (Date.now() - conn.lastHeard > 3 * heartbeat * 1000) { lost('missed three heartbeats'); ws.terminate(); return; }
      if (ws.readyState === ws.OPEN) conn.send('ping', { t: Date.now() });
    }, heartbeat * 1000);
    beat.unref?.();

    let lostOnce = false;
    const lost = (why) => {
      if (lostOnce) return;
      lostOnce = true;
      Promise.resolve(onLost(conn, why)).catch((e) => log.error?.(`runners: onLost: ${e.message}`));
    };

    ws.on('message', async (data, binary) => {
      conn.lastHeard = Date.now();
      let f;
      try { f = JSON.parse(binary ? data.toString('utf8') : String(data)); } catch { return nack(null, 'a frame is JSON'); }
      if (!f || typeof f !== 'object' || typeof f.op !== 'string' || typeof f.id !== 'string' || !f.id || f.id.length > 100) return nack(f?.id ?? null, 'a frame is { op, id, ref?, body }');
      const body = f.body ?? {};
      if (typeof body !== 'object' || Array.isArray(body)) return nack(f.id, 'body is an object');

      // Answers to frames we sent.
      if (f.op === 'ack' || f.op === 'nack') {
        const p = conn.pending.get(f.ref);
        if (p) { clearTimeout(p.timer); conn.pending.delete(f.ref); f.op === 'ack' ? p.resolve(body) : p.reject(Object.assign(new Error(body.problem ?? 'refused'), { nack: body })); }
        return;
      }
      if (f.op === 'pong') { touch(); return; }
      if (f.op === 'ping') return conn.send('pong', { t: body.t ?? null }, { ref: f.id });

      // Requests are idempotent by id: a resent frame gets the same answer and is not run twice.
      if (conn.seen.has(f.id)) {
        const prior = await conn.seen.get(f.id);
        return prior.ok ? ack(f.id, prior.body) : nack(f.id, prior.problem);
      }
      // Requests run one at a time per connection, in the order they arrived, so a runner's frames (session.started,
      // then a heartbeat, then idle) reach the log in the order it sent them. Pings, pongs, acks and nacks above
      // are answered at once and never wait behind a request.
      const run = conn.chain.then(async () => {
        try {
          if (f.op === 'hello') return { ok: true, body: await onHello(body) };
          if (!conn.hello) return { ok: false, problem: 'say hello first' };
          const fn = ops[f.op];
          if (!fn) return { ok: false, problem: `${f.op} is not supported by this control plane` };
          return { ok: true, body: (await fn(conn, body, f)) ?? {} };
        } catch (e) {
          if (e instanceof store.Problem) return { ok: false, problem: e.message };
          log.error?.(`runners: ${f.op}: ${e.message}`);
          return { ok: false, problem: 'something went wrong on the control plane; resend later' };
        }
      });
      conn.chain = run;
      conn.seen.set(f.id, run);
      if (conn.seen.size > SEEN) conn.seen.delete(conn.seen.keys().next().value);
      const out = await run;
      if (f.op === 'hello' && out.ok) return; // answered with welcome, which refs the hello
      return out.ok ? ack(f.id, out.body) : nack(f.id, out.problem);

      async function onHello(b) {
        conn.hello = { version: typeof b.version === 'string' ? b.version.slice(0, 50) : null, capabilities: b.capabilities && typeof b.capabilities === 'object' && !Array.isArray(b.capabilities) ? b.capabilities : {} };
        clearTimeout(helloTimer);
        await db.tenant(conn.tenant, ({ q }) => q('update runners set last_seen = now(), version = coalesce($2, version), capabilities = $3 where id = $1',
          [conn.runner, conn.hello.version, JSON.stringify(conn.hello.capabilities).length <= 16 * 1024 ? JSON.stringify(conn.hello.capabilities) : '{}']));
        const extra = (await welcome(conn)) ?? {};
        conn.send('welcome', { protocol: PROTOCOL, heartbeat, sessions: [], ...extra }, { ref: f.id });
        return {};
      }
    });

    let touchedAt = 0;
    function touch() {
      if (Date.now() - touchedAt < 60_000) return;
      touchedAt = Date.now();
      // Also how a revoke made on another instance reaches this socket, within a minute.
      db.tenant(conn.tenant, ({ q }) => q('update runners set last_seen = now() where id = $1 and revoked_at is null returning id', [conn.runner]))
        .then((rows) => { if (!rows.length) ws.close(4003, 'revoked'); }).catch(() => {});
    }

    ws.on('close', () => {
      conn.closed = true;
      clearInterval(beat); clearTimeout(helloTimer);
      for (const p of conn.pending.values()) { clearTimeout(p.timer); p.reject(new Error('runner disconnected')); }
      conn.pending.clear();
      if (live.get(runner) === conn) live.delete(runner);
      if (!conn.replaced) lost('disconnected');
    });
    ws.on('error', () => {});
  }

  return {
    /** Live, greeted runners of a tenant. */
    connected: (tenant) => [...live.values()].filter((c) => c.tenant === tenant && c.hello && !c.closed),
    get: (runner) => live.get(runner) ?? null,
    /** Every live connection on this instance, for the tick's revoke sweep. */
    all: () => [...live.values()].filter((c) => !c.closed),
    /** Ends a runner's connection, for example when its key is revoked. */
    close(runner, why = 'revoked') { const c = live.get(runner); if (c) c.ws.close(4003, why); },
    closeAll() { for (const c of live.values()) c.ws.terminate(); wss.close(); },
  };
}
