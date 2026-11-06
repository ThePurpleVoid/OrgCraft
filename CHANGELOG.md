# Changelog

## 0.9.0

Running a team from project threads, where every thread has its own machine (issue #29). Existing teams see these changes on their next sync:

- **One board for threads on separate machines.** `AGENT_TEAM_HOME` can now be set in `.agent-team/config.sh`, `~/.agent-team/<project>/team.env` or `.agent-team/local.env` as well as the environment, so every thread can point at a folder they all share. `team-status.sh`, `report.mjs`, the hooks, `team-board.sh` and the dashboard all follow it. A state folder set this way can hold its own `team.env`, for a shared board's URL and token. The environment still wins.
- **Each checkout knows its role.** `.agent-team/local.env` (`AGENT_TEAM_ROLE=<role>`) names the role a checkout plays. The hooks report the thread's own session as that role without anything in the environment, and `team-status.sh status working --task "..."` and `report.mjs` work without the role argument. Sync adds `.agent-team/local.env` to `.gitignore` (one line, once). `doctor` prints the role a checkout reports as, and fails when `local.env` is committed or names a role that is not on the team.
- **Briefs, protocols and project instructions:** "the main project chat" is now "the owner's channel". The protocols define it and describe **the chief of staff as a thread**: when the host has its own coordinator, the owner keeps talking to the coordinator, the coordinator relays to the chief of staff's thread verbatim, and the chief of staff dispatches through the coordinator. Nothing else changes. Role threads may leave the role out of `team-status.sh` when `local.env` names it.
- **Running the team:** sections on one board for threads on separate machines, the role of a checkout, the chief of staff as a thread, and routines scheduled from a thread (a scheduled task whose prompt names the role and the job) rather than only cron.
- `templates/config.sh` documents `AGENT_TEAM_HOME`.

## 0.8.0

- **Contracts for the online product** ([docs/contracts/](docs/contracts/README.md), milestone M1 of the MVP). They are written before the code that implements them:
  - the event envelope, version 1, CloudEvents-compatible, with a catalogue of report, message, run, session, chat, approval, team and connector events
  - `/v1/` of the public API as OpenAPI 3.1. `POST /v1/teams/{team}/reports` takes the kit's reports byte for byte, so teams already on the kit are seen without changing a script
  - the runner protocol: runners connect outbound, work is checkpointed, secrets are released per session
  - the connector manifest. The MCP tools come with `notify`, `sink`, `inbound`, `discover` and `work` capabilities. A `sink` in `kit-report` format keeps a board a team already runs working unchanged
  - the work contract: area, check, propose, accept, evidence
- **Mobile is a first-class client** ([ADR 0006](docs/adr/0006-mobile-apps-native-per-platform.md)): native iPhone and Android apps, each in its own repository, later (phase 4). The new [clients contract](docs/contracts/clients.md) says what every client can rely on now: a discovery document, OIDC with PKCE, an inbox across teams, structured cards with versions, step-up for approvals, one deep-link URL per thing, devices and contentless push, catching up by event id. `api-v1.yaml` gains these endpoints. The PRD (6.10, demo step 18), architecture (section 14), deployment (phones) and delivery plan are updated, with two mobile mockups.
- `packages/events`: the envelope and an exact two-way mapping with the kit's board reports, tested on every report kind.
- **The control plane** ([apps/server](apps/server/README.md), milestone M2). An event log in Postgres with row-level security per tenant, PGlite for local mode and tests, so `node apps/server/bin.mjs` needs nothing else installed. A team already on the kit connects by changing `TEAM_REPORT_URL` and `TEAM_REPORT_TOKEN`: the kit's own `team-status.sh` is tested against it unchanged. It also has the board, the event log with its live stream (it resumes from `Last-Event-ID`), report tokens that can be revoked, and sinks that forward reports in the kit's shape to a board the team already runs, with their tokens sealed in a vault. The API contract gains sinks, secrets, token revoke and health.
- **The live board on the Studio's canvas.** A Live button shows what every role is doing now: a dot coloured by status, the task, who it is waiting on, and threads that have gone quiet. It updates as reports arrive. The Studio reads the local event log, or the control plane when `AGENT_TEAM_SERVER`, `AGENT_TEAM_SERVER_TOKEN` and `AGENT_TEAM_SERVER_TEAM` are set, and keeps the token on its own server.
- **Report mirrors.** `TEAM_REPORT_MIRROR_URL` and `TEAM_REPORT_MIRROR_TOKEN` send every report (from `team-status.sh`, `report.mjs` and the hooks) to a second board too, with the same id. A team can feed the control plane next to the board it already runs.
- Control plane: `after=<event id>` on the log, SSE ids that are event ids, an opaque `cursor`, and `asOf` plus an ETag on the board, matching docs/contracts/clients.md. Its default port is now 4849, so it can run next to the Studio.

## 0.7.1

- **Round trips keep extension files byte-identical.** A `roles/<x>.extend.md` with no blank line after its title was rewritten with one on import and compile, so opening a real team in the Studio and publishing it changed files nobody edited. The team model now keeps an unchanged extension's own text (`extensionText` in the TeamSpec). Found by opening a 50-role production team in the Studio.
- **Custom agents in the team model** (the editor comes next): `draftRole` (blank from the kit template, a copy of a role as the team runs it, or an imported brief), `addAgent`, `checkSlug`, `briefSection`/`setBriefSection`/`setBriefField`/`setBriefTitle`, `ownsPaths`/`setOwnsPaths`, `pathConflicts`, and role packs (`rolePack`, `readPack`; `pack.json` lists tools, system types and paths, never secrets). `loadKit` now includes the role template.
- `validate` checks custom agents: a valid slug, a warning when one replaces a kit role, an Identity, one writer per area (against `ownership.json` and other custom agents), and sign-off evidence for roles that send SIGNOFF.
- This repository's own team is on 0.7.0.

## 0.7.0

Agent Team Studio: connect your systems, assign owned areas and set checks (demo steps 5 and 6).

- **Views:** Org, Flow, Systems, Owned areas and Checks, over the same team.
  - **Flow** draws who hands work to whom, from each role's "Hands to". Click a role to see its hand-offs, with blue going out and green coming in.
  - **Systems:** add a repository, database, backend, hosting, monitoring or any MCP server, with its settings and the *names* of its secrets. Drag a system onto a role to let the role use it, then set read, write or deploy in the inspector. Cards show each role's systems, and publishing writes `.agent-team/resources.json`.
  - **Owned areas:** one writer per area of the repository. The Studio reads the repository's folders and suggests an owner for each one nobody owns (`apps/web/` → web dev, `supabase/` → backend dev, `e2e/` → test automation). You can also import a hand-written `ownership.md`. Publishing writes `.agent-team/ownership.json`.
  - **Checks:** sets of checks that must pass before a merge, with machine slots (pools), suggested from `package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, Gradle and Swift. Publishing writes `.agent-team/gates.json`.
- The inspector shows each role's systems. The live check list is now called **Problems**, and clicking one opens the view it is about.
- The Studio's API moved to `/v1/` (`GET /v1/team`; `POST /v1/team/preview`, `/publish`, `/graph`, `/suggestions`), versioned like the public API it will become ([ADR 0005](docs/adr/0005-online-first-built-to-last.md)).

- This repository's own team is on 0.6.0.

## 0.6.0

**Agent Team Studio, local mode** (phase 2 of the [Studio plan](docs/product/delivery-plan.md)): build your team visually and publish it to a branch.

- `agent-team studio` opens a visual editor for the repository's team at http://localhost:4848 (`--port`, `--host`, `--open`, `--dir`).
  - **Library:** every kit role and every role of your own, grouped by lane, with a switch each and search. Drag a role onto a manager on the canvas to add it there.
  - **Org chart:** drag a card onto another to change who it reports to (loops are refused), with zoom and fit.
  - **Inspector:** model tier, reporting line, dormant or active, and each section of the kit's brief with your own text added to it or replacing it. Reset a role to the kit. Roles of your own are edited as markdown.
  - **Checks:** the kit's `validate` runs on every change, and clicking an issue opens the role. Undo and redo (Ctrl+Z, Ctrl+Shift+Z).
  - **Publish:** a diff of every file the publish would write (the layer and what sync generates), then one commit on a new branch. It refuses a team with errors, an existing branch and uncommitted changes to the team's files. Push the branch and open a pull request as usual.
- The server has no dependencies and no build step ([ADR 0003](docs/adr/0003-studio-local-mode-without-a-build.md)). It listens on 127.0.0.1 and only accepts same-origin JSON posts.
- This repository's own team is on 0.5.0 and uses the new data files: its ownership is `.agent-team/ownership.json` and its kit gate is `.agent-team/gates.json`.

## 0.5.0

The team as data: everything the visual team builder (Agent Team Studio) will edit, available today from the CLI. Existing teams see no change on sync unless they add one of the new files.

- **Ownership, gates and systems as data**, each an optional file in `.agent-team/`:
  - `ownership.json` (rows of path, writer, notes). Sync generates `docs/team/ownership.md` from it, showing each writer by role title, so the dashboard still maps paths to roles. Without the file, `ownership.md` stays hand-written as before.
  - `gates.json` (`all`, `pools`, `targets` of named steps with an optional pool). Sync generates `scripts/agent-team/gates.sh`, which `lib.sh` sources after `config.sh`. A target defined there replaces a `gate_<target>` of the same name in `config.sh`, and bash-shaped gates stay in `config.sh`.
  - `resources.json` (systems with non-secret settings and secret *names*, plus bindings of role × system × read, write or deploy). Sync adds a Systems table to the project instructions and a Systems section to each bound role's brief.
- **`agent-team validate`** checks the team without writing anything: one role reporting to the owner, no reporting loops, valid tiers, one writer per path, no role owning a generated path, bindings that point at real systems with a known permission, secret names that are names, and no secret values anywhere in the team's text.
- `.agent-team/studio.json` is reserved for the editor's layout; sync ignores it.
- This repository's own team is on 0.4.0 with the reporting hooks on (`.claude/settings.json`).
- **The team model** (`packages/team-model`, phase 1 of the [Studio plan](docs/product/delivery-plan.md)). A whole team as one JSON document, a TeamSpec ([schema](packages/team-model/schema/team-spec.v1.json)). `agent-team import` prints the project layer as a TeamSpec. `agent-team compile <spec.json>` writes one back to `.agent-team/` and syncs. Switching roles on and off produces the smallest `include`/`exclude`, and editing a kit role produces an `.extend.md`. The round trip is tested on every preset (with and without subagents), the native-mobile example and this repository's own team, and it builds byte-identical generated files. The module is pure, so the Studio editor can run it in a browser.
- `bin/agent-team.mjs` now uses the team model's implementation of the extension and reporting-line rules, so there is only one. Existing teams see no change on sync.

## 0.4.0

Closes the gaps against other agent kits: reports no longer depend on the roles remembering, the team runs as a Claude Code agent team, the day-to-day path needs only Node, and there is a smoke test.

- **Hooks report for the roles.** `"hooks": true` in `team.json` (the default for `init`) makes sync merge the kit's hooks into `.claude/settings.json`, keeping everything else in that file; `check` fails when they are missing. `scripts/agent-team/report.mjs hook` turns Claude Code events into board reports with `"source": "hook"`: `working` on session start and on a prompt (a waiting, blocked or in-review role keeps its status), a heartbeat at most every 5 minutes while tools run, `idle` when a turn or session ends, and every subagent or teammate as its own role (`SubagentStart`/`SubagentStop`, `TeammateIdle`, `TaskCompleted`). The main session is the role in `AGENT_TEAM_ROLE`. Built-in agents such as Explore are not reported. The dashboard's feed marks hook reports "auto".
- **Claude Code agent teams.** `"agentTeams": true` installs the roles as teammate types in `.claude/agents/`, sets `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in `.claude/settings.json`, and writes `docs/team/agent-teams.md` with a spawn prompt for each lead and its reports.
- **Node only, where it is cheap.** `scripts/agent-team/report.mjs` takes `team-status.sh`'s arguments and writes the same event without bash, `jq` or `curl`; `team-status.sh` hands over to it when `jq` is missing. `scripts/agent-team/sync.mjs` is `sync.sh` for machines without bash. [docs/windows.md](docs/windows.md) lists what runs on Node alone and what needs Git Bash or WSL.
- **`agent-team doctor`.** Checks the tools, that generated files and hooks are in sync, the roster and its hand-offs, and runs a hook event through the reporter into a scratch board. `--ping` posts a note to `TEAM_REPORT_URL`. Exits 1 on any failure.
- Tests: smoke scenarios (a new project reporting through its hooks, `team-status.sh` without `jq`, an agent-teams project passing `doctor` and `sync.mjs check`) and evals that every preset's roster, reporting lines, hand-offs and teammate exports hold together.
- Protocols: hooks are a safety net, not a substitute for the role's own start, wait and message reports.
- Generated scripts with a `#!` line are now executable.
- This repository runs its own team: `.agent-team/` (21 roles, with a `kit-core-dev` role of its own), generated `docs/team/` and `scripts/agent-team/`, and `sync.sh check` in CI. Nothing changes for other teams.
- The kit package no longer picks up generated scripts: `package.json` `files` lists `scripts/*.sh` instead of `scripts/`.
- CI checks the role library explicitly (`roster.mjs --check team/roles`), because `docs/team/roles` (this repository's own team) would otherwise be the default.
- Docs: the product plan for Agent Team Studio in `docs/product/` (PRD, architecture, deployment, delivery plan, how our own team builds it) and ADRs 0001 and 0002.

## 0.3.0

Rules a production team learned the hard way, now the default. Existing teams see these changes on their next sync:

- Briefs (every role's shared footer): the first command of every task, and of every resume, is a `status working` board report, before reading anything; the heartbeat and `waiting` switch are restated where each thread reads them; a role never asks the owner anything in its own thread, but sends a BLOCKED with a recommendation to the chief of staff and keeps working on it unless the step cannot be undone. The chief of staff's footer says it is the one door instead.
- Protocols: **chain of command**. The chief of staff routes every request to the lane's executive, never to an individual contributor; the executive's thread opens as soon as its lane has work, scopes, hands off, reviews before merge, reports its own status and logs decisions in `docs/team/lanes/<executive>.md`. Replaces "an executive is active when any role in its lane is active" and "or to the role directly when the lane has no active executive". The chief of staff still covers lanes whose executive is not installed.
- Protocols: **when the owner steps in**. Engineers merge and deploy; the owner is asked only for irreversible data changes, secrets, money and anything outside the team's reach. Automatic deploys never run destructive migrations.
- Protocols: **architect first**. The list of tasks that need an ADR before any engineer starts (new tables or subsystems, cross-client contracts, irreversible migrations, tenancy/auth/RLS design, infrastructure, more than about a week).
- Protocols: **report on start** spelled out; an hourly stuck-role check; the chief of staff's own card, with the "board reporter" thread for a coordinator that cannot run commands.
- Project instructions: the same rules in the standing rules and in "How work moves".

## 0.2.3

- Tests never post to a real board: `tests/scripts.test.sh` and `npm test` clear `TEAM_REPORT_URL`, `TEAM_REPORT_TOKEN`, `TEAM_BOARD_URL`, `TEAM_READ_TOKEN` and `DASHBOARD_TOKEN` first. Before, running the tests from a thread that reports to a hosted board posted the example reports (backend-dev "Invoices API", PR 57) to that board as if they were real.

## 0.2.2

- Protocols: a **heartbeat** rule. A working thread reports at least every 15 minutes, and reports `waiting` (with what it waits on) the moment it waits on CI, a review or an answer.
- Dashboard: `team.json` can set `dashboard.staleMinutes` (`working`, `waiting`, `review`, `blocked`), written into `roster.json`. The page decides "gone quiet" itself from those limits, so a project can flag a silent working thread after 15 minutes and a waiting one after 2 hours. A quiet card's line reads "Silent 24 min · <task>", the panel says how long and what the limit is, quiet threads no longer count as working or waiting in the tiles, and the legend states the project's limits.
- The local board (`dashboard.mjs`, `summarize`) uses the same limits; `team-board.sh` takes `STALE_WAITING_MINUTES` next to `STALE_MINUTES`.

## 0.2.1

- Dashboard: picking a role no longer rebuilds the page. The chart, tiles, legend, panel and feed are updated in place (elements keep their identity, focus and scroll), and the chart keeps the size it had before the panel opened, scrolling sideways instead of shrinking, so nothing moves under the pointer.
- Dashboard: the panel shows no history until the picked role's history has loaded, instead of the previous role's.
- Dashboard: cards outside the picked chain stay readable (opacity .65, at least 4.5:1 for the name in light and dark).
- Dashboard: an embedded dashboard fills its container's width (it no longer shrinks to its content inside a flex column).

## 0.2.0

- `team.json` can set `"dashboard": { "export": "<folder>", "repo": "<https://github.com/owner/repo>" }`: sync then writes the dashboard's page code and this team's `roster.json` into your website's source, and `check` keeps them current. Your site imports them and mounts the dashboard behind its own sign-in, so the team board on your real site is not code you maintain.
- `AgentTeamDashboard.mount` takes `role`, `view`, `onSelect` and `embedded`, and its handle has `select(id)`, so a host app's router can own the URL (`/admin/team/<role>`).
- `graphFrom(briefs, ownership)` builds the roster graph from parsed briefs.

## 0.1.0

First public version, extracted from a production agent team and generalised.

- 48 role briefs across engineering, quality, product and design, go-to-market, customer and corporate lanes.
- Shared protocols: one door, dilution rule, fast and full lanes, HANDOFF, BUG, SIGNOFF and BLOCKED, ownership, memory files, dormant roles.
- `agent-team` CLI (`init`, `sync`, `check`, `roles`), run with npx: projects keep only a `.agent-team/` overlay (role extensions, new roles, include/exclude, gates and pools) and generate the rest from a pinned kit version.
- `minimal`, `engineering` and `company` presets.
- Example overlay for native Android and iOS apps.
- Scripts: `team-status.sh`, `team-board.sh`, `merge-gate.sh` (config-driven gates), `with-lock.sh` (config-driven pools), `janitor.sh`.
- Tools: `roster.mjs` (check and print the org) and `export-subagents.mjs` (briefs to Claude Code subagents).
- Optional hosted board on Supabase, readable from a website with `TEAM_DASHBOARD_ORIGINS`.
- Live web dashboard (`agent-team dashboard`, `scripts/agent-team/dashboard.mjs`): the org chart and hand-off flow drawn from the briefs, each role lit by its thread's last report, a panel per role, the feed and a phone layout. Runs locally with instant updates from the event log, takes reports from other machines on `POST /api/report`, has a `--demo` mode, and exports as static files or mounts into your own site (`AgentTeamDashboard.mount`) to read a hosted board.
- `team-status.sh` gives every report an id and posts to `TEAM_REPORT_URL` with or without a token.
- The org tree in the project instructions is generated from the installed roles.
- The role template is generated as `docs/team/role-template.md`, so tools that read every file in `docs/team/roles/` see only roles.
- Fixed: generated Node tools keep their `#!` line first, so `node scripts/agent-team/roster.mjs` runs.
- Releases: every new version in `package.json` on main is tagged and released automatically.
