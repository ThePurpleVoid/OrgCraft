# Agent Team Studio: deployment

Owner: infra, secrets and on-call. Status: draft 1, 2026-11-05. Reads with the [architecture](architecture.md).

The Studio runs in three ways. The code is the same in all three; storage, secret and sandbox *drivers* change.

| | Local | Self-hosted | Hosted (later) |
| --- | --- | --- | --- |
| Who | One person on a laptop; the demo | A team or company on its own infrastructure | Anyone, no setup |
| Start | `npx agent-team studio` | `docker compose up` (then Helm) | Sign in at the Studio's website |
| Accounts | None | GitHub OAuth, workspace members | GitHub OAuth, SSO later |
| Storage | SQLite in `~/.agent-team/studio/` | Postgres | Managed Postgres, per-tenant rows with RLS |
| Secrets | OS keychain (fallback: a 0600 file outside git) | Encrypted in Postgres with a master key from the environment | KMS envelope encryption |
| Repositories | The local folder, plus `gh` or a GitHub App for PRs | A GitHub App the operator registers | Our GitHub App |
| Sessions run | Local processes, the user's toolchain and devices | Docker containers on runner hosts | Isolated microVMs per run |
| Board | The kit's local JSONL plus the server's WebSocket | Server + Postgres | Server + Postgres |
| Model key | The user's Anthropic key or Claude Code login | Per workspace, in the vault | Per workspace, in the vault |

## 1. Local

The MVP and the demo target. Nothing to install beyond Node 20+ and git.

```sh
cd ~/code/my-app
npx --yes github:PurpleGiragge/Agent-Team-Kit#v0.x studio      # http://localhost:4747
```

- One Node process serves the editor, the API, the WebSocket and the runner. It replaces `dashboard.mjs`'s server on the same port, and `/api/report` stays where threads already send reports.
- It opens the current folder's `.agent-team/` (or offers `init`). Publish writes files, runs sync and commits on a branch. "Open PR" uses `gh` if it is signed in, else a GitHub App device flow.
- Sessions run as local processes in worktrees under `~/.agent-team/<project>/worktrees/`, so they can use the user's emulators, simulators and signed-in CLIs. Hardware pools from `config.sh` apply.
- The model: `ANTHROPIC_API_KEY`, or the Claude Code login on the machine.
- Remote reach: `agent-team studio --tunnel` prints a URL through the user's own tunnel (Cloudflare Tunnel or Tailscale Funnel, whichever is installed) with a one-time token, so the owner can chat with the chief of staff from a phone. It is off by default.
- Windows: native once the kit's Node scripts land (kit 0.5). Until then, WSL.

## 2. Self-hosted

For teams who want the Studio on a shared server, with their code and keys staying on their own infrastructure.

```
deploy/compose/
  docker-compose.yml     studio (web + API), runner (N replicas), postgres, caddy (TLS), optional minio (evidence files)
  .env.example           STUDIO_URL, DATABASE_URL, STUDIO_MASTER_KEY, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, ...
```

- **Images:** `studio` (server + built editor) and `runner` (Agent SDK, git, Node, Docker-in-Docker or a socket to start role containers). Published to GHCR per release, multi-arch (amd64, arm64), signed (cosign) with an SBOM.
- **GitHub App:** `agent-team studio github-app create` uses GitHub's manifest flow to register an app for the operator's organisation and writes its id and key to `.env`.
- **Role containers:** built from the product repository's `devcontainer.json` when it has one, else a default image with common toolchains. Resource limits per container match the hardware pools.
- **Evidence storage:** screenshots and logs from SIGNOFFs go to S3-compatible storage (MinIO in Compose); links in the board point there.
- **Backups:** Postgres (pg_dump nightly in Compose; managed backups on a cloud database). Teams themselves are in Git and need no backup from the Studio.
- **Upgrades:** images follow semver; migrations run on start and are additive only within a major version. `studio doctor` checks the database, the GitHub App, the model key, the runner hosts and the egress allowlist.
- **Kubernetes:** a Helm chart (`deploy/helm/agent-team-studio`) after Compose is proven, with runners as a Deployment and role sessions as Jobs or pods in a namespace per workspace.

## 3. Hosted SaaS (later, not in the MVP)

The same images, run by us. Built only when the self-hosted version is proven and there is demand. Sketch:

- **Control plane:** the Studio server on a managed container platform (Fly.io, Render or AWS ECS), behind a CDN, in two regions to start (US, EU) with data kept in the workspace's region.
- **Data:** managed Postgres with row-level security per workspace; S3 for evidence; KMS for secrets; nothing from customer repositories stored beyond what a run needs.
- **Runs:** each run in its own microVM (Firecracker-class: Fly Machines, E2B or Modal), started on demand, destroyed at the end; egress allowlist per run; no shared credentials across tenants.
- **Billing (undecided):** the customer brings their own model key, so we would charge for orchestration (seats or run-hours), not tokens. This is an open question in the [PRD](prd.md).
- **Compliance path:** audit log export, data deletion on request, SOC 2 when customers need it.

## 4. How the Studio itself ships

- **Two release tracks from one repository.** Kit releases (`vX.Y.Z` tags, consumed by `npx` pins) stay as they are. Studio releases are the same tags. A tag builds the images and publishes the `studio` subcommand, so `npx …#vX studio` and `ghcr.io/…/studio:X` are always the same code.
- **CI:** the kit gates (shellcheck, briefs, node tests, script tests, this repository's own `sync.sh check`), then the Studio gates (lint, types, unit tests, build, Playwright flows over the demo script), then the round-trip golden tests. Windows and macOS runners join when the Node scripts land.
- **Environments for the Studio's own development:** local (each builder's worktree, SQLite), a preview per PR for the editor (static build plus a mock server), and, once self-hosted exists, a staging Compose stack the QA role walks before a release.
- **Compatibility:** each Studio release states the kit versions it can import and publish. Publishing with a newer kit is an explicit "upgrade the kit" diff, never silent.

## 5. Operations

- **Observability:** structured logs, OpenTelemetry traces across server → runner → session, metrics on queue depth, session count, cost per run and approval wait time.
- **On-call (self-hosted and hosted):** runbooks in `docs/runbooks/` for a stuck run, a runaway cost, a leaked secret (rotate, revoke the GitHub App token, purge the audit entry), and a failed publish.
- **Kill switch:** per run, per workspace and global, stopping every session and revoking session tokens.
