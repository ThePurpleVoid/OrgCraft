# Several members of the same role type

Status: draft, 2026-11-09. Owner: architect. Asked by the chief of staff, from the owner's message of 2026-11-09 06:35 UTC: "What if I want multiple agents of the same type under different lanes". web-dev is mocking the UI, and the CPO owns the copy. The ADR draft is [adr-0011-draft-role-types-and-members.md](../adr/0011-role-types-and-members.md).

It was checked against OrgCraft main (b27e99d): `packages/team-model` (importLayer, compileLayer, the TeamSpec schema), `tools/board.mjs`, `apps/server` sessions and deliveries, and `apps/runner` sandbox slots. It is project files only, with no code.

## 0. The answer in one paragraph

Today a role's slug is both **what the job is** and **who does it**. That is why dragging a role onto the org chart removes it from the roles list: there is only one of each.

We split those two:
- A **type** is a job description in the library, such as "Support agent". The library becomes a catalog that never runs out.
- A **member** is a seat on the team. It has its own id, title, manager, owned areas, systems, triggers and memory, and it is based on a type.

Every existing role is already a member whose id equals its type, so **no existing team changes by a single byte**. A second member of a type is one new file in `.agent-team/roles/` that names the type it is based on.

## 1. Member, type and pool: when to use which

| | What differs | Example | Mechanism |
| --- | --- | --- | --- |
| **Type** | The job itself: identity, rules, tools, how it signs off | "Support agent" | A kit role brief, or a project's own role brief |
| **Member** | Anything about the seat: name, manager (lane), owned areas, systems and bindings, triggers, schedule, model tier, extra rules, memory | "Support agent (EMEA)" reporting to the EMEA lead, bound to the EMEA inbox; "Support agent (US)" reporting to the US lead | **New:** `roles/<member>.extend.md` with `**Based on:** <type>` |
| **Pool instance** | Nothing but capacity. The same brief, the same lane and the same bindings, numbered `#1`, `#2` | Three identical code reviewers working PRs in parallel | Exists today: `pool` in RunCreate, `role#instance` in reports and handoffs |

The rule for the Studio and the docs: **if anything except throughput differs, it's a member. If only throughput differs, it's a pool.** A pool belongs to one member, so "Support agent (EMEA)" can have a pool of 2.

## 2. The layer format (`.agent-team/`)

Nothing is renamed and nothing moves. There is one new field in the extension file format the kit already has:

```markdown
<!-- .agent-team/roles/support-agent-emea.extend.md -->
# Support agent (EMEA)

**Based on:** support-agent
**Reports to:** support-lead-emea

## Owns (writes)
replace: nothing in the repository

## Rules
- Answer in the customer's language; EMEA business hours only.
```

- **The file name is the member id, and it never changes.** It is a slug (`SLUG` in team-model), unique in the team. `addMember` picks it once (`<type>-2`, `-3` and so on), and no rename touches it. History, wiring, bindings, triggers, meetings, approvals, ownership, memory and branches all key on it.
- **The display name is the file's `# Title` line** (the extension's `title`, which already exists). It is free text, at most 60 characters, and **unique within the team**, compared case-insensitively with spaces trimmed. The default is the type's title plus a number: "Support agent 2", "Support agent 3". A name change is a one-line edit. The id stays put, so nothing downstream moves (owner, 2026-11-09 06:37 UTC).
- **Existing roles get names too.** A kit role on the team can be given a display name through the same `title` in its `.extend.md`, for example "Backend dev" renamed to "Ana (backend)". Its id stays `backend-dev`.
- **`**Based on:**`** names the type: a kit role slug or a project role slug, meaning the slug of a `roles/<slug>.md` the project wrote itself. It is only allowed in an `.extend.md` whose slug is not itself a kit or project role. Validate refuses a chain, where a member is based on a member: a member is based on a type, never on another seat.
- The rest of the file is the ordinary extension: fields such as `Reports to`, `Model` and `Group`, and sections with `append` or `replace`, applied on top of the type's brief exactly as today.
- **On and off.** A member is on unless `team.json` `exclude` lists it. That is the same rule as a project role today (importLayer: "a project role is on unless exclude lists it"), so switching a member off keeps its file.
- **Bindings, triggers, meetings and ownership** already name roles by slug in `resources.json`, `triggers.json` (N2), `meetings.json` and `ownership.json`. They now name member ids, which for every existing team are the same strings.

