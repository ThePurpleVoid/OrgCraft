// A host site with the Studio mounted in its own admin page, for tests (docs/specs/studio-embed.md section 4): a
// strict CSP (script-src 'self', style-src 'self', no 'unsafe-inline'), the host's own header and ids that the
// Studio's could clash with (#publish, #canvas, #project), its own sign-in as a bearer token, and the Studio's files
// served from one directory as the handler serves /assets/<kit version>/.
//
// The API under /api/agent-team/studio is a local Studio server behind a small proxy that refuses what the handler
// refuses (no x-agent-team-studio header, no bearer token, a body that is not JSON) and records every request, and
// that reports the step 1 features. It stands in for createStudioHandler (kit #134) so this proves the page's side.
import { createServer, request as httpRequest } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = join(KIT, 'apps/studio/public');
const ASSETS = {
  'team-model.mjs': join(KIT, 'packages/team-model/index.mjs'),
  'model-prices.json': join(KIT, 'packages/model-prices/prices.json'),
};
const TYPES = { js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8' };
export const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
export const TOKEN = 'host-session-token';
export const BASE_PATH = '/api/agent-team/studio';
export const FEATURES = { publish: true, chat: false, runs: false, live: false };

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Admin · Team</title>
  <link rel="stylesheet" href="/host.css">
  <link rel="stylesheet" href="/assets/test/app.css">
</head>
<body>
  <header class="host-header"><span id="project">Host admin</span> <button id="publish" type="button">Host button</button> <a href="/admin">Admin home</a></header>
  <div id="canvas" class="host-note">The host's own #canvas</div>
  <main id="team"></main>
  <script type="module" src="/host.js"></script>
</body>
</html>`;

const HOST_CSS = `body { margin: 0; background: rgb(250, 240, 230); font-family: Georgia, serif; }
.host-header { height: 48px; display: flex; gap: 12px; align-items: center; padding: 0 16px; background: rgb(20, 30, 40); color: white; }
.host-header button { border-radius: 0; }
#team { --ats-vh: calc(100vh - 100px); }
`;

const HOST_JS = `import { mount } from '/assets/test/studio.js';
const el = document.getElementById('team');
window.navs = [];
const opts = {
  api: '${BASE_PATH}',
  headers: async () => ({ authorization: 'Bearer ${TOKEN}' }),
  features: ${JSON.stringify(FEATURES)},
  onNavigate: (page) => window.navs.push(page),
};
window.studio = mount(el, opts);
window.remount = () => { window.studio = mount(el, opts); };
`;

/** The host. `studio` is a listening local Studio server (apps/studio/server.mjs) and its launch token. */
export async function embedHost({ studio, launchToken }) {
  const upstream = `http://127.0.0.1:${studio.address().port}`;
  // The local Studio's own sign-in, once: its session cookie goes on every proxied request.
  const cookie = await new Promise((done, fail) => {
    httpRequest(`${upstream}/?t=${launchToken}`, (res) => { res.resume(); done(String(res.headers['set-cookie'] ?? '').split(';')[0]); }).on('error', fail).end();
  });
  const seen = []; // every API request: { method, path, studioHeader, auth, type }
  const refused = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://host');
    const send = (status, type, body, extra = {}) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra }); res.end(body); };
    if (url.pathname === '/admin/team') return send(200, 'text/html; charset=utf-8', PAGE, { 'content-security-policy': CSP });
    if (url.pathname === '/host.css') return send(200, TYPES.css, HOST_CSS);
    if (url.pathname === '/host.js') return send(200, TYPES.js, HOST_JS);
    const a = /^\/assets\/test\/([a-z0-9-]+\.(?:js|mjs|css|json))$/.exec(url.pathname);
    if (a) {
      const file = ASSETS[a[1]] ?? join(PUBLIC, a[1]);
      if (!existsSync(file)) return send(404, 'text/plain', 'not found');
      return send(200, TYPES[a[1].split('.').pop()], readFileSync(file));
    }
    if (url.pathname.startsWith(`${BASE_PATH}/v1/`)) {
      const path = url.pathname.slice(BASE_PATH.length);
      const entry = { method: req.method, path, studioHeader: req.headers['x-agent-team-studio'] ?? null, auth: req.headers.authorization ?? null, type: req.headers['content-type'] ?? null };
      seen.push(entry);
      const no = entry.studioHeader !== '1' ? 'the x-agent-team-studio header is missing' : entry.auth !== `Bearer ${TOKEN}` ? 'not signed in' : req.method === 'POST' && !String(entry.type).startsWith('application/json') ? 'send JSON' : null;
      if (no) { refused.push({ ...entry, why: no }); return send(no === 'not signed in' ? 401 : 400, TYPES.json, JSON.stringify({ error: no })); }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const up = await fetch(`${upstream}${path}${url.search}`, { method: req.method, headers: { cookie, ...(body.length ? { 'content-type': 'application/json' } : {}) }, body: body.length ? body : undefined });
      let text = await up.text();
      if (req.method === 'GET' && path === '/v1/team' && up.ok) text = JSON.stringify({ ...JSON.parse(text), features: FEATURES });
      return send(up.status, up.headers.get('content-type') ?? TYPES.json, text);
    }
    return send(404, 'text/plain', 'not found');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${server.address().port}`, seen, refused, close: () => { server.closeAllConnections?.(); server.close(); } };
}
