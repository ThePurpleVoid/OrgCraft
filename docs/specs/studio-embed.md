# Spec: one Studio, local or deployed, and mounted in your own app

Status: proposed, 2026-11-06. Owner: architect. Issue: #123. Decision: [ADR 0008](../adr/0008-studio-mounts-in-the-host-app.md). Security review: requested.

The goal: a company's admin site mounts the Studio. Its people edit the team there and press Publish, and a pull request appears on the repository. The same Studio also runs locally and as a deployment's standalone page. It has one UI and one publish result in every mode. Nothing here is specific to any product. "Host" means the customer's app that mounts the Studio.

## 1. Modes

| Mode | Backend | Who signs people in | GitHub credential | Control plane |
| --- | --- | --- | --- | --- |
| **Local** (`agent-team studio`, today) | `local`: `git` and `gh` on the machine | The launch token (ADR 0003) | The machine's own (git credential helper, `gh`) | Optional, as today |
| **Mounted** in a host app | `github`, through `createStudioHandler` in the host's server | The host's admin auth (`authorize`) | The host's own GitHub App, minted per request on the host's server (section 7) | Step 1: none. Step 2: through the same handler (section 6) |
| **Hosted**, a deployment's own Studio page | `github`, the same handler, served by the deployment | The deployment's sign-in (ADR 0007) | The deployment's M4 GitHub App | Yes |

**Same everywhere.** The front end is the same build. Publish writes byte-identical files and opens a pull request. No feature is designed to work in only one mode (ADR 0005). Step 1 ships the mounted mode without chat, runs and the live board, because those need the control plane. Step 2 closes that gap, and the front end hides a feature only while its backend is missing (`features`, section 4).

## 2. The backend interface

Sync is **not** a backend operation. The shared core runs it in a temp dir in every mode, and that shared code is what makes the output byte-identical. A backend only does repository I/O:

```js
/** @typedef {{ path: string, content: string, mode: '100644' | '100755' }} File */
interface RepoBackend {
  kind: 'local' | 'github'
  /** The default branch, its head commit, and what this backend can do. */
  info(): Promise<{ repo: string /* https URL or path */, defaultBranch: string, head: { sha: string, at: string }, pr: boolean }>
  /** The read set (below) at `base`, a commit sha. Immutable for a given sha, so it can be cached. */
  readTeam(base: string): Promise<{ files: File[] }>
  /** Every path in the tree at `base`, without contents: for suggestions (owned areas, checks). */
  listPaths(base: string): Promise<string[]>
  /**
   * One commit on a new branch from `base`, with `changes` (content null = delete), then a pull request into `into`.
   * Never updates an existing ref and never forces. Refuses with 'stale' when `into` no longer points at `base`.
   */
  publish(p: { base: string, into: string, branch: string, message: string, changes: { path: string, content: string | null, mode?: string }[], pr: { title: string, body: string } | null }):
    Promise<{ branch: string, commit: string, files: string[], pr: PrResult | null }>
  /** The pull request for a branch: { state: 'open' | 'merged' | 'closed' | 'none', number, url, checks: 'pass' | 'fail' | 'pending' | null }. */
  prStatus(branch: string): Promise<PrResult>
}
```

`PrResult.state` keeps today's local values (`opened`, `exists`, `pushed`, `not-pushed`, `no-remote`). The `github` backend always returns `opened` or `exists`.

**The read set** is what `build` and `sync` read and write: `.agent-team/**`, `docs/team/**`, `scripts/agent-team/**`, `.claude/**`, `AGENTS.md` and `.gitignore`. Sync can only ever touch the read set, so it is also the **write allowlist** (section 5, E5).

**The shared core** (`apps/studio/core.mjs`, used by both servers):

- `state(read)` gives the TeamSpec, the kit, and `base`.
- `preview(read, spec)` gives `{ changes, issues }`.
- `plan(read, spec)` gives the publish `changes`.

