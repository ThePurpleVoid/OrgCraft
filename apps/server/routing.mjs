// Routing a message's `to` (team-json-0.22 section 5.3, local PR L17). The server resolves it against the run's frozen
// roster, in this order, and stamps the resolved member id on the event and the delivery; it never picks silently.
//
//   1. a member id (or id#n): that member
//   2. a display name, case-insensitive exact match: that member
//   3. a type with exactly one member on: that member (every team from before 0.22)
//   4. a type with several: the one that owns a path the message names (handoff: changed and branch; bug: where)
//   5. a type with several: the one in the sender's lane
//   6. a type with several: the one the sender's structured Hands to lists
//   7. otherwise refused, listing the teammates: "support-agent has 2 teammates: support-agent-2 (Maya, reports to
//      support-lead-emea), support-agent-3 (Ana, reports to support-lead-us). Pick one."
//
// A message to a member outside the sender's Hands to is still delivered: the wiring is drawn, not a firewall. The
// result says `offWiring` so the work timeline can note it.

const typeOf = (r) => r.type ?? r.slug;

/** The executive a seat's lane hangs from: the role it reports up to that reports to the team's top role. */
export function laneOf(slug, roles) {
  const manager = new Map(roles.map((r) => [r.slug, r.reportsTo]));
  const chain = [slug];
  for (let m = manager.get(slug); m && m !== 'owner' && manager.has(m) && !chain.includes(m); m = manager.get(m)) chain.push(m);
  return chain.length >= 2 ? chain.at(-2) : slug;
}

/** Path-like words in a message's text: anything with a slash or a file extension, without quotes or punctuation. */
export function pathsIn(...texts) {
  const out = new Set();
  for (const t of texts) {
    if (typeof t !== 'string') continue;
    for (const w of t.slice(0, 20_000).split(/[\s,;()<>"'`]+/)) {
      const p = w.replace(/^\.\//, '').replace(/[.:]+$/, '');
      if (p.length > 1 && p.length <= 300 && !/^[a-z]+:\/\//i.test(p) && (p.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(p))) out.add(p);
    }
  }
  return [...out].slice(0, 200);
}

/** Does an ownership area (a path, a dir, or a glob with * and **) cover this path? */
export function covers(area, path) {
  const a = String(area).replace(/^\.\//, '');
  if (!/[*?]/.test(a)) {
    const dir = a.replace(/\/+$/, '');
    return path === dir || path.startsWith(`${dir}/`);
  }
  const re = new RegExp(`^${a.split(/(\*\*\/?|\*|\?)/).map((part) => (part === '**' || part === '**/' ? '.*' : part === '*' ? '[^/]*' : part === '?' ? '[^/]' : part.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('')}$`);
  return re.test(path);
}

/**
 * Resolves `to` for a message from `sender`. `message` is the tool input (for paths). Returns { to, how, offWiring? }
 * with `to` a member id (and `#n` when one was named), or { problem }.
 */
export function resolveTo(roster, to, sender, message = {}) {
  const roles = roster?.roles ?? [];
  const bySlug = new Map(roles.map((r) => [r.slug, r]));
  const raw = String(to ?? '').trim();
  const me = bySlug.get(sender);
  const wiring = (slug) => (Array.isArray(me?.handsTo) && me.handsTo.length && !me.handsTo.includes(slug) ? { offWiring: true } : {});
  const done = (slug, how, inst = null) => ({ to: inst ? `${slug}#${inst}` : slug, how, ...wiring(slug) });

  // 1. A member id, with or without #n.
  const [base, inst = null] = raw.split('#');
  if (bySlug.has(base)) return done(base, 'id', inst);

  // 2. A display name.
  const named = roles.filter((r) => typeof r.name === 'string' && r.name.trim().toLowerCase() === raw.toLowerCase());
  if (named.length === 1) return done(named[0].slug, 'name');
  if (named.length > 1) return { problem: `${raw} is the name of ${named.length} teammates: ${named.map((r) => describe(r)).join(', ')}. Pick one by id.` };

  // 3 to 6. A type.
  const of = roles.filter((r) => typeOf(r) === base && r.slug !== sender);
  if (!of.length) return { problem: `${raw} is not a teammate, a name or a role on this team (teammates: ${roles.map((r) => r.slug).join(', ')})` };
  if (of.length === 1) return done(of[0].slug, 'type');
  const one = (list) => (list.length === 1 ? list[0] : null);
  const paths = pathsIn(message.changed, message.branch, message.where, ...(Array.isArray(message.files) ? message.files : []));
  const owner = paths.length ? one(of.filter((r) => (r.areas ?? []).some((a) => paths.some((p) => covers(a, p))))) : null;
  if (owner) return done(owner.slug, 'ownership');
  if (me) {
    const mine = laneOf(sender, roles);
    const inLane = one(of.filter((r) => laneOf(r.slug, roles) === mine));
    if (inLane) return done(inLane.slug, 'lane');
    const wired = Array.isArray(me.handsTo) ? one(of.filter((r) => me.handsTo.includes(r.slug))) : null;
    if (wired) return done(wired.slug, 'hands-to');
  }
  return { problem: `${base} has ${of.length} teammates: ${of.map((r) => describe(r)).join(', ')}. Pick one.` };
}

const describe = (r) => `${r.slug} (${r.name ? `${r.name}, ` : ''}reports to ${r.reportsTo})`;
