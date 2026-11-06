# The Studio in your own app

The Studio runs on your laptop (`agent-team studio`) or inside a site you already run, behind your own sign-in. Both
are the same Studio: the same screens, and a Publish that writes byte-identical commits. On your site it reads and
publishes through a GitHub App, so your server needs no checkout and no git. The design is in
[specs/studio-embed.md](specs/studio-embed.md) and ADR 0008.

Step 1, available now: edit the team and Publish, which opens a pull request. Chat, runs and the live board on the same
page come with step 2, through the control plane.

## 1. Make a GitHub App

On GitHub, Settings → Developer settings → GitHub Apps → New GitHub App:

- Private, installed on **this one repository** only.
- Repository permissions: **Contents: read and write**, **Pull requests: read and write**, **Metadata: read**.
  Nothing else (no Workflows, Actions, Administration, Secrets or Environments). The handler refuses a token with more.
- No webhook.

Generate a private key, install the app on the repository, and note the app id and the installation id (the number at
the end of the installation's settings URL). Put them in your server's environment, for example
`AGENT_TEAM_GITHUB_APP_ID`, `AGENT_TEAM_GITHUB_APP_INSTALLATION_ID` and `AGENT_TEAM_GITHUB_APP_KEY` (the PEM; `\n`
escapes are fine).

Suggested branch ruleset on the default branch: require a pull request, and do not let the app bypass it. The Studio
only ever creates new `agent-team/…` branches; it never moves or force-pushes a ref.

## 2. Mount the handler

`createStudioHandler` is a Fetch-API handler (`Request` in, `Response` out), so it fits Next.js route handlers,
Remix, Hono, Workers or plain Node.

```js
// app/api/agent-team/studio/[...path]/route.js (Next.js App Router)
import { createStudioHandler } from 'agent-team-kit/studio/handler';
import { githubAppToken } from 'agent-team-kit/studio/github-app-token';
import { currentAdmin } from '@/lib/auth'; // your own sign-in

const studio = createStudioHandler({
  repo: 'acme/shop',
  basePath: '/api/agent-team/studio',
  allowedOrigins: ['https://admin.acme.com'],
  // Called on every request. Return { id, name } to allow, null to refuse.
  // action is 'read', 'publish', or 'publish-code' (a change to commands the team runs: gates, checks, scripts).
  authorize: async (request, action) => {
    const admin = await currentAdmin(request);
    if (!admin) return null;
    if (action === 'publish-code' && !admin.isOwner) return null;
    return { id: admin.id, name: admin.name };
  },
  getInstallationToken: githubAppToken({
    appId: process.env.AGENT_TEAM_GITHUB_APP_ID,
    installationId: process.env.AGENT_TEAM_GITHUB_APP_INSTALLATION_ID,
    privateKey: process.env.AGENT_TEAM_GITHUB_APP_KEY,
  }),
  // Optional but recommended on more than one instance: a shared counter (KV, Redis or your database).
  limiter: async (key, { limit, windowSeconds }) => true,
  logger: (entry) => console.info(JSON.stringify(entry)), // one audit line per publish; never file contents
});

export { studio as GET, studio as POST };
```

With plain Node or Express, wrap it: `import { toNodeListener } from 'agent-team-kit/studio/handler'`, then
`app.use('/api/agent-team/studio', toNodeListener(studio))`. It reads Express's `req.originalUrl`, so the handler
sees the full path; with plain `node:http`, `createServer(toNodeListener(studio))`.

Without the three variables, the handler answers `503 the GitHub App is not connected yet` and nothing else
breaks, so the page can say so.

## 3. What the handler checks

- Every `/v1` request: `authorize` (401 when it returns null for `read`, 403 for a refused action), the
  `x-agent-team-studio: 1` header, `Sec-Fetch-Site` same-origin (or absent, for clients that do not send it), and for a request with a body an `Origin` in
  `allowedOrigins` and `Content-Type: application/json`. No CORS headers are ever sent.
- The token: in memory only, scoped to this repository with exactly the three permissions. `getInstallationToken` returns `{ token, permissions, repositories }` as GitHub minted it (`githubAppToken` does); a bare token string is refused, because its reach could not be checked.
- Publish: only the team's files (`.agent-team/`, `docs/team/`, `scripts/agent-team/`, `.claude/`, `AGENTS.md`,
  `.gitignore`), on a new branch under `agent-team/`, from the commit the page read. If the default branch moved, the
  new branch is removed and the page is told to reload. A change to a command the team runs (gates, systems, `config.sh`, any script, anything under `scripts/agent-team/`, Claude Code's `.claude/settings*.json` hooks) needs `publish-code`, and
  the pull request lists every such command under "Commands this PR adds or changes". The commit ends with
  `Published-by: <name> (<id>) via Agent Team Studio`.
- Assets: `/assets/<kit version>/<name>`, only names in the packaged manifest, cached as immutable.
- Errors are plain sentences; unexpected ones go to `logger` with anything token-shaped removed.

## 4. The page

The admin page loads the Studio's assets from the handler and mounts it into an element of its own, with its API
pointed at `basePath` (from kit 0.19.0). The assets are versioned by kit release, so the page and the handler always
match:

```html
<link rel="stylesheet" href="/api/agent-team/studio/assets/<kit version>/app.css">
<div id="team-studio"></div>
<script type="module" src="/your/own/admin-team.js"></script>
```

```js
// admin-team.js, served by your site, so a strict CSP (script-src 'self') allows it
import { mount } from '/api/agent-team/studio/assets/<kit version>/studio.js';

const studio = mount(document.getElementById('team-studio'), {
  api: '/api/agent-team/studio',                                           // the handler's basePath
  headers: async () => ({ authorization: `Bearer ${await session.token()}` }), // your admin sign-in
  features: { publish: true, chat: false, runs: false, live: false },      // step 1: edit and Publish
  onNavigate: (page) => {},                                                // optional: keep your URL in step
});
// later: studio.navigate('board'); studio.destroy();
```

- `mount(el, { api, headers, features, onNavigate })` returns `{ destroy(), navigate(page) }`.
- It sizes itself to the element; set `--ats-vh` on the element to give it a height other than the viewport's.
- It needs no inline scripts or styles, so it runs under a strict Content Security Policy;
  `tests/e2e/studio-embed.e2e.mjs` mounts it over the handler that way.
- `headers` is called before each request, so a short-lived token stays fresh. The handler still checks every
  request with your `authorize`; the page only hides what a person cannot do.
- A page that loads `studio.js` with a plain module script tag can use `globalThis.AgentTeamStudio.mount` instead.

## 5. Publish through the team's deployment instead (control-plane mode)

From kit 0.21.0, a site whose team runs on a deployment of the control plane can skip its own GitHub App: the
handler sends read, preview and publish to the deployment's `/v1/teams/{team}/studio/` routes, and the deployment's
GitHub App opens the pull request (spec section 6).

1. Register your site on the deployment (an owner, with a passkey step-up): its name, origins and callback URL. You get
   a client id and a secret, shown once.
2. Your server signs your admin in through the deployment once (authorization code with PKCE, `client_secret_basic`
   and a DPoP key), and keeps the access and refresh tokens and the DPoP key server-side. The person says yes on the
   deployment's consent page, which says your site may open pull requests for them.
3. Mount the handler with `controlPlane` in place of `repo` and `getInstallationToken`:

```js
export const handler = createStudioHandler({
  basePath: '/api/agent-team/studio',
  allowedOrigins: ['https://admin.example.com'],
  authorize,                                        // your own admin sign-in, as before
  controlPlane: {
    url: 'https://teams.example.com',               // the deployment's origin
    team: 'shop',                                   // the team's name there
    hostToken: async ({ user }) => tokens.accessFor(user), // the token from step 2 (refresh it as it expires)
    dpopKey,                                        // the private key it is bound to: a KeyObject or JWK, P-256 or Ed25519
  },
});
```

- Every call carries `Authorization: DPoP <token>`, a fresh DPoP proof signed with `dpopKey` (node:crypto, no
  dependencies), and `x-agent-team-host-user` with your user's name and id. The host's cookies are never forwarded.
- Your `authorize` still decides who may read and publish on your page, first. The deployment then checks the token's
  person: the pull request and its commit are theirs, and the PR body says "Published through <your site> for
  <your user>".
- A change to the commands the team runs is never published through a site. The page says so in the Publish dialog
  and links the deployment's own Studio (`features.studio`); the handler refuses it with `type: 'publish-code'`.
- The deployment limits each site to 10 publishes in 10 minutes and 60 previews a minute; over that the handler
  passes on the 429 with `Retry-After`. A token the deployment no longer accepts answers 502 with
  `type: 'host-sign-in'`: sign your admin in through it again.