All three work the same way. They write the read set into a fresh temp dir (`mkdtemp`, mode 0700, removed in `finally`), write the compiled layer there, run `sync`, and diff the result against the read set. The executable bit follows `sync`'s own rule (`.sh` files and shebang files become `100755`).

Local mode moves onto the same path. It no longer runs `sync` in the working tree: it computes `plan` from `HEAD`, writes those changes, and commits them as today. That one change makes "byte-identical" true by construction.

**Kit version.** `kit.lock.json` records the kit version that last synced. The core applies one rule in every mode:

- Same version: nothing special.
- The repository's version is older: the preview names the upgrade ("this also moves the team from kit 0.15.0 to 0.16.0"), and Publish carries it.
- The repository's version is newer: 409, "this repository was synced by kit X; update the Studio to X or later". A host fixes that with a dependency bump.

## 3. Step 1: the handler

```js
import { createStudioHandler } from 'agent-team-kit/studio/handler';

export const handler = createStudioHandler({
  repo: 'owner/name',                       // the repository the team lives in
  basePath: '/api/agent-team/studio',      // where the host mounts it
  allowedOrigins: ['https://admin.example.com'], // required: the host's own page origin(s), exact
  authorize: async (request, action) => ({ id: 'u_123', name: 'Dana' }) /* or null */, // action: 'read' | 'publish' | 'publish-code'
  getInstallationToken: async ({ repo, permissions }) => '<token>', // minted on the server, section 7
  branchPrefix: 'agent-team/',             // default; every Studio branch starts with it
  limiter: async (key, { limit, windowSeconds }) => true, // optional, a shared store (KV or the DB): S6
});
// handler(request: Request) => Promise<Response>: the Fetch API, so it runs in Node 18+ serverless functions,
// Next.js route handlers and plain node:http (through a small adapter the kit ships).
```

It needs a **Node runtime** with `node:fs` and a writable temp dir. Edge runtimes without them are not supported in step 1.

**Routes.** These are the local Studio's routes, under `basePath`, so the front end calls the same paths:

| Route | `authorize` action | Does |
| --- | --- | --- |
| `GET /v1/team` | read | `info`, then `readTeam(head)`, then `state`. Returns `base` (the head sha) with the spec |
| `POST /v1/team/preview` `{ spec, base }` | read | `readTeam(base)`, then `preview` |
| `POST /v1/team/graph`, `/v1/team/suggestions` | read | As today. Suggestions use `listPaths(base)` |
| `POST /v1/team/from-template` | read | As today. Refused when the repository already has a team |
| `POST /v1/team/publish` `{ spec, base, branch?, message }` | **publish**, and also **publish-code** when the plan changes code (S1) | `validate`, then `readTeam(base)`, then `plan`, then `publish` into the default branch with a pull request. A `stale` result is a 409 ("the team changed on GitHub since you opened it; reload") |
| `GET /v1/team/pr?branch=` | read | `prStatus` |
| `GET /assets/<kit version>/<name>` | none | The Studio's static files and `team-model.mjs`. They are public kit code, cached as immutable. Served only from a manifest built at package time (S2) |

**How the `github` backend uses the GitHub API.** Everything uses an installation token.

- **`info`** reads the repository and the default branch's ref: 2 calls.
- **`readTeam`** fetches the root tree without recursion, then the tree of each read-set directory recursively. That keeps a large monorepo from hitting the truncated recursive tree. It then fetches blobs, 16 at a time, and caches them across warm invocations, keyed on `(repo id, installation id, sha)` and re-hashed on read (S3). Limits: at most 2,000 files and 20 MB, otherwise a 413 that names the size.
- **`publish`** makes one `POST /git/trees` with `base_tree` and inline `content` for each change (`sha: null` deletes), then a commit with `base` as its parent, then `POST /git/refs`, which is create-only. It then checks that the `into` branch still points at `base`; if not, it deletes its own new ref and returns `stale`. Last comes `POST /pulls`.
- **The commit** is authored by the app. Its message ends with `Published-by: <name> (<host user id>) via Agent Team Studio`, from `authorize`'s answer and appended last (S5). That line is the host user's display name and id only, never an email address or a token.

