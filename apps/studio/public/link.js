// The hosted site's landing page for a link from an email, a Slack message, a card or a meeting's minutes
// (/teams/{team}/inbox?card=…, /t/{team}/meetings/mtg_…, …): it sends the browser on to the right page of the Studio,
// the same place the local Studio's server redirects to.
import { linkHash, linkTeam, resolveMeeting } from './links.js';

const to = linkHash(location.pathname, location.search);
if (!to) document.getElementById('link-note').innerHTML = 'This link does not point to anything in the Studio. <a href="/">Open the Studio</a>.';
else {
  const team = encodeURIComponent(linkTeam(location.pathname));
  const lookup = async (id) => {
    const r = await fetch(`/v1/teams/${team}/meetings/${encodeURIComponent(id)}`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };
  resolveMeeting(to, lookup).then((h) => location.replace(h));
}
