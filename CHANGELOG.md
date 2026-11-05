# Changelog

## Unreleased

- This repository now runs its own team: `.agent-team/` (21 roles, pinned to v0.3.0, with a `kit-core-dev` role of its own), generated `docs/team/` and `scripts/agent-team/`, and `sync.sh check` in CI. Nothing changes for other teams.
- The kit package no longer picks up generated scripts: `package.json` `files` lists `scripts/*.sh` instead of `scripts/`. The package contents are the same as in 0.3.0.
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
