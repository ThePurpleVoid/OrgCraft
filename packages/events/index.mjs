// The event envelope (docs/contracts/events.md), and the exact mapping between it and the kit's board reports, so
// every team that reports today (team-status.sh, report.mjs, the hooks) is seen by the product with nothing lost,
// and a sink can hand the same events back to a board a team already runs. Pure: runs in Node and in browsers.

export const SPEC = '1.0';
export const VERSION = 1;
const MESSAGES = new Set(['handoff', 'bug', 'signoff', 'blocked']);
/** report fields that live in the envelope rather than in data */
const LIFTED = new Set(['id', 'at', 'role', 'instance', 'session', 'source', 'kind', 'to_role', 'team_version']);
const VIA = { hook: 'hook', 'team-status.sh': 'script', 'report.mjs': 'script' };

/** The event type for a kit report kind. */
export const typeOfKind = (kind) => (MESSAGES.has(kind) ? `message.${kind}` : `report.${kind}`);
export const kindOfType = (type) => (/^(report|message)\.([a-z]+)$/.exec(type) ?? [])[2] ?? null;

/**
 * A kit board row (tools/board.mjs toRow output) as an envelope. Fields that are null or empty are left out of
 * `data`, and `toKitRow` puts them back, so the round trip is exact.
 */
export function fromKitRow(row, { tenant, team }) {
  const data = {};
  for (const [k, v] of Object.entries(row)) {
    // An empty `unverified` is kept: it means "Unverified: none" (governance G1); left out means "not stated".
    if (LIFTED.has(k) || v === null || v === undefined || (Array.isArray(v) && !v.length && k !== 'unverified')) continue;
    data[k] = v;
  }
  if (row.to_role) data.to = row.to_role;
  const event = {
    specversion: SPEC,
    id: row.id,
    type: typeOfKind(row.kind),
    version: VERSION,
    source: `/tenants/${tenant}/teams/${team}`,
    tenant,
    team,
    time: row.at,
    actor: { kind: 'role', id: row.role, instance: row.instance ?? null, session: row.session ?? null, via: VIA[row.source] ?? 'api' },
    subject: `role/${row.role}`,
    data,
  };
  // The team version the role runs is the envelope's teamVersion (events.md), as for a runner's sessions.
  if (row.team_version) event.teamVersion = row.team_version;
  // The kit's own source label (team-status.sh, hook, or anything a team sends) is kept verbatim for sinks.
  if (row.source) event.data.source = row.source;
  return event;
}

/** The kit board row for a report or message event; null for any other type. */
export function toKitRow(event) {
  const kind = kindOfType(event.type);
  if (!kind) return null;
  const d = event.data ?? {};
  return {
    id: event.id,
    at: event.time,
    role: event.actor.id,
    instance: event.actor.instance ?? null,
    kind,
    status: d.status ?? null,
    task: d.task ?? null,
    issue: d.issue ?? null,
    pr: d.pr ?? null,
    branch: d.branch ?? null,
    commit: d.commit ?? null,
    platform: d.platform ?? null,
    to_role: d.to ?? null,
    severity: d.severity ?? null,
    evidence: d.evidence ?? [],
    detail: d.detail ?? null,
    source: d.source ?? 'team-status.sh',
    session: event.actor.session ?? null,
    team_version: event.teamVersion ?? null,
    // A sign-off's version fields (governance G1, kit 0.23.0), only when it has them.
    ...(kind === 'signoff' ? Object.fromEntries(['version', 'versionKind', 'result', 'unverified', 'kit'].filter((k) => d[k] !== undefined).map((k) => [k, d[k]])) : {}),
  };
}

/** The checks every stored envelope passes (schema/event.v1.json, without a JSON Schema library). Returns problems. */
export function checkEvent(e) {
  const out = [];
  if (!e || typeof e !== 'object') return ['an event is a JSON object'];
  if (e.specversion !== SPEC) out.push('specversion must be "1.0"');
  if (typeof e.id !== 'string' || !e.id || e.id.length > 80) out.push('id must be a string of 1 to 80 characters');
  if (typeof e.type !== 'string' || !/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(e.type)) out.push('type must look like area.name');
  if (!Number.isInteger(e.version) || e.version < 1) out.push('version must be a whole number from 1');
  if (typeof e.source !== 'string' || !/^\/tenants\/[^/]+(\/teams\/[^/]+)?$/.test(e.source)) out.push('source must be /tenants/{tenant}[/teams/{team}]');
  if (typeof e.tenant !== 'string' || !e.tenant) out.push('tenant is required');
  if (typeof e.time !== 'string' || Number.isNaN(Date.parse(e.time))) out.push('time must be an ISO 8601 date-time');
  if (!e.actor || !['role', 'person', 'runner', 'system'].includes(e.actor.kind) || typeof e.actor.id !== 'string' || !e.actor.id) out.push('actor needs a kind (role, person, runner, system) and an id');
  if (!e.data || typeof e.data !== 'object' || Array.isArray(e.data)) out.push('data must be an object');
  if (JSON.stringify(e).length > 65536) out.push('an event is at most 64 KiB');
  return out;
}
