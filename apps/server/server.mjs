// The control plane's HTTP API (docs/contracts/api-v1.yaml): teams, report intake in the kit's shape, the event
// log, its live stream, the board, report tokens, sinks and secrets. Dependency-free on top of node:http.
//
// Who can call what:
//   x-team-token: <report token>     POST /v1/teams/{team}/reports only (append, for that one team; reads nothing)
//   Authorization: Bearer <token>    everything else, as a person of the server's tenant. Until sign-in (OIDC)
//                                    lands, that is one admin token per server (AGENT_TEAM_ADMIN_TOKEN).
//   (none, a one-time code)          POST /v1/runners only: a runner redeems a code a person minted for its key.
//
// Every write may carry an Idempotency-Key: the first answer is kept for a day and a retry gets it back verbatim
// (with Idempotent-Replayed: true), so a request sent twice from a bad connection acts once.
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import * as store from './store.mjs';
import { attachRunners } from './runners.mjs';
import { createM3 } from './m3.mjs';

const { Problem } = store;
const REPORTS_PER_MINUTE = 30;

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The JSON body for a Problem: { error }, plus RFC 9457 type, title and status when it has a type, plus any body
 *  it carries (a 409 for a changed card carries the current card itself, as api-v1.yaml says). */
const problemBody = (e) => ({ ...(e.body ?? {}), error: e.message, ...(e.type ? { type: e.type, title: e.message, status: e.status } : {}) });
const MAX_BODY = 2 * 1024 * 1024;

/**
 * Writes a JSON answer. `secrets` names fields shown once (a token, a key, a code): an idempotent write never stores
 * them, and a replay of such a write answers 409 with the other fields instead of showing the secret again.
 */
const send = (res, status, body, headers = {}, { secrets = [] } = {}) => {
  // Inside an idempotent write the answer is held until it is stored, so a retry can never overtake it.
  if (res.hold) { res.answer = { status, body, headers, secrets }; return; }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(JSON.stringify(body));
};

/** The raw body, read once and kept on the request (the idempotency check hashes it before a route parses it). */
function readRaw(req, limit = MAX_BODY) {
  if (req.rawBody) return req.rawBody.length > limit ? Promise.reject(new Problem(413, `at most ${limit} bytes`)) : Promise.resolve(req.rawBody);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Problem(413, `at most ${limit} bytes`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { req.rawBody = Buffer.concat(chunks); resolve(req.rawBody); });
    req.on('error', reject);
  });
}

async function readJson(req, limit) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new Problem(415, 'send JSON (content-type: application/json)');
  const raw = await readRaw(req, limit);
  try { return JSON.parse(raw.toString('utf8') || 'null'); } catch { throw new Problem(400, 'the body is not valid JSON'); }
}

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Live listeners per team, fed by every append on this instance. */
/** Live listeners per team, and for every team ('*', which /me/stream filters by tenant), fed by every append. */
function hub() {
  const subs = new Map();
  return {
    on(team, fn) { if (!subs.has(team)) subs.set(team, new Set()); subs.get(team).add(fn); return () => subs.get(team)?.delete(fn); },
    emit(team, stored) { for (const k of [team, '*']) for (const fn of subs.get(k) ?? []) fn(stored); },
  };
}

/**
 * The API server. `db` from openDb, `key` the vault master key, `tenant` the tenant this server signs people in to,
 * `adminToken` the bearer token for people, `publicUrl` how others reach this server (for report URLs).
 */
export function createControlPlane(opts) {
  const server = createServer();
  // Runners connect here over a WebSocket (runner-protocol.md). The ops they may send are wired in as M3 lands.
  const runners = attachRunners(server, { db: opts.db, ...(opts.runnerOptions ?? {}) });
  const m3 = opts.m3 ?? createM3({ db: opts.db, now: opts.now, publicUrl: opts.publicUrl });
  server.on('request', createHandler({ ...opts, runners, m3 }));
  server.runners = runners;
  server.m3 = m3;
  server.on('close', () => runners.closeAll());
  return server;
}

/**
 * The API as a request handler, `(req, res) => Promise`, for hosts that bring their own HTTP server (serverless
 * functions, a framework). createControlPlane wraps it in node:http. `pollMs`: how often an open stream also reads
 * the log, so it sees events appended by other instances (0 turns that off; one instance needs only the hub).
 */
