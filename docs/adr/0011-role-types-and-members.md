# ADR 0011: A role is a type in a catalog; a team is made of members based on types

Status: **Accepted**, 2026-11-09. Built as kit 0.22 after the owner signed off the vision mockup (2026-11-09 15:41 UTC, relayed by the chief of staff), which showed the Team page with several teammates of one role; the owner's earlier decisions on names (06:37 UTC) are in it. Owner of the document: architect. Background: [role-instances.md](../specs/role-instances-background.md). **Build contract: [docs/specs/team-json-0.22.md](../specs/team-json-0.22.md)**, which wins where the two differ. The number is taken when the ADR lands in docs/adr.

## Context

A role's slug is both the job description and the one seat that does it. The owner wants several agents of the same kind on one team, in different lanes: for example, two support agents, each with its own manager, systems, triggers and memory. Today the only ways to get that are:
- a **pool** (`role#n`), which gives identical copies in one lane;
- copying a brief into a new custom role, which forks the job description so it stops getting kit updates.

The model is also the contract of every generated file, the board, the event log and the runner. A change here must not move a single byte for teams that don't use it (ADR 0001 and the team-model round-trip contract).

## Options

| | Shape | Cost |
| --- | --- | --- |
| A | Grow pools: give each instance its own manager, bindings and triggers | Pool instances are interchangeable by design, and delivery picks any live one. Making them different breaks routing and the meaning of `#n` |
| B | Copy the brief into a new project role (today's workaround) | It forks the job: kit updates no longer reach it, and there are N copies to keep in step |
| C | A new top-level `members[]` in team.json, with roles becoming pure templates | It is a migration for every team, it rewrites team.json, and old kits break silently |
| **D** | **A member is an extension file that names the type it is based on.** Existing roles are members whose id equals their type | One new field in a file format that already exists. No migration |

## Decision

D.

- A member is `roles/<id>.extend.md` with `**Based on:** <type>`. It inherits the type's brief and kit updates, and overrides any field or section.
- **A member has a stable id and a display name.** The id never changes. The display name is free text, unique in the team, and defaults to "<Type> 2" (owner, 2026-11-09). People see the name, and everything else keys on the id. A rename changes one line.
- The member id is the identity at run time: board, events, sessions, ownership, bindings, triggers and meetings. For existing roles that is the same string as today.
- **Pools stay** for "same seat, more hands". Members are for anything else that differs.
- **Addressing by type** keeps briefs that name a type working. With exactly one member of the type on, the message goes to that member. With several, the sender's own lane decides if it can. Otherwise the call is refused with the list of members. It is never silently picked.
- **A new member does not inherit the type's owned areas,** so one writer per area still holds.

## Consequences

- No migration. The round-trip and generated output are byte-identical for every existing team, including CoachSpotter's overlay.
- A layer that uses members needs kit 0.22 or later. An older kit fails validate loudly rather than dropping the member. Pins are bumped before members are used.
- Kit briefs move their own-slug references to a `{{ROLE}}` placeholder. Until then, compile replaces the slug in the "Every thread" section.
- The Studio library becomes a catalog that never empties. "Add another" is the new verb.
- Selectors by type (`attendees.types`, `type:` bindings) are added additively where a team wants "all support agents".

## Review 2 (security), 2026-11-09

- **A teammate's change to its own extension file is refused** when it widens the teammate's own access, reviewer, checks or cap (S2-09, ADR 0013). That covers fields such as `Reports to`, a binding, model or tier, a Hands-to check, or owned areas. Another role or a person may propose it.
- **Creating a member from a type is a capability change.** It adds bindings and effects, so the Publish sheet shows its `Widens access` block.

## Decision record, 2026-11-09

- **Accepted** for kit 0.22 after the owner's mockup sign-off at 15:41 UTC. Option D stands: no `members[]` in team.json.
- **Settled at acceptance** (details in docs/specs/team-json-0.22.md): a `Pool` field for "same job, more hands"; `Hands to` is structured (`- <target>: <what>`, prose lines kept); routing of a type-addressed message tries one member, then ownership, then the sender's lane, then the sender's Hands to, and otherwise refuses; the Studio API returns a computed `members` list and `catalog`; Publish warns about orphans and overlaps.
- **Build:** local PR L11 (web-dev/team-model-members) for the team-model helpers, reviewed by the architect (shape) and kit-core-dev.
