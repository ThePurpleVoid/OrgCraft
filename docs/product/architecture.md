# Agent Team Studio: architecture

Owner: architect. Status: draft 1, 2026-11-05. Reads with the [PRD](prd.md). Decisions that need an ADR have one in [docs/adr/](../adr/).

## 1. Principles

1. **The repository is the source of truth.** A team is the `.agent-team/` folder in the product's repository. The Studio is an editor and a control room over it. It is never the only copy ([ADR 0001](../adr/0001-repository-is-the-source-of-truth.md)).
2. **Publish = compile + sync.** The Studio compiles its team model to `.agent-team/` and then runs the *pinned* kit `sync`. A Studio user and a text-only user get byte-identical generated files.
3. **Lossless round trip.** `compile(import(layer))` yields the same sync output as `layer`, for every layer we know. This is tested, not hoped for.
4. **Governance is enforced, not only prompted.** Ownership, approvals, budgets and merge gates are checked by the runner and by CI, so they hold whatever model or agent is inside.
5. **Runtime-neutral team, runtime-specific adapters.** The team model says *who* does *what* and *may touch what*. Adapters turn it into Claude Code threads, subagents, built-in agent teams, Agent SDK sessions, or other agents' formats.
6. **Online first, built to last a decade** ([ADR 0005](../adr/0005-online-first-built-to-last.md)). The product is an online service: the customer's cloud or our hosted service, from the same images. Local is that same build on one machine, for development, evaluation and demos. No feature works only locally.
7. **Durable contracts, replaceable parts.** The team files, the TeamSpec schema, the event envelope, the connector manifest (over MCP), the public API and the runner protocol are versioned contracts with migration paths. Every vendor behind them (model, agent SDK, sandbox, workflow engine, email provider, cloud) can be replaced. See section 13.
8. **Industry-neutral core.** Work is not assumed to be code. Ownership is over *areas* in any connector (repository paths, folders, CRM records, helpdesk queues), gates are *checks* of any kind, a PR is one form of *propose and accept*, and roles come in industry *packs*. Engineering is the first pack and the repository connector is its implementation ([ADR 0005](../adr/0005-online-first-built-to-last.md) §8).

## 2. System overview

```
 People (browser, phone, email, Slack)
        │  OIDC sign-in, HTTPS, WebSocket
┌───────▼──────────────────────────── CONTROL PLANE (stateless services + Postgres) ─────────────────────────┐
│  apps/studio   editor · control room · chat · meetings · notifications · rollout                           │
│  apps/server   public API /v1 (OpenAPI) · identity and tenancy · team model · publish (Git, PRs)            │
│                connectors and vault · scheduler · notifier · approvals · event log (system of record)      │
│                durable workflows (meetings, transitions, approvals, retries, timers)                       │
│  Postgres (row-level tenancy) · object storage (S3 API) · OpenTelemetry                                    │
└───────▲─────────────────────────────────────────────────────────────────────────────────────────────────────┘
        │  runner protocol: runners connect OUTBOUND, authenticate, pull work, stream events
┌───────┴──────────────────────────── DATA PLANE (ours, or in the customer's network) ───────────────────────┐
│  apps/runner   chief-of-staff and role sessions · team tool server (MCP) · bus delivery · checkpoints      │
│                ownership hook · repository worktrees · released secrets for bound connectors only          │
│  sandbox driver: process (local) | container (self-hosted) | microVM (hosted)                              │
└───────┬──────────────────────────────────────┬─────────────────────────────────────────────────────────────┘
        │ model API (adapter: Anthropic first)  │ connectors: GitHub, databases, hosting, email, Slack, any MCP
```

One build, four shapes: everything in one process on a laptop; control and data plane in one cluster (self-hosted); our control plane with the customer's runners in their VPC; or fully hosted.

Repository layout (monorepo, npm workspaces). The kit's root package stays as it is, so `npx github:PurpleGiragge/Agent-Team-Kit#vX` keeps working. The `files` whitelist in the root `package.json` keeps the apps out of the kit package.

```
bin/ team/ presets/ scripts/ tools/ templates/ board/   the kit (unchanged role: CLI, briefs, scripts, dashboard)
packages/team-model/       schema, import, validate, compile; used by the CLI, the server and the browser
apps/studio/               the editor and control room (React)
apps/server/               control plane: API, identity, tenancy, publish, connectors, scheduler, notifier, event log
apps/runner/               data plane: run modes, sessions, team tool server, sandboxes, checkpoints
evals/                     task sets, harness, scoring
deploy/                    Dockerfiles, Compose, Helm
```

## 3. The team model

### 3.1 Shape

`TeamSpec` is a JSON document with a JSON Schema (`packages/team-model/schema/team-spec.v1.json`). It is what the canvas edits and what the server stores as a draft. Sketch:

