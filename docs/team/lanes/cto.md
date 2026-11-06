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
| Kit gaps from running in project threads (#29) | Live (kit 0.9.0, 0.9.1) |
| Studio and dashboard DNS-rebinding fix | Live (kit 0.9.2, #43) |
| Runner and chief-of-staff chat (M3, #28) | Building: seams spec (#37), server part 1 (#38) and runner (#42) merged; Studio chat (#36) signed off; server part 2, runner F3 and resumed-session fix (#46) in flight |
| Online: hosting, sign-in, GitHub App, email (M4) | Deploy path ready (#44, #34); owner accounts at M4 |
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
8. **M3 seams spec accepted** (2026-11-06, #37): docs/product/m3-design.md is the contract for the runner, approvals, chat and budget; changes to it are additive.
9. **Hosting split** (2026-11-06, #34): Vercel serves only the static Studio and rewrites `/v1/*` to one always-on control-plane container (Fly.io). Supabase holds Postgres in its own `agent_team` schema. No serverless functions, no Supabase Realtime. A hosted Studio with sign-in is M4. One narrow exception (2026-11-06, #73): a Vercel Routing Middleware on the rewritten paths that only sets `x-agent-team-edge` from `AGENT_TEAM_EDGE_SECRET`, so per-caller rate limits see the real caller; Fly runs with `AGENT_TEAM_PROXY_HOPS=1`. Anything more on Vercel needs a new decision.
10. **Security decisions are binding** (2026-11-06): D1 to D8 from the security reviewer go into m3-design section 12. Two of them: an approval is bound to the PR head sha, and the agent's credential can never merge or dispatch workflows.
11. **Runner sandboxing** (2026-11-06, #42, #46): each session gets a throwaway home and an allowlisted env. The runner pushes from outside the sandbox with a branch-only credential, after an ownership and secret check against bases it fetched itself, not refs the agent can write. Sessions run under their own user so they cannot read the runner's keys (F3). A container is the supported setup.
12. **Step-up secret is server-side** (2026-11-06): only its hash lives on the control plane (`AGENT_TEAM_STEP_UP_SECRET_HASH`), never in the Studio or runner env. The person types it to approve.
13. **No real model calls until the owner sets the key and a daily cap** (2026-11-06), and not before F3 is signed off. Smoke tests are opt-in and never use ambient credentials.
14. **Phone approval for the M3 exit** (2026-11-06): the local Studio over the same Wi-Fi, no tunnel. The QR code is parked in #30.
