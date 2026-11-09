# ADR 0001: the repository is the source of truth for a team

Status: accepted, 2026-11-05. Owner: architect.

## Context

The Studio lets people build a team on a canvas. The team could live in the Studio's database, with the repository as an export, or in the repository, with the Studio as an editor. Agent Team Kit already defines a team as `.agent-team/` in the product's repository, pinned to a kit version, and real teams (CoachSpotter's among them) run that way today.

## Decision

A team is its `.agent-team/` folder. The Studio imports it into a `TeamSpec`, edits that, and publishes by compiling back to `.agent-team/` and running the pinned kit `sync`. The Studio's database holds drafts, canvas layout, runs, chat, events, secrets and audit records, never the only copy of a team. A published version is a commit SHA.

Amended 2026-11-09 by [ADR 0012](0012-no-repository-start.md): a team's `.agent-team/` folder lives in the product's repository, or in the managed team store (ADR 0012), which is Git underneath and exportable at any time.

## Consequences

- No lock-in: a team built in the Studio works with the CLI alone, and a team built by hand opens in the Studio.
- Publishing goes through Git: diffs, pull requests, branch protection and CI (`sync.sh check`) review a team change like any other code.
- The round trip must be lossless, so `packages/team-model` carries golden tests for every known layer, and new concepts (ownership, gates, resources) get optional layer files instead of living only in the database.
- Some editor state (canvas positions) lives in `.agent-team/studio.json`, which sync ignores.
- Secrets can never be part of a team definition; only their names are.

## Rejected

- **The database is the source of truth, and the repository is an export.** Edits made in the repository would drift or get overwritten. It also adds lock-in and contradicts how the kit already works.
- **Two-way live sync.** Too complex, with conflicts that are hard to explain. A PR-based publish is simpler and can be reviewed.