**What an existing role is in the new model:** a kit role that is on is a member with `id = type = slug`. A project role (`roles/<slug>.md`) is a type and also a member with the same id. That identity is why there is nothing to migrate (section 7).

## 3. TeamSpec (`agent-team/team-spec@1`, additive)

The schema's `$defs.role` gains:
- `type` (string), present only on a member whose id differs from its type;
- a `source` value `member`, alongside `kit`, `project`, `project-replaces-kit` and `missing`.

`importLayer` sets `source: "member"` and `type` when an `.extend.md` has `Based on` and its slug is not a kit or project role. Today such a file is `missing`. `compileLayer` writes it back unchanged, so the round-trip contract holds.

Naming helpers:
- `displayName(spec, kit, id)` returns the extension's `title`, otherwise the type's title. When several members of a type have no title, it numbers the rest by id order: "Support agent", "Support agent 2".
- `setDisplayName(spec, id, name)` writes the extension `title` and refuses a duplicate.

The existing `renameRole` (which changes the slug) stays for the CLI. The Studio's "Rename" only ever calls `setDisplayName`.

New pure helpers in team-model:
- `addMember(spec, kit, { type, id?, title?, reportsTo? })` picks the id: `<type>` if that seat is free, else `<type>-2`, `-3` and so on, or a slug of the title.
- `membersOf(spec, type)`.
- `typeOf(spec, id)` returns `type ?? id`.

`renameRole` already exists and works on members.

**validate** gains these checks:
- `Based on` names an existing type;
- no chains;
- a member id does not equal a kit slug of a different type, so the kit can't shadow it (checkUpgrade covers new kits);
- `pathConflicts` already refuses two writers for one path. **A new member does not inherit the type's `Owns` section**: `addMember` writes `replace: nothing` until the owner picks areas, because two members of one type would otherwise claim the same paths.

## 4. What sync writes (compile outputs)

Each member compiles exactly like a role does today. The id is the member id and the text is the type's brief plus the member's extension.

| Output | Today | With members |
| --- | --- | --- |
| `docs/team/roles/<id>.md` | One per enabled role | One per enabled member. The header gains `**Type:** Support agent (support-agent)` when the id differs from the type |
| `.claude/agents/<id>.md` (claude-code target) | One per role | One per member. `name` is the member id and `description` names the title and the lane |
| `AGENTS.md` (agents-md target) | The roster lists roles | It lists members, with a Type column. Two members of one type appear as two rows with their managers |
| `docs/team/ownership.md` | The writer column holds roles | It holds members. Unchanged for existing teams |
| Meetings and systems sections in briefs | Per role | Per member, because bindings and attendees name members |

**Slug references inside a type's brief.** Kit briefs name their own slug in text, for example ``scripts/agent-team/team-status.sh backend-dev`` and `roles/backend-dev.md` in "Every thread, every task".
- Compile renders a member by replacing the type's slug with the member id **in that section only**, and in the memory path. The rest of the brief describes the job and keeps the type's wording.
- kit-core-dev should also change the kit briefs to the existing placeholder mechanism (`{{ROLE}}`, like `{{PROJECT_NAME}}`) in the next minor version. The replacement rule then becomes a fallback for project-written types.

**"Hands to" and other prose that names a type** ("Hands to: security reviewer") stays prose. The roster in AGENTS.md and the handoff rule in section 5 resolve it at run time.

## 5. Runtime identity

**The member id is the identity everywhere at run time.** That is the string that is already there today.

