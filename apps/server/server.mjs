// The control plane's HTTP API (docs/contracts/api-v1.yaml): teams, report intake in the kit's shape, the event
// log, its live stream, the board, report tokens, sinks and secrets. Dependency-free on top of node:http.
//
// Who can call what:
//   x-team-token: <report token>     POST /v1/teams/{team}/reports only (append, for that one team; reads nothing)
//   Authorization: Bearer <token>    everything else, as a person of the server's tenant. Until sign-in (OIDC)
//                                    lands, that is one admin token per server (AGENT_TEAM_ADMIN_TOKEN).
//   cookie __Host-agent-team         a signed-in person (identity.mjs, hosted only): the same routes, as that person,
//                                    in the server's tenant if they are a member there. Unsafe methods need this
//                                    deployment's Origin and content-type: application/json (CSRF), and, until roles
//                                    land on every route (M4 order 2), the owner role.
//   (none, a one-time code)          POST /v1/runners only: a runner redeems a code a person minted for its key.
//
// Every write may carry an Idempotency-Key: the first answer is kept for a day and a retry gets it back verbatim
// (with Idempotent-Replayed: true), so a request sent twice from a bad connection acts once.
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import * as store from './store.mjs';
import { attachRunners } from './runners.mjs';
import { createM3 } from './m3.mjs';
import { createBus } from './bus.mjs';
import { createInspector } from './inspector-api.mjs';
import { createTriggers } from './triggers.mjs';
import { createVault, probeThrough } from './credentials.mjs';
import { createLive } from './live.mjs';
import { createCaps } from './caps.mjs';
import { createLedger } from './ledger.mjs';
import { createGateway } from './gateway.mjs';
import { createPasskeys } from './passkeys.mjs';
import { createRecovery } from './recovery.mjs';
import { createMembers } from './members.mjs';
import { atLeast, minRole } from './roles.mjs';
import { appCaller } from './dpop.mjs';
import { HOST_ID } from './hosts.mjs';
import { HOST_CARD_KINDS, hostMay } from './roles.mjs';
import { PROVIDERS, createEmail, createNotifications, page } from './email.mjs';
import { PROVIDERS as SLACK_PROVIDERS, createSlack } from './slack.mjs';
import { createHostedStudio } from './studio.mjs';
import { pgObjects, pgRefs } from './managed-db.mjs';
import { createChanges } from './changes.mjs';
import { CHECK_SECONDS, SERVER_VERSION, createReachability, deploymentView, describeRunner } from './deployment.mjs';

/**
 * The event types POST /v1/teams/{team}/events takes (issue #135): the kit's own reports and messages (report.mjs,
 * packages/events), usage that a subagents or agent-teams integration reports, and the Studio's fast-path
 * team.published (it collapses with the CI's report by id).
 */
/** B8: the words for a hosted budget in another currency (CPO; the Studio's key is budget.usd.only, strings-now.md §6e). */
export const USD_ONLY = 'Budgets are in US dollars for now. Enter the amount in USD. Other currencies are coming, and nothing is converted until then.';

export const POSTABLE_EVENTS = Object.freeze({ prefixes: ['report.', 'message.'], types: ['usage.recorded', 'team.published'] });
export const postable = (type) => POSTABLE_EVENTS.types.includes(type) || POSTABLE_EVENTS.prefixes.some((pre) => type.startsWith(pre) && type.length > pre.length);

/** The bus hears every stored event (deliveries) and run and approval changes (stops, results). */
function wireBus(m3, bus) {
  m3.hooks.project = bus.project;
  m3.hooks.runChanged = bus.runChanged;
  m3.hooks.approvalDecided = bus.approvalDecided;
  m3.hooks.memberChanged = bus.memberChanged;
}

const { Problem } = store;
const REPORTS_PER_MINUTE = 30;

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const NOTICE_ACTIONS = ['passkey.added', 'passkey.removed', 'passkey.sign-count-flagged', 'step-up.locked', 'sessions.ended', 'member.role-changed', 'member.removed', 'recovery-owner.added', 'recovery-owner.removed'];

/** The JSON body for a Problem: { error }, plus RFC 9457 type, title and status when it has a type, plus any body
 *  it carries (a 409 for a changed card carries the current card itself, as api-v1.yaml says). */
const problemBody = (e) => ({ ...(e.body ?? {}), error: e.message, ...(e.type ? { type: e.type, title: e.message, status: e.status } : {}) });
const PROBLEM_JSON = { 'content-type': 'application/problem+json; charset=utf-8' };
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

const readText = async (req, limit) => (await readRaw(req, limit)).toString('utf8');

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
  const m3 = opts.m3 ?? createM3({ db: opts.db, now: opts.now, publicUrl: opts.publicUrl });
  // The outbound governor and effect idempotency (L20g): shared by the bus (runner ops) and the code-host fetch.
  const gateway = opts.gateway ?? createGateway({ db: opts.db, m3, ...(opts.now ? { now: opts.now } : {}), ...(opts.gatewayLimits ? { limits: opts.gatewayLimits } : {}) });
  let runners = null;
  // The bus: what wakes whom, and sending it to runners (m3-design sections 2 to 4, 7).
  // Triggers (N2, L21): webhooks, schedules and events inside the team that wake a teammate.
  const triggers = opts.triggers ?? createTriggers({ db: opts.db, key: opts.key, m3, publicUrl: opts.publicUrl, ...(opts.now ? { now: opts.now } : {}) });
  // The vault (L20): credentials, and their release only to a session's sidecar or the gateway. Test connection goes
  // through the gateway (one probe per credential a minute, GitHub paced).
  const vault = opts.vault ?? createVault({ db: opts.db, key: opts.key, m3, now: opts.now, outbound: probeThrough(gateway, m3, opts.vaultOptions?.fetch), ...(opts.vaultOptions ?? {}) });
  const bus = createBus({ db: opts.db, m3, runners: () => runners, now: opts.now, publicUrl: opts.publicUrl, meetingTurnMinutes: opts.meetingTurnMinutes, triggers, gateway, vault,
    installationsFor: opts.installationsFor ?? (opts.identity?.installations?.enabled ? (tn, url) => opts.identity.installations.forRepo(tn, url) : null) });
  wireBus(m3, bus);
  // Runners connect here over a WebSocket (runner-protocol.md).
  runners = attachRunners(server, { db: opts.db, ops: bus.ops, welcome: bus.welcome, onLost: bus.onLost, ...(opts.serverVersion ? { version: opts.serverVersion } : {}), ...(opts.runnerOptions ?? {}) });
  const handler = createHandler({ ...opts, runners, m3, bus, triggers, gateway, vault });
  server.on('request', handler);
  // The tick runs in-process every 15 s; a deployment can also call POST /v1/internal/tick from a cron.
  const tickMs = opts.tickMs ?? 15_000;
  let ticking = false;
  const timer = tickMs > 0 ? setInterval(() => { if (ticking) return; ticking = true; bus.tick().then(() => opts.identity?.sweep()).then(() => handler.recheck()).catch((e) => console.error(`tick: ${e.message}`)).finally(() => { ticking = false; }); }, tickMs) : null;
  timer?.unref?.();
  server.runners = runners;
  server.m3 = m3;
  server.bus = bus;
  server.vault = vault;
  server.on('close', () => { if (timer) clearInterval(timer); runners.closeAll(); });
  return server;
}

