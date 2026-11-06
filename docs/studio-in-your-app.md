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

The admin page loads the Studio's assets from the handler and mounts it into an element, pointing its API at
`basePath` (web-dev's `AgentTeamStudio.mount`, section 4 of the spec). Until the mount ships, the handler can be
exercised with any HTTP client that sends the headers above.
