// The link paths that emails and Slack messages point into the Studio (kit #101, apps/server/email.mjs), and where
// each lands in the Studio's page: a hash that app.js's setPage reads. Shared by the local Studio server and the
// hosted site's build (deploy/vercel/build.mjs), so both send a person to the same place. Pure: no DOM.
//
//   /teams/{team}/inbox?card={id}   → /#chat?card={id}     the card in the chief-of-staff chat
//   /teams/{team}/budget            → /#chat?budget        today's spend against the cap
//   /teams/{team}/board?role={slug} → /#team?role={slug}   that role, picked on the canvas
//   /teams/{team}/meetings/{id}     → /#meetings?id={id}   that meeting
//   /teams/{team}/notifications     → the Notifications page itself (notifications.html, hosted only)

const SLUG = /^[a-z0-9][a-z0-9_-]{0,62}$/i;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Where a link path lands, as '/#…', or null when it is not one of the paths above. */
export function linkHash(pathname, search = '') {
  const m = /^\/teams\/([^/]+)\/(inbox|budget|board|meetings)(?:\/([^/]+))?\/?$/.exec(pathname ?? '');
  if (!m) return null;
  let team, rest;
  try { team = decodeURIComponent(m[1]); rest = m[3] === undefined ? undefined : decodeURIComponent(m[3]); } catch { return null; }
  if (!SLUG.test(team)) return null;
  const q = new URLSearchParams(search);
  const one = (k) => { const v = q.get(k); return v && ID.test(v) ? encodeURIComponent(v) : null; };
  if (m[2] === 'inbox' && rest === undefined) return one('card') ? `/#chat?card=${one('card')}` : '/#chat';
  if (m[2] === 'budget' && rest === undefined) return '/#chat?budget';
  if (m[2] === 'board' && rest === undefined) return one('role') ? `/#team?role=${one('role')}` : '/';
  if (m[2] === 'meetings') return rest && ID.test(rest) ? `/#meetings?id=${encodeURIComponent(rest)}` : '/#meetings';
  return null;
}