**Time budget** (10 seconds per request):

| Request | Target (p95, a 300-file team on a cold function) |
| --- | --- |
| `GET /v1/team` | under 3 s |
| Preview | under 2 s once the blobs are cached |
| Publish | under 4 s: the read is cached, then 4 writes |

Sync itself takes milliseconds. A test fails the build if `sync` or `build` ever starts a child process or opens a network connection (section 8).

## 4. The front end

```js
const studio = AgentTeamStudio.mount(element, {
  api: '/api/agent-team/studio',             // same origin as the page
  headers: async () => ({ 'x-csrf-token': token }), // optional: the host's own CSRF header, if it has one
  features: { publish: true, chat: false, runs: false, live: false }, // step 1
  embedded: true, urlState: false, onNavigate: (view) => {},
});
studio.destroy();
```

- Every fetch goes to `api` with `credentials: 'same-origin'` and the header `x-agent-team-studio: 1`. No path is hard-coded any more.
- When it is mounted there is no launch token, no `sign-in.html` and no `account.html`: the host's page is the sign-in.
- The styles are scoped (`.ats`), with CSS variables, like the dashboard. There are no inline scripts and no `eval`, so it runs under a strict CSP with `script-src 'self'`. The host either serves the files from `/assets/` through the handler or copies them from the package.
- Local mode keeps today's page and launch token. It calls `mount` with `features` filled in from what its server reports.
- **One Studio per page.** Element ids may stay global, but every lookup is scoped to the mount root. The page's state lives on the root as data attributes, not on `document.body`: today's `data-page`, `data-mode`, `small`, `previewing` and `no-team`. The stylesheet selects `.ats[data-page=…]`.
- **Routing.** With `urlState: true` (local mode's default), the page is in `location.hash`, as today. With `urlState: false` (the default when `embedded`), the page is kept in memory, and every change calls `onNavigate(view)`. The Studio never touches `location` or `history`, so the host's router stays in charge.
- **Module paths.** The bundle imports `./team-model.mjs` and fetches `./model-prices.json` relative to its own URL (`import.meta.url`). The host serves all three from one directory: the handler's `/assets/<kit version>/`, or a copy of the package's `apps/studio/public/`. No import map is needed.
- **CSP.** Use `script-src 'self'` and `style-src 'self'`, with no `'unsafe-inline'` for either. That means no `style=""` attributes in generated HTML (they become classes or CSSOM writes) and no `innerHTML` on `document.body`: the fatal-error view renders inside the root.
- **Dialogs** use `<dialog>.showModal()`. It renders in the browser's top layer, so the host's `z-index` cannot hide it, and it brings its own focus trap. `confirm()` is replaced by the same dialog component, because some hosts block native dialogs in embedded views.

## 5. Security

**What the host must provide:**

- an admin-only `authorize`, with `publish-code` mapped to a narrower group than `publish` (S1);
- its page origin(s) in `allowedOrigins`;
- a session cookie set with `SameSite=Lax` or `Strict` (`Secure`, `HttpOnly`);
- a GitHub App with the permissions in section 7, installed on that one repository;
- the app's private key in its server's secret store, by name only (for example `AGENT_TEAM_GITHUB_APP_KEY`; never in the browser bundle or in logs);
- **required** review of the Studio's pull requests by a person with write access, through branch protection on the default branch. **The pull request is the security boundary**: a team spec can carry shell commands (S1);
- a **required** ruleset that lets the app create only `branchPrefix` branches (S7);
- optionally, a `limiter` backed by a shared store (S6).

Findings for review, E1 to E10:

- **E1. Gate.** `authorize` runs on every `/v1` request, GETs included, because the team's files can be private. `null` gives 401; a `read` answer to a `publish` request gives 403. The handler never caches the answer.
- **E2. Cross-site requests.** These are refused before any work, in this order:
  1. a `Sec-Fetch-Site` header that is present and not `same-origin`;
  2. on a request with a body, an `Origin` that is missing or not exactly one of `allowedOrigins` (never derived from `Host`, which a proxy rewrites);
  3. a missing `x-agent-team-studio: 1`, on every `/v1` request (a custom header forces a CORS preflight);
  4. a `Content-Type` that is not `application/json`.

  The handler answers no preflight and sends no `Access-Control-Allow-*` headers, so no other origin can read or write. If the host has its own CSRF token, `headers` passes it and the host checks it in `authorize`.
- **E3. The token.** It is minted per request (the host may cache it until 5 minutes before it expires). It is scoped down at minting to this repository and to `contents: write`, `pull_requests: write` and `metadata: read`. It lives only in memory. It is never in a response, a log line, the temp dir or an error: GitHub's error bodies are turned into plain sentences, and headers are dropped.
- **E4. Branches.** Every branch starts with `branchPrefix`, and the name matches `^[A-Za-z0-9._/-]{1,100}$` with no `..`. Refs are create-only, so nothing is ever force-pushed or moved. Recommended: a ruleset that limits the app to creating `agent-team/**` branches, as in the M3 owner checklist.
- **E5. Paths.** `plan` refuses any change outside the read set. That rules out `.github/**`, so the app needs no `workflows` permission and cannot change CI. Modes are only `100644` or `100755`: no symlinks and no submodules. Each file is at most 1 MB.
- **E6. Input.** Bodies are at most 5 MB. `spec` goes through `validate` before anything else. `base` must be a 40- or 64-character hex sha.
- **E7. Hostile repository content.** Someone who can push to the repository controls `.agent-team/`. `build` and `sync` are pure JavaScript over text: no `eval`, no child processes and no network (enforced by a test, section 8). Generated shell scripts are only ever written, never run. Each request gets its own temp dir, which is deleted afterwards. Blob-cache entries are named by sha only.
- **E8. Abuse.** Publish is limited to 10 per user per hour and one at a time per repository, through the host's `limiter` (S6). Without one, the only serialisation is GitHub's create-only ref, and the handler says so in its startup warning.
- **E9. Audit.** Each publish logs `{ user id, branch, commit, PR, files count }` to the host's logger, with no contents. The commit trailer and the PR are the durable record.
- **E10. Responses.** Every `/v1` response has `cache-control: no-store` and `x-content-type-options: nosniff`. Assets are served as `immutable` under a versioned path.

### Security review findings S1 to S9 (security-reviewer on #126)

These bind the handler PR, together with E1 to E10.

- **S1. Publishing a spec publishes code.** `gates.json` steps are shell: `renderGates` writes them into `scripts/agent-team/gates.sh`, which the merge gate sources. CI also runs `scripts/agent-team/sync.sh check` from the PR branch with its `.agent-team/config.sh`. So a publish can add commands that the runner and CI will run.
  - (a) **`publish-code`** is a third `authorize` action. It is required, in addition to `publish`, whenever the plan changes `gates.json`, `resources.json`, `.agent-team/config.sh`, or any `100755` or `.sh` file.
  - (b) The preview, in every mode, and the PR body list each added or changed command verbatim, in a fenced block under "Commands this PR adds or changes".
  - (c) The host must require review of the PR by a person with write access. This is in the host checklist above.
  - (d) A fuzz test feeds every spec string field `'`, `$()`, a backtick and a newline. It asserts that no generated `.sh` changes except through `shq`-quoted values and the gates `run` field.
- **S2. Assets.** They are served only from a manifest built at package time, looked up as map keys, never by joining paths. A request is refused when it has `%2e`, `%2f`, `\`, a doubled `/` or dot segments, checked both before and after decoding. Tests: `/assets/0.16.0/..%2f..%2fpackage.json` and `/assets/0.16.0/.//x` get 404.
- **S3. Blob cache isolation.** The cache key is `(repo id, installation id, sha)`, and content is re-hashed against its sha on read. Hosted mode uses one temp root per customer. A test proves that one customer's warm cache never answers another's read.
- **S4. Step 2 proxy.** It forwards only an explicit allowlist of method and route pairs, matched after normalisation, with dot segments refused. It forwards only `content-type` and `accept`, plus the bearer token it adds. It never forwards `cookie`, `authorization`, `x-forwarded-*` or `x-agent-team-edge`. Routes behind step-up or `su_` tokens are never proxied.
- **S5. Injection into the commit and the PR.**
  - `name` is stripped of control characters and capped at 100 characters.
  - Any user line that starts with `Published-by:` or `Co-authored-by:` is removed, and the trailer goes last.
  - In the PR body, user text goes in a block quote, and `@` becomes `&#64;`, so it pings nobody.
- **S6. Limits in serverless.** In-memory counters do nothing across instances, so limits go through the host's `limiter` hook (E8).
- **S7. Token scope is checked, not trusted.** `githubAppToken` always asks for `repositories: [name]` and the three permissions. The handler reads the mint response's `permissions` and `repositories`, or calls `GET /installation/repositories` once per token, and refuses a token that reaches more. The `branchPrefix` ruleset is required.
- **S8. Stream tickets** (step 2):
  - bound to tenant, team and person;
  - the stream's CORS sets no `Access-Control-Allow-Credentials`, because the ticket is the only credential;
  - the ticket is redacted from access logs, since it travels in the query string;
  - the stream re-checks membership and ends when the person is removed or loses the team (as in #101).
- **S9. Step 2 publish through the M4 app** uses only an installation that the tenant has proven it owns: the same multi-customer gate as for runs (sections 6 and 7).

## 6. Step 2: chat, runs and the live board through the control plane

Once M4 is up, the host registers with the deployment as a **confidential OIDC client** (ADR 0007), with its redirect URI and page origin. Then:

- **Linking.** Each host user links once with "Connect Agent Team". That runs the deployment's sign-in (GitHub upstream) in a top-level window. The handler keeps the refresh token server-side, encrypted in the host's store, keyed on the host user. The browser never holds a control-plane token.
- **Built (control plane, backend-dev):** `POST /v1/hosts` registers the host (admin, step-up) and returns its `clientId` and, once, its `clientSecret`; tokens are **DPoP-bound** (the handler keeps one DPoP key and signs a proof per proxied request, as the apps do), and a host's token is refused on step-up, passkeys and `/v1/hosts`. `POST /v1/teams/{team}/stream-tickets` and `GET …/events/stream?ticket=` as below. See apps/server/README.md, "Hosts".
- **Requests.** `basePath/v1/*` beyond the step 1 routes is proxied to the deployment's `/v1` through an explicit route allowlist, with the user's access token added and nothing else forwarded (S4). These are the same routes and the same front end as the hosted Studio.
- **Live** (S8). Server-sent events cannot pass through a 10-second function. Instead the handler gets a **stream ticket** from the control plane: single use, 60 seconds, read-only, for one team. The browser then opens the control plane's stream URL directly. For that one GET only, the control plane allows the origins registered for that client. A new control-plane route is needed, `POST /v1/teams/{team}/stream-tickets`, and it is additive.
- **Step-up.** A passkey is bound to the control plane's domain, so an approval that needs step-up opens the deployment's approval page in a new window and is approved there, or on the phone. Other cards are answered inline. The control plane is never put in an iframe (`frame-ancestors 'none'` stays).
- **Publishing.** Publishing can move to the deployment with `createStudioHandler({ controlPlane })`. Preview and publish then go to the new route `POST /v1/teams/{team}/publish`, which is additive and needs `editor`. The deployment runs the same core with the M4 app, on an installation the tenant has proven it owns (S9). After that the host deletes its own GitHub App and key. The handler's `publish` action still runs `authorize` first.

## 7. The GitHub App

- **Step 1: the host's own app.** It is private and installed on the one repository, with Contents read and write, Pull requests read and write, and Metadata read. It has **no** Workflows, Actions, Administration, Secrets or Environments permission. The kit ships an optional `githubAppToken({ appId, privateKey, installationId })`, which signs the app JWT with `node:crypto` and asks for a scoped installation token. A host may use `@octokit/auth-app` instead.
- **Can it be the M4 app? Not in step 1.** A GitHub App's private key mints tokens for every installation of that app. On a hosted deployment that means every customer, so a host must never hold the deployment's key. A self-hosted owner who runs both could technically reuse it, but the spec says not to: the blast radius is the reason. **In step 2, yes, by delegation:** the host keeps no key, and the deployment publishes with the M4 app (section 6).
- **Hosted mode** uses the M4 app directly, because the deployment owns that key. It uses only installations the tenant has proven it owns (S9), and keeps a blob cache per customer (S3).

## 8. Tests: one suite, both backends

`tests/studio-backends.test.mjs` runs the same scenarios against `local` and `github`. It uses the kit's fixture teams, including the 50-role round-trip team from #22.

- **Local** runs on a temp git repository with a fake `gh`.
- **GitHub** runs on an in-process **fake GitHub API** backed by a real bare git repository. It implements the endpoints used: refs, trees, blobs, commits, pulls and repository. Because it is backed by real git, tree SHAs are comparable.

Scenarios: edit a role's brief; switch a role off; add a meeting; first publish from a template; the kit upgrade path; nothing changed. For each one, both backends must produce **the same commit tree sha** and a pull request.

Further proofs:

- Publish on a moved default branch is `stale`, and the new ref is removed.
- A change outside the read set is refused.
- An existing branch name is refused, and nothing is forced.
- E2: a cross-origin POST, a POST without the header, and a GET with `Sec-Fetch-Site: cross-site` are each refused.
- `authorize` returning `null` or a read-only user gives 401 or 403.
- A token never appears in any response body or log line (a canary token).
- `sync` and `build` run under a guard that throws on `child_process` and `net` (E7).
- A 300-file team: `GET /v1/team` under 3 s against the fake API with 50 ms of latency per call.
- S1 to S9: a gate change needs `publish-code` and appears verbatim in the preview and the PR. The `.sh` fuzz test passes. Asset traversal requests get 404. One customer's cache never answers another's. Proxy requests outside the allowlist, and forwarded cookies, are refused. A newline in `name` forges no trailer. A token that is too broad is refused.

## 9. Who builds what, in order

1. **kit-core-dev:**
   - the shared core (`apps/studio/core.mjs`) and the move of local mode onto it;
   - `RepoBackend` with `local` and `github`;
   - `createStudioHandler`, the Node adapter, and `githubAppToken`;
   - the fake GitHub API and the shared suite.
2. **web-dev:** `AgentTeamStudio.mount` and the `api` base, with about 42 fetch and EventSource calls moved behind it. Also the `features` switches; root-scoped state, lookups and styles (the stylesheet's body selectors); in-memory routing; inline styles moved to classes; and `<dialog>` in place of `confirm()`. Finally, a strict-CSP test page in CI.
3. **security-reviewer:** E1 to E10 and S1 to S9 on this spec, then on the handler PR.
4. **kit-core-dev, in the first host's own repository:**
   - the host's function, which mounts the handler behind that host's admin check;
   - the host's GitHub App;
   - the admin page that calls `mount`.

   The owner creates the app and stores the key by name. The chief of staff gives that as a checklist item.
5. **Step 2, after M4:**
   - backend-dev: the OIDC client registration for hosts, `stream-tickets` and `POST /v1/teams/{team}/publish`;
   - kit-core-dev: the handler's proxy and `controlPlane` mode.