```jsonc
{
  "schema": "agent-team/team-spec@1",
  "kit": "github:PurpleGiragge/Agent-Team-Kit#v0.7.1",
  "base": { "preset": "engineering" },             // what the roles are diffed against
  "values": { "PROJECT_NAME": "My App", "OWNER": "Sam", "TIMEZONE": "UTC", "DIGEST_TIME": "08:00" },
  "roles": {
    "backend-dev": {
      "source": "kit",                             // kit | project | project-replaces-kit
      "state": "on",                               // on | off | dormant
      "fields": { "model": "deep (high effort)" }, // header fields changed from the kit
      "sections": {                                // per section: append or replace
        "Rules": { "mode": "append", "text": "- Every migration has a rollback note." }
      }
    },
    "android-dev": { "source": "project", "brief": { "title": "Android dev", "reportsTo": "cto", "...": "..." } }
  },
  "reporting": { "qa-web": "head-of-quality" },     // edges that differ from the briefs
  "ownership": [ { "path": "apps/web/", "role": "web-dev", "notes": "" } ],
  "resources": [
    { "id": "db", "type": "postgres", "name": "Main database", "config": { "host": "…", "database": "app" },
      "secrets": ["DATABASE_URL"] }
  ],
  "bindings": [ { "role": "backend-dev", "resource": "db", "permission": "write" } ],
  "gates": { "all": ["web", "backend"], "targets": { "web": [ { "name": "build", "run": "npm run build", "pool": "build" } ] } },
  "pools": { "build": 2, "browser": 3, "backend": 1 },
  "runtime": { "adapters": ["threads", "subagents", "agent-teams", "runner"], "budgets": { "dailyUsd": 50 } },
  "rules": { "protocols": "…project-wide rules…", "instructions": "…" },
  "meetings": [                                     // section 12.2; .agent-team/meetings.json
    { "id": "standup", "title": "Daily standup", "when": { "days": ["mon","tue","wed","thu","fri"], "at": "09:00" },
      "attendees": { "roles": ["cto", "web-dev", "backend-dev"], "lanes": [], "rule": null },
      "facilitator": "chief-of-staff", "format": "round", "rounds": 1,
      "agenda": "1. Done since last time …", "ifBusy": "next-pause", "owner": "minutes",
      "capUsd": 1.0, "skipIfQuiet": true, "outputs": ["minutes", "action-items", "decisions"] }
  ],
  "layout": { "backend-dev": { "x": 320, "y": 180 } }  // canvas positions only
}
```

### 3.2 Mapping to `.agent-team/` (1:1)

