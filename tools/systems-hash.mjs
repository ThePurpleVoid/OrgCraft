// canonicalSystemsHash (L40b): one hash of a team's systems (.agent-team/resources.json) that the kit's
// `report.mjs published`, the Studio and the control plane all compute the same way, so team.published can say which
// systems a commit carries and the server can apply a pending set only when they match.
//
// The hash is of the systems as the server stores them (apps/server/credentials.mjs checkSystems, without its
// validation): every default filled in, `config` left out (the server keeps none) and unordered lists sorted. Normalizing twice changes
// nothing, so a raw resources.json and the server's stored row hash the same. Standalone: sync copies this file into
// scripts/agent-team/ beside report.mjs, and packages/team-model/node.mjs re-exports it.
import { createHash } from 'node:crypto';

export const SYSTEMS_HASH_VERSION = 'systems/1';
const PERMISSIONS = ['read', 'write', 'deploy'];
const list = (v) => (Array.isArray(v) ? v : []);
/** A list whose order means nothing (secrets, egress, a permission's tools): sorted, so a reorder is the same systems. */
const set = (v) => [...list(v)].sort();
const by = (key) => (a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
const map = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/**
 * The systems as the server stores them: { resources, bindings } with defaults filled in, and every list whose order
 * means nothing sorted (resources by id, bindings by role and resource, secrets, egress, permissions); tools.args keep
 * their order. No systems (a missing file, null, an empty file) is { resources: [], bindings: [] }.
 */
export function normalizeSystems(json) {
  const resources = list(json?.resources).map((r) => {
    const t = r?.tools;
    const tools = t && typeof t === 'object' ? (t.command !== undefined ? { command: t.command, args: list(t.args) } : typeof t.url === 'string' ? { url: t.url } : null) : null;
    return {
      id: r?.id, type: r?.type, ...(typeof r?.name === 'string' ? { name: r.name.slice(0, 80) } : {}), secrets: set(r?.secrets), ...(tools ? { tools } : {}),
      permissions: Object.fromEntries(PERMISSIONS.map((p) => [p, set(r?.permissions?.[p])])), effects: map(r?.effects), egress: set(r?.egress), tier: r?.tier ?? 'custom',
    };
  }).sort(by((r) => String(r.id)));
  const bindings = list(json?.bindings).map((b) => ({ role: b?.role, resource: b?.resource, permission: b?.permission })).sort(by((b) => `${b.role}\u0000${b.resource}`));
  return { resources, bindings };
}

/** JSON with object keys sorted at every level; array order is kept (it is meaningful). */
export function canonicalJson(v) {
  return JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
}

/**
 * sha256 (hex) of "systems/1\n" + the canonical normalized systems. Always a hash: no systems is the empty set's hash,
 * so a change that removes every system still matches its pending set. (A team.published without the field is from
 * an older kit.)
 */
export function canonicalSystemsHash(json) {
  return createHash('sha256').update(`${SYSTEMS_HASH_VERSION}\n${canonicalJson(normalizeSystems(json))}`).digest('hex');
}
