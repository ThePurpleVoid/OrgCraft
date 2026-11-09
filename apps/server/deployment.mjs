// Where OrgCraft runs (vision O19.1, O37.1), its runner (O19.2, one in Now) and outage mode (O37.8, the Now part).
// The data only; the Studio draws the tiles, the runner card and the banner (web-dev, L29).
//
// - Version window (CTO R13): the control plane accepts runners up to RUNNER_WINDOW minor versions behind its own.
//   An older runner is still served, so nothing it holds is lost, but its welcome says `upgrade.required` with a
//   date, and the runner card says how many versions behind it is.
// - Reachability: the code host (seen from the server's own calls to it) and the model provider (seen by each runner's
//   model proxy and reported over its link). A dependency is "unreachable" after DOWN_AFTER failures in a row and
//   "ok" again after one success. While one is unreachable, nothing that needs it goes out: publishing waits (503
//   with the reason), and new work waits in the delivery queue instead of starting on a runner that can't reach
//   the model. Nothing is dropped and no attempt is spent while waiting.
import { readFileSync } from 'node:fs';

export const SERVER_VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
export const RUNNER_WINDOW = 2;
export const DOWN_AFTER = 2;
export const UPGRADE_GRACE_DAYS = 30;
/** One manual "Check again" probe of the code host per this many seconds, per server process. */
export const CHECK_SECONDS = 30;
const STATES = new Set(['ok', 'unreachable', 'unknown']);

const parse = (v) => { const m = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+].*)?$/.exec(String(v ?? '')); return m ? m.slice(1, 4).map(Number) : null; };

/**
 * Where a runner's version sits against the control plane's: current (same minor), supported (1 to RUNNER_WINDOW
 * minors behind), upgrade-required (more, or an older major), ahead (newer than the server), or unknown.
 */
export function versionWindow(version, current = SERVER_VERSION, window = RUNNER_WINDOW) {
  const v = parse(version); const c = parse(current);
  if (!v || !c) return { status: 'unknown', behind: null, current };
  if (v[0] !== c[0]) return v[0] > c[0] ? { status: 'ahead', behind: 0, current } : { status: 'upgrade-required', behind: null, current };
  const behind = c[1] - v[1];
  if (behind < 0) return { status: 'ahead', behind: 0, current };
  return { status: behind === 0 ? 'current' : behind <= window ? 'supported' : 'upgrade-required', behind, current };
}

/** A runner's health report, reduced to what we keep: the model provider's state, its time, and a short error. */
export function cleanHealth(h) {
  const m = h && typeof h === 'object' && !Array.isArray(h) ? h.model : null;
  if (!m || typeof m !== 'object' || !STATES.has(m.state)) return {};
  const since = typeof m.since === 'string' && !Number.isNaN(Date.parse(m.since)) ? new Date(m.since).toISOString() : null;
  return { model: { state: m.state, since, provider: typeof m.provider === 'string' ? m.provider.slice(0, 40) : null, error: typeof m.error === 'string' ? m.error.slice(0, 200) : null } };
}

/** The date by which a runner behind the window must upgrade: kept once set, cleared once it is back in the window. */
export function upgradeBy(win, previous, now) {
  if (win.status !== 'upgrade-required') return null;
  if (previous && !Number.isNaN(Date.parse(previous))) return previous;
  return new Date(now.getTime() + UPGRADE_GRACE_DAYS * 86_400_000).toISOString();
}

/** Tracks whether this process can reach the dependencies it calls itself (the code host). */
export function createReachability({ now = () => new Date(), downAfter = DOWN_AFTER } = {}) {
  const deps = new Map();
  const get = (id) => { if (!deps.has(id)) deps.set(id, { id, state: 'unknown', since: null, lastOk: null, lastError: null, fails: 0 }); return deps.get(id); };
  const ok = (id) => { const d = get(id); if (d.state !== 'ok') { d.state = 'ok'; d.since = now().toISOString(); } d.fails = 0; d.lastOk = now().toISOString(); };
  const fail = (id, why) => {
    const d = get(id);
    d.fails++; d.lastError = String(why ?? 'unreachable').slice(0, 200);
    if (d.fails >= downAfter && d.state !== 'unreachable') { d.state = 'unreachable'; d.since = now().toISOString(); }
  };
  const view = (d) => ({ id: d.id, state: d.state, since: d.since, lastOk: d.lastOk, lastError: d.state === 'unreachable' ? d.lastError : null });
  return {
    ok, fail,
    state: (id) => get(id).state,
    get: (id) => view(get(id)),
    /** A fetch that records what it saw: a network error or a 5xx is a failure; any other answer means it's up. */
    wrap(id, f = globalThis.fetch) {
      return async (...args) => {
        let res;
        try { res = await f(...args); } catch (e) { fail(id, e?.cause?.code ?? e?.message); throw e; }
        if (res.status >= 500) fail(id, `HTTP ${res.status}`); else ok(id);
        return res;
      };
    },
  };
}

