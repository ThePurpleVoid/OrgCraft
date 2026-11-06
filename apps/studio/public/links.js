// The link paths that emails, Slack messages, cards and meeting notes point into the Studio (kit #101,
// apps/server/email.mjs, slack.mjs, m3.mjs, meetings.mjs), and where each lands in the Studio's page: a hash that
// app.js's setPage reads. Shared by the local Studio server and the hosted site's link.html, so both send a person to
// the same place. Pure: no DOM.
//
//   /teams/{team}/inbox?card={id}   → /#chat?card={id}     the card in the chief-of-staff chat
//   /teams/{team}/budget            → /#chat?budget        today's spend against the cap
//   /teams/{team}/board?role={slug} → /#team?role={slug}   that role, picked on the canvas
//   /teams/{team}/meetings/{id}     → /#meetings?id={id}   that meeting (a meeting's mtg_ id: see resolveMeeting)
//   /t/{team}/cards/{id}            → /#chat?card={id}     the links cards carry (m3.mjs cardUrl)
//   /t/{team}/approvals/{id}        → /#chat?card={id}     an approval card, found by its subject
//   /t/{team}/meetings/{id}         → as /teams/…/meetings  the link in a meeting's minutes (meetings.mjs)
//   /teams/{team}/notifications     → the Notifications page itself (notifications.html, hosted only)

const SLUG = /^[a-z0-9][a-z0-9_-]{0,62}$/i;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
/** A held meeting's id (meetings.mjs), not a meeting definition's. */
export const MEETING_INSTANCE = /^mtg_[A-Za-z0-9_-]+$/;

/** Where a link path lands, as '/#…', or null when it is not one of the paths above. */
export function linkHash(pathname, search = '') {
  const m = /^\/(teams|t)\/([^/]+)\/(inbox|budget|board|meetings|cards|approvals)(?:\/([^/]+))?\/?$/.exec(pathname ?? '');
  if (!m) return null;
  const [, prefix, , what] = m;
  let team, rest;
  try { team = decodeURIComponent(m[2]); rest = m[4] === undefined ? undefined : decodeURIComponent(m[4]); } catch { return null; }
  if (!SLUG.test(team)) return null;
  const q = new URLSearchParams(search);
  const one = (k) => { const v = q.get(k); return v && ID.test(v) ? encodeURIComponent(v) : null; };
  if (what === 'meetings') return rest && ID.test(rest) ? `/#meetings?id=${encodeURIComponent(rest)}` : '/#meetings';
  if (prefix === 't') {
    if (what !== 'cards' && what !== 'approvals') return null;
    return rest && ID.test(rest) ? `/#chat?card=${encodeURIComponent(rest)}` : '/#chat';
  }
  if (rest !== undefined) return null;
  if (what === 'inbox') return one('card') ? `/#chat?card=${one('card')}` : '/#chat';
  if (what === 'budget') return '/#chat?budget';
  if (what === 'board') return one('role') ? `/#team?role=${one('role')}` : '/';
  return null;
}

/** The team in a link path, or null. */
export function linkTeam(pathname) {
  const m = /^\/(?:teams|t)\/([^/]+)\//.exec(pathname ?? '');
  try { return m && SLUG.test(decodeURIComponent(m[1])) ? decodeURIComponent(m[1]) : null; } catch { return null; }
}

/**
 * A link to a held meeting (mtg_…) opens the meeting it was held from: `lookup(id)` reads it from the control plane
 * ({ definition }). Anything else, or a lookup that fails, is left as it is or falls back to the Meetings page.
 */
export async function resolveMeeting(hash, lookup) {
  const m = /^\/#meetings\?id=([^&]+)$/.exec(hash ?? '');
  const id = m && decodeURIComponent(m[1]);
  if (!id || !MEETING_INSTANCE.test(id)) return hash;
  try {
    const def = (await lookup(id))?.definition;
    return typeof def === 'string' && ID.test(def) ? `/#meetings?id=${encodeURIComponent(def)}` : '/#meetings';
  } catch { return '/#meetings'; }
}
