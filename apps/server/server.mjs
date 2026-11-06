// The control plane's HTTP API (docs/contracts/api-v1.yaml): teams, report intake in the kit's shape, the event
// log, its live stream, the board, report tokens, sinks and secrets. Dependency-free on top of node:http.
//
// Who can call what:
//   x-team-token: <report token>     POST /v1/teams/{team}/reports only (append, for that one team; reads nothing)
//   Authorization: Bearer <token>    everything else, as a person of the server's tenant. Until sign-in (OIDC)
//                                    lands, that is one admin token per server (AGENT_TEAM_ADMIN_TOKEN).
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import * as store from './store.mjs';

const { Problem } = store;
const REPORTS_PER_MINUTE = 30;

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(JSON.stringify(body));
};

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return reject(new Problem(415, 'send JSON (content-type: application/json)'));
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Problem(413, `at most ${limit} bytes`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch { reject(new Problem(400, 'the body is not valid JSON')); }
    });
    req.on('error', reject);
  });
}

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Live listeners per team, fed by every append on this instance. */
function hub() {
  const subs = new Map();
  return {
    on(team, fn) { if (!subs.has(team)) subs.set(team, new Set()); subs.get(team).add(fn); return () => subs.get(team)?.delete(fn); },
    emit(team, stored) { for (const fn of subs.get(team) ?? []) fn(stored); },
  };
}

/**
 * The API server. `db` from openDb, `key` the vault master key, `tenant` the tenant this server signs people in to,
 * `adminToken` the bearer token for people, `publicUrl` how others reach this server (for report URLs).
 */