- **Events and the board:** `actor.id`, `report.role`, `message.to` and `subject: role/<id>` hold the member id. The board key stays `role#instance` (tools/board.mjs). Nothing changes for existing teams.
- **Display names on every surface.** The board, chat, cards, runs, the N1 Work tab, emails and Slack show the display name, with the type as a subtitle when it differs ("Maya · Support agent"). Events never carry the name: they keep the id, so a rename never rewrites history. Clients resolve id → name from the current team. For a member that no longer exists, they use the name frozen in the run where it last ran.
- **Control plane:** `RunCreate.team.roles[]` gains two optional fields, `type` and `name` (the display name). Both are additive. The server uses `name` wherever it writes text for people (card titles, email and Slack bodies, meeting minutes) and `type` for selectors.
- **Agents see both.** The compiled roster (AGENTS.md, the brief header) lists each teammate as `Maya (support-agent-2), Support agent, reports to …`. Agents address teammates by id. A tool call that names a teammate by display name (case-insensitive exact match) is accepted and resolved to the id, which is additive, the same as addressing by type. `sessions.role` and `deliveries.role` hold member ids, and `sessions_one_per_role (run, role, instance)` stays correct.
- **Runner:** per-session OS users (#136) are slots per **live session**, not per role. So two members of one type get two sessions, two uids, two worktrees, two branches and two memory files. No change is needed.
- **Addressing by type (compatibility rule).** A team tool `to` (handoff, bug, signoff, blocked) may name a type instead of a member:
  - **Exactly one member of that type is on:** the server routes to it. That is every existing team, so briefs that say "hand to the security reviewer" keep working.
  - **Several are on:** the call is refused, and the error lists them: `support-agent-emea (reports to support-lead-emea), support-agent-us (reports to support-lead-us)`. The agent picks one. Picking quietly would hide the lane the owner drew.
  - **The sender's own lane wins when it decides the question.** If exactly one member of the type is in the sender's lane (same executive), it is chosen. The tool says so in its result.

  This is additive to tools/1 and needs no new error code, because the refusal uses the existing `problems`.
- **Selectors by type** are additive:
  - `meetings.json` `attendees.types: ["support-agent"]` invites every member of the type;
  - N2 `triggers.json` `to` must be a member, and validate refuses a type that has more than one member;
  - a binding can target `type:support-agent` as shorthand for every member of the type, expanded at compile time.

## 6. Ownership and one writer per area

The rule stays: **one writer per path, and that writer is a member.** Two support agents in two lanes are expected to own different things, or nothing in the repository: support work happens through connectors, not files. When two members of one type must touch the same code, that is a pool, or a third member that owns it and takes requests. validate's `pathConflicts` enforces this as it does today.

## 7. Migration: none needed, and why it is lossless

1. **An existing layer imports identically.** No `.extend.md` today has `Based on`, so every role keeps its current `source`. The member id equals the slug, and `type` is absent. `compileLayer(importLayer(layer))` is byte-identical, which the existing round-trip test already proves for every preset, example and this repository's own team.
2. **Generated files are identical.** No member's id differs from its type, so no `Type:` header is added, AGENTS.md has no Type column (it appears only when some member's type differs from its id), and slug replacement is a no-op. That keeps the compile output identical for every existing team.
3. **CoachSpotter.** Its `.agent-team/` overlay files are not moved or renamed (the mailbox rule). Its `docs/team/` output changes only through the sync script as usual, and for this change it does not change at all. When CoachSpotter wants a second member of a type, it adds one `roles/<id>.extend.md`. Per the mailbox protocol, that is announced in `to-coachspotter.md` first.
4. **Kit version floor.** A layer that uses `Based on` needs the kit version that understands it (proposed 0.22.0). An older kit imports such a file as `missing`, and its validate fails loudly rather than running without the member. kit-core-dev bumps CoachSpotter's pin before CoachSpotter adds a member, and the release notes say so.
5. **Control plane.** It needs no data migration. Runs already frozen keep working. `type` is optional, and old runs have none.
6. **Rollback.** Delete the member's `.extend.md` and publish. The change-safety step already handles a role going away (`diffTeams` lists it as removed, and `impact` lists its work in flight).

## 8. Studio (for web-dev's mock; the CPO owns the copy)

