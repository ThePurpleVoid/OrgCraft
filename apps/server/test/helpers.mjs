// Shared by the control plane's tests: a fresh database (PGlite in memory, or a real Postgres when
// TEST_DATABASE_URL is set, whose public schema is wiped per test) and a running server to call.
import { randomBytes } from 'node:crypto';
import { openDb } from '../db.mjs';
import { masterKey } from '../vault.mjs';
import * as store from '../store.mjs';
import { createControlPlane } from '../server.mjs';
import { hashStepUpSecret, stepUpVerifier } from '../m3.mjs';

export const key = masterKey(randomBytes(32).toString('base64'));
export const ADMIN = 'adm_test';
export const STEP_UP_SECRET = 'a long step-up secret';
export const verifier = stepUpVerifier(await hashStepUpSecret(STEP_UP_SECRET));

export async function fresh() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return openDb();
  const { default: pg } = await import('pg');
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query('drop schema public cascade; create schema public');
  await c.end();
  return openDb({ url });
}

export async function plane(fn, { now, ...extra } = {}) {
  const db = await fresh();
  await store.ensureTenant(db, 'acme');
  let woke = 0;
  const server = createControlPlane({ db, key, tenant: 'acme', adminToken: ADMIN, sinks: { wake: () => woke++ }, stepUpVerifier: verifier, ...(now ? { now } : {}), ...extra });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const call = async (method, path, body, headers = { authorization: `Bearer ${ADMIN}` }) => {
    const res = await fetch(base + path, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  };
  /** Headers with a fresh single-use step-up token, for writes that need one. */
  const su = async () => ({ authorization: `Bearer ${ADMIN}`, 'x-step-up': (await call('POST', '/auth/step-up', { secret: STEP_UP_SECRET })).body.token });
  try { await fn({ db, call, base, server, m3: server.m3, su, woke: () => woke }); } finally { server.runners?.closeAll(); server.closeAllConnections(); server.close(); await db.close(); }
}

/** Reads a server-sent event stream: until(n) resolves once n events with ids have arrived. */
export async function sse(url, headers) {
  const ctl = new AbortController();
  const res = await fetch(url, { headers, signal: ctl.signal });
  const reader = res.body.getReader();
  const got = [];
  let buf = '';
  const dec = new TextDecoder();
  return {
    res,
    async until(n, ms = 10_000) {
      const deadline = Date.now() + ms;
      while (got.length < n) {
        const left = deadline - Date.now();
        let timer;
        const { value, done } = await Promise.race([reader.read(), new Promise((_, j) => { timer = setTimeout(() => j(new Error(`only ${got.length} of ${n} events in ${ms} ms: ${got.map((g) => g.id).join(', ')}`)), Math.max(left, 0)); })]).finally(() => clearTimeout(timer));
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const id = /^id: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (id && data) got.push({ id, event: JSON.parse(data) });
        }
      }
      return got;
    },
    close: () => ctl.abort(),
  };
}

/** A minimal valid envelope for team `team` of tenant `tenant`. */
export const envelope = (tenant, team, id, type, data = {}, extra = {}) => ({
  specversion: '1.0', id, type, version: 1, source: `/tenants/${tenant}/teams/${team}`, tenant, team,
  time: new Date().toISOString(), actor: { kind: 'runner', id: 'rnr_test' }, data, ...extra,
});

/** Registers a runner through the API (code minted with step-up) and returns { id, key }. */
export async function registerRunner(call, name = 'r1') {
  const token = (await call('POST', '/auth/step-up', { secret: STEP_UP_SECRET })).body.token;
  const { code } = (await call('POST', '/runners/codes', undefined, { authorization: `Bearer ${ADMIN}`, 'x-step-up': token })).body;
  return (await call('POST', '/runners', { code, name })).body;
}

/**
 * A fake runner on the WebSocket: says hello, answers pings, acks what the control plane sends (`reply` picks the ack
 * body per frame, or null to stay silent), and can wait for a frame.
 */
export async function fakeRunner(base, key, { runner, maxSessions = 4, reply = () => ({}) } = {}) {
  const { default: WebSocket } = await import('ws');
  const ws = new WebSocket(base.replace(/^http/, 'ws') + '/runners/connect', { headers: { authorization: `Bearer ${key}` } });
  const frames = [];
  const waiters = [];
  let n = 0;
  const raw = (f) => ws.send(JSON.stringify(f));
  ws.on('message', (d) => {
    const f = JSON.parse(String(d));
    frames.push(f);
    if (f.op === 'ping') raw({ op: 'pong', id: `p${n++}`, ref: f.id, body: { t: f.body.t } });
    else if (!['ack', 'nack', 'welcome'].includes(f.op)) {
      const body = reply(f);
      if (body !== null) raw({ op: 'ack', id: `a${n++}`, ref: f.id, body });
    }
    for (const w of [...waiters]) if (w.match(f)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(f); }
  });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  const next = (match, ms = 5000) => new Promise((resolve, reject) => {
    const hit = frames.find(match);
    if (hit) return resolve(hit);
    const t = setTimeout(() => reject(new Error(`no such frame in time; got ${frames.map((f) => f.op).join(', ')}`)), ms);
    waiters.push({ match, resolve: (f) => { clearTimeout(t); resolve(f); } });
  });
  /** Sends a request and resolves with the ack or nack that refs it. */
  const request = async (op, body) => { const id = `q${n++}`; raw({ op, id, body }); return next((f) => f.ref === id && (f.op === 'ack' || f.op === 'nack')); };
  raw({ op: 'hello', id: 'hello', body: { runner, version: 'test', capabilities: { runtimes: ['agent-sdk'], maxSessions } } });
  const welcome = await next((f) => f.op === 'welcome');
  return { ws, frames, next, request, welcome, close: () => ws.close() };
}
