// The credentials vault (L20, F4; vision areas 6 and 7; connectors.md "Values live in the vault and are released only
// to a session whose role is bound to the resource").
//
//   GET    /v1/credentials               admin: the list (never a value): name, service, health, last used, who uses it
//   POST   /v1/credentials               admin + step-up scoped credential:<name>: { name, service, value, grants, label? }
//   POST   /v1/credentials/{id}/test     admin: Test connection, server side, through the outbound pacing
//   DELETE /v1/credentials/{id}          admin + step-up scoped credential:<name>: removes it and its sealed value
//   GET    /v1/teams/{team}/systems      viewer: the team's resources and bindings (names only)
//   PUT    /v1/teams/{team}/systems      admin + step-up scoped systems:<team>: sets them, audited with the diff
//
// No route a session token, a host or a person can call ever returns a value. A value leaves the vault only through
// release(): to the runner's sidecar (secret.get, for a local MCP server) or the gateway (in process, for a remote one),
// for a session that is live in a running run, whose role the run's frozen systems bind to a resource listing the
// name, when that resource is of the credential's service and the credential is granted to that team and resource.
// The frozen systems come from team_systems, which only an admin sets (with a step-up); never from a run request.
// Every release is an audit row, without the value.
import { randomBytes } from 'node:crypto';
import { Problem, getTeam } from './store.mjs';
import { seal, unseal } from './vault.mjs';
import { canonicalSystemsHash } from '../../packages/team-model/node.mjs';

const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const SERVICE = /^[a-z0-9][a-z0-9.-]{0,39}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,59}$/;
const RESOURCE = /^[a-z0-9][a-z0-9_-]{0,59}$/;
const PERMISSIONS = ['read', 'write', 'deploy'];
const EFFECTS = ['read', 'write', 'send', 'destructive', 'payment', 'deploy'];
const TIERS = ['verified', 'community', 'custom'];
const LIVE_SESSION = ['starting', 'running', 'idle', 'waiting'];
const rid = () => `cred_${randomBytes(12).toString('base64url')}`;
/** The columns a credential is read with everywhere but the vault's own unseal: never `sealed`. */
const COLS = 'id, name, label, service, auth, grants, created_by, created_at, last_used_at, last_test, removed_at, removed_by';
const sealName = (id) => `credential/${id}`;
/** The step-up scope for adding or removing one credential (ADR 0013: the step-up names the change). */
export const credentialScope = (name) => `credential:${name}`;
/** The step-up scope for changing a team's systems: what its sessions can reach, and with which secrets. */
export const systemsScope = (team) => `systems:${team}`;
const SHA = /^[0-9a-f]{40}$/;
/** How long a pending systems set waits for its pull request to merge (L40b). */
const PENDING_DAYS = 30;
const GRANT = /^[a-z0-9][a-z0-9-]{0,62}\/[a-z0-9][a-z0-9_-]{0,59}$/;

/**
 * The systems part of a run's roster (resources.json, frozen at run start like the roles): each resource with its
 * MCP server (a local `command` or a remote `url`), the tools each permission grants, effects, egress, tier and the
 * secret names it needs; and which member is bound to which resource with which permission. Names only, never values.
 */
