# Agent Team Studio: architecture

Owner: architect. Status: draft 1, 2026-11-05. Reads with the [PRD](prd.md). Decisions that need an ADR have one in [docs/adr/](../adr/).

## 1. Principles

1. **The repository is the source of truth.** A team is the `.agent-team/` folder in the product's repository. The Studio is an editor and a control room over it. It is never the only copy ([ADR 0001](../adr/0001-repository-is-the-source-of-truth.md)).
2. **Publish = compile + sync.** The Studio compiles its team model to `.agent-team/` and then runs the *pinned* kit `sync`. A Studio user and a text-only user get byte-identical generated files.
3. **Lossless round trip.** `compile(import(layer))` yields the same sync output as `layer`, for every layer we know. This is tested, not hoped for.
4. **Governance is enforced, not only prompted.** Ownership, approvals, budgets and merge gates are checked by the runner and by CI, so they hold whatever model or agent is inside.
5. **Runtime-neutral team, runtime-specific adapters.** The team model says *who* does *what* and *may touch what*. Adapters turn it into Claude Code threads, subagents, built-in agent teams, Agent SDK sessions, or other agents' formats.
6. **Local first.** Everything runs on one laptop. Self-hosted and hosted are the same code with other storage and sandbox drivers.

## 2. System overview

```
                      ┌──────────────────────── Studio (one Node process locally) ───────────────────────┐
 Browser              │                                                                                  │
 ┌──────────────┐     │  apps/server  (HTTP + WebSocket)                                                 │
 │ apps/studio  │◄───►│   ├─ teams API ── packages/team-model (import · edit · validate · compile)       │
 │  canvas      │     │   ├─ publish ──── kit CLI (pinned) sync ── git / GitHub App ── PR                │
 │  inspector   │     │   ├─ systems ──── connectors (GitHub, Supabase, Postgres, Vercel, MCP) + vault   │
 │  chat        │     │   ├─ board ────── POST /api/report (same shape as team-status.sh and hooks)      │
 │  live board  │     │   └─ runs ─────── apps/runner                                                    │
 └──────────────┘     │                    ├─ chief-of-staff session (always on while a run is live)     │
                      │                    ├─ role sessions (on demand, one worktree each)               │
                      │                    ├─ team tool server (MCP): report, handoff, ask_owner, ...    │
                      │                    ├─ message bus · approvals · budgets · audit                   │
                      │                    └─ sandbox driver: local process | Docker | microVM            │
                      │  storage driver: SQLite (local) | Postgres (self-hosted, hosted)                 │
                      └──────────────────────────────────────────────────────────────────────────────────┘
                                    │ model API (Anthropic)        │ product systems (bound per role)
```

Repository layout (monorepo, npm workspaces). The kit's root package stays as it is, so `npx github:PurpleGiragge/Agent-Team-Kit#vX` keeps working. The `files` whitelist in the root `package.json` keeps the apps out of the kit package.

```
bin/ team/ presets/ scripts/ tools/ templates/ board/   the kit (unchanged role: CLI, briefs, scripts, dashboard)
packages/team-model/       schema, import, validate, compile; used by the CLI, the server and the browser
apps/studio/               the editor and control room (React)
apps/server/               API, auth, publish, systems, board endpoint, storage
apps/runner/               run modes, sessions, team tool server, bus, approvals, budgets
evals/                     task sets, harness, scoring
deploy/                    Dockerfiles, Compose, Helm
```

## 3. The team model

### 3.1 Shape

`TeamSpec` is a JSON document with a JSON Schema (`packages/team-model/schema/team-spec.v1.json`). It is what the canvas edits and what the server stores as a draft. Sketch:

```jsonc
{
  "schema": "agent-team/team-spec@1",
  "kit": "github:PurpleGiragge/Agent-Team-Kit#v0.6.0",
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

- **Stack:** Node 20+, TypeScript, Hono (runs on Node, Bun and edge runtimes), WebSocket for live board and chat, Drizzle ORM. Storage driver: SQLite in local mode, Postgres in self-hosted and hosted mode.
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

- **Bus:** a table-backed queue (SQLite or Postgres). A message to a role whose session is idle wakes it with "Resume from roles/<slug>.md" plus the message. The owner's messages are stored verbatim and travel quoted (the dilution rule).
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

Every resource type is a **connector** with the same four parts. This is how the Studio links a team to "the whole deal".

| Part | What it does | Example: Postgres |
| --- | --- | --- |
| Config | Non-secret identifiers stored in `resources.json` | host, database, schema |
| Secrets | Names in the repository, values in the vault | `DATABASE_URL` (read-write), `DATABASE_URL_RO` |
| Tools | An MCP server or CLI the bound roles get, scoped by permission | read → a read-only role and query tool; write → migrations through the repository only |
| Discovery | Suggestions for ownership, gates and bindings | `supabase/migrations/` → backend dev; a gate step for migration tests |

MVP connectors: **GitHub** (GitHub App: contents, pull requests, issues, checks; per-repository installation), **Supabase** (database, functions, storage, via its MCP server), **Postgres** (any URL), **Vercel** (preview URLs for QA's SIGNOFF, production deploys behind an approval), **generic MCP server** (any server, attached to chosen roles). Later: GitLab, Netlify, Cloudflare, Sentry, Linear, Slack.

Rules that hold for every connector: writes to a database schema happen only through migrations in the repository and the deploy workflow; production deploys and destructive operations always need an approval; a role without a binding gets no tools and no secrets for that resource.

## 8. Auth and security

- **People:** local mode has no accounts (the person at the keyboard is the owner). Self-hosted and hosted use GitHub OAuth for sign-in, with workspace roles owner, editor, viewer. SSO (OIDC/SAML) later.
- **Repositories:** a GitHub App with per-repository installation and short-lived installation tokens. The app identity, not the user's token, opens PRs, so branch protection and required reviews still apply.
- **Model access:** bring your own Anthropic API key (or a cloud provider's Claude endpoint), stored in the vault. In local mode the Agent SDK can also use the user's existing Claude Code login.
- **Secrets:** envelope encryption (local: OS keychain; self-hosted: a master key from the environment; hosted: KMS). Secrets are released to a session only for bound resources, never written to the repository, briefs, memory or the chat (a kit rule, now enforced by redaction in the audit log and chat).
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

All of it is backwards compatible: a layer without the new files behaves as today.
