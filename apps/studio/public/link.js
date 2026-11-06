// The hosted site's landing page for a link from an email or Slack message (/teams/{team}/inbox?card=…, …): it sends
// the browser on to the right page of the Studio, the same place the local Studio's server redirects to.
import { linkHash } from './links.js';

const to = linkHash(location.pathname, location.search);
if (to) location.replace(to);
else document.getElementById('link-note').innerHTML = 'This link does not point to anything in the Studio. <a href="/">Open the Studio</a>.';