export function checkSystems(team, roles = null) {
  const resources = team.resources ?? [];
  const bindings = team.bindings ?? [];
  if (!Array.isArray(resources) || resources.length > 50) throw new Problem(400, 'team.resources is a list of at most 50 resources');
  if (!Array.isArray(bindings) || bindings.length > 500) throw new Problem(400, 'team.bindings is a list of at most 500 bindings');
  const ids = new Set();
  const out = resources.map((r) => {
    if (!r || typeof r !== 'object' || !RESOURCE.test(r.id ?? '') || ids.has(r.id)) throw new Problem(400, 'every resource has a unique id (lowercase letters, digits, - and _)');
    ids.add(r.id);
    const at = `resource ${r.id}`;
    if (typeof r.type !== 'string' || !SERVICE.test(r.type)) throw new Problem(400, `${at}: type names a connector, like slack`);
    const secrets = r.secrets ?? [];
    if (!Array.isArray(secrets) || secrets.length > 20 || secrets.some((s) => typeof s !== 'string' || !NAME.test(s))) throw new Problem(400, `${at}: secrets is a list of at most 20 names (UPPER_SNAKE_CASE), never values`);
    let tools = null;
    if (r.tools !== undefined && r.tools !== null) {
      const t = r.tools;
      if (typeof t !== 'object') throw new Problem(400, `${at}: tools is { command, args } or { url }`);
      if (t.command !== undefined) {
        if (typeof t.command !== 'string' || !t.command || t.command.length > 200) throw new Problem(400, `${at}: tools.command is the server's program`);
        const args = t.args ?? [];
        if (!Array.isArray(args) || args.length > 50 || args.some((a) => typeof a !== 'string' || a.length > 500)) throw new Problem(400, `${at}: tools.args is a list of at most 50 strings`);
        tools = { command: t.command, args };
      } else if (typeof t.url === 'string') {
        let u;
        try { u = new URL(t.url); } catch { throw new Problem(400, `${at}: tools.url is a URL`); }
        if (u.protocol !== 'https:' || u.username || u.password) throw new Problem(400, `${at}: tools.url is an https:// URL with no credentials in it`);
        tools = { url: t.url };
      } else throw new Problem(400, `${at}: tools is { command, args } or { url }`);
    }
    const globs = (v, what) => {
      if (v === undefined || v === null) return [];
      if (!Array.isArray(v) || v.length > 200 || v.some((x) => typeof x !== 'string' || !x || x.length > 128)) throw new Problem(400, `${at}: ${what} is a list of tool names or globs`);
      return v;
    };
    const permissions = Object.fromEntries(PERMISSIONS.map((p) => [p, globs(r.permissions?.[p], `permissions.${p}`)]));
    const effects = r.effects ?? {};
    if (typeof effects !== 'object' || Array.isArray(effects) || Object.keys(effects).length > 200 || Object.entries(effects).some(([k, v]) => !k || k.length > 128 || !EFFECTS.includes(v))) throw new Problem(400, `${at}: effects maps tool names or globs to ${EFFECTS.join(', ')}`);
    const egress = globs(r.egress, 'egress');
    if (r.tier !== undefined && !TIERS.includes(r.tier)) throw new Problem(400, `${at}: tier is ${TIERS.join(', ')}`);
    return { id: r.id, type: r.type, ...(typeof r.name === 'string' ? { name: r.name.slice(0, 80) } : {}), secrets, ...(tools ? { tools } : {}), permissions, effects, egress, tier: r.tier ?? 'custom' };
  });
  const members = roles ? new Set(roles.map((r) => r.slug)) : null;
  const seen = new Set();
  const bound = bindings.map((b) => {
    if (!b || !SLUG.test(b.role ?? '') || (members && !members.has(b.role))) throw new Problem(400, `binding ${b?.role ?? '?'}: role is a member of the team`);
    if (!ids.has(b.resource)) throw new Problem(400, `binding ${b.role}: resource ${b.resource} is not one of team.resources`);
    if (!PERMISSIONS.includes(b.permission)) throw new Problem(400, `binding ${b.role} → ${b.resource}: permission is read, write or deploy`);
    const k = `${b.role}\0${b.resource}`;
    if (seen.has(k)) throw new Problem(400, `${b.role} is bound to ${b.resource} twice`);
    seen.add(k);
    return { role: b.role, resource: b.resource, permission: b.permission };
  });
  return out.length || bound.length ? { resources: out, bindings: bound } : null;
}

/**
 * A run's frozen systems from the team's stored ones: the bindings of members in this run only. Null when there are
 * none. The stored ones were checked when an admin set them.
 */
export function freezeSystems(row, roles) {
  if (!row) return null;
  const members = new Set(roles.map((r) => r.slug));
  const bindings = (row.bindings ?? []).filter((b) => members.has(b.role));
  return row.resources?.length || bindings.length ? { version: row.version, resources: row.resources ?? [], bindings } : null;
}

/** The resources the frozen systems bind a member to, each with the permission. */
function boundTo(roster, role) {
  const sys = roster?.systems;
  if (!sys) return [];
  const byId = new Map(sys.resources.map((r) => [r.id, r]));
  return sys.bindings.filter((b) => b.role === role && byId.has(b.resource)).map((b) => byId.get(b.resource));
}

/**
 * What a member's session gets from the frozen roster: `mcp` (one server per bound resource that has one, with the
 * tools its permission grants: read, or read and write, or all three) and `secrets` (every name its bound resources
 * list). secret.get and the gateway check names against this, never against the request.
 */
export function systemsFor(roster, role) {
  const sys = roster?.systems;
  if (!sys) return { mcp: {}, secrets: [] };
  const byId = new Map(sys.resources.map((r) => [r.id, r]));
  const mcp = {};
  const secrets = new Set();
  for (const b of sys.bindings.filter((x) => x.role === role)) {
    const r = byId.get(b.resource);
    if (!r) continue;
    for (const s of r.secrets) secrets.add(s);
    if (!r.tools) continue;
    const upTo = PERMISSIONS.slice(0, PERMISSIONS.indexOf(b.permission) + 1);
    mcp[r.id] = { ...r.tools, tools: [...new Set(upTo.flatMap((p) => r.permissions[p]))], secrets: r.secrets, effects: r.effects, egress: r.egress, tier: r.tier };
  }
  return { mcp, secrets: [...secrets].sort() };
}