| TeamSpec | `.agent-team/` and generated files | Today or new |
| --- | --- | --- |
| `kit`, `base.preset`, `values` | `team.json` `kit`, `preset`, `values` | today |
| roles with `state` | `team.json` `include` / `exclude`, computed as the smallest diff from the preset | today |
| `state: dormant` on a kit role | `<role>.extend.md` with a `**Status:**` line | today |
| `fields` and `sections` on a kit role | `<role>.extend.md`: `**Field:**` lines, `## Section`, `## Section (replace)` | today |
| `source: project` | `<role>.md` | today |
| `reporting` | `**Reports to:**` in the role's extension, and `## Direct reports (replace)` on both managers | today |
| `rules.protocols`, `rules.instructions` | `protocols.extend.md`, `instructions.extend.md` | today |
| `runtime.adapters` | `team.json` `subagents`, plus `agentTeams` (built-in agent teams: `.claude/agents/`, the settings flag and `docs/team/agent-teams.md` with the lead's spawn prompts) | subagents today; agent teams in kit 0.4 |
| `ownership` | `.agent-team/ownership.json` → sync writes `docs/team/ownership.md` | **kit 0.5.** Without the JSON file, today's hand-written `ownership.md` stays and the Studio parses and writes its table |
| `gates`, `pools` | `.agent-team/gates.json` → sync writes `scripts/agent-team/gates.sh`, sourced after `config.sh` | **kit 0.5.** `config.sh` stays for anything bash-shaped; the Studio shows its gates read-only |
| `resources`, `bindings` | `.agent-team/resources.json` → sync adds a "Systems" section to the project instructions and a "Systems" section to each bound role's brief; secret *names* only | **kit 0.5** |
| `layout` | `.agent-team/studio.json` (ignored by sync) | kit 0.5 (reserved; sync ignores it) |
| custom role (`source: project`) with `evidence`, `wakesOn` | `.agent-team/roles/<slug>.md` with two optional sections, `## Sign-off evidence` and a structured `## Wakes on` list the runner can read | today for the file; **new** for the two sections (section 12.1) |
| `meetings` | `.agent-team/meetings.json` → sync adds a "Meetings" section to the project instructions and "a meeting it is invited to" to each attendee's Wakes on | **new** (section 12.2) |
| notification settings | none: a person's settings, kept by the Studio, never in the repository | **new** (section 12.3) |

The new files are optional: a layer without them behaves exactly as today. This keeps every existing team, CoachSpotter included, valid without changes.

### 3.3 Import, validate, compile

`packages/team-model` exposes four functions and nothing else does these jobs:

- `importLayer(files) → TeamSpec`: reuses the kit's `loadProject`, `resolveRoles` and `extendBrief` (in `packages/team-model` since kit 0.5; the CLI uses them).
- `validate(spec) → issues[]`: the roster checks of `tools/roster.mjs` plus ownership coverage, binding sanity (a deploy binding needs a gate), and secret scanning of free text.
- `compile(spec) → files`: writes the smallest `.agent-team/` that expresses the spec (extensions over replacements, `include`/`exclude` over a preset change).
- `build(files, kitVersion) → generated files`: the kit's sync, run in memory, for the diff preview.

The package is plain ES modules with no Node-only APIs in its core, so the browser runs the same checks live. Golden tests: every folder in `examples/`, the kit repository's own `.agent-team/`, and copies of real layers (with permission) must round-trip to zero diff.

## 4. The editor (`apps/studio`)

- **Local mode (shipped in 0.6.0):** plain ES modules, a hand-drawn SVG org chart and a dependency-free Node server, so `npx` runs it with no build ([ADR 0003](../adr/0003-studio-local-mode-without-a-build.md)). The plan below is for the hosted Studio.
- **Stack:** React + TypeScript + Vite. Canvas: React Flow (`@xyflow/react`, MIT), with automatic layout from ELK (`elkjs`) for the org tree. State: a single `TeamSpec` store (Zustand) with an undo/redo history of patches (Immer). Markdown sections: CodeMirror 6.
- **Views:** Org (edges = `reportsTo`), Flow (edges from `Hands to`, as `tools/roster-graph.mjs` already derives), Systems (resource nodes in a side lane, binding edges labelled by permission). One model, three projections.
- **Panels:** palette (the role library, grouped by lane), inspector (fields and sections, "kit default / your change", reset), checks (live `validate`), ownership table (with repository tree suggestions), gates, publish (diff and PR), chat, run controls.
- **Live board on the canvas:** the existing dashboard (`tools/dashboard/app.js`) already renders an org and a flow from a roster and board events, and exports `mount(el, { roster, fetchBoard })`. The Studio reuses its event model and status colours. It draws status on its own React Flow nodes so editing and watching are one surface. The kit dashboard stays the standalone and embeddable board.
- **Offline-capable:** the editor works against a local folder with no server features except file access, so a user can shape a team before connecting anything.

## 5. The server (`apps/server`)

- **Stack:** Node 20+, TypeScript, Hono (runs on Node, Bun and edge runtimes), WebSocket for live board and chat, Drizzle ORM. Storage: Postgres in every deployment, including local (bundled), with row-level tenancy ([ADR 0005](../adr/0005-online-first-built-to-last.md)).
- **Main records:** `workspace`, `member`, `team` (repository link), `draft` (a TeamSpec under edit), `version` (published: commit SHA + spec snapshot), `resource`, `binding`, `secret` (encrypted value, name), `run`, `session` (one per role per run), `message` (owner and inter-role, with shape and verbatim owner text), `event` (board, same columns as `board/supabase`'s `team_events`), `approval`, `usage`, `audit`.
- **Board endpoint:** `POST /api/report` accepts exactly what `team-status.sh` and the kit hooks send today, so threads outside the Studio (claude.ai projects, a teammate's laptop) report into the same board.
- **Publish pipeline:** `validate` → `compile` → run the pinned kit CLI in a scratch checkout (`sync`, then `check`) → commit on `agent-team/publish-<n>` → PR through the GitHub App (or a local commit) → watch CI → on merge, record the version. The pinned CLI is fetched once per kit version and cached.

## 6. Running a team (`apps/runner`)

### 6.1 Run modes (closes G2)

| Mode | What runs | Best for | Infrastructure |
| --- | --- | --- | --- |
| **Built-in agent teams** | Claude Code's own lead and teammates, from the exported team; the lead plays chief of staff | Trying a team, one developer, one terminal | None beyond Claude Code |
| **Subagents** | One Agent SDK session as the chief of staff, with every active role as a subagent | Small teams, short tasks, lowest cost | The Studio runner, one session |
| **Studio runner** | The chief of staff as a long-lived session; each role as its own session, woken by messages, each in its own git worktree, with its own memory file | Long-running products, parallel work, the full demo | The Studio runner, many sessions, concurrency capped |
| **Threads (export only)** | claude.ai project threads, as the kit runs today | Teams already on claude.ai projects | claude.ai |

All four read the same generated briefs. The first two are the MVP's fallbacks; the Studio runner is the MVP's main mode ([ADR 0002](../adr/0002-runtime-agent-sdk-runner.md)).

### 6.2 Sessions

A role session is a Claude Agent SDK session with:

- **System prompt:** the generated brief, the protocols, the project instructions, and the role's memory file (`roles/<slug>.md`, stored by the runner and mirrored to project memory in threads mode).
- **Working copy:** a git worktree on a branch per issue (builders), or the release manager's plain checkout (everyone else, read-only).
- **Tools:** Claude Code's built-in tools, restricted by the role's ownership (writes outside owned paths are refused by a pre-tool hook, not just discouraged); the team tool server (below); and the MCP tools of the resources bound to the role.
- **Environment:** `AGENT_TEAM_ROLE`, `AGENT_TEAM_RUN`, `TEAM_REPORT_URL` and only the secrets of bound resources.

### 6.3 The team tool server

An MCP server the runner gives every session. Each tool is a protocol the briefs already describe. There are no new behaviours, only enforced ones.

| Tool | Protocol | Effect |
| --- | --- | --- |
| `report(status, task, …)` | board report | event; same as `team-status.sh` |
| `handoff(to, issue, branch, artifact, verify, done_when)` | HANDOFF | message on the bus, wakes the target, edge animates |
| `bug(...)`, `signoff(...)`, `blocked(...)` | BUG, SIGNOFF, BLOCKED | required fields checked; a SIGNOFF without evidence paths is rejected |
| `ask_owner(question, options, recommendation)` | one door | chief of staff only; a decision card in the chat |
| `request_approval(action, why)` | owner steps in | blocks until the owner approves in the chat |
| `memory_read()`, `memory_write(sections)` | memory files | the five-part memory file |
| `open_issue(...)`, `merge(pr)` | PR flow | merge only when approval + SIGNOFF + green gate + no conflicts |

### 6.4 Message bus, approvals, budgets

- **Bus:** a table-backed queue in Postgres, delivered to runners over the runner protocol. A message to a role whose session is idle wakes it with "Resume from roles/<slug>.md" plus the message. The owner's messages are stored verbatim and travel quoted (the dilution rule).
- **Approvals:** the owner-steps-in list from `docs/team/protocols.md` becomes a policy the runner enforces. A pre-tool hook classifies commands and MCP calls (destructive SQL, production deploy, secret writes, payments, outbound email). Classified calls pause the session and raise an approval card.
- **Budgets:** per-run and per-day cost caps from token usage; a concurrency cap on live sessions; the kit's priority order when capped; pause and stop for the whole run or one role.
- **Audit:** every tool call, approval and message is recorded with the session and the role.

### 6.5 Automatic status from hooks (closes G1)

Two sources, one event stream:

- **Liveness from hooks.** The kit (0.4, PR #10) ships Claude Code hooks (`scripts/agent-team/report.mjs hook`, merged into `.claude/settings.json` by sync) that map `SessionStart`, `PreToolUse`/`PostToolUse` (throttled to a heartbeat), `Notification`, `SubagentStop` and `Stop` to board events with `source: "hook"`. The role is the session's agent or teammate name when it matches a role slug, else `AGENT_TEAM_ROLE`. They work in every mode: claude.ai threads, a local CLI, built-in agent teams and the runner. In the runner the session supervisor emits the same events itself, so liveness never depends on hook configuration.
- **Meaning from roles.** `report`, HANDOFF, BLOCKED and SIGNOFF stay role-written (`source: "team-status.sh"`, kept for existing boards; anything that is not `"hook"` counts as role-written), because only the role knows the task name and who it waits on.
- **The board joins them:** a card is live if hooks say so, and it shows the last role-written task. When a role works for a long time without saying what it is doing, the card is flagged "working, unreported", not "silent".

### 6.6 Sandboxes

The sandbox driver decides where sessions run: a local process (local mode; the user's own toolchain), Docker (self-hosted; the image built from the repository's `devcontainer.json` when present), or a microVM (hosted; Firecracker-class isolation from a provider such as Fly Machines, E2B or Modal). Hardware pools (`with-lock.sh`) map to slots per machine in all three. Network egress is allowlisted per run: the model API, the Git host, and the bound resources.

## 7. Systems: repositories, backends, databases, frontends

Everything outside the team is a **connector**: product systems (repositories, databases, backends, hosting) and the people's channels (email, Slack, Teams). One lifecycle for all of them: connect (OAuth or key), store the secret in the vault, health check, scope, revoke. Local and online work the same way ([ADR 0005](../adr/0005-online-first-built-to-last.md) §6).

A connector declares **capabilities** in a small manifest next to its MCP server: `tools` (roles get them through bindings), `notify` (people get them through notification rules), `inbound` (replies and button presses come back, signed), `discover` (suggestions for ownership, gates and bindings). Most product systems have `tools` and `discover`; email has `notify` and `inbound`; Slack has all four.

Each connector has the same four parts. This is how the Studio links a team to "the whole deal".

| Part | What it does | Example: Postgres |
| --- | --- | --- |
| Config | Non-secret identifiers stored in `resources.json` | host, database, schema |
| Secrets | Names in the repository, values in the vault | `DATABASE_URL` (read-write), `DATABASE_URL_RO` |
| Tools | An MCP server or CLI the bound roles get, scoped by permission | read → a read-only role and query tool; write → migrations through the repository only |
| Discovery | Suggestions for ownership, gates and bindings | `supabase/migrations/` → backend dev; a gate step for migration tests |

MVP connectors: **GitHub** (GitHub App: contents, pull requests, issues, checks; per-repository installation), **Supabase** (database, functions, storage, via its MCP server), **Postgres** (any URL), **Vercel** (preview URLs for QA's SIGNOFF, production deploys behind an approval), **generic MCP server** (any server, attached to chosen roles). Channels in the MVP: **email** (the customer's provider through its API: Resend, Postmark, SES, SendGrid; SMTP as a fallback; Gmail or Microsoft 365 through OAuth when a person wants mail from their own address) and **webhook**. Then **Slack**, Teams, Discord, push. Later: GitLab, Netlify, Cloudflare, Sentry, Linear.

Rules that hold for every connector: writes to a database schema happen only through migrations in the repository and the deploy workflow; production deploys and destructive operations always need an approval; a role without a binding gets no tools and no secrets for that resource.

## 8. Auth and security

- **People:** sign-in through OIDC in every deployment: GitHub first, then Google and Microsoft, then any OIDC or SAML provider. Local mode uses one built-in owner account through the same code path. Roles: owner, admin, editor, viewer, approver. Approvals check the person's role.
- **Repositories:** a GitHub App with per-repository installation and short-lived installation tokens. The app identity, not the user's token, opens PRs, so branch protection and required reviews still apply.
- **Model access:** bring your own Anthropic API key (or a cloud provider's Claude endpoint), stored in the vault. In local mode the Agent SDK can also use the user's existing Claude Code login.
- **Secrets:** envelope encryption (local: OS keychain; self-hosted: the customer's KMS or a master key from the environment; hosted: our KMS, or the customer's KMS key when their data plane runs in their network). Secrets are released to a session only for bound resources, never written to the repository, briefs, memory or the chat (a kit rule, now enforced by redaction in the audit log and chat).
- **Untrusted content:** issue bodies, PR comments, web pages and tool output are wrapped as untrusted in prompts. Actions outside the repository need approval. The egress allowlist limits what an injected instruction can reach.
- **Isolation:** one sandbox per run (hosted: per session), no shared credentials between tenants, and an audit log the owner can export.

## 9. Portability (closes G3)

| Layer | Today | Plan |
| --- | --- | --- |
| Scripts | bash + `jq` (Windows needs WSL) | Node equivalents in the kit CLI (`agent-team status`, `board`, `gate`, `lock`), generated next to the bash scripts. The bash scripts become thin wrappers, so existing teams keep working |
| Team definition | markdown briefs + `.agent-team/` | unchanged, plus the TeamSpec schema as a neutral, versioned contract |
| Agent runtime | Claude Code only | adapters: Claude Code threads, subagents, built-in agent teams, Agent SDK runner (MVP); `AGENTS.md`-style instruction export for other coding agents (later). Governance is enforced by the runner and by CI, so it holds for any agent inside |
| Board | JSONL file or Supabase | the same event shape on the Studio server; Supabase board kept |

## 10. Evals (closes G4)

- `evals/tasks/`: task sets on pinned sample repositories (a web app with Supabase, a CLI, a native mobile app), each with hidden acceptance tests.
- `evals/harness`: runs a task with a chosen configuration (single agent, subagents, built-in agent teams, Studio runner with a given team) in a fresh sandbox, with the same model and the same budget.
- **Scores:** hidden tests passed, regressions, code review findings (by a separate reviewer model), owner interventions, wall time, cost. Results are stored as runs and shown in the Studio.
- The harness doubles as the regression suite for kit releases: a brief or protocol change that lowers scores does not ship without a reason in the changelog.

## 11. What changes in the kit

| Kit version | Change | Why |
| --- | --- | --- |
| 0.4 | Hook-based status (in progress), built-in agent teams export from sync (in progress), `ownership.json`, `gates.json`, `resources.json`, `packages/team-model` with import/compile used by the CLI | G1, G2, round trip |
| 0.5 | Node equivalents of the scripts; Windows CI | G3 |
| 0.6 | Policy file for approvals (the owner-steps-in list as data), consumed by the runner and by a CI check | Governance enforced |
| next | `## Sign-off evidence` and structured `## Wakes on` in briefs, `meetings.json` with sync support, role packs (`pack.json`), `diffTeams` and `impact` in `packages/team-model`, a shadowing check for custom slugs on upgrade | Section 12 |

All of it is backwards compatible: a layer without the new files behaves as today.

## 12. Team operations: custom agents, meetings, notifications, changes while running

Added 2026-11-06 for [PRD](prd.md) sections 6.6 to 6.9. Mockups in [mockups/](mockups/). The decision behind 12.4 is [ADR 0004](../adr/0004-team-versions-and-transitions.md).

### 12.1 Custom agents

A custom agent is a project role. Nothing new is needed in the kit to hold one: `roles/<slug>.md` already works, and the TeamSpec already carries it as `source: "project"` with a `brief`. What is new:

- **Two optional brief sections.** `## Sign-off evidence` (a list the team tool server checks: a SIGNOFF from this role without these artefacts is rejected) and a machine-readable `## Wakes on` list (`handoff`, `pr-paths: apps/web/**`, `label: a11y`, `schedule: fri 14:00`, `meeting`). Free text in `Wakes on` keeps working; the runner reads only lines it understands and the checks warn about the rest. Kit roles may use the same sections later.
- **Editor flow** (`apps/studio`): the start sheet (blank, copy a kit role, import) writes a `brief` into the draft; the editor edits that brief's sections; the preview is `compile` of that one role. "Copy a kit role" resolves the kit brief with the project's extensions first, so the copy matches what the team runs today.
- **Checks** in `validate`: slug free and not a kit slug in the pinned kit (or `project-replaces-kit` chosen); one writer per path (the existing ownership check, now run on every keystroke for the role being edited); `Hands to` and `Reports to` resolve; evidence present for roles that sign off; secret scan.
- **Path conflicts**: the editor never writes a second owner. "Read only" adds a reads line to `Owns`; "narrower path" splits the ownership row; "move the path" creates an ownership change that goes through 12.4 if the old owner has work in flight.
- **Role packs**: a folder with `<slug>.md` and `pack.json` (`{ "roles": [...], "needs": { "tools": [...], "resources": ["postgres"], "paths": ["tests/a11y/"] } }`). Import checks the brief like any other and maps `needs.resources` to bindings the owner confirms. A pack never brings secrets.
- **Kit upgrades**: `agent-team sync` and the Studio's upgrade check compare custom slugs with the new kit's roles and report a shadowing conflict as an error with a rename fix.
- **Try it on a task** (runner): a one-off session with the draft brief, in a throwaway worktree, with writes refused outside it, no bindings above read, and a $1 default cap. The result is shown, never merged.

### 12.2 Meetings

Meetings are a runner feature built on the bus and the team tool server. There is no new agent behaviour that is not a protocol: a meeting turn is a message, and the minutes are a report.

- **Scheduler.** A persisted job table in the control plane (a durable workflow per meeting definition) computed from `meetings.json` of the live team version, in `values.TIMEZONE` (DST-safe: times are wall-clock in that zone). If the runner was down at a meeting's time, it runs once on start if less than 2 hours late, otherwise records "missed" and notifies; it never runs a backlog of missed meetings. Event-triggered meetings subscribe to board and GitHub events.
- **Meeting run.** A `meeting` record (id, definition, team version, attendees resolved at start, status, cost). The facilitator's session gets a `meeting_open` message; each attendee gets a `meeting_turn` message with the agenda and, in discussion format, the transcript so far.
- **Busy attendees.** A role session that is working is never interrupted. The bus marks `meeting_turn` as deliverable at the next pause: the supervisor delivers it when the session's current turn ends (between tool calls, after a Stop or a SIGNOFF/HANDOFF). With `ifBusy: proxy`, the facilitator answers from the role's board events and memory file and the minutes mark it. With `skip`, it is left out. Dormant roles are woken only when named explicitly. A role in two meetings answers them in order.
- **Discussion format.** Rounds are bounded (`rounds`, default 3). The facilitator decides after each round whether to close. The owner's messages in a meeting are stored verbatim like chat messages.
- **Outputs.** New team tools: `meeting_reply(meeting, text)` for attendees; `meeting_close(meeting, minutes, action_items[], decisions[])` for the facilitator. Each action item becomes `open_issue` or a HANDOFF with its usual fields; each decision becomes `ask_owner` or `request_approval`. The minutes are a chat message and a board event (`kind: "meeting"`).
- **Cost.** The estimate in the editor is attendees × tier × a per-turn token estimate from recent runs. The cap stops the meeting and the facilitator writes partial minutes. `skipIfQuiet` skips when no board event since the last run touched an attendee.
- **Without the runner.** In threads mode the export adds each meeting to the chief of staff's brief as a scheduled duty; the CLI can print the agenda. Real scheduling needs the runner.
- **Validation.** Attendees must be on the team (a removed role is dropped from definitions by the change step in 12.4); two meetings for the same role at the same time warn; a meeting with no active attendees is skipped with a note.

### 12.3 Notifier

A runner service, not an agent. It reads the same event stream as the board and the chat.

- **Inputs:** board events (hook and role), approvals, decision cards, budget events, run events, meeting events, publish and rollout events (12.4), channel failures.
- **Rules:** `{ when: <event kind + filter>, about: { roles, lanes }, to: [channel ids], how: { mode: now|batch|summary, every, quiet: breakthrough|hold } }`. Stored per member in the control plane (`notification_rule`, `member_channel`), in every deployment, never in the repository.
- **Channels are connectors** with the `notify` capability (section 7), connected once per workspace (Slack app, email provider) and then claimed by each member (their verified address, their Slack user). The notifier calls `notify.send(message) → delivery` and `notify.verify()`; it knows no vendor. Each delivery is a durable workflow: retries with backoff (3 tries), then the rule's fallback channel, and the member is told in the Studio.
- **Rendering:** a template per event kind with a subject, a short body, a recommendation when there is one, and a deep link into the Studio. Text from outside the team is quoted and cut to 120 characters. Secrets are redacted by the same redactor as the audit log.
- **Replies:** a decision link or a Slack button carries a signed, single-use token tied to the card and the person. Email replies are parsed only for decision cards (the first line must match an option). Approvals always require the signed-in Studio; the email holds a link, never an approve action.
- **Dedup and batching:** a key per (rule, event subject) suppresses repeats for 10 minutes; batched rules flush on a timer; quiet hours hold non-breakthrough messages for the digest.
- **Safety:** recipients are only verified addresses of the person who owns the rule; the team tool server has no notify tool; outbound email from agents to anyone else stays on the owner-steps-in list.

### 12.4 Team versions and changes while running

The core rule ([ADR 0004](../adr/0004-team-versions-and-transitions.md)): **every session runs a pinned team version**, and a new version reaches a running session only at a point the owner chose.

- **Versions.** A team version is the merge commit of a publish (already true, PRD P3). The runner records `session.team_version` at start and gives the session that version's generated briefs, ownership, bindings and gates. The ownership pre-tool hook reads ownership **for the session's version**, plus the transition rules below.
- **In-flight inventory.** For each role: live sessions and their state (working, waiting, idle), the current task and its branch and PR, uncommitted changes in the worktree, queued bus messages to and from it, pending approvals and decision cards it raised, held locks, assigned issues, and meeting invitations. In threads mode (no runner) the inventory comes from board events, open PRs and issues, and is marked possibly stale.
- **Impact analysis.** `diffTeams(published, draft) → changes[]` (in `packages/team-model`, pure) classifies each change: role removed or switched off, role made dormant, reporting changed, path ownership moved, binding removed or narrowed, tier changed, brief section changed, gate changed, meeting changed. `impact(changes, inventory) → items[]` joins them with the inventory. Each item gets a severity (`safe`, `choice`, `blocking`) and the allowed and recommended choices:

| Change | In flight | Allowed choices | Recommended |
| --- | --- | --- | --- |
| Role off or removed | working on a task | finish then off, hand off now, pause, stop and drop | finish if the task is near done (by its checklist and age), else hand off |
| Role off or removed | idle | off at merge | off at merge (safe) |
| Path moves A → B | A has a branch touching it | move after A's PR merges, move now with an exception for the touched files, move now and hand over the files | move after merge |
| Binding removed or narrowed | role mid-task using it | at next task, now (revoked between tool calls) | at next task |
| Tier or brief text changed | working | at next task, apply now (restart from memory) | at next task (safe) |
| Reporting changed | open hand-offs to the old manager | re-route queued, keep in-flight threads with the old manager | re-route queued |
| Gate changed | PR in the merge queue | old gate for open PRs, new gate for all | old gate for open PRs |
| Meeting changed | meeting running now | finish this one on the old definition | finish (safe) |

- **Transition plan.** The owner's choices are a `transition` record: `{ from: <sha>, to: <draft id → sha on merge>, items: [{ id, choice, params }], mode: per-item | when-idle, created_by }`. It lives in the Studio's storage and is summarised in the publish PR body, so a reviewer sees it. It is runtime data, not part of `.agent-team/`.
- **Applying.** When the publish PR merges, the runner re-runs the inventory (things may have changed), applies the plan item by item, and gives new items the default "let it finish". Per choice:
  - *finish*: the session keeps its version, gets a `finishing` flag (the bus stops routing new work to it; the router sends it to the new owner), and moves or stops at its next SIGNOFF, HANDOFF or idle.
  - *hand off now*: the supervisor sends the session a `checkpoint` message (push, write memory, write a HANDOFF to the target with what is done and left), waits for it (with a timeout, after which the supervisor itself pushes the worktree to a `wip/` branch and writes the HANDOFF from the board), then stops it.
  - *pause*: checkpoint, stop, the task goes to the board as `paused` with its branch.
  - *apply now*: checkpoint, stop, start a new session on the new version with "Resume from roles/<slug>.md".
  - *stop and drop*: checkpoint to a `wip/` branch (kept 30 days), close the PR, stop.
  - *move after merge* and *exceptions*: the ownership hook gets a temporary rule (`{ path, writer: A, until: pr-merged #142, files: [...] }`) so exactly one writer holds each file at every moment.
- **Invariants** (checked by the runner, and a failed check stops the transition and raises a card): every running session's writes are allowed by exactly one ownership rule; no bus message is addressed to a role absent from both the old and new versions; no approval is pending for a role with no session that can run it; every stop was preceded by a successful push or a `wip/` push.
- **Rollout view and events.** Each step emits a board event (`kind: "transition"`) so the canvas, the chat and the notifier show it. A role on an old version for more than 24 hours raises a card.
- **Changes from outside the Studio.** The runner watches the default branch. A merge that changes `.agent-team/` without a transition plan gets one generated with all recommended choices, posted as an impact card in the chat; it applies when the owner confirms, or after 30 minutes with the "let it finish" defaults (never "stop and drop" by default).
- **Concurrent drafts.** A Studio draft records its base version. If the team moved on, the draft is rebased with a three-way merge on the TeamSpec (per role, per section); conflicts are shown in the editor before Publish.

### 12.5 Tools added to the team tool server

| Tool | Who | Effect |
| --- | --- | --- |
| `meeting_reply(meeting, text)` | attendees | the role's turn; refused outside an open meeting |
| `meeting_close(meeting, minutes, action_items, decisions)` | facilitator | minutes to the chat, action items to issues or HANDOFFs, decisions to cards |
| `checkpoint()` | every role (runner-invoked) | push, write the memory file, report; the runner calls it before any stop |

## 13. Built to last: the decade checklist

[ADR 0005](../adr/0005-online-first-built-to-last.md) holds the decision. This is the checklist every design and PR is held to. The contracts themselves are in [docs/contracts/](../contracts/README.md).

| Concern | Rule | What it protects against |
| --- | --- | --- |
| Team definition | Plain files in Git; TeamSpec schema `@N` with an upgrade function from every earlier version; golden tests | Losing teams to a database migration or to us going away |
| Runtime history | One append-only event log; current-state tables are projections that can be rebuilt; events are versioned (`type` + `version`) and upcast on read | Schema changes that rewrite history; new views that need old data |
| Long-running work | Durable workflows behind one interface (Postgres jobs and timers first; Temporal-class later); every step idempotent with a key | Restarts, deploys and crashes losing a meeting, an approval wait or a transition halfway |
| Tenancy | `tenant` on every row from the first migration; row-level security; per-tenant encryption keys | A painful retrofit when the first second customer arrives |
| Identity | OIDC everywhere, local included; people have roles; agents have their own identities (per session, short-lived tokens) | Shared credentials; approvals by the wrong person |
| Integrations | Connectors over MCP with a capability manifest; no vendor SDK in the core | Vendors changing or disappearing |
| Agents and models | Runner protocol is ours; agent runtimes and model providers are adapters (at least two planned) | One vendor's SDK or model shaping the product |
| Deployment | Control plane and data plane separate; runners connect outbound; same images everywhere | Customers who cannot let code or secrets leave their network |
| API | `/v1/` OpenAPI; additive changes only within a version; 12 months' notice before removal; the CLI and the Studio use only the public API | Breaking integrations and scripts |
| Data | Postgres and an S3-compatible store; export of a whole tenant (team files, events, evidence) as an archive | Lock-in; compliance requests |
| Operations | OpenTelemetry; kill switches per run, workspace and globally; runbooks | Running a service for years, not a demo |
| Industry | Neutral core concepts (workspace store, areas, checks, propose and accept, evidence, policy); engineering is the repository connector's implementation and the first role pack; vocabulary comes from the pack | Being stuck as a developer tool when any team (marketing, legal, support, finance) could use it |
| Security | Least privilege per role and per person; secrets only to bound sessions; everything from outside marked untrusted; audit from the event log | Injected instructions, leaked keys, silent actions |
