# ADR 0004: running sessions are pinned to a team version; changes reach them through a transition plan

Status: accepted, 2026-11-06. Owner: architect. Reads with [PRD 6.9](../product/prd.md#69-changing-a-team-that-is-working) and [architecture 12.4](../product/architecture.md#124-team-versions-and-changes-while-running).

## Context

The owner asked that changes to the team (structure, a role's details, a role that is working or its lane) never break ongoing work, and that the Studio ask explicitly how to handle work in progress. Today a published change is just a new set of briefs: a role that resumes reads the new brief, and anything in the middle of a task sees its ownership, manager or very existence change under it. Hand-offs can be addressed to a role that no longer exists, two roles can briefly own the same path, and an approval can be left with nobody to run it.

## Options

| Option | Work lost or broken | Owner effort | Complexity |
| --- | --- | --- | --- |
| A. Apply on merge, everywhere, immediately | High: mid-task sessions see new rules, paths change owner under open branches | None | Low |
| B. Block publishing while any affected role is working | None, but a busy team can never change | Waiting, sometimes forever | Low |
| C. **Pin each session to the version it started on, and move it to the new version at a point the owner chooses per item (finish, hand off, pause, apply now, stop), with safe defaults** | None, by invariants the runner checks | One step in Publish, with recommendations | Medium: inventory, impact analysis, transition plans |
| D. Run old and new teams side by side until the old one drains | None | None | High: two rosters, two ownership maps, confusing board |

## Decision

C. A session's team version is fixed at start. Publish computes the impact of the draft on in-flight work and asks the owner per item, with "let it finish" as the default and a recommendation per item. The plan applies on merge. The runner enforces four invariants (nothing lost, one writer per file at every moment, no orphaned message, no orphaned approval) and stops the transition if one fails. "Apply only when idle" (B for the chosen items) and a team freeze stay available as options.

## Consequences

- `packages/team-model` gets two pure functions, `diffTeams` and `impact`, usable in the browser.
- The runner keeps the team version per session, a transition table, temporary ownership rules, and a `checkpoint()` it calls before any stop.
- Without the runner (threads mode) the same analysis runs on board events and open PRs, clearly marked as possibly stale, and applies when each thread next resumes.
- A change merged outside the Studio gets a generated plan with safe defaults and an impact card in the chat.