/**
 * Test connection probes, one per service: a cheap read that proves the key works. Each answers { ok, detail }, where
 * detail is the service's short word for it, never the value. A service with none answers "no test".
 */
export const PROBES = {
  slack: async (value, send) => {
    const res = await send('https://slack.com/api/auth.test', { method: 'POST', headers: { authorization: `Bearer ${value}`, 'content-type': 'application/x-www-form-urlencoded' }, body: '' });
    const b = await res.json().catch(() => ({}));
    return b.ok === true ? { ok: true, detail: `signed in to ${String(b.team ?? 'Slack').slice(0, 60)}` } : { ok: false, detail: String(b.error ?? `HTTP ${res.status}`).slice(0, 80) };
  },
  github: async (value, send) => {
    const res = await send('https://api.github.com/user', { headers: { authorization: `Bearer ${value}`, accept: 'application/vnd.github+json', 'user-agent': 'OrgCraft' } });
    const b = await res.json().catch(() => ({}));
    return res.status === 200 ? { ok: true, detail: `signed in as ${String(b.login ?? 'GitHub').slice(0, 60)}` } : { ok: false, detail: `HTTP ${res.status}` };
  },
  stripe: async (value, send) => {
    const res = await send('https://api.stripe.com/v1/balance', { headers: { authorization: `Bearer ${value}` } });
    return res.status === 200 ? { ok: true, detail: 'the key works' } : { ok: false, detail: `HTTP ${res.status}` };
  },
};

/** What a systems change does, for its audit row and the answer: resources and bindings in and out, and commands. */
function systemsDiff(prev, next) {
  const was = new Map((prev?.resources ?? []).map((r) => [r.id, JSON.stringify(r)]));
  const now = new Map(next.resources.map((r) => [r.id, JSON.stringify(r)]));
  const key = (b) => `${b.role} → ${b.resource} (${b.permission})`;
  const wasB = new Set((prev?.bindings ?? []).map(key));
  const nowB = new Set(next.bindings.map(key));
  return {
    added: [...now.keys()].filter((k) => !was.has(k)), removed: [...was.keys()].filter((k) => !now.has(k)),
    changed: [...now.keys()].filter((k) => was.has(k) && was.get(k) !== now.get(k)),
    bound: [...nowB].filter((k) => !wasB.has(k)), unbound: [...wasB].filter((k) => !nowB.has(k)),
    // Every command that will be started with secrets: what an admin agreed to run with them.
    commands: next.resources.filter((r) => r.tools?.command && r.secrets.length).map((r) => ({ id: r.id, command: r.tools.command, args: r.tools.args, secrets: r.secrets })),
  };
}

