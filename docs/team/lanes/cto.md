# Engineering lane: priorities and decisions

Owner of this file: cto. Last updated 2026-11-05.

## Baseline

[docs/product/delivery-plan.md](../../product/delivery-plan.md) and [docs/product/architecture.md](../../product/architecture.md). They replace every earlier plan.

## Priorities, in order

1. **Phase 1, team model and round trip** (next): kit 0.4 with `packages/team-model`, the optional layer files, hook-based status and the built-in agent teams export (the last two with the kit thread), and zero-diff golden tests.
2. **Phase 2, local editor and publish**: demo steps 1 to 8 and 13 on a sample repository.
3. **Phase 3, runner and chat**: the full demo locally, and the first evals report.
4. **Keep existing teams safe**: every kit release says what teams see on sync; CoachSpotter upgrades cleanly.

## Decisions made

1. **Repository is the source of truth** (2026-11-05): ADR 0001.
2. **This team runs on the last kit release** (2026-11-05): pinned in `.agent-team/team.json`, bumped by the release manager after each release.
3. **Runtime** (2026-11-05, the owner chose "Our own runner (Agent SDK)"): our runner on the Claude Agent SDK, with subagents and built-in agent teams as zero-infrastructure modes (ADR 0002).
