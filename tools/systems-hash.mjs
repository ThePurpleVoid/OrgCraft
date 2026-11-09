// canonicalSystemsHash (L40b): one hash of a team's systems (.agent-team/resources.json) that the kit's
// `report.mjs published`, the Studio and the control plane all compute the same way, so team.published can say which
// systems a commit carries and the server can apply a pending set only when they match.
//
// The hash is of the systems as the server stores them (apps/server/credentials.mjs checkSystems, without its
// validation): every default filled in and `config` left out, since the server keeps none. Normalizing twice changes
// nothing, so a raw resources.json and the server's stored row hash the same. Standalone: sync copies this file into
// scripts/agent-team/ beside report.mjs, and packages/team-model/node.mjs re-exports it.
import { createHash } from 'node:crypto';

export const SYSTEMS_HASH_VERSION = 'systems/1';
const PERMISSIONS = ['read', 'write', 'deploy'];
const list = (v) => (Array.isArray(v) ? v : []);
const map = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** The systems as the server stores them: { resources, bindings } with defaults filled in, or null when there are none. */
export function normalizeSystems(json) {
  const resources = list(json?.resources).map((r) => {
    const t = r?.tools;
    const tools = t && typeof t === 'object' ? (t.command !== undefined ? { command: t.command, args: list(t.args) } : typeof t.url === 'string' ? { url: t.url } : null) : null;
    return {
      id: r?.id, type: r?.type, ...(typeof r?.name === 'string' ? { name: r.name.slice(0, 80) } : {}), secrets: list(r?.secrets), ...(tools ? { tools } : {}),
      permissions: Object.fromEntries(PERMISSIONS.map((p) => [p, list(r?.permissions?.[p])])), effects: map(r?.effects), egress: list(r?.egress), tier: r?.tier ?? 'custom',
    };
  });
  const bindings = list(json?.bindings).map((b) => ({ role: b?.role, resource: b?.resource, permission: b?.permission }));
  return resources.length || bindings.length ? { resources, bindings } : null;
}

/** JSON with object keys sorted at every level; array order is kept (it is meaningful). */
export function canonicalJson(v) {
  return JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
}

/** sha256 (hex) of "systems/1\n" + the canonical normalized systems; null when there are none (the field is left out). */
export function canonicalSystemsHash(json) {
  const n = normalizeSystems(json);
  return n ? createHash('sha256').update(`${SYSTEMS_HASH_VERSION}\n${canonicalJson(n)}`).digest('hex') : null;
}
