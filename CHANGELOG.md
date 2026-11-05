# Changelog

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
