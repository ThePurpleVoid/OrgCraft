# Engineering lane: priorities and decisions

Owner of this file: cto. Last updated 2026-11-06.

## Baseline

[docs/product/delivery-plan.md](../../product/delivery-plan.md) and [docs/product/architecture.md](../../product/architecture.md). They replace every earlier plan.

## Status by feature (2026-11-06)

| Feature | Status |
|---|---|
| Team model and round trip (phase 1) | Live (kit 0.5.0 to 0.7.1) |
| Studio editor: org, flow, systems, owned areas, checks, publish | Live (kit 0.6.0, 0.7.0) |
| Contracts for the online product (M1) | Live (#23) |
| Control plane: event log, report intake, board, stream, sinks (M2) | Live (#24) |
| Live board in the Studio, report mirrors (M2b) | Live (kit 0.8.0, #27) |
| Kit gaps from running in project threads (#29) | Building (kit-core-dev) |
| Runner and chief-of-staff chat (M3, #28) | Building (architect first, then ai-engineer, backend-dev, web-dev) |
| Online: hosting, sign-in, GitHub App, email (M4) | Idea |
| Phase 2 leftovers: custom agent editor, change safety, meetings (#30) | Idea, parked behind M3 |

## Priorities, in order

1. **M3, runner and chat** (#28): a real request from the Studio chat to a merged PR, with QA sign-off and an approval from a phone. Hand-offs: /mnt/project-files/plans/m3-handoffs.md.
2. **Keep existing teams safe**: every kit release says what teams see on sync; CoachSpotter upgrades cleanly (#29 and its pin bumps).
3. **M4, online**, so CoachSpotter can report to the control plane through its mirror.
4. **Phase 2 leftovers** (#30) after M3.

## Decisions made

1. **Repository is the source of truth** (2026-11-05): ADR 0001.
2. **This team runs on the last kit release** (2026-11-05): pinned in `.agent-team/team.json`, bumped by the release manager after each release.
3. **Runtime** (2026-11-05, the owner chose "Our own runner (Agent SDK)"): our runner on the Claude Agent SDK, with subagents and built-in agent teams as zero-infrastructure modes (ADR 0002).
4. **The team runs itself** (2026-11-06, owner: "Yeah let's go with the first approach"): the chief-of-staff thread dispatches; the CTO scopes, hands off and reviews, and no longer writes `apps/` code. Reports go to the shared board in the project folder until #29 lands.
5. **Architect first for M3** (2026-11-06): the runner is a new subsystem and three roles build against the same seams (tables, bus, tool schemas, chat events, budget). One short architect PR fixes them, then ai-engineer, backend-dev and web-dev build in parallel. The contracts in docs/contracts/ stay the law; changes are additive.
6. **Tenancy pattern** (2026-11-06, from M2): row-level security on `app.tenant`, tenant work as `agent_team_app`, no FORCE (the schema owner needs cross-tenant lookups). Every new table follows it and is tested on a real Postgres as a non-superuser, because PGlite runs as a superuser and hides mistakes.
7. **Ports** (2026-11-06): Studio 4848, control plane 4849.
