// A host site with the Studio mounted in its own admin page, for tests (docs/specs/studio-embed.md section 4): a
// strict CSP (script-src 'self', style-src 'self', no 'unsafe-inline'), the host's own header and ids that the
// Studio's could clash with (#publish, #canvas, #project), and its own sign-in as a bearer token.
//
// Everything under /api/agent-team/studio is the real handler (createStudioHandler, kit #134) over the fake GitHub
// (tests/fake-github.mjs): the Studio's files from /assets/<kit version>/, and the API, whose authorize() accepts only
// the host's bearer token. Every API request is recorded.
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KIT } from '../../bin/agent-team.mjs';
import { createStudioHandler, toNodeListener } from '../../apps/studio/handler.mjs';
import { VERSION } from '../../apps/studio/core.mjs';
import { fakeGitHub } from '../fake-github.mjs';

export const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
export const TOKEN = 'host-session-token';
export const BASE_PATH = '/api/agent-team/studio';
export const FEATURES = { publish: true, chat: false, runs: false, live: false };
const ASSETS = `${BASE_PATH}/assets/${VERSION}`;

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Admin · Team</title>
  <link rel="stylesheet" href="/host.css">
  <link rel="stylesheet" href="${ASSETS}/app.css">
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

const HOST_JS = `import { mount } from '${ASSETS}/studio.js';
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
// ?race: what React StrictMode does in development, mount, clean up and mount again before the first read is back.
if (new URLSearchParams(location.search).has('race')) { window.studio.destroy(); window.remount(); }
`;

const git = (root, ...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A repository with a minimal team (or none), as the bare "GitHub" copy the fake serves. */
function repository({ team = true } = {}) {
  const seed = mkdtempSync(join(tmpdir(), 'embed-seed-'));
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'config', 'user.email', 's@example.com'); git(seed, 'config', 'user.name', 'Seed'); git(seed, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(seed, 'README.md'), '# Sample app\n');
  if (team) execFileSync(process.execPath, [join(KIT, 'bin/agent-team.mjs'), 'init', '--preset', 'minimal', '--project', 'Sample app', '--owner', 'Sam', '--timezone', 'UTC', '--dir', seed], { stdio: 'ignore' });
  git(seed, 'add', '-A'); git(seed, 'commit', '-q', '-m', 'start');
  const bare = mkdtempSync(join(tmpdir(), 'embed-bare-'));
  execFileSync('git', ['clone', '-q', '--bare', seed, bare]);
  return bare;
}

/** The host; `team: false` for a repository with no team yet. Returns { origin, seen, refused, gh, close }. */
export async function embedHost({ team = true } = {}) {
  const gh = await fakeGitHub({ bare: repository({ team }) });
  const seen = []; // every API request: { method, path, studioHeader, auth, type }
  const refused = []; // what authorize() turned away
  let api = null;
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://host');
    const send = (status, type, body, extra = {}) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra }); res.end(body); };
    if (url.pathname === '/admin/team') return send(200, 'text/html; charset=utf-8', PAGE, { 'content-security-policy': CSP });
    if (url.pathname === '/host.css') return send(200, 'text/css; charset=utf-8', HOST_CSS);
    if (url.pathname === '/favicon.ico') return send(204, 'image/x-icon', ''); // Chromium asks by itself
    if (url.pathname === '/host.js') return send(200, 'text/javascript; charset=utf-8', HOST_JS);
    if (url.pathname.startsWith(`${BASE_PATH}/`)) {
      if (url.pathname.startsWith(`${BASE_PATH}/v1/`)) seen.push({ method: req.method, path: url.pathname.slice(BASE_PATH.length), studioHeader: req.headers['x-agent-team-studio'] ?? null, auth: req.headers.authorization ?? null, type: req.headers['content-type'] ?? null });
      return api(req, res);
    }
    return send(404, 'text/plain', 'not found');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  api = toNodeListener(createStudioHandler({
    repo: 'acme/shop', basePath: BASE_PATH, allowedOrigins: [origin], api: gh.url,
    authorize: async (request, action) => {
      if (request.headers.get('authorization') === `Bearer ${TOKEN}`) return { id: 'u_host', name: 'Host admin' };
      refused.push({ path: new URL(request.url).pathname, action });
      return null;
    },
    getInstallationToken: async () => ({ token: 'ghs_fake', permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' }, repositories: ['acme/shop'] }),
    limiter: async () => true, logger: () => {},
  }));
  return { origin, seen, refused, gh, close: () => { server.closeAllConnections?.(); server.close(); gh.close(); } };
}
