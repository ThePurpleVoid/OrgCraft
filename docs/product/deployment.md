# Agent Team Studio: deployment

Owner: infra, secrets and on-call. Status: draft 2, 2026-11-06. Reads with the [architecture](architecture.md) and [ADR 0005](../adr/0005-online-first-built-to-last.md).

**The product runs online.** Customers deploy it in their own cloud or use our hosted service. Both run the same images. Local is the same build on one machine, used for trying the product and for developing it. Every shape has the same two halves: the **control plane** (Studio, API, identity, scheduler, notifier, event log, Postgres) and the **data plane** (runners with repository checkouts, sandboxes and released secrets). Runners connect outbound to the control plane.

| | Your cloud (self-hosted) | Hosted by us | Hosted control plane, your runners | Local (try and develop) |
| --- | --- | --- | --- | --- |
| Who | A team or company that keeps everything in its own account | Anyone, with no setup | Companies whose code and secrets must stay in their network | One person, a demo, our own developers |
| Start | One-click template (Render, Railway, Fly) or `terraform apply` (AWS, GCP, Azure modules), or `docker compose up` on a VM, then Helm | Sign up at the Studio's website | Sign up, then run `agent-team runner join <token>` in their VPC (container or Helm) | `npx agent-team studio` |
| People | OIDC (GitHub, Google, Microsoft; SAML for enterprise), orgs, members, roles | Same | Same | One built-in owner, through the same code path |
| Storage | Their Postgres and S3-compatible store | Managed Postgres with row-level security per tenant, S3 | Ours for control data; evidence in their bucket if they choose | Bundled Postgres in `~/.agent-team/studio/` |
| Secrets | Their KMS, or a master key from the environment | Our KMS, per-tenant keys | Their KMS; secrets never leave their runners | OS keychain |
| Sessions run | Containers on their runner hosts or Kubernetes | MicroVMs per run, destroyed at the end | Their runners | Local processes, the user's toolchain and devices |
| Connectors (GitHub, databases, hosting, email, Slack) | Connected in the Studio, same flow everywhere | Same | Same; tool calls run on their runners | Same |

## 1. Your cloud (self-hosted): the main path

```
deploy/
  compose/      docker-compose.yml: studio (web + API + scheduler + notifier), runner (N replicas), postgres, caddy (TLS), minio (evidence)
  terraform/    aws/ gcp/ azure/ modules: managed Postgres, object storage, KMS, container service, runners, DNS and TLS
  helm/         agent-team-studio chart: control plane Deployments, runners, role sessions as pods in a namespace per workspace
  templates/    one-click files for Render, Railway and Fly
```

- **Images:** `studio` (control plane) and `runner` (data plane: Agent SDK, git, Node, and a container runtime or a socket to start role containers). Published to GHCR per release, multi-arch (amd64, arm64), signed (cosign) with an SBOM.
- **First run:** `studio doctor` checks the database, object storage, KMS, the GitHub App, the model key, the runners and the egress allowlist. The setup page registers a GitHub App through GitHub's manifest flow and connects the first email provider.
- **Role containers:** built from the product repository's `devcontainer.json` when it has one, else a default image with common toolchains. Resource limits match the hardware pools. Devices (simulators, phones) are reached through a runner on a machine that has them (see section 3).
- **Upgrades:** images follow semver. Database migrations are additive within a major version and run before the new version takes traffic. Events are upcast on read, so history never needs rewriting. Rolling upgrades never interrupt running sessions: runners drain and checkpoint first (the same `checkpoint()` as [ADR 0004](../adr/0004-team-versions-and-transitions.md)).
- **Backups:** Postgres point-in-time recovery on managed databases (nightly `pg_dump` in Compose). Teams themselves are in Git. A tenant export (team files, events, evidence) is one command.

## 2. Hosted by us

The same images, run by us, with the same release cadence as self-hosted. Launching it commercially (billing, terms) is the owner's call. The architecture assumes it from the start.

- **Control plane:** a managed container platform behind a CDN, starting in two regions (US, EU), with each tenant's data kept in its region.
- **Data:** managed Postgres with row-level security per tenant, per-tenant encryption keys in KMS, S3 for evidence. Nothing from customer repositories is stored beyond what a run needs.
- **Runs:** each run in its own microVM (Firecracker-class, through a provider behind the sandbox interface), destroyed at the end, with an egress allowlist per run and no shared credentials across tenants.
- **Private data plane:** a customer can run the runners in their own VPC (`agent-team runner join`). Runners connect outbound only. Code, worktrees and secret values stay on their side, and the control plane sees events, not source.
- **Billing (undecided):** customers bring their own model key, so we would charge for orchestration (seats or run-hours), not tokens.
- **Compliance path:** audit export from the event log, data deletion on request, SOC 2 when customers need it.

## 3. Local: try it and develop it

```sh
cd ~/code/my-app
npx --yes github:PurpleGiragge/Agent-Team-Kit#v0.x studio      # http://localhost:4747
```

- One process runs the control plane and one runner, with a bundled Postgres in `~/.agent-team/studio/`. It is the same code as the online shapes, so anything built here works online.
- It opens the current folder's `.agent-team/` (or offers `init`). Sessions run as local processes in worktrees under `~/.agent-team/<project>/worktrees/`, so they can use the user's emulators, simulators and signed-in CLIs.
- Connectors, email and Slack included, are connected the same way as online. Secrets go to the OS keychain.
- **Move online without starting over:** `agent-team studio export` writes a tenant archive that an online deployment imports. A laptop can also join an online Studio as a runner (`agent-team runner join`), which is how a team uses devices only that machine has.
- The model: `ANTHROPIC_API_KEY`, or the Claude Code login on the machine.
- Windows: native once the kit's Node scripts land. Until then, WSL.

## 4. How the Studio itself ships

- **Two release tracks from one repository.** Kit releases (`vX.Y.Z` tags, consumed by `npx` pins) stay as they are. Studio releases are the same tags. A tag builds the images and publishes the `studio` subcommand, so `npx …#vX studio` and `ghcr.io/…/studio:X` are always the same code.
- **CI:** the kit gates (shellcheck, briefs, node tests, script tests, this repository's own `sync.sh check`), then the Studio gates (lint, types, unit tests, build, Playwright flows over the demo script), then the round-trip golden tests. Windows and macOS runners join when the Node scripts land.
- **Environments for the Studio's own development:** local (each builder's worktree, bundled Postgres), a preview deployment per PR (control plane plus one runner), and a staging deployment in a real cloud account that the QA role walks before every release. Releases ship to staging, then to our hosted service, then as images for self-hosted customers.
- **Compatibility:** each Studio release states the kit versions it can import and publish. Publishing with a newer kit is an explicit "upgrade the kit" diff, never silent.

## 5. Operations

- **Observability:** structured logs, OpenTelemetry traces across server → runner → session, metrics on queue depth, session count, cost per run and approval wait time.
- **On-call (self-hosted and hosted):** runbooks in `docs/runbooks/` for a stuck run, a runaway cost, a leaked secret (rotate, revoke the GitHub App token, purge the audit entry), and a failed publish.
- **Kill switch:** per run, per workspace and global, stopping every session and revoking session tokens.