/** The connection state of one runner row, with its live link if any. */
export function runnerState(row, conn, now, heartbeat = 20) {
  if (row.revoked_at) return 'revoked';
  if (conn) return 'connected';
  if (!row.last_seen) return 'never-connected';
  return now.getTime() - new Date(row.last_seen).getTime() <= 3 * heartbeat * 1000 + 60_000 ? 'quiet' : 'offline';
}

/** One runner as the Studio's runner card shows it. */
export function describeRunner(row, conn, now, current = SERVER_VERSION) {
  const version = conn?.hello?.version ?? row.version ?? null;
  const win = versionWindow(version, current);
  const health = conn?.health ?? row.health ?? {};
  return {
    id: row.id, name: row.name, version, created_at: row.created_at, last_seen: row.last_seen, revoked_at: row.revoked_at,
    capabilities: row.capabilities, state: runnerState(row, conn, now),
    window: { ...win, supported: RUNNER_WINDOW, upgradeBy: win.status === 'upgrade-required' ? (row.health?.upgradeBy ?? null) : null },
    model: health.model ?? { state: 'unknown', since: null, provider: null, error: null },
  };
}

/**
 * The model provider's state across the tenant's connected runners: ok if any can reach it (work goes there),
 * unreachable if every connected runner says so, otherwise unknown.
 */
export function modelState(runners) {
  const live = runners.filter((r) => r.state === 'connected');
  if (live.some((r) => r.model.state === 'ok')) return { id: 'model', state: 'ok', provider: live.find((r) => r.model.state === 'ok').model.provider, since: null, lastError: null };
  const down = live.filter((r) => r.model.state === 'unreachable');
  if (live.length && down.length === live.length) {
    const first = down.map((r) => r.model.since).filter(Boolean).sort()[0] ?? null;
    return { id: 'model', state: 'unreachable', provider: down[0].model.provider, since: first, lastError: down[0].model.error };
  }
  return { id: 'model', state: 'unknown', provider: null, since: null, lastError: null };
}

/** Whether a live runner link can take new work: not while it says its model provider is unreachable. */
export const canWork = (conn) => conn?.health?.model?.state !== 'unreachable';

/**
 * GET /v1/deployment: the deployment tile, a runner summary, both dependencies and the outage state. Every member
 * reads it (the banner is for everyone), so it holds no runner names or ids; GET /v1/runners (admin) has those.
 */
export function deploymentView({ mode, codeHost, codeHostName = 'GitHub', runners, startedAt, region = null, db, version = SERVER_VERSION }) {
  const model = modelState(runners);
  const active = runners.filter((r) => r.state !== 'revoked');
  const behind = active.filter((r) => r.window.status === 'upgrade-required').length;
  const down = [codeHost.state === 'unreachable' ? 'code-host' : null, model.state === 'unreachable' ? 'model' : null].filter(Boolean);
  return {
    mode, version, region, startedAt, db: { kind: db.kind },
    window: { current: version, supported: RUNNER_WINDOW },
    runners: { total: active.length, connected: active.filter((r) => r.state === 'connected').length, upgradeRequired: behind },
    dependencies: [{ ...codeHost, id: 'code-host', name: codeHostName }, { ...model, name: model.provider ?? 'the model provider' }],
    outage: {
      active: down.length > 0, down,
      // What waits, so the banner can say it honestly: publishing needs the code host, new work needs the model.
      publish: down.includes('code-host') ? 'waiting' : 'ok',
      work: down.includes('model') ? 'queued' : runners.some((r) => r.state === 'connected') ? 'ok' : 'queued',
    },
  };
}
