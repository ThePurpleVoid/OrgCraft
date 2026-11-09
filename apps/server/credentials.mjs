// The credentials vault (L20, F4; vision areas 6 and 7; connectors.md "Values live in the vault and are released only
// to a session whose role is bound to the resource").
//
//   GET    /v1/credentials               admin: the list (never a value): name, service, health, last used, who uses it
//   POST   /v1/credentials               admin + step-up scoped credential:<name>: { name, service, value, teams, label? }
//   POST   /v1/credentials/{id}/test     admin: Test connection, server side, through the outbound pacing
//   DELETE /v1/credentials/{id}          admin + step-up scoped credential:<name>: removes it and its sealed value
//
// No route a session token, a host or a person can call ever returns a value. A value leaves the vault only through
// release(): to the runner's sidecar (secret.get, for a local MCP server) or the gateway (in process, for a remote one),
// for a session that is live in a running run, whose role the run's frozen roster binds to a resource listing the
// name, and when the credential is granted to the team. Every release is an audit row, without the value.
import { randomBytes } from 'node:crypto';
import { Problem, getTeam, putSecret, readSecret } from './store.mjs';

const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const SERVICE = /^[a-z0-9][a-z0-9.-]{0,39}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,59}$/;
const RESOURCE = /^[a-z0-9][a-z0-9_-]{0,59}$/;
const PERMISSIONS = ['read', 'write', 'deploy'];
const EFFECTS = ['read', 'write', 'send', 'destructive', 'payment', 'deploy'];
const TIERS = ['verified', 'community', 'custom'];
const LIVE_SESSION = ['starting', 'running', 'idle', 'waiting'];
const rid = () => `cred_${randomBytes(12).toString('base64url')}`;
/** The step-up scope for adding or removing one credential (ADR 0013: the step-up names the change). */
export const credentialScope = (name) => `credential:${name}`;

/**
 * The systems part of a run's roster (resources.json, frozen at run start like the roles): each resource with its
 * MCP server (a local `command` or a remote `url`), the tools each permission grants, effects, egress, tier and the
 * secret names it needs; and which member is bound to which resource with which permission. Names only, never values.
 */
export function checkSystems(team, roles) {
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
  const members = new Set(roles.map((r) => r.slug));
  const seen = new Set();
  const bound = bindings.map((b) => {
    if (!b || !SLUG.test(b.role ?? '') || !members.has(b.role)) throw new Problem(400, `binding ${b?.role ?? '?'}: role is a member of the team`);
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

  const view = (r, names, usedBy) => ({
    id: r.id, name: r.name, label: r.label ?? r.name, service: r.service, auth: r.auth, teams: r.teams,
    createdBy: r.created_by, createdByName: names.get(r.created_by) ?? null, createdAt: new Date(r.created_at).toISOString(),
    lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
    health: r.last_test ? { ok: r.last_test.ok, at: r.last_test.at, detail: r.last_test.detail ?? null } : null,
    usedBy: usedBy.get(r.id) ?? [],
  });

  async function list(tenant) {
    const [rows, uses] = await db.tenant(tenant, async ({ q }) => [
      await q('select * from credentials where removed_at is null order by name'),
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
    const teams = b.teams ?? [];
    if (!Array.isArray(teams) || teams.length > 200 || teams.some((t) => typeof t !== 'string')) throw new Problem(400, 'teams lists the teams that may use it');
    for (const t of teams) await getTeam(db, tenant, t);
    // ADR 0013: adding a way into a system is a capability change; the step-up names this credential.
    await m3.requireStepUp(tenant, who, stepUp, 'Adding a credential', credentialScope(b.name));
    const id = rid();
    await m3.tx(tenant, async (ctx) => {
      const [dupe] = await ctx.q('select id from credentials where name = $1 and removed_at is null', [b.name]);
      if (dupe) throw new Problem(409, `${b.name} is already a credential; remove it first to replace it`, { type: 'already' });
      await ctx.q('insert into credentials(id, tenant, name, label, service, auth, teams, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8)',
        [id, tenant, b.name, b.label ?? null, b.service, 'key', [...new Set(teams)], who]);
      await ctx.audit({ actorKind: 'person', actorId: who, action: 'credential', target: id, decision: 'allowed', detail: { op: 'add', name: b.name, service: b.service, teams } });
    });
    await putSecret(db, key, tenant, b.name, b.value);
    return { id, name: b.name, service: b.service, teams: [...new Set(teams)] };
  }

  async function one(tenant, id) {
    const [r] = await db.tenant(tenant, ({ q }) => q('select * from credentials where id = $1 and removed_at is null', [id]));
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
      const value = await readSecret(db, key, tenant, r.name);
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
      const gone = await ctx.q('update credentials set removed_at = $2, removed_by = $3 where id = $1 and removed_at is null returning id', [id, ctx.now, who]);
      if (!gone.length) throw new Problem(404, 'no such credential');
      await ctx.q('delete from secrets where name = $1', [r.name]);
      await ctx.audit({ actorKind: 'person', actorId: who, action: 'credential', target: id, decision: 'allowed', detail: { op: 'remove', name: r.name } });
    });
    return { id, removed: true };
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
      const sys = systemsFor(s.roster, s.role);
      if (!sys.secrets.includes(name)) return deny('not-bound');
      if (server && !(sys.mcp[server]?.secrets ?? []).includes(name)) return deny('not-this-server');
      const [c] = await q('select id, teams from credentials where name = $1 and removed_at is null', [name]);
      if (!c) return deny('no-credential');
      if (!c.teams.includes(s.team)) return deny('not-granted');
      await q('update credentials set last_used_at = now() where id = $1', [c.id]);
      await q("insert into audit(tenant, team, actor_kind, actor_id, session, action, target, decision, rule, detail) values ($1, $2, 'system', 'vault', $3, 'secret.release', $4, 'allowed', $5, $6)",
        [tenant, s.team, session, c.id, purpose, { name, purpose, team: s.team, role: s.role, ...(server ? { server } : {}) }]);
      return c;
    });
    if (!found) return null;
    const value = await readSecret(db, key, tenant, name);
    return value ? { name, value } : null;
  }

  return { list, add, test, remove, release };
}