- **The library is a catalog of types.** Dragging a type onto the chart **always creates a new member** (`addMember`), so the type stays in the library. A small count shows how many teammates have that role ("2 teammates with this role"). UI words, settled by the chief of staff on 2026-11-09: **role** is the job in the catalog, and **teammate** is a seat. `member` and `type` stay in the format, the code and this spec.
- **A member card** shows its display name, with the type underneath in small text when the two differ. Rename edits the name in place. A duplicate name is refused inline (`Another teammate is already called Maya`). The id appears only in an "Advanced" line. Its inspector edits that member's fields only. "Edit the job description" opens the type, with a warning that the change applies to every member of that type.
- **Pool vs member** in the inspector: "Same job, more hands" sets the pool size. "Add another, set up differently" creates a member.
- **n8n-style wiring** (the owner's first question). Edges are already data:
  - reports-to: `Reports to`;
  - system bindings: `resources.json`;
  - triggers: `triggers.json`, N2;
  - meetings: `meetings.json`.

  Drag-to-wire needs no format change for those. The one edge that is still prose is **"Hands to"**. **Decided (CPO, 2026-11-09): a structured `**Hands to:**` field.** It drives the wiring view and the org health check.
  - **Format:** one line per target in the brief's `## Hands to` section, `- <member id or role> : <what is handed over>`, parsed like `Wakes on` (`wakesOn` and `setWakesOn`). The new helpers are `handsTo(md)` and `setHandsTo(md, items)`. Lines that don't parse stay as prose notes, so every existing brief still reads and compiles unchanged.
  - **Targets:** a member id, or a role. A role means "whichever teammate with that role", resolved as in section 5.
  - **validate:**
    - a target that isn't on the team is a warning ("hands to security-reviewer, which is off");
    - a role with several teammates and no lane match is a warning ("pick which Support agent").
  - **Run time:** the team tools accept any `to`, as today. The field is the drawn wiring, not a firewall. A handoff to someone not listed gets a soft note on the step in the run inspector ("not on the wiring"), which feeds the org health check.

## 9. Proofs to add

1. The round trip is byte-identical for every preset, example, this repository's team and CoachSpotter's layer (a fixture copy).
2. Two members of one type compile two briefs, two agent files and two AGENTS.md rows. Each brief's "Every thread" section names its own member id, and the rest of the brief matches the type.
3. A handoff `to: support-agent` with one member routes to it. With two members it is refused, listing both. With one member in the sender's lane it routes there and says so.
4. validate refuses: an unknown `Based on`; a chain; a member id equal to a kit slug of another type; two members owning the same path.
5. `addMember` on a type with a seat picks `<type>-2`, names it "<Type> 2", and writes `Owns: replace: nothing`.
8. Renaming a member changes only its `# Title` line. The id, the files, ownership, bindings, triggers and history are untouched, and a duplicate name fails validate.
9. A handoff addressed by display name resolves to the id. The board and cards show the new name after a rename, including for events written before it.
6. An older kit given a layer with `Based on` fails validate and names the file.
7. A run with two members of one type starts two sessions with different uids, worktrees and memory files (runner e2e, stub model).

## 10. Build split

- **kit-core-dev (M):** the extension field, importLayer and compileLayer, the helpers, validate, the slug rendering in sync, the AGENTS.md and agent-file targets, the `{{ROLE}}` placeholder in kit briefs, and the pin floor for CoachSpotter.
- **backend-dev (S):** `RunCreate.team.roles[].type`, routing by type in the team tools, and the `attendees.types` selector.
- **web-dev (M):** the catalog, "Add another", member cards, the inspector split and the pool control. Mock first.
- **architect:** folds this into the TeamSpec schema docs, `docs/customizing.md`, team-tools.md and api-v1.yaml, plus ADR 0011, as one spec PR when GitHub is back.

## 11. Open points for the CPO

1. ~~Words~~ Settled: "role" in the catalog and "teammate" for a seat, in the UI only (section 8).
2. ~~Default name~~ Decided by the owner, 2026-11-09: "<Type> 2", free text, unique within the team, and the id never changes on rename (section 2).
3. ~~Structured Hands to~~ Yes, per the CPO (section 8).