/**
 * The API as a request handler, `(req, res) => Promise`, for hosts that bring their own HTTP server (serverless
 * functions, a framework). createControlPlane wraps it in node:http. `pollMs`: how often an open stream also reads
 * the log, so it sees events appended by other instances (0 turns that off; one instance needs only the hub).
 */
export function createHandler({ db, key, tenant, adminToken, publicUrl = '', sinks = null, now = () => new Date(), pollMs = 2000, runners = null, stepUpVerifier = null, m3: given = null, bus: givenBus = null, triggers: givenTriggers = null, cronSecret = process.env.CRON_SECRET ?? null, identity = null, email: emailOpts = {}, slack: slackOpts = {}, studio: studioOpts = null, streamCheckMs = 20_000, mode = process.env.AGENT_TEAM_MODE ?? null, reachability = null, region = process.env.FLY_REGION ?? null, serverVersion = SERVER_VERSION, gateway: givenGateway = null, gatewayLimits = null, vault: givenVault = null }) {
  if (cronSecret && String(cronSecret).length < 32) throw new Error('CRON_SECRET must be at least 32 characters');
  const live = hub();
  const m3 = given ?? createM3({ db, now, publicUrl });
  const inspector = createInspector({ db, m3 });
  const passkeys = identity ? createPasskeys({ db, m3, origin: identity.origin, now }) : null;
  const recovery = identity ? createRecovery({ db, requireStepUp: passkeys.requireStepUp, now }) : null;
  const members = identity ? createMembers({ db, lookup: identity.lookup, endSessions: (p) => identity.endSessions(p), requireStepUp: passkeys.requireStepUp, now }) : null;
  const emailProviders = emailOpts.providers ?? PROVIDERS;
  const email = createEmail({ db, key, publicUrl, providers: emailProviders, readSecret: store.readSecret, now, fetch: emailOpts.fetch ?? fetch });
  const notifications = createNotifications({ db });
  const studioUrl = String(emailOpts.studioUrl ?? publicUrl ?? '').replace(/\/+$/, '');
  // "Connect Slack" sends a person back to this Studio page, which posts { code, state } with their session.
  const slack = createSlack({ db, key, publicUrl, redirectUri: studioUrl ? `${studioUrl}/slack/callback` : '', providers: slackOpts.providers ?? SLACK_PROVIDERS, readSecret: store.readSecret, now, fetch: slackOpts.fetch ?? fetch });
  // The deployment's own Studio page (hosted mode, apps/server/studio.mjs): off until the M4 GitHub App is set up.
  const studioOrigin = identity?.origin ?? (publicUrl ? new URL(publicUrl).origin : null);
  const installations = identity?.installations?.enabled ? identity.installations : null;
  // Where OrgCraft runs and outage mode (L29): what this process saw of the code host, from its own calls to it.
  const reach = reachability ?? createReachability({ now });
  const codeHostApi = String(studioOpts?.api ?? 'https://api.github.com').replace(/\/+$/, '');
  // Every code-host call is paced on the App and its installation, and a "slow down" answer holds them (R1a, L20g).
  const gateway = givenGateway ?? createGateway({ db, m3, now, ...(gatewayLimits ? { limits: gatewayLimits } : {}) });
  const codeHostFetch = reach.wrap('code-host', gateway.wrapFetch(studioOpts?.fetch ?? globalThis.fetch));
  const startedAt = now().toISOString();
  const deployMode = ['local', 'self-hosted', 'hosted'].includes(mode) ? mode : db.kind === 'pglite' ? 'local' : 'self-hosted';
  let lastCheck = 0;
  /** One probe of the code host unless one ran in the last CHECK_SECONDS; returns ms until the next may run (<= 0: it ran). */
  const probeCodeHost = async () => {
    const wait = lastCheck + CHECK_SECONDS * 1000 - now().getTime();
    if (wait > 0) return wait;
    lastCheck = now().getTime();
    try { await codeHostFetch(`${codeHostApi}/rate_limit`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'agent-team-server' }, signal: AbortSignal.timeout(10_000) }); } catch { /* recorded by the wrapper */ }
    return wait;
  };
  const runnerCards = async (t) => { const at = now(); return (await store.listRunners(db, t)).map((r) => describeRunner(r, runners?.get(r.id)?.hello && !runners.get(r.id).closed ? runners.get(r.id) : null, at, serverVersion)); };
  // A managed team (ADR 0012, migration 022) needs no GitHub App: its files are in this database's Git store.
  const managedStore = {
    teamBackend: async (tn, tm) => (await db.tenant(tn, ({ q }) => q('select backend from teams where id = $1', [tm])))[0]?.backend ?? 'github',
    store: (tn, tm) => pgObjects(db, tn, tm),
    refs: (tn, tm) => pgRefs(db, tn, tm),
  };
  const changes = createChanges({ db, m3, now });
  const hostedStudio = createHostedStudio(studioOrigin ? {
    origin: studioOrigin,
    managed: managedStore,
    // The installations this workspace proved (S9) and the team's repository, unless the caller brings its own.
    ...(installations ? { teamRepo: (tn, tm) => installations.teamRepo(tn, tm), boundInstallations: (tn) => installations.bound(tn) } : {}),
    // Delegated publish: the person's consent on the host's current text, and the host's name for the PR line.
    ...(identity ? { hosts: { consented: (h, p) => identity.hosts.linked(h, p), nameOf: (h) => identity.hosts.nameOf(h) } } : {}),
    ...studioOpts,
    fetch: codeHostFetch,
    audit: (row) => m3.tx(row.tenant, (ctx) => ctx.audit({ team: row.team, actorKind: row.actorId ? 'person' : 'system', actorId: row.actorId ?? 'control-plane', action: row.action, target: row.target, decision: row.decision, rule: row.rule ?? null, detail: row.detail ?? null })),
  } : null);
  let tickMisses = [];
  const triggers = givenTriggers ?? createTriggers({ db, key, m3, publicUrl, now });
  const vault = givenVault ?? createVault({ db, key, m3, now, outbound: probeThrough(gateway, m3) });
  const bus = givenBus ?? createBus({ db, m3, runners: () => runners, now, publicUrl, triggers, gateway, vault, installationsFor: installations ? (tn, url) => installations.forRepo(tn, url) : null });
  if (!givenBus) wireBus(m3, bus);
  m3.hooks.drainTriggers = (tn, tm) => triggers.drain(tn, tm);
  const overrides = createLive({ db, m3 });
  const caps = createCaps({ db, getTeam: store.getTeam, now });
  const ledger = createLedger({ db, m3, now });
  // Every write of the m3 module and the bus reaches the live streams and the sinks once it commits.
  m3.onStored((stored) => { const byTeam = new Map(); for (const x of stored) byTeam.set(x.event.team, [...(byTeam.get(x.event.team) ?? []), x]); for (const [tm, xs] of byTeam) appended(tm, xs); });
  /** Runs an m3 write and tells the hub and sinks about what it stored. */
  const did = async (p) => (await p).result;
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

  /** Who is calling: the admin token, or (hosted) a signed-in person's cookie. `tenant` is null for a person who is
   *  not a member of this server's workspace: they can read /v1/me and nothing else. */
  const person = async (req, path) => {
    // An app (iPhone, Android, the CLI): its device-bound access token and a DPoP proof for this request (S3).
    if (identity && /^DPoP /.test(req.headers.authorization ?? '')) {
      const app = await appCaller({ db, provider: identity.provider, origin: identity.origin, now }, req, path);
      const [p] = await db.system('select login, name from people where id = $1', [app.person]);
      if (!p) throw new Problem(401, 'app token refused: no such person', { type: 'unauthenticated' });
      const workspaces = await identity.workspaces(app.person);
      const here = workspaces.find((w) => w.tenant === tenant);
      // No cookie session: authTime is null, so nothing that trusts a recent sign-in (a first passkey) is open to apps.
      // A host's server (studio-embed.md section 6) calls for its signed-in user the same way, through its proxy.
      const via = HOST_ID.test(app.client) ? 'host' : 'app';
      return { tenant: here ? tenant : null, principal: app.person, via, role: here?.role ?? null, client: app.client, session: { person: app.person, login: p.login, name: p.name, authTime: null, session: null }, workspaces };
    }
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    // D6: a session's token acts for a role, never for a person (approvals, cards, runs, budgets, step-up).
    if (m && /^st_/.test(m[1])) throw new Problem(403, 'a session token cannot act for a person');
    if (m) {
      if (!adminToken || !same(m[1], adminToken)) throw new Problem(401, 'sign in: send Authorization: Bearer <token>', { type: 'unauthenticated' });
      // Retired once a person owns the deployment: from then on people sign in, and the host's way back in is
      // `agent-team-server admin reset-owner <github-id>`, never this token over the network.
      if (identity && (await db.system("select 1 from members where tenant = $1 and role = 'owner' and removed_at is null limit 1", [tenant])).length) {
        throw new Problem(401, 'the admin token is retired on this deployment: sign in with GitHub', { type: 'admin-token-retired' });
      }
      return { tenant, principal: 'admin', via: 'admin', role: 'owner' };
    }
    const s = identity ? await identity.sessionOf(req) : null;
    if (!s) throw new Problem(401, identity ? 'sign in first' : 'sign in: send Authorization: Bearer <token>', { type: 'unauthenticated' });
    // A cross-site form can send neither this Origin nor JSON, so a cookie alone never makes a write (spec section 2).
    if (!identity.csrfOk(req)) throw new Problem(403, 'cross-site request refused: send this deployment\'s Origin and content-type: application/json', { type: 'csrf' });
    const workspaces = await identity.workspaces(s.person);
    const here = workspaces.find((w) => w.tenant === tenant);
    return { tenant: here ? tenant : null, principal: s.person, via: 'cookie', role: here?.role ?? null, session: s, workspaces };
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
  async function stream(req, res, t, team, url, { headers = {}, still = null } = {}) {
    if (team) await store.getTeam(db, t, team);
    const from = req.headers['last-event-id'] ?? url.searchParams.get('after') ?? '';
    let last = team ? await store.seqOf(db, t, team, from) : await store.tenantSeqOf(db, t, from);
    const type = url.searchParams.get('type') ?? '';
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no', ...headers });
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
    // A ticket's stream (S8) ends when the person leaves the workspace or the host is revoked: checked with each beat.
    const beat = setInterval(async () => {
      if (still && !(await still().catch(() => false))) { res.end(); return; }
      res.write(': keep-alive\n\n');
    }, still ? streamCheckMs : 20_000);
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
      return send(res, claim.status, claim.response, { 'idempotent-replayed': 'true', ...(claim.response?.type ? PROBLEM_JSON : {}) });
    }
    res.hold = true;
    let answer;
    try {
      await fn();
      answer = res.answer;
    } catch (e) {
      answer = e instanceof Problem ? { status: e.status, body: problemBody(e), headers: e.type ? PROBLEM_JSON : {} } : e?.code === '23505' ? { status: 409, body: { error: 'already exists' } } : undefined;
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

  /** CRON_SECRET for /v1/internal/*: 404 when unset; the right secret always passes; wrong ones get 429 after 10 a minute. */
  function cron(req) {
    if (!cronSecret) throw new Problem(404, 'not found');
    const at = now().getTime();
    tickMisses = tickMisses.filter((x) => x > at - 60_000);
    const got = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    // The right secret always passes, so wrong guesses cannot lock the real cron out; guesses are slowed.
    if (!got || !same(got, cronSecret)) {
      if (tickMisses.length >= 10) throw new Problem(429, 'too many wrong tick secrets; try again in a minute');
      tickMisses.push(at);
      throw new Problem(401, 'send Authorization: Bearer <CRON_SECRET>');
    }
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.replace(/\/+$/, '').split('/').slice(1).map(decodeURIComponent);
    const m = req.method;
    // Sign-in (hosted only): the issuer's /oauth/* and discovery.
    if (identity && await identity.handle(req, res, url)) return;
    if (parts[0] !== 'v1') throw new Problem(404, 'not found');
    const [, a, team, b, c] = parts;

    if (a === 'health' && m === 'GET') return send(res, 200, { ok: true, db: db.kind });

    // Email links (no sign-in): the signed token is the proof. Unsubscribe turns off one kind for one team (D54).
    if (a === 'email' && !b) return emailPage(req, res, url, team);
    // The same for Slack DMs: "Turn off these messages" (D60), with the same ask-first page.
    if (a === 'slack' && !b && (team === 'unsubscribe' || team === 'resubscribe')) return noticePage(req, res, url, team, SLACK_WORDS);

    // The kit's reports: the same body and answer as the hosted board, so only TEAM_REPORT_URL changes.
    if (a === 'teams' && b === 'reports' && !c && m === 'POST') {
      const t = await store.authReport(db, team, req.headers['x-team-token']);
      if (!t) throw new Problem(401, 'a valid x-team-token for this team is required');
      const body = await readJson(req, 64 * 1024);
      // A publish from the repository's CI (report.mjs published): team.published, once per commit.
      if (body?.kind === 'published') {
        if (limited(team, ':published')) throw new Problem(429, `more than ${REPORTS_PER_MINUTE} publishes a minute`);
        const { id, stored, duplicate } = await store.appendPublished(db, t, team, body, now());
        appended(team, stored);
        return send(res, 200, { ok: true, id, duplicate });
      }
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

    // The team tools (team-tools.md), for a session: its token names the session; the actor comes from it alone.
    if (a === 'sessions' && b === 'tools' && c && m === 'POST' && !parts[5]) {
      const tok = /^Bearer (st_.+)$/.exec(req.headers.authorization ?? '')?.[1];
      const sess = tok ? await bus.authSession(team, tok) : null;
      if (!sess) throw new Problem(401, 'send this session\'s token: Authorization: Bearer st_…');
      return idempotent(req, res, sess.tenant, `session:${sess.id}`, url.pathname, async () => {
        const body = await readJson(req, 64 * 1024);
        return send(res, 200, await bus.toolCall(sess, c, body));
      });
    }

    // The tick for hosts without a long-lived process (a cron). Refused unless CRON_SECRET is set (issue #28 D8).
    if (a === 'internal' && team === 'tick' && !b && m === 'POST') {
      cron(req);
      await bus.tick();
      return send(res, 200, { ok: true });
    }
    // For the deploy's smoke check: who the sign-in rate limits think is calling, and whether the request came
    // through our edge. Never the edge header's value. CRON_SECRET, because the admin token is not for the network.
    if (a === 'internal' && team === 'caller' && !b && m === 'GET') {
      if (!identity) throw new Problem(404, 'not found');
      cron(req);
      return send(res, 200, identity.caller(req));
    }

    // The live stream opened by a host's page with a stream ticket (S8): the ticket is the only credential.
    if (a === 'teams' && b === 'events' && c === 'stream' && !parts[5] && m === 'GET' && url.searchParams.has('ticket')) {
      if (!identity) throw new Problem(404, 'not found');
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
      const tk = await identity.hosts.redeem(url.searchParams.get('ticket'), team, origin);
      const cors = tk.allowOrigin ? { 'access-control-allow-origin': tk.allowOrigin, vary: 'Origin' } : {};
      return stream(req, res, tk.tenant, team, url, { headers: cors, still: () => identity.hosts.stillMember(tk.tenant, tk.person, tk.client) });
    }

    // GitHub's webhook for the deployment's App (github.mjs): signed with GITHUB_WEBHOOK_SECRET, no other credential.
    // A trigger's webhook (N2, L21): the hook's own signature is the only credential. Nothing is written for an
    // unknown hook, a bad signature or a flood; the answer never echoes the body.
    if (a === 'hooks' && team && !b && m === 'POST') {
      const raw = await readRaw(req, 256 * 1024);
      const r = await triggers.receive(team, raw, req.headers);
      return send(res, r.status, r.body, r.headers ?? {});
    }
    if (a === 'github' && team === 'webhook' && !b && m === 'POST') {
      if (!identity?.installations?.enabled) throw new Problem(404, 'not found');
      return send(res, 200, await identity.installations.webhook(await readRaw(req, 1024 * 1024), req.headers));
    }

    const who = await person(req, url.pathname);
    if (a === 'me' && !team && m === 'GET') return send(res, 200, await meView(who));
    // A host acts for its user in the Studio's own routes only: never step-up or passkeys (those open on this
    // deployment in a top-level window, spec section 6), and never the host registry itself (S4).
    // An allowlist (roles.mjs HOST_ROUTES): anything else, and anything carrying step-up, opens on this deployment.
    if (who.via === 'host' && (!hostMay(m, url.pathname.slice(3)) || req.headers['x-step-up'])) {
      throw new Problem(403, 'not through a host: open this deployment in a top-level window for that', { type: 'forbidden' });
    }
    // Resuming is interactive only (ADR 0013, x-interactive-only): a host may pause or stop a run, never resume one.
    if (who.via === 'host' && a === 'runs' && m === 'POST' && b === 'resume') {
      throw new Problem(403, 'resuming a run is done on this deployment, with your passkey', { type: 'forbidden' });
    }
    if (who.via === 'host' && a === 'cards' && team && m === 'POST') {
      const card = await m3.getCard(who.tenant ?? tenant, team);
      if (!HOST_CARD_KINDS.has(card.kind)) throw new Problem(403, `a ${card.kind} card is answered on this deployment, not through a host`, { type: 'forbidden' });
    }
    if (passkeys && ((a === 'me' && team === 'passkeys') || (a === 'auth' && team === 'step-up'))) {
      // A retry after a lost answer replays it (the challenge is single use, so running it again would fail).
      // Idempotency is kept per workspace, so a person in none of them has none.
      return who.tenant ? idempotent(req, res, who.tenant, who.principal, url.pathname, () => passkeyRoute(req, res, who, parts)) : passkeyRoute(req, res, who, parts);
    }
    // A member elsewhere only: nothing here shows which teams exist (spec section 4).
    if (!who.tenant) throw new Problem(404, 'not found');
    // Roles on every route (roles.mjs): a route without a listed role is refused, so none ships unguarded.
    if (who.via !== 'admin') {
      const min = minRole(m, url.pathname.slice(3));
      if (!min) throw new Problem(404, 'not found');
      if (!atLeast(who.role, min)) throw new Problem(403, `this needs the ${min} role or above; you are ${who.role}`, { type: 'forbidden' });
    }
    // The Studio (hosted mode): the kit's handler answers; a publish is idempotent like every other write.
    if (a === 'teams' && b === 'studio') {
      // Up to 5 MB, the handler's own limit (E6), read here first so idempotent() hashes the same bytes.
      // Outage mode (O37.8): nothing goes out to a code host this process can't reach. The draft stays in the Studio.
      if (m === 'POST' && reach.state('code-host') === 'unreachable') throw new Problem(503, "GitHub can't be reached. Publishing waits until it's back. Nothing already published is affected, and nothing is lost.", { type: 'code-host-unreachable' });
      const raw = m === 'GET' || m === 'HEAD' ? null : await readRaw(req, 5 * 1024 * 1024);
      const serve = async () => {
        const r = await hostedStudio.handle(req, who, team, raw);
        if (/^application\/json/.test(r.headers['content-type'] ?? '')) {
          const { 'content-type': _ct, 'content-length': _cl, ...headers } = r.headers;
          let body; try { body = JSON.parse(r.body.toString('utf8') || 'null'); } catch { body = { error: 'the Studio answered something that is not JSON' }; }
          return send(res, r.status, body, headers);
        }
        res.writeHead(r.status, r.headers);
        return res.end(m === 'HEAD' ? undefined : r.body);
      };
      return m === 'POST' ? idempotent(req, res, who.tenant, who.principal, url.pathname, serve) : serve();
    }
    return idempotent(req, res, who.tenant, who.principal, url.pathname, () => personRoute(req, res, who, url, parts));
  }

  /** Passkeys and step-up for a signed-in person (spec section 3). Their own, so any member may manage them. */
  async function passkeyRoute(req, res, who, parts) {
    const m = req.method;
    const [, a, , b, c] = parts;
    const step = req.headers['x-step-up'] ?? null;
    if (a === 'auth' && b === 'challenge' && !c && m === 'GET') return send(res, 200, await passkeys.challenge(mustBePerson(who)));
    if (a === 'auth' && !b && m === 'POST') {
      const body = await readJson(req, 16 * 1024);
      // The typed secret is local mode's only (spec section 3): a hosted deployment steps up with a passkey.
      if (!body?.webauthn) throw new Problem(400, 'step up with your passkey: GET /v1/auth/step-up/challenge, then POST { webauthn }', { type: 'step-up-method' });
      return send(res, 201, await passkeys.stepUp(mustBePerson(who), body.webauthn, body.scope ?? null), {}, { secrets: ['token'] });
    }
    if (a === 'me' && !b && m === 'GET') return send(res, 200, await passkeys.list(mustBePerson(who)));
    if (a === 'me' && b === 'options' && !c && m === 'GET') return send(res, 200, await passkeys.registrationOptions(mustBePerson(who, { web: true })));
    if (a === 'me' && !b && m === 'POST') return send(res, 201, await passkeys.register(mustBePerson(who, { web: true }), await readJson(req, 64 * 1024), step));
    if (a === 'me' && b && !c && m === 'DELETE') return send(res, 200, await passkeys.remove(mustBePerson(who, { web: true }), b, step));
    throw new Problem(404, 'not found');
  }

  /** Passkeys are a person's: never the admin token's. Adding or removing one is the web's (it needs a recent sign-in
   *  or step-up in the browser); an app may list them and step up with one. */
  const mustBePerson = (who, { web = false } = {}) => {
    if (who.via === 'admin') throw new Problem(400, 'passkeys belong to a signed-in person, not the admin token');
    if (web && who.via !== 'cookie') throw new Problem(403, 'add or remove passkeys in the Studio, signed in on the web', { type: 'forbidden' });
    return who;
  };

  /** GET /v1/me: the signed-in person, their workspaces and roles, and how many passkeys they have. */
  async function meView(who) {
    if (who.via === 'admin') return { id: 'admin', login: null, name: 'Admin token', workspaces: [{ tenant, role: 'owner' }], passkeys: 0, authTime: null };
    const [{ n }] = await db.system('select count(*)::int as n from passkeys where person = $1', [who.principal]);
    // S5, until the notifications channel delivers them: the person's own security changes of the last 30 days, so the
    // Studio can show "a passkey was added to your account" on their next visit.
    const notices = await db.system(`select action, at, detail from identity_audit where person = $1 and at > now() - interval '30 days'
      and action = any($2) order by at desc, id desc limit 20`, [who.principal, NOTICE_ACTIONS]);
    return { id: who.principal, login: who.session.login, name: who.session.name ?? who.session.login, workspaces: who.workspaces.map((w) => ({ tenant: w.tenant, role: w.role })), passkeys: Number(n), authTime: who.session.authTime,
      notices: notices.map((r) => ({ action: r.action, at: new Date(r.at).toISOString(), ...(r.detail?.passkey ? { passkey: r.detail.passkey } : {}), ...(r.detail?.name ? { name: r.detail.name } : {}), ...(r.detail?.tenant ? { tenant: r.detail.tenant } : {}), ...(r.detail?.to ? { role: r.detail.to } : {}), ...(r.detail?.person ? { person: r.detail.person } : {}), ...(r.detail?.effectiveAt ? { effectiveAt: r.detail.effectiveAt } : {}) })) };
  }

  const html = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'", ...headers }); res.end(body); };
  async function emailPage(req, res, url, what) {
    const t = url.searchParams.get('t') ?? '';
    const m = req.method;
    if (what === 'link' && m === 'GET') {
      const target = email.linkTarget(t);
      if (!target) return html(res, 400, page('This link is not valid', ['Open the Studio and find the item there.']));
      if (target.expired) return html(res, 410, page('This link has expired', ['Links in team emails expire. Open the Studio and find the item there.'], studioUrl ? [{ label: 'Open the Studio', href: studioUrl + '/' }] : []));
      res.writeHead(302, { location: studioUrl + target.path, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      return res.end();
    }
    if (what === 'unsubscribe' || what === 'resubscribe') return noticePage(req, res, url, what, EMAIL_WORDS);
    throw new Problem(404, 'not found');
  }

  // The words of the turn-off pages, per channel (CPO copy, D54 and D60).
  const EMAIL_WORDS = { api: email, path: 'email', noun: 'emails', these: 'these emails', still: 'Other emails you turned on still arrive. Your address stays verified.', again: 'Other emails you turned on still arrive.', manage: 'Manage all emails' };
  const SLACK_WORDS = { api: slack, path: 'slack', noun: 'Slack messages', these: 'these messages', still: 'Other messages you turned on still arrive. Slack stays connected.', again: 'Other messages you turned on still arrive.', manage: 'Manage all messages' };
  async function noticePage(req, res, url, what, w) {
    const t = url.searchParams.get('t') ?? '';
    const m = req.method;
    if (m !== 'GET' && m !== 'POST') throw new Problem(404, 'not found');
    const on = what === 'resubscribe';
    const self = (op) => `/v1/${w.path}/${op}?t=${encodeURIComponent(t)}`;
    if (on && m !== 'POST') return html(res, 405, page('Use the button', [`Turn the ${w.noun} back on with the button on the confirmation page.`]), { allow: 'POST' });
    // A GET only asks: mail scanners and link previews open links, and must not turn anything off (security review). The button POSTs.
    if (m === 'GET') {
      const p = await w.api.peekToken(t);
      if (!p) return html(res, 400, page('This link is not valid', [`Manage your ${w.noun} in the Studio.`]));
      if (url.searchParams.get('keep') === '1') return html(res, 200, page('Nothing changed', [`You still get ${w.these}.`]));
      return html(res, 200, page(`Stop "${p.label}" ${w.noun} for ${p.teamName}?`, [w.still],
        [{ label: `Turn off ${w.these}`, href: self('unsubscribe'), post: true }, { label: 'Keep getting them', href: `${self('unsubscribe')}&keep=1`, secondary: true }]));
    }
    const r = await w.api.fromToken(t, on);
    if (!r) return html(res, 400, page('This link is not valid', [`Manage your ${w.noun} in the Studio.`]));
    // A mail client's one-click unsubscribe (RFC 8058) only needs a 200.
    if (!on && w === EMAIL_WORDS && /List-Unsubscribe=One-Click/.test(await readText(req, 1024))) return html(res, 200, page('Unsubscribed', []));
    const settings = studioUrl ? [{ label: w.manage, href: `${studioUrl}/teams/${encodeURIComponent(r.team)}/notifications`, secondary: true }] : [];
    if (on) return html(res, 200, page(`You will get "${r.label}" ${w.noun} for ${r.teamName} again`, [w.again], [{ label: 'Turn them off', href: self('unsubscribe'), post: true, secondary: true }, ...settings]));
    return html(res, 200, page(`You won't get "${r.label}" ${w.noun} for ${r.teamName}`, [w.still], [{ label: 'Turn it back on', href: self('resubscribe'), post: true }, ...settings]));
  }

  async function personRoute(req, res, who, url, parts) {
    const m = req.method;
    const stepUp = req.headers['x-step-up'] ?? null;
    const [, a, team, b, c] = parts;
    const t = who.tenant, me = who.principal;
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
    if (a === 'me' && team === 'notifications' && !b && m === 'GET') return send(res, 200, await notifications.get(t, me));
    if (a === 'me' && team === 'notifications' && !b && m === 'PUT') return send(res, 200, await notifications.put(t, me, await readJson(req, 4 * 1024)));
    if (a === 'me' && team === 'inbox' && !b && m === 'GET') {
      const q = Object.fromEntries(url.searchParams);
      const { seq, ...body } = await m3.inbox(t, q);
      return etagged(req, res, seq, body, `${q.cursor ?? ''}|${q.limit ?? ''}`);
    }
    if (a === 'auth' && team === 'step-up' && !b && m === 'POST') {
      const body = await readJson(req, 4 * 1024);
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      return send(res, 201, await m3.stepUp(t, me, body?.secret, { verifier: stepUpVerifier, bearer, scope: body?.scope ?? null }), {}, { secrets: ['token'] });
    }
    if (a === 'runs' && team && b && !c && m === 'POST') return send(res, 200, await did(m3.controlRun(t, team, b, me, { stepUp })));
    if (a === 'approvals' && team && !b && m === 'POST') return send(res, 200, await did(m3.decideApproval(t, team, await readJson(req, 16 * 1024), me, { stepUp })));
    if (a === 'cards' && team && !b && m === 'GET') return send(res, 200, await m3.getCard(t, team));
    if (a === 'cards' && team && !b && m === 'POST') return send(res, 200, await did(m3.answerCard(t, team, await readJson(req, 16 * 1024), me, { stepUp, role: who.role })));
    if (a === 'runners' && team === 'codes' && !b && m === 'POST') {
      const body = req.headers['content-type'] ? (await readJson(req, 16 * 1024)) ?? {} : {};
      await m3.requireStepUp(t, me, stepUp, 'Adding a runner');
      return send(res, 201, await store.mintRunnerCode(db, t, me, body), {}, { secrets: ['code'] });
    }
    // Hosts: a customer's own site that mounts the Studio (studio-embed.md section 6). Sign-in must be on.
    if (a === 'hosts') {
      if (!identity) throw new Problem(404, 'hosts need sign-in on this deployment (GITHUB_APP_CLIENT_ID and an https AGENT_TEAM_PUBLIC_URL)');
      if (!team && m === 'GET') return send(res, 200, await identity.hosts.list(t));
      if (!team && m === 'POST') {
        const body = await readJson(req, 16 * 1024);
        await m3.requireStepUp(t, me, stepUp, 'Registering a host');
        return send(res, 201, await identity.hosts.create(t, me, body), {}, { secrets: ['clientSecret'] });
      }
      if (team && !b && m === 'DELETE') return send(res, 200, await identity.hosts.revoke(t, team, me));
    }
    // GitHub App installations the workspace has proven it owns (S9, github.mjs). Binding one is an admin's, with step-up.
    if (a === 'github' && team === 'installations') {
      if (!identity?.installations?.enabled) throw new Problem(404, 'GitHub App installations need sign-in and GITHUB_APP_SLUG on this deployment');
      if (!b && m === 'GET') return send(res, 200, await identity.installations.list(t));
      if (!b && m === 'POST') {
        await readJson(req, 4 * 1024);
        if (who.via === 'admin') throw new Problem(400, 'connecting GitHub proves a person administers the account: sign in as one');
        await m3.requireStepUp(t, me, stepUp, 'Connecting a GitHub App installation');
        return send(res, 201, await identity.installations.start(t, me), {}, { secrets: ['url'] });
      }
      if (b && !c && m === 'DELETE') {
        await m3.requireStepUp(t, me, stepUp, 'Disconnecting a GitHub App installation');
        return send(res, 200, await identity.installations.unbind(t, b, me));
      }
    }
    if (a === 'me' && team === 'hosts' && identity && who.via !== 'admin') {
      if (!b && m === 'GET') return send(res, 200, await identity.hosts.myLinks(me));
      if (b && !c && m === 'DELETE') return send(res, 200, await identity.hosts.unlink(me, b));
    }
    if (a === 'teams' && team && b === 'stream-tickets' && !c && m === 'POST') {
      if (!identity) throw new Problem(404, 'stream tickets need sign-in on this deployment');
      await store.getTeam(db, t, team);
      return send(res, 201, await identity.hosts.mintTicket(t, team, who), {}, { secrets: ['ticket', 'url'] });
    }
    if (a === 'runners' && !team && m === 'GET') return send(res, 200, { runners: await runnerCards(t) });
    // Where OrgCraft runs, the runner summary and outage mode (L29). Any member: the banner is for everyone.
    if (a === 'deployment' && !team && m === 'GET') return send(res, 200, deploymentView({ mode: deployMode, codeHost: reach.get('code-host'), runners: await runnerCards(t), startedAt, region, db, version: serverVersion }));
    // "Check again": one probe of the code host, at most once per CHECK_SECONDS per process (rate_limit costs no quota).
    if (a === 'deployment' && team === 'check' && !b && m === 'POST') {
      const wait = await probeCodeHost();
      return send(res, 200, { checked: wait <= 0, ...(wait > 0 ? { retryIn: Math.ceil(wait / 1000) } : {}), ...deploymentView({ mode: deployMode, codeHost: reach.get('code-host'), runners: await runnerCards(t), startedAt, region, db, version: serverVersion }) });
    }
    if (a === 'runners' && team && team !== 'codes' && !b && m === 'DELETE') { await store.revokeRunner(db, t, team); runners?.close(team); return send(res, 200, { ok: true }); }
    if (a === 'teams' && !team) {
      if (m === 'GET') return send(res, 200, { teams: await store.listTeams(db, t) });
      if (m === 'POST') return send(res, 201, await store.createTeam(db, t, (await readJson(req, 16 * 1024)) ?? {}));
    }
    // Standing rules and the approvals ledger (L22).
    if (a === 'teams' && team && b === 'standing-rules' && !parts[5]) {
      if (!c && m === 'GET') return send(res, 200, await ledger.list(t, team));
      if (!c && m === 'POST') return send(res, 201, await ledger.add(t, team, (await readJson(req, 8 * 1024)) ?? {}, who, stepUp));
      if (c && m === 'DELETE') return send(res, 200, await ledger.withdraw(t, team, c, who));
    }
    if (a === 'teams' && team && b === 'ledger' && !c && m === 'GET') return send(res, 200, await ledger.ledger(t, team, { limit: url.searchParams.get('limit'), before: url.searchParams.get('before') }));
    // Hooks and triggers (N2, L21).
    // L20: the team's systems (resources.json), set only by an admin with a step-up; runs freeze them.
    if (a === 'teams' && team && b === 'systems' && !c && m === 'GET') return send(res, 200, await vault.getSystems(t, team));
    if (a === 'teams' && team && b === 'systems' && !c && m === 'PUT') return send(res, 200, await vault.putSystems(t, team, me, await readJson(req, 256 * 1024), stepUp));
    if (a === 'teams' && team && b === 'hooks') {
      const d = parts[5];
      if (!c && m === 'GET') return send(res, 200, await triggers.listHooks(t, team));
      if (!c && m === 'POST') return send(res, 201, await triggers.createHook(t, team, (await readJson(req, 4 * 1024)) ?? {}, me, stepUp), {}, { secrets: ['secret'] });
      if (c && d === 'rotate' && !parts[6] && m === 'POST') return send(res, 200, await triggers.rotateHook(t, team, c, me, stepUp), {}, { secrets: ['secret'] });
      if (c && !d && m === 'DELETE') return send(res, 200, await triggers.revokeHook(t, team, c, me, stepUp));
      throw new Problem(404, 'not found');
    }
    if (a === 'teams' && team && b === 'triggers') {
      const d = parts[5];
      if (c === 'test' && !d && m === 'POST') return send(res, 200, triggers.test((await readJson(req, 64 * 1024)) ?? {}));
      if (c && d === 'history' && !parts[6] && m === 'GET') return send(res, 200, await triggers.history(t, team, c, Object.fromEntries(url.searchParams)));
      throw new Problem(404, 'not found');
    }
    // Live overrides (L18): emergency controls as control-plane state, never Git. Stopping is one tap; lifting needs
    // a step-up scoped to the one change (a host never sends one, so a host can stop but never lift).
    if (a === 'live' && team === 'stop-everything' && !b && m === 'POST') return send(res, 200, await overrides.stopEverywhere(t, me, { reason: ((await readJson(req, 4 * 1024)) ?? {}).reason ?? null }));
    if (a === 'teams' && team && b === 'live') {
      const d = parts[5];
      if (!c && m === 'GET') return send(res, 200, await overrides.list(t, team));
      if (c === 'stop-everything' && !d && m === 'POST') return send(res, 200, await overrides.stopEverything(t, team, me, { reason: ((await readJson(req, 4 * 1024)) ?? {}).reason ?? null }));
      if (c === 'members' && d && !parts[6] && m === 'PUT') return send(res, 200, await overrides.setMember(t, team, d, (await readJson(req, 4 * 1024)) ?? {}, me));
      if (c && c !== 'members' && c !== 'stop-everything' && !d && m === 'DELETE') return send(res, 200, await overrides.lift(t, team, c, me, { stepUp }));
      throw new Problem(404, 'not found');
    }
    if (a === 'teams' && team) {
      if (!b && m === 'GET') return send(res, 200, await store.getTeam(db, t, team));
      if (!b && m === 'PUT') return send(res, 200, await store.putTeam(db, t, team, (await readJson(req, 16 * 1024)) ?? {}));
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
        // An allowlist (issue #135): what an integration reports. Everything the server or a runner writes itself
        // (approvals, cards, chat, runs, sessions, proposals, budgets, meetings, notifications) is refused, so no admin
        // token can make the chat or the clients show something the system never said.
        const bad = events.map((e) => String(e?.type ?? '')).filter((ty) => !postable(ty));
        if (bad.length) throw new Problem(403, `these event types are written by the control plane or a runner, never posted: ${[...new Set(bad)].slice(0, 10).join(', ')}`, { type: 'forbidden', body: { refused: [...new Set(bad)].slice(0, 50) } });
        const stored = await did(m3.appendEvents(t, team, events));
        const sent = new Set(events.map((e) => e?.id));
        const mine = stored.filter(({ id }) => sent.has(id));
        return send(res, 200, { stored: mine.map(({ id }) => id), duplicates: events.length - mine.length });
      }
      if (b === 'events' && c === 'stream' && m === 'GET') return stream(req, res, t, team, url);
      if (b === 'budget' && !c && m === 'GET') return send(res, 200, await m3.getBudget(t, team));
      // The cap tree and cost estimates (L24s; vision G15.1, G15.2): reads, for anyone who can see the budget.
      if (b === 'caps' && !c && m === 'GET') return send(res, 200, await caps.tree(t, team));
      if (b === 'estimate' && !c && m === 'GET') return send(res, 200, await caps.estimate(t, team, Object.fromEntries(url.searchParams)));
      if (b === 'budget' && !c && m === 'PUT') {
        const body = await readJson(req, 16 * 1024);
        // B8 (CTO, L24s): runners price usage in US dollars and nothing converts yet, so a hosted deployment keeps
        // budgets in USD. A local or self-hosted one may name another currency; amounts are then USD under its label.
        if (deployMode === 'hosted' && body?.currency !== undefined && body.currency !== 'USD') throw new Problem(422, USD_ONLY, { type: 'currency' });
        return send(res, 200, await did(m3.putBudget(t, team, body, me, { stepUp })));
      }
      if (b === 'tasks' && !c && m === 'GET') { await store.getTeam(db, t, team); return send(res, 200, await inspector.list(t, team, Object.fromEntries(url.searchParams))); }
      if (b === 'tasks' && c && !parts[5] && m === 'GET') return send(res, 200, await inspector.get(t, team, c));
      if (b === 'io' && c && !parts[5] && m === 'GET') return send(res, 200, await inspector.read(t, team, c, me));
      if (b === 'io' && !c && m === 'DELETE') { await store.getTeam(db, t, team); return send(res, 200, await inspector.remove(t, team, url.searchParams.get('before'), me, stepUp)); }
      if (b === 'runs' && !c && m === 'GET') return send(res, 200, { runs: await m3.listRuns(t, team) });
      if (b === 'runs' && !c && m === 'POST') {
        const body = (await readJson(req, MAX_BODY)) ?? {};
        if (deployMode === 'hosted' && (await m3.getBudget(t, team)).currency !== 'USD') throw new Problem(422, USD_ONLY, { type: 'currency' });
        // A run on a GitHub repository needs an installation the workspace has proven it owns (S9): the runner gets
        // only those, as repo.installations on session.start.
        const ids = installations?.enabled ? await installations.forRepo(t, body?.team?.repo?.url) : null;
        if (ids && !ids.length) throw new Problem(409, 'connect the GitHub App for this repository first: POST /v1/github/installations', { type: 'installation' });
        return send(res, 201, await did(m3.startRun(t, team, body, me)));
      }
      if (b === 'meetings' && !c && m === 'GET') return send(res, 200, { meetings: await bus.meetings.list(t, team) });
      if (b === 'meetings' && !c && m === 'POST') return send(res, 201, await did(bus.meetings.start(t, team, (await readJson(req, 16 * 1024)) ?? {}, me)));
      if (b === 'meetings' && c && !parts[5] && m === 'GET') return send(res, 200, await bus.meetings.get(t, team, c));
      if (b === 'chat' && !c && m === 'GET') return send(res, 200, await m3.getChat(t, team, Object.fromEntries(url.searchParams)));
      if (b === 'chat' && !c && m === 'POST') {
        const { created, event } = await did(m3.postChat(t, team, await readJson(req, 64 * 1024), me));
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
      // The rollout view after a publish merges (demo step 17): which roles have picked up the new team version.
      // A managed team's change requests (ADR 0012, spec L9 section 4.5).
      if (b === 'changes' && !c && m === 'GET') return send(res, 200, await changes.list(t, team, url.searchParams.get('state') ?? ''));
      if (b === 'changes' && c && !parts[5] && m === 'GET') return send(res, 200, await changes.get(t, team, c));
      if (b === 'changes' && c && parts[5] === 'accept' && !parts[6] && m === 'POST') {
        const body = (await readJson(req, 16 * 1024)) ?? {};
        return send(res, 200, await changes.accept(who, team, c, { stepUp, words: typeof body.words === 'string' ? body.words : '' }));
      }
      if (b === 'changes' && c && parts[5] === 'close' && !parts[6] && m === 'POST') { await readJson(req, 4 * 1024); return send(res, 200, await changes.close(who, team, c)); }
      if (b === 'rollback' && !c && m === 'POST') return send(res, 201, await changes.rollback(who, team, (await readJson(req, 4 * 1024)) ?? {}));
      if (b === 'rollout' && !c && m === 'GET') return send(res, 200, await store.rollout(db, t, team, { version: url.searchParams.get('version') ?? '', publishedAt: url.searchParams.get('publishedAt') ?? '', now: now() }));
      if (b === 'report-tokens' && !c && m === 'POST') {
        const tok = await store.mintReportToken(db, t, team);
        const base = publicUrl || `http://${req.headers.host}`;
        return send(res, 201, { ...tok, url: `${base.replace(/\/+$/, '')}/v1/teams/${team}/reports` }, {}, { secrets: ['token'] });
      }
      if (b === 'report-tokens' && c && m === 'DELETE') { await store.revokeReportToken(db, t, team, c); return send(res, 200, { ok: true }); }
      if (b === 'sinks' && !c && m === 'GET') return send(res, 200, { sinks: await store.listSinks(db, t, team) });
      if (b === 'sinks' && !c && m === 'POST') { const s = await store.addSink(db, t, team, (await readJson(req, 16 * 1024)) ?? {}, { providers: Object.keys(emailProviders) }); sinks?.wake(); return send(res, 201, s); }
      if (b === 'notifications' && c === 'log' && !parts[5] && m === 'GET') {
        const all = url.searchParams.get('all') === '1';
        if (all && !atLeast(who.role, 'admin')) throw new Problem(403, "everyone's deliveries need the admin role or above", { type: 'forbidden' });
        return send(res, 200, await notifications.log(t, team, me, { all, limit: url.searchParams.get('limit'), before: url.searchParams.get('before') }));
      }
      // A person's own email addresses for this team (PRD 6.8 O7): add, verify with a code, choose kinds, remove.
      if (b === 'emails') {
        const d = parts[5];
        if (!c && m === 'GET') return send(res, 200, await email.list(t, team, me));
        if (!c && m === 'POST') return send(res, 201, await email.add(t, team, me, await readJson(req, 4 * 1024)));
        if (c && d === 'verify' && m === 'POST') return send(res, 200, await email.verify(t, team, me, c, await readJson(req, 4 * 1024)));
        if (c && !d && m === 'PATCH') return send(res, 200, await email.setKinds(t, team, me, c, await readJson(req, 4 * 1024)));
        if (c && !d && m === 'DELETE') return send(res, 200, await email.remove(t, team, me, c));
      }
      // Slack (CPO story "Slack notifications"): a person's own DMs, and the channels an admin picks.
      if (b === 'slack') {
        const d = parts[5];
        if (!c && m === 'GET') return send(res, 200, await slack.status(t, team, me));
        if (c === 'connect' && !d && m === 'POST') return send(res, 200, await slack.connect(t, team, me));
        if (c === 'link' && !d && m === 'POST') return send(res, 201, await slack.link(t, team, me, await readJson(req, 4 * 1024)));
        if (c === 'me' && !d && m === 'PATCH') return send(res, 200, await slack.setKinds(t, team, me, await readJson(req, 4 * 1024)));
        if (c === 'me' && !d && m === 'DELETE') return send(res, 200, await slack.unlink(t, team, me));
        if (c === 'channels' && !d && m === 'GET') return send(res, 200, await slack.channels(t, team));
        if (c === 'channels' && !d && m === 'POST') {
          const name = who.session?.name ?? who.session?.login ?? (who.via === 'admin' ? 'The admin' : '');
          return send(res, 201, await slack.addChannel(t, team, { principal: me, name }, await readJson(req, 4 * 1024)));
        }
        if (c === 'channels' && d && m === 'PATCH') return send(res, 200, await slack.setChannelKinds(t, team, d, await readJson(req, 4 * 1024)));
        if (c === 'channels' && d && m === 'DELETE') return send(res, 200, await slack.removeChannel(t, team, d));
      }
      if (b === 'sinks' && c && m === 'DELETE') { await store.removeSink(db, t, team, c); return send(res, 200, { ok: true }); }
    }
    if (members && a === 'members' && !b) {
      if (!team && m === 'GET') return send(res, 200, await members.list(who));
      if (team && m === 'PATCH') return send(res, 200, await members.update(who, team, await readJson(req, 4 * 1024), stepUp));
      if (team && m === 'DELETE') return send(res, 200, await members.remove(who, team, stepUp));
    }
    // Recovery owners (L27): who can still get in and put things right when an owner loses their way in.
    if (recovery && a === 'recovery' && !b) {
      if (!team && m === 'GET') return send(res, 200, await recovery.list(who));
      if (!team && m === 'POST') return send(res, 201, await recovery.add(who, await readJson(req, 4 * 1024), stepUp));
      if (team && m === 'DELETE') return send(res, 200, await recovery.remove(who, team, stepUp, (await readJson(req, 4 * 1024)) ?? {}));
    }
    if (members && a === 'invitations' && !b) {
      if (!team && m === 'GET') return send(res, 200, await members.invitations(who));
      if (!team && m === 'POST') return send(res, 201, await members.invite(who, await readJson(req, 4 * 1024), stepUp));
      if (team && m === 'DELETE') return send(res, 200, await members.withdraw(who, team));
    }
    // Credentials (L20): the list, Add a credential, Test connection and Remove. No route ever returns a value.
    if (a === 'credentials' && !team && m === 'GET') return send(res, 200, await vault.list(t));
    if (a === 'credentials' && !team && m === 'POST') return send(res, 201, await vault.add(t, me, await readJson(req, 20 * 1024), stepUp));
    if (a === 'credentials' && team && b === 'test' && !c && m === 'POST') return send(res, 200, await vault.test(t, me, team));
    if (a === 'credentials' && team && !b && m === 'DELETE') return send(res, 200, await vault.remove(t, me, team, stepUp));
    if (a === 'secrets' && !team && m === 'GET') return send(res, 200, { secrets: await store.listSecrets(db, t) });
    if (a === 'secrets' && team && !b && m === 'PUT') {
      const body = await readJson(req, 64 * 1024);
      await m3.requireStepUp(t, me, stepUp, 'Writing a secret');
      await store.putSecret(db, key, t, team, body?.value);
      return send(res, 200, { ok: true, name: team });
    }
    throw new Problem(404, 'not found');
  }

  const handler = (req, res) => route(req, res).catch((e) => {
    res.hold = false;
    if (res.headersSent) { res.end(); return; }
    if (e instanceof Problem) return send(res, e.status, problemBody(e), e.type ? PROBLEM_JSON : {});
    if (e?.code === '23505') return send(res, 409, { error: 'already exists' });
    console.error(e);
    send(res, 500, { error: 'something went wrong on the server' });
  });
  // Outage mode: Studio writes wait while the code host is unreachable, so nothing else would call it. The tick probes
  // it (at most every CHECK_SECONDS) until it answers, so publishing comes back on its own.
  handler.recheck = async () => { if (reach.state('code-host') === 'unreachable') await probeCodeHost(); };
  return handler;
}