export function createHandler({ db, key, tenant, adminToken, publicUrl = '', sinks = null, now = () => new Date(), pollMs = 2000, runners = null, stepUpVerifier = null, m3: given = null }) {
  const live = hub();
  const m3 = given ?? createM3({ db, now, publicUrl });
  /** Runs an m3 write and tells the hub and sinks about what it stored. */
  const did = async (p) => { const { result, stored } = await p; const byTeam = new Map(); for (const x of stored) byTeam.set(x.event.team, [...(byTeam.get(x.event.team) ?? []), x]); for (const [tm, xs] of byTeam) appended(tm, xs); return result; };
  const etagged = async (req, res, seq, body, extra = '') => {
    const tag = `W/"${seq}-${Math.floor(now().getTime() / 60_000)}${extra ? `-${Buffer.from(extra).toString('base64url')}` : ''}"`;
    if (req.headers['if-none-match'] === tag) { res.writeHead(304, { etag: tag }); return res.end(); }
    return send(res, 200, body, { etag: tag });
  };
  // A key of its own for request fingerprints, derived from the master key so nothing new needs keeping.
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('createHandler needs the 32-byte master key (vault.mjs masterKey)');
  const idemKey = createHmac('sha256', key).update('agent-team/idempotency/v1').digest();
  const rate = new Map();
  const appended = (team, stored) => { if (stored.length) { live.emit(team, stored); sinks?.wake(); } };

  const person = (req) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    if (!m || !adminToken || !same(m[1], adminToken)) throw new Problem(401, 'sign in: send Authorization: Bearer <token>');
    return tenant;
  };

  // A sliding minute per team and role, so a burst that straddles the turn of a clock minute is still counted.
  const limited = (team, role) => {
    const t = now().getTime();
    const k = `${team}/${role}`;
    const hits = (rate.get(k) ?? []).filter((x) => t - x < 60_000);
    if (hits.length >= REPORTS_PER_MINUTE) { rate.set(k, hits); return true; }
    hits.push(t);
    if (!rate.has(k) && rate.size > 10_000) rate.clear();
    rate.set(k, hits);
    return false;
  };

  /**
   * Server-sent events: catch up from the log after an event id (Last-Event-ID on reconnect, or ?after=), then live.
   * Ids, not positions, so clients never parse. `team` null streams every team of the tenant (/me/stream).
   */
  async function stream(req, res, t, team, url) {
    if (team) await store.getTeam(db, t, team);
    const from = req.headers['last-event-id'] ?? url.searchParams.get('after') ?? '';
    let last = team ? await store.seqOf(db, t, team, from) : await store.tenantSeqOf(db, t, from);
    const type = url.searchParams.get('type') ?? '';
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 3000\n\n');
    const write = ({ seq, event }) => {
      last = seq;
      if (!type || event.type.startsWith(type)) res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    // Every event is sent from the log, in seq order. Appends take a per-tenant lock, so seq is commit order and a
    // read after "seq > last" never skips one that commits late. The in-process hub only says "read now"; the poll
    // covers appends made on other instances.
    let closed = false, reading = false, again = false;
    const pump = async () => {
      if (reading) { again = true; return; }
      reading = true;
      try {
        do {
          again = false;
          for (;;) {
            if (closed) return;
            const page = team
              ? (await store.listEvents(db, t, team, { after: last, limit: 500 })).events
              : await store.tenantEvents(db, t, { after: last, limit: 500 });
            if (closed) return;
            page.forEach(write);
            if (page.length < 500) break;
          }
        } while (again && !closed);
      } catch { /* the next wake or poll retries */ } finally { reading = false; }
    };
    const off = live.on(team ?? '*', (stored) => { if (stored.some((x) => x.event.tenant === t)) pump(); });
    const beat = setInterval(() => res.write(': keep-alive\n\n'), 20_000);
    const poll = pollMs > 0 ? setInterval(pump, pollMs) : null;
    poll?.unref?.();
    res.on('close', () => { closed = true; off(); clearInterval(beat); if (poll) clearInterval(poll); });
    await pump();
  }

  /**
   * Runs a write once per Idempotency-Key. The key is scoped to the tenant and the caller, and bound to the method,
   * path and body: the same key on a different request is a 422, and on one still running a 409.
   */
  async function idempotent(req, res, t, principal, path, fn) {
    const key = req.headers['idempotency-key'];
    if (key === undefined || !WRITES.has(req.method)) return fn();
    const raw = await readRaw(req);
    // Keyed, so the table never holds a plain hash of a body (which could be guessed back for short secret values).
    const hash = createHmac('sha256', idemKey).update(String(req.headers['content-type'] ?? '')).update('\n').update(raw).digest('hex');
    const claim = await store.claimIdempotency(db, t, principal, String(key), { method: req.method, path, hash });
    if (claim.state === 'replay') {
      const { shownOnce, ...rest } = claim.response && typeof claim.response === 'object' ? claim.response : { body: claim.response };
      if (shownOnce) return send(res, 409, { error: `this request already succeeded; its ${shownOnce.join(' and ')} was shown once and is not kept`, ...rest }, { 'idempotent-replayed': 'true' });
      return send(res, claim.status, claim.response, { 'idempotent-replayed': 'true' });
    }
    res.hold = true;
    let answer;
    try {
      await fn();
      answer = res.answer;
    } catch (e) {
      answer = e instanceof Problem ? { status: e.status, body: problemBody(e) } : e?.code === '23505' ? { status: 409, body: { error: 'already exists' } } : undefined;
      if (!answer) { res.hold = false; await store.settleIdempotency(db, t, principal, String(key)); throw e; }
    }
    // A secret is never written to the idempotency table: only the answer without it, marked as shown once.
    let kept = answer?.body;
    if (answer?.secrets?.length && kept && typeof kept === 'object') {
      kept = Object.fromEntries(Object.entries(kept).filter(([k]) => !answer.secrets.includes(k)));
      kept.shownOnce = answer.secrets;
    }
    // "Sign in again" and "slow down" are not answers to the request: a retry after step-up or a pause must run.
    const final = answer && answer.status !== 401 && answer.status !== 429;
    await store.settleIdempotency(db, t, principal, String(key), final ? answer.status : undefined, kept);
    res.hold = false;
    if (answer) send(res, answer.status, answer.body, answer.headers);
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

    // A runner redeems a one-time code for its key. No sign-in: the code is the proof, and it names the tenant.
    if (a === 'runners' && !team && m === 'POST') {
      const body = await readJson(req, 32 * 1024);
      const t = await store.runnerCodeTenant(db, body?.code);
      const principal = `code:${store.codeHash(body?.code)}`;
      if (!t) throw new Problem(401, 'that code is unknown, used or expired; mint a new one in the Studio');
      return idempotent(req, res, t, principal, url.pathname, async () => send(res, 201, await store.registerRunner(db, body ?? {}), {}, { secrets: ['key'] }));
    }

    const t = person(req);
    return idempotent(req, res, t, 'admin', url.pathname, () => personRoute(req, res, t, url, parts));
  }

  async function personRoute(req, res, t, url, parts) {
    const m = req.method;
    const stepUp = req.headers['x-step-up'] ?? null;
    const [, a, team, b, c] = parts;
    if (a === 'me' && team === 'summary' && !b && m === 'GET') {
      const tag = `W/"${(await store.tenantHead(db, t)).seq}-${Math.floor(now().getTime() / 60_000)}"`;
      if (req.headers['if-none-match'] === tag) { res.writeHead(304, { etag: tag }); return res.end(); }
      const { seq, ...body } = await store.summary(db, t, { now: now() });
      const extras = await m3.teamExtras(t);
      for (const x of body.teams) {
        const e = extras[x.team];
        if (!e) continue;
        x.run = e.run;
        x.inbox = e.inbox;
        if (e.capPerDay !== null) x.cost = { today: e.spent ?? x.cost.today, capPerDay: e.capPerDay, currency: e.currency ?? x.cost.currency };
      }
      return send(res, 200, body, { etag: tag });
    }
    if (a === 'me' && team === 'stream' && !b && m === 'GET') return stream(req, res, t, null, url);
    if (a === 'me' && team === 'inbox' && !b && m === 'GET') {
      const q = Object.fromEntries(url.searchParams);
      const { seq, ...body } = await m3.inbox(t, q);
      return etagged(req, res, seq, body, `${q.cursor ?? ''}|${q.limit ?? ''}`);
    }
    if (a === 'auth' && team === 'step-up' && !b && m === 'POST') {
      const body = await readJson(req, 4 * 1024);
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      return send(res, 201, await m3.stepUp(t, 'admin', body?.secret, { verifier: stepUpVerifier, bearer }), {}, { secrets: ['token'] });
    }
    if (a === 'runs' && team && b && !c && m === 'POST') return send(res, 200, await did(m3.controlRun(t, team, b, 'admin', { stepUp })));
    if (a === 'approvals' && team && !b && m === 'POST') return send(res, 200, await did(m3.decideApproval(t, team, await readJson(req, 16 * 1024), 'admin', { stepUp })));
    if (a === 'cards' && team && !b && m === 'GET') return send(res, 200, await m3.getCard(t, team));
    if (a === 'cards' && team && !b && m === 'POST') return send(res, 200, await did(m3.answerCard(t, team, await readJson(req, 16 * 1024), 'admin', { stepUp })));
    if (a === 'runners' && team === 'codes' && !b && m === 'POST') {
      const body = req.headers['content-type'] ? (await readJson(req, 16 * 1024)) ?? {} : {};
      await m3.requireStepUp(t, 'admin', stepUp, 'Adding a runner');
      return send(res, 201, await store.mintRunnerCode(db, t, 'admin', body), {}, { secrets: ['code'] });
    }
    if (a === 'runners' && !team && m === 'GET') return send(res, 200, { runners: await store.listRunners(db, t) });
    if (a === 'runners' && team && team !== 'codes' && !b && m === 'DELETE') { await store.revokeRunner(db, t, team); runners?.close(team); return send(res, 200, { ok: true }); }
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
        const stored = await did(m3.appendEvents(t, team, events));
        const sent = new Set(events.map((e) => e?.id));
        const mine = stored.filter(({ id }) => sent.has(id));
        return send(res, 200, { stored: mine.map(({ id }) => id), duplicates: events.length - mine.length });
      }
      if (b === 'events' && c === 'stream' && m === 'GET') return stream(req, res, t, team, url);
      if (b === 'budget' && !c && m === 'GET') return send(res, 200, await m3.getBudget(t, team));
      if (b === 'budget' && !c && m === 'PUT') return send(res, 200, await did(m3.putBudget(t, team, await readJson(req, 16 * 1024), 'admin', { stepUp })));
      if (b === 'runs' && !c && m === 'GET') return send(res, 200, { runs: await m3.listRuns(t, team) });
      if (b === 'runs' && !c && m === 'POST') return send(res, 201, await did(m3.startRun(t, team, (await readJson(req, 512 * 1024)) ?? {}, 'admin')));
      if (b === 'chat' && !c && m === 'GET') return send(res, 200, await m3.getChat(t, team, Object.fromEntries(url.searchParams)));
      if (b === 'chat' && !c && m === 'POST') {
        const { created, event } = await did(m3.postChat(t, team, await readJson(req, 64 * 1024), 'admin'));
        return send(res, created ? 201 : 200, event);
      }
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
        return send(res, 201, { ...tok, url: `${base.replace(/\/+$/, '')}/v1/teams/${team}/reports` }, {}, { secrets: ['token'] });
      }
      if (b === 'report-tokens' && c && m === 'DELETE') { await store.revokeReportToken(db, t, team, c); return send(res, 200, { ok: true }); }
      if (b === 'sinks' && !c && m === 'GET') return send(res, 200, { sinks: await store.listSinks(db, t, team) });
      if (b === 'sinks' && !c && m === 'POST') { const s = await store.addSink(db, t, team, (await readJson(req, 16 * 1024)) ?? {}); sinks?.wake(); return send(res, 201, s); }
      if (b === 'sinks' && c && m === 'DELETE') { await store.removeSink(db, t, team, c); return send(res, 200, { ok: true }); }
    }
    if (a === 'secrets' && !team && m === 'GET') return send(res, 200, { secrets: await store.listSecrets(db, t) });
    if (a === 'secrets' && team && !b && m === 'PUT') {
      const body = await readJson(req, 64 * 1024);
      await m3.requireStepUp(t, 'admin', stepUp, 'Writing a secret');
      await store.putSecret(db, key, t, team, body?.value);
      return send(res, 200, { ok: true, name: team });
    }
    throw new Problem(404, 'not found');
  }

  return (req, res) => route(req, res).catch((e) => {
    res.hold = false;
    if (res.headersSent) { res.end(); return; }
    if (e instanceof Problem) return send(res, e.status, problemBody(e), e.type ? { 'content-type': 'application/problem+json; charset=utf-8' } : {});
    if (e?.code === '23505') return send(res, 409, { error: 'already exists' });
    console.error(e);
    send(res, 500, { error: 'something went wrong on the server' });
  });
}