/** Writes a team's systems inside a transaction (prev read FOR UPDATE by the caller), with the audit row. */
async function writeSystems(ctx, team, prev, next, who, extra = {}) {
  const diff = systemsDiff(prev, next);
  const version = (prev?.version ?? 0) + 1;
  await ctx.q(`insert into team_systems(tenant, team, resources, bindings, version, updated_by, updated_at) values ($1, $2, $3, $4, $5, $6, $7)
               on conflict (tenant, team) do update set resources = excluded.resources, bindings = excluded.bindings, version = excluded.version, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    [ctx.tenant, team, JSON.stringify(next.resources), JSON.stringify(next.bindings), version, who, ctx.now]);
  await ctx.audit({ team, actorKind: 'person', actorId: who, action: 'team.systems', target: team, decision: 'allowed', detail: { version, ...extra, ...diff } });
  return { version, ...diff };
}

/** Drops a team's pending systems, audited, and tells the team's clients so the Studio can show the owner (L40b). */
async function dropPendingIn(ctx, team, p, why, by = null) {
  await ctx.q('delete from team_systems_pending where team = $1', [team]);
  await ctx.audit({ team, actorKind: by ? 'person' : 'system', actorId: by ?? 'control-plane', action: 'team.systems.pending', target: team, decision: why === 'withdrawn' ? 'withdrawn' : 'refused', rule: why, detail: { sha: p.sha, pr: p.pr } });
  await ctx.emit?.(team, 'systems.pending.dropped', { sha: p.sha, pr: p.pr ?? null, reason: why }, by ? { actor: { kind: 'person', id: by } } : {});
}

/** Drops an expired pending set; true when one was dropped. */
export async function expirePending(ctx, team) {
  const [p] = await ctx.q('select sha, pr, expires_at from team_systems_pending where team = $1 for update', [team]);
  if (!p || new Date(p.expires_at).getTime() > ctx.now.getTime()) return false;
  await dropPendingIn(ctx, team, p, 'expired');
  return true;
}

/**
 * L40b: makes a team's pending systems its systems, only on a publish the server itself vouches for (security sev2):
 * a managed change it fast-forwarded (`shas`: the change's head and the commit main moved to), or an admin's
 * "Switch on now" with a fresh step-up after the pull request merged (`shas` null). Never on a report-token or posted
 * team.published, which any teammate can send. Only when the base it was confirmed against has not moved (else it
 * is dropped and the owner told). Runs inside a transaction.
 */
export async function activatePending(ctx, team, { shas = null, via, by = null, ciReported = null } = {}) {
  const [p] = await ctx.q('select sha, pr, resources, bindings, expect, created_by, expires_at from team_systems_pending where team = $1 for update', [team]);
  if (!p) return null;
  if (new Date(p.expires_at).getTime() <= ctx.now.getTime()) { await dropPendingIn(ctx, team, p, 'expired'); return null; }
  const [prev] = await ctx.q('select resources, bindings, version from team_systems where team = $1 for update', [team]);
  if ((prev?.version ?? 0) !== p.expect) { await dropPendingIn(ctx, team, p, 'base-moved'); return null; }
  if (shas && !shas.includes(p.sha)) return null;
  await ctx.q('delete from team_systems_pending where team = $1', [team]);
  // Recorded as the admin who confirmed it (and who switched it on, when that was a person), with its commit.
  return writeSystems(ctx, team, prev, { resources: p.resources, bindings: p.bindings }, p.created_by, { sha: p.sha, pr: p.pr, via, ...(by ? { switchedOnBy: by } : {}), ...(ciReported !== null ? { ciReported } : {}) });
}

/**
 * Test connection through the gateway (L20g): the probe is an effect keyed test:<credential>:<minute>, so a double
 * tap sends one call and answers the second with the first's status and body; GitHub calls are paced on the
 * installation and tenant (wrapFetch). An effect whose outcome is unknown is not sent again.
 */
export function probeThrough(gateway, m3, send = fetch) {
  if (!gateway) return null;
  return async (url, init, { tenant, key }) => {
    const b = (await m3.tx(tenant, (ctx) => gateway.begin(ctx, { key, tool: 'credential.test' }))).result;
    if (b.state === 'repeat') return new Response(b.result?.body ?? '{}', { status: b.result?.status ?? 200 });
    if (b.state !== 'first') return new Response(JSON.stringify({ error: 'unknown' }), { status: 409 });
    const go = String(url).startsWith('https://api.github.com/') ? gateway.wrapFetch(send, () => ({ tenant })) : send;
    let res, body;
    try {
      res = await go(url, { ...init, signal: AbortSignal.timeout(10_000) });
      body = (await res.text()).slice(0, 2000);
    } catch (e) { await m3.tx(tenant, (ctx) => gateway.end(ctx, { key, ok: false })); throw e; }
    await m3.tx(tenant, (ctx) => gateway.end(ctx, { key, ok: res.ok, result: { status: res.status, body } }));
    return new Response(body, { status: res.status });
  };
}

/**
 * `outbound(url, init, { tenant, key })` makes the probe's call: the gateway's pacing (L20g) when it is wired, else
 * fetch. A test within a minute of the last one answers that one again, so a double tap sends one probe.
 */
export function createVault({ db, key, m3, now = () => new Date(), outbound = null, probes = PROBES, fetch: send = fetch }) {
  const out = outbound ?? ((url, init) => send(url, { ...init, signal: AbortSignal.timeout(10_000) }));

  async function namesOf(tenant, ids) {
    const want = [...new Set(ids.filter((x) => typeof x === 'string' && x.startsWith('per_')))];
    if (!want.length) return new Map();
    const rows = await db.system(`select distinct p.id, coalesce(nullif(p.name, ''), p.login) as name from people p
      join members m on m.person = p.id and m.tenant = $1 where p.id = any($2)`, [tenant, want]);
    return new Map(rows.map((x) => [x.id, x.name]));
  }

  const grantOf = (g) => ({ team: g.slice(0, g.indexOf('/')), resource: g.slice(g.indexOf('/') + 1) });
  const view = (r, names, usedBy) => ({
    id: r.id, name: r.name, label: r.label ?? r.name, service: r.service, auth: r.auth, grants: r.grants.map(grantOf),
    createdBy: r.created_by, createdByName: names.get(r.created_by) ?? null, createdAt: new Date(r.created_at).toISOString(),
    lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
    health: r.last_test ? { ok: r.last_test.ok, at: r.last_test.at, detail: r.last_test.detail ?? null } : null,
    usedBy: usedBy.get(r.id) ?? [],
  });

  async function list(tenant) {
    const [rows, uses] = await db.tenant(tenant, async ({ q }) => [
      await q(`select ${COLS} from credentials where removed_at is null order by name`),
      // Who used each one in the last 30 days: from the release audit, never from what anyone claims.
      await q(`select target as id, detail->>'team' as team, detail->>'role' as role, max(at) as at from audit
        where action = 'secret.release' and decision = 'allowed' and at > now() - interval '30 days' group by 1, 2, 3 order by 4 desc`),
    ]);
    const usedBy = new Map();
    for (const u of uses) usedBy.set(u.id, [...(usedBy.get(u.id) ?? []), { team: u.team, role: u.role, at: new Date(u.at).toISOString() }]);
    const names = await namesOf(tenant, rows.map((r) => r.created_by));
    return { credentials: rows.map((r) => view(r, names, usedBy)), services: Object.keys(probes) };
  }

  async function add(tenant, who, body, stepUp) {
    const b = body ?? {};
    if (typeof b.name !== 'string' || !NAME.test(b.name)) throw new Problem(400, 'name is UPPER_SNAKE_CASE, the name resources.json lists in a resource\'s secrets, like SLACK_BOT_TOKEN');
    if (typeof b.service !== 'string' || !SERVICE.test(b.service)) throw new Problem(400, 'service names the connector, like slack, github or stripe');
    if (typeof b.value !== 'string' || !b.value || b.value.length > 16 * 1024) throw new Problem(400, 'value is the key itself, at most 16 KB; it is sealed and never shown again');
    if (b.label !== undefined && b.label !== null && (typeof b.label !== 'string' || b.label.length > 80)) throw new Problem(400, 'label is a short name for people');
    const asked = b.grants ?? [];
    if (!Array.isArray(asked) || asked.length > 200 || asked.some((g) => !g || typeof g !== 'object' || !GRANT.test(`${g.team}/${g.resource}`))) throw new Problem(400, 'grants lists where it may be used: [{ team, resource }], the resource id in that team\'s systems');
    const grants = [...new Set(asked.map((g) => `${g.team}/${g.resource}`))];
    for (const t of new Set(asked.map((g) => g.team))) await getTeam(db, tenant, t);
    // ADR 0013: adding a way into a system is a capability change; the step-up names this credential.
    await m3.requireStepUp(tenant, who, stepUp, 'Adding a credential', credentialScope(b.name));
    const id = rid();
    await m3.tx(tenant, async (ctx) => {
      const [dupe] = await ctx.q('select id from credentials where name = $1 and removed_at is null', [b.name]);
      if (dupe) throw new Problem(409, `${b.name} is already a credential; remove it first to replace it`, { type: 'already' });
      // The value is sealed in the same insert: a credential is never there without its value (code review sev4).
      await ctx.q('insert into credentials(id, tenant, name, label, service, auth, grants, created_by, sealed) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [id, tenant, b.name, b.label ?? null, b.service, 'key', grants, who, seal(key, tenant, sealName(id), b.value)]);
      await ctx.audit({ actorKind: 'person', actorId: who, action: 'credential', target: id, decision: 'allowed', detail: { op: 'add', name: b.name, service: b.service, grants } });
    });
    return { id, name: b.name, service: b.service, grants: grants.map(grantOf) };
  }

  /** The one place a value is unsealed: Test connection and release, never a route's answer. */
  async function valueOf(tenant, id) {
    const [row] = await db.tenant(tenant, ({ q }) => q('select sealed from credentials where id = $1 and removed_at is null', [id]));
    return row?.sealed ? unseal(key, tenant, sealName(id), row.sealed) : null;
  }

  async function one(tenant, id) {
    const [r] = await db.tenant(tenant, ({ q }) => q(`select ${COLS} from credentials where id = $1 and removed_at is null`, [id]));
    if (!r) throw new Problem(404, 'no such credential');
    return r;
  }

  async function test(tenant, who, id) {
    const r = await one(tenant, id);
    const at = now();
    if (r.last_test?.at && at.getTime() - Date.parse(r.last_test.at) < 60_000) return { ...r.last_test, again: true };
    const probe = probes[r.service];
    let result;
    if (!probe) result = { ok: null, detail: 'no test for this service yet' };
    else {
      const value = await valueOf(tenant, id);
      if (!value) result = { ok: false, detail: 'no value stored' };
      else {
        try { result = await probe(value, (url, init) => out(url, init, { tenant, key: `test:${id}:${Math.floor(at.getTime() / 60_000)}` })); } catch (e) { result = { ok: false, detail: String(e.name === 'TimeoutError' ? 'timed out' : 'could not reach the service').slice(0, 80) }; }
      }
    }
    const last = { ok: result.ok, at: at.toISOString(), detail: result.detail };
    await m3.tx(tenant, async (ctx) => {
      await ctx.q('update credentials set last_test = $2 where id = $1', [id, JSON.stringify(last)]);
      await ctx.audit({ actorKind: 'person', actorId: who, action: 'credential', target: id, decision: 'allowed', detail: { op: 'test', ok: result.ok } });
    });
    return last;
  }

  async function remove(tenant, who, id, stepUp) {
    const r = await one(tenant, id);
    await m3.requireStepUp(tenant, who, stepUp, 'Removing a credential', credentialScope(r.name));
    await m3.tx(tenant, async (ctx) => {
      // The sealed value goes with it; the sinks' secrets are never touched (code review sev3).
      const gone = await ctx.q('update credentials set removed_at = $2, removed_by = $3, sealed = null where id = $1 and removed_at is null returning id', [id, ctx.now, who]);
      if (!gone.length) throw new Problem(404, 'no such credential');
      await ctx.audit({ actorKind: 'person', actorId: who, action: 'credential', target: id, decision: 'allowed', detail: { op: 'remove', name: r.name } });
    });
    return { id, removed: true };
  }

  async function getSystems(tenant, team) {
    await getTeam(db, tenant, team);
    const [row, p] = await db.tenant(tenant, async ({ q }) => [
      (await q('select resources, bindings, version, updated_by, updated_at from team_systems where team = $1', [team]))[0],
      (await q('select sha, pr, resources, bindings, expect, content_hash, ready_sha, ready_at, created_by, created_at, expires_at from team_systems_pending where team = $1', [team]))[0],
    ]);
    // `ready` is the CI's report that the change merged (a matching systemsHash): its word, shown as such.
    const pending = p ? { sha: p.sha, pr: p.pr, resources: p.resources, bindings: p.bindings, expect: p.expect, contentHash: p.content_hash,
      ready: p.ready_sha ? { sha: p.ready_sha, at: new Date(p.ready_at).toISOString(), by: 'ci' } : null,
      createdBy: p.created_by, createdAt: new Date(p.created_at).toISOString(), expiresAt: new Date(p.expires_at).toISOString() } : null;
    return row ? { resources: row.resources, bindings: row.bindings, version: row.version, updatedBy: row.updated_by, updatedAt: new Date(row.updated_at).toISOString(), pending } : { resources: [], bindings: [], version: 0, pending };
  }

  /**
   * Sets a team's systems (resources.json). Only an admin, with a step-up scoped systems:<team>: a resource's command
   * and the secret names it gets are the power to read a credential, so this is where that power is granted, and the
   * audit row records the diff, with every command that receives secrets (security review sev2).
   */
  async function putSystems(tenant, team, who, body, stepUp, { ifMatch = null } = {}) {
    await getTeam(db, tenant, team);
    const next = checkSystems(body ?? {}) ?? { resources: [], bindings: [] };
    // L40b: in PR mode the change waits for its pull request: `pending: { sha, pr? }` binds it to the commit, and it
    // needs the version it was confirmed against.
    const pend = body?.pending ?? null;
    if (pend !== null && (typeof pend !== 'object' || !SHA.test(String(pend.sha ?? '')) || (pend.pr !== undefined && pend.pr !== null && !(Number.isInteger(pend.pr) && pend.pr > 0)))) throw new Problem(400, 'pending is { sha, pr? }: the full commit SHA (40 lowercase hex) the change is published at, and its pull request');
    if (pend && (body.expect === undefined || body.expect === null) && !ifMatch) throw new Problem(400, 'a pending change names the version it was confirmed against: expect');
    // The version the person confirmed the change against (L40, security): `expect` in the body or If-Match. When the
    // stored set moved since, 409 with the current one, so a concurrent PUT can't change the base under a confirmation.
    const tag = ifMatch ? String(ifMatch).replace(/^W\//, '').replace(/"/g, '') : null;
    const given = body?.expect !== undefined && body?.expect !== null;
    const expect = given ? body.expect : tag !== null && /^\d{1,9}$/.test(tag) ? Number(tag) : tag !== null ? -1 : null;
    if (expect !== null && (!Number.isInteger(expect) || expect < 0)) throw new Problem(400, 'expect is the systems version you saw (0 when there were none)');
    // Checked before the step-up is spent, and again under the lock.
    if (expect !== null) {
      const [row] = await db.tenant(tenant, ({ q }) => q('select version from team_systems where team = $1', [team]));
      if ((row?.version ?? 0) !== expect) throw new Problem(409, 'the team\'s systems changed since you saw them; look again', { type: 'systems-changed', body: await getSystems(tenant, team) });
    }
    await m3.requireStepUp(tenant, who, stepUp, 'Changing what the team can reach', systemsScope(team));
    const { result } = await m3.tx(tenant, async (ctx) => {
      const [prev] = await ctx.q('select resources, bindings, version from team_systems where team = $1 for update', [team]);
      if (expect !== null && (prev?.version ?? 0) !== expect) throw new Problem(409, 'the team\'s systems changed since you saw them; look again', { type: 'systems-changed' });
      if (!pend) {
        // A direct change drops any pending one: it was confirmed against a base that is gone.
        const gone = await ctx.q('delete from team_systems_pending where team = $1 returning sha', [team]);
        return writeSystems(ctx, team, prev, next, who, gone.length ? { droppedPending: gone[0].sha } : {});
      }
      // A newer pending set replaces the older one, which is never applied.
      const [old] = await ctx.q('select sha from team_systems_pending where team = $1 for update', [team]);
      const sha = String(pend.sha);
      const contentHash = canonicalSystemsHash(next);
      await ctx.q(`insert into team_systems_pending(tenant, team, sha, pr, resources, bindings, expect, content_hash, created_by, created_at, expires_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                   on conflict (tenant, team) do update set sha = excluded.sha, pr = excluded.pr, resources = excluded.resources, bindings = excluded.bindings, expect = excluded.expect,
                     content_hash = excluded.content_hash, ready_sha = null, ready_at = null, created_by = excluded.created_by, created_at = excluded.created_at, expires_at = excluded.expires_at`,
        [tenant, team, sha, pend.pr ?? null, JSON.stringify(next.resources), JSON.stringify(next.bindings), prev?.version ?? 0, contentHash, who, ctx.now, new Date(ctx.now.getTime() + PENDING_DAYS * 86_400_000)]);
      const diff = systemsDiff(prev, next);
      await ctx.audit({ team, actorKind: 'person', actorId: who, action: 'team.systems.pending', target: team, decision: 'allowed', detail: { sha, pr: pend.pr ?? null, expect: prev?.version ?? 0, ...(old && old.sha !== sha ? { replaced: old.sha } : {}), ...diff } });
      return { version: prev?.version ?? 0, pending: { sha, pr: pend.pr ?? null, contentHash }, ...diff };
    });
    return { ...next, ...result };
  }

  /**
   * One value for one session, or null (the caller answers with a nack that says nothing more). `purpose` is sidecar
   * or gateway. Checked here, never from the request: the session is live in a running run, the frozen roster binds its
   * role to a resource listing `name`, and the credential is granted to the session's team.
   */
  async function release({ tenant, session, name, purpose, runner = null, server = null }) {
    if (typeof name !== 'string' || !NAME.test(name) || !['sidecar', 'gateway'].includes(purpose)) return null;
    const found = await db.tenant(tenant, async ({ q }) => {
      const [s] = await q(`select s.id, s.team, s.role, s.state, s.runner, r.state as run_state, r.roster from sessions s join runs r on r.id = s.run where s.id = $1`, [session]);
      const deny = async (why) => {
        await q("insert into audit(tenant, team, actor_kind, actor_id, session, action, target, decision, rule, detail) values ($1, $2, 'system', 'vault', $3, 'secret.release', $4, 'refused', $5, $6)",
          [tenant, s?.team ?? null, s ? session : null, name, why, { name, purpose }]);
        return null;
      };
      if (!s) return deny('no-session');
      if (runner && s.runner !== runner) return deny('not-this-runner');
      if (!LIVE_SESSION.includes(s.state) || s.run_state !== 'running') return deny('not-live');
      const listing = boundTo(s.roster, s.role).filter((r) => r.secrets.includes(name));
      if (!listing.length) return deny('not-bound');
      const here = server ? listing.filter((r) => r.id === server) : listing;
      if (!here.length) return deny('not-this-server');
      const [c] = await q('select id, service, grants from credentials where name = $1 and removed_at is null', [name]);
      if (!c) return deny('no-credential');
      // Security review sev2: only to a resource of the credential's own service, granted for this team's resource.
      const ofService = here.filter((r) => r.type === c.service);
      if (!ofService.length) return deny('wrong-service');
      if (!ofService.some((r) => c.grants.includes(`${s.team}/${r.id}`))) return deny('not-granted');
      await q('update credentials set last_used_at = now() where id = $1', [c.id]);
      await q("insert into audit(tenant, team, actor_kind, actor_id, session, action, target, decision, rule, detail) values ($1, $2, 'system', 'vault', $3, 'secret.release', $4, 'allowed', $5, $6)",
        [tenant, s.team, session, c.id, purpose, { name, purpose, team: s.team, role: s.role, ...(server ? { server } : {}) }]);
      return c;
    });
    if (!found) return null;
    const value = await valueOf(tenant, found.id);
    return value ? { name, value } : null;
  }

  /** The pull request closed without merging (or the person withdrew it): its pending systems are dropped. */
  async function dropPending(tenant, team, who, sha = null) {
    await getTeam(db, tenant, team);
    const { result } = await m3.tx(tenant, async (ctx) => {
      const [p] = await ctx.q('select sha, pr from team_systems_pending where team = $1 for update', [team]);
      if (!p || (sha && p.sha !== sha)) return { dropped: null };
      await dropPendingIn(ctx, team, p, 'withdrawn', who);
      return { dropped: p.sha };
    });
    return result;
  }

  /**
   * "Switch on now" (L40b): the pull request merged on the code host, which the server can't see for itself yet, so an
   * admin says so with a fresh step-up scoped to the team. Applies the pending set bound to `sha`, if its base is
   * unmoved. (When the server can check the merge through the GitHub App, that check replaces this tap.)
   */
  async function applyPending(tenant, team, who, body, stepUp) {
    await getTeam(db, tenant, team);
    const sha = String(body?.sha ?? '');
    if (!SHA.test(sha)) throw new Problem(400, 'sha is the commit the pending change is bound to');
    const [p, base] = await db.tenant(tenant, async ({ q }) => [
      (await q('select sha, expect, expires_at, ready_sha from team_systems_pending where team = $1', [team]))[0],
      (await q('select version from team_systems where team = $1', [team]))[0],
    ]);
    if (!p || p.sha !== sha) throw new Problem(409, 'no pending change for that commit', { type: 'no-pending' });
    // Checked before the step-up is spent (and again under the lock): an expired set or a moved base is dropped and
    // the person confirms again; nothing is ever written over a base they did not see.
    if (new Date(p.expires_at).getTime() <= now().getTime() || (base?.version ?? 0) !== p.expect) {
      await m3.tx(tenant, (ctx) => activatePending(ctx, team, { shas: [], via: 'switched-on' }));
      throw new Problem(409, 'the pending change could not be switched on: it expired, or the team\'s systems changed since it was confirmed; confirm it again', { type: 'pending-dropped' });
    }
    await m3.requireStepUp(tenant, who, stepUp, 'Switching on what the team can reach', systemsScope(team));
    // Allowed with or without the CI's "ready" mark (an older kit sends no systemsHash): an admin with a step-up can
    // set systems directly anyway. The audit row records whether the CI had reported the merge.
    const { result } = await m3.tx(tenant, (ctx) => activatePending(ctx, team, { shas: [sha], via: 'switched-on', by: who, ciReported: !!p.ready_sha }));
    if (!result) throw new Problem(409, 'the pending change could not be switched on: it expired, or the team\'s systems changed since it was confirmed; confirm it again', { type: 'pending-dropped' });
    return { ...result, applied: true };
  }

  /**
   * A publish reported by the repository's CI (report token: any teammate holds it, so it is a claim). With a
   * `systemsHash` equal to the pending set's, the set is marked "merged, ready" for an admin to switch on; it is never
   * applied here. The same pull request published with another hash drops the set (it merged changed). No hash (an
   * older kit, or the file did not parse) is neither a match nor a drop.
   */
  async function reported(tenant, team, { version, pr = null, systemsHash = null }) {
    if (typeof systemsHash !== 'string' || !/^[0-9a-f]{64}$/.test(systemsHash)) return null;
    const { result } = await m3.tx(tenant, async (ctx) => {
      const [p] = await ctx.q('select sha, pr, content_hash, ready_sha from team_systems_pending where team = $1 for update', [team]);
      if (!p) return null;
      if (p.content_hash === systemsHash) {
        if (p.ready_sha) return { ready: p.ready_sha };
        await ctx.q('update team_systems_pending set ready_sha = $2, ready_at = $3 where team = $1', [team, version, ctx.now]);
        await ctx.emit(team, 'systems.pending.ready', { sha: p.sha, pr: p.pr ?? null, publishedSha: version, by: 'ci' });
        return { ready: version };
      }
      if (pr && p.pr && Number(pr) === Number(p.pr)) { await dropPendingIn(ctx, team, p, 'merged-different'); return { dropped: p.sha }; }
      return null;
    });
    return result;
  }

  return { list, add, test, remove, release, getSystems, putSystems, dropPending, applyPending, reported };
}