export function createControlPlane({ db, key, tenant, adminToken, publicUrl = '', sinks = null, now = () => new Date() }) {
  const live = hub();
  const rate = new Map();
  const appended = (team, stored) => { if (stored.length) { live.emit(team, stored); sinks?.wake(); } };

  const person = (req) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    if (!m || !adminToken || !same(m[1], adminToken)) throw new Problem(401, 'sign in: send Authorization: Bearer <token>');
    return tenant;
  };

  const limited = (team, role) => {
    const minute = Math.floor(Date.now() / 60_000);
    const k = `${team}/${role}`;
    const r = rate.get(k);
    if (!r || r.minute !== minute) { rate.set(k, { minute, n: 1 }); if (rate.size > 10_000) rate.clear(); return false; }
    return ++r.n > REPORTS_PER_MINUTE;
  };

  async function stream(req, res, t, team, url) {
    await store.getTeam(db, t, team);
    // Resume after an event id (Last-Event-ID on reconnect, or ?after=); ids, not positions, so clients never parse.
    let last = await store.seqOf(db, t, team, req.headers['last-event-id'] ?? url.searchParams.get('after') ?? '');
    const type = url.searchParams.get('type') ?? '';
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 3000\n\n');
    const write = ({ seq, event }) => {
      if (seq <= last) return;
      last = seq;
      if (!type || event.type.startsWith(type)) res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    // Listen first and hold what arrives, then catch up from the log, so nothing falls in between.
    let held = [];
    const off = live.on(team, (stored) => (held ? held.push(...stored) : stored.forEach(write)));
    const beat = setInterval(() => res.write(': keep-alive\n\n'), 20_000);
    res.on('close', () => { off(); clearInterval(beat); });
    for (;;) {
      const page = await store.listEvents(db, t, team, { after: last, limit: 500 });
      page.events.forEach(write);
      if (!page.next) break;
    }
    held.sort((a, b) => a.seq - b.seq).forEach(write);
    held = null;
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.replace(/\/+$/, '').split('/').slice(1).map(decodeURIComponent);
    const m = req.method;
    if (parts[0] !== 'v1') throw new Problem(404, 'not found');
    const [, a, team, b, c] = parts;

    if (a === 'health' && m === 'GET') return send(res, 200, { ok: true, db: db.kind });

    // The kit's reports: the same body and answer as the hosted board, so only TEAM_REPORT_URL changes.
    if (a === 'teams' && b === 'reports' && !c && m === 'POST') {
      const t = await store.authReport(db, team, req.headers['x-team-token']);
      if (!t) throw new Problem(401, 'a valid x-team-token for this team is required');
      const body = await readJson(req, 64 * 1024);
      const role = String(body?.role ?? '').toLowerCase();
      if (limited(team, role)) throw new Problem(429, `more than ${REPORTS_PER_MINUTE} reports a minute from ${role}`);
      const { id, stored } = await store.appendReport(db, t, team, body, now());
      appended(team, stored);
      return send(res, 200, { ok: true, id });
    }

    const t = person(req);
    if (a === 'teams' && !team) {
      if (m === 'GET') return send(res, 200, { teams: await store.listTeams(db, t) });
      if (m === 'POST') return send(res, 201, await store.createTeam(db, t, (await readJson(req, 16 * 1024)) ?? {}));
    }
    if (a === 'teams' && team) {
      if (!b && m === 'GET') return send(res, 200, await store.getTeam(db, t, team));
      if (b === 'events' && !c && m === 'GET') {
        const q = Object.fromEntries(url.searchParams);
        const after = q.cursor ? Number(Buffer.from(q.cursor, 'base64url').toString()) || 0 : await store.seqOf(db, t, team, q.after ?? '');
        const page = await store.listEvents(db, t, team, { ...q, after });
        return send(res, 200, { events: page.events.map((e) => e.event), next: page.next && Buffer.from(page.next).toString('base64url') });
      }
      if (b === 'events' && !c && m === 'POST') {
        const body = await readJson(req, 2 * 1024 * 1024);
        const events = Array.isArray(body?.events) ? body.events : null;
        if (!events || events.length > 500) throw new Problem(400, 'send { events: [...] }, at most 500');
        const stored = await store.append(db, t, team, events);
        appended(team, stored);
        return send(res, 200, { stored: stored.map(({ id }) => id), duplicates: events.length - stored.length });
      }
      if (b === 'events' && c === 'stream' && m === 'GET') return stream(req, res, t, team, url);
      if (b === 'board' && m === 'GET') {
        const days = url.searchParams.get('days') ?? '', role = url.searchParams.get('role') ?? '';
        // The ETag changes with the log and the query; ages and staleness also move with the clock, so it is weak
        // and lasts a minute at most.
        const tag = `W/"${(await store.head(db, t, team)).seq}-${Math.floor(now().getTime() / 60_000)}-${Buffer.from(`${days}|${role}`).toString('base64url')}"`;
        if (req.headers['if-none-match'] === tag) { res.writeHead(304, { etag: tag }); return res.end(); }
        const { seq, ...body } = await store.board(db, t, team, { days, role, now: now() });
        return send(res, 200, body, { etag: tag });
      }
      if (b === 'report-tokens' && !c && m === 'POST') {
        const tok = await store.mintReportToken(db, t, team);
        const base = publicUrl || `http://${req.headers.host}`;
        return send(res, 201, { ...tok, url: `${base.replace(/\/+$/, '')}/v1/teams/${team}/reports` });
      }
      if (b === 'report-tokens' && c && m === 'DELETE') { await store.revokeReportToken(db, t, team, c); return send(res, 200, { ok: true }); }
      if (b === 'sinks' && !c && m === 'GET') return send(res, 200, { sinks: await store.listSinks(db, t, team) });
      if (b === 'sinks' && !c && m === 'POST') { const s = await store.addSink(db, t, team, (await readJson(req, 16 * 1024)) ?? {}); sinks?.wake(); return send(res, 201, s); }
      if (b === 'sinks' && c && m === 'DELETE') { await store.removeSink(db, t, team, c); return send(res, 200, { ok: true }); }
    }
    if (a === 'secrets' && !team && m === 'GET') return send(res, 200, { secrets: await store.listSecrets(db, t) });
    if (a === 'secrets' && team && !b && m === 'PUT') {
      const body = await readJson(req, 64 * 1024);
      await store.putSecret(db, key, t, team, body?.value);
      return send(res, 200, { ok: true, name: team });
    }
    throw new Problem(404, 'not found');
  }

  return createServer((req, res) => {
    route(req, res).catch((e) => {
      if (res.headersSent) { res.end(); return; }
      if (e instanceof Problem) return send(res, e.status, { error: e.message });
      if (e?.code === '23505') return send(res, 409, { error: 'already exists' });
      console.error(e);
      send(res, 500, { error: 'something went wrong on the server' });
    });
  });
}
