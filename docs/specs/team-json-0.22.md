# Kit 0.22: the team file shape for many teammates per role

Owner: architect. Builders: kit-core-dev (format, team-model, sync), backend-dev (routing), web-dev (Team page). Decision: ADR 0011 (accepted with this spec, 2026-11-09). Background and reasoning: [plans/n8n/role-instances.md](role-instances-background.md). This file is the **exact build contract**; where the two differ, this file wins.

Checked against `main` b27e99d: `packages/team-model/index.mjs` (importLayer, compileLayer, diffTeams, impact, wakesOn), `packages/team-model/schema/team-spec.v1.json`, `apps/server/tools.mjs` (the `to` check), `docs/contracts/api-v1.yaml` (RunCreate `team.roles[]`).

## 0. Summary for web-dev

- A **role** (UI word) is a job in the catalog. In the format it is a **type**: a kit brief `team/roles/<slug>.md` or a project brief `.agent-team/roles/<slug>.md`.
- A **teammate** (UI word) is a seat. In the format it is a **member**: it has a fixed **id** (a slug, never changes) and an editable **name** (unique in the team).
- Every role on a team today is already a member whose id equals its type. **No existing team file changes.**
- A second teammate of a role is **one new file**: `.agent-team/roles/<id>.extend.md` with `**Based on:** <type>`.
- `team.json` gets **no new required key and no `members[]` list** (ADR 0011 rejected that as option C). The Team page reads the members from the Studio API (section 4), not from team.json.

## 1. Files in `.agent-team/`

### 1.1 `team.json` (unchanged shape)

```json
{
  "kit": "github:ThePurpleVoid/OrgCraft#v0.22.0",
  "preset": "minimal",
  "include": ["support-lead"],
  "exclude": ["support-agent-us"],
  "values": { "PROJECT_NAME": "Acme", "OWNER": "Dana", "TIMEZONE": "Europe/Lisbon", "DIGEST_TIME": "08:00" }
}
```

| Key | Change in 0.22 |
| --- | --- |
| `kit` | Must be `#v0.22.0` or later when any member file has `Based on`. validate errors otherwise (1.4) |
| `include` | Kit roles only, as today. **Members never go in `include`**: a member is on unless `exclude` lists it, the same rule as a project role (`importLayer`: "a project role is on unless exclude lists it") |
| `exclude` | May list member ids. Switching a teammate off keeps its file |
| everything else | Unchanged |

### 1.2 A member file: `.agent-team/roles/<id>.extend.md`

```markdown
# Maya

**Based on:** support-agent
**Reports to:** support-lead-emea
**Pool:** 2

## Owns (writes) (replace)
Nothing in the repository.

## Hands to (replace)
- support-lead-emea: refunds over the limit and angry customers
- bug-triager: anything that looks like a product bug
Escalations outside business hours wait for the morning.

## Rules
- Answer in the customer's language. EMEA business hours only.
```

| Part | Rule |
| --- | --- |
| File name `<id>` | The member id. Matches `SLUG` (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`), at most 48 characters, unique in the team, and **never changed by the Studio**. Picked once by `addMember` (section 3) |
| `**Name:** <name>` | The display name (L11b). Free text, 1 to 60 characters after trimming, unique in the team compared case-insensitively with inner spaces collapsed. Optional: without it the name is computed (3.2). A member's legacy `# <name>` line still reads as its name; the Studio writes the field |
| `**Based on:** <type>` | **New field.** A kit role slug or a project role slug. Only allowed when `<id>` is not itself a kit or project role. The type must not itself be a member (no chains) |
| `**Pool:** <n>` | **New field**, optional, integer 1 to 10, default 1. "Same job, more hands": n identical sessions of this member, addressed as `<id>#1` … `<id>#n` (the existing board key). Allowed on any role, member or not. Sent as RunCreate `team.roles[].pool` |
| Other fields and sections | The ordinary extension format, applied on top of the type's brief exactly as today (`append`, or `replace` with ` (replace)` in the heading) |

**A kit or project role that is not a member** can also get a display name the same way: `roles/backend-dev.extend.md` with `**Name:** Ana`. Its id stays `backend-dev`. The `# ` line of a role's own extension is **the role's title** (a pack's or the team's name for the job, such as `# Problem-report triager`), not a seat name: every teammate of the role shows it as its role and in its `**Type:**` line, and renaming the role's own seat never changes it (L11b). `Name` is a seat setting, like `Reports to`: it never passes to the role's other teammates.

### 1.3 `## Hands to`: structured lines (new, additive)

The section stays a normal brief section. Lines are parsed like `## Wakes on`:

- A line `- <target>: <what is handed over>` is **structured** when `<target>` is a member id or a role slug on the team (on or off). `<what>` is free text, at most 200 characters, and may be empty (`- qa-web`).
- `<target>` may also be `owner`.
- Every other line is **prose**, kept in order, and shown as notes. So every existing brief still reads and compiles unchanged: today's kit briefs have one prose line ("Shared core dev, backend tester, security reviewer (always), …"), which parses as prose.
- `handsTo(md, roster)` → `{ targets: [{ to, what }], text: [lines], problems: [] }`.
- `setHandsTo(md, { targets, text })` writes structured lines first, then the prose as it was, like `setWakesOn`.
- Kit 0.22 converts the 49 kit briefs' `Hands to` to structured lines (kit-core-dev). That is kit content, so teams see it as a brief change in their kit-upgrade change, not as a migration of their files.

### 1.4 Other layer files

`ownership.json` `writer`, `resources.json` `bindings[].role`, `meetings.json` `attendees.roles` and `facilitator`, `triggers.json` `to` (N2), and `studio.json` node keys all hold **member ids**. For existing teams these are the same strings as today. Additive selectors:

- `meetings.json` `attendees.types: ["support-agent"]`: every member of that type, resolved by `meetingAttendees`.
- `resources.json` binding `role: "type:support-agent"`: shorthand for every member of the type, expanded at compile time. The Publish sheet's capability diff lists each member it reaches.
- `triggers.json` `to` must be one member. validate refuses a type that has more than one member on.

## 2. TeamSpec (`agent-team/team-spec@1`, additive)

`$defs.role` gains:

```json
"source": { "enum": ["kit", "project", "project-replaces-kit", "member", "missing"] },
"type":   { "type": "string", "description": "The type this member is based on. Present only when source is member." }
```

`$defs.extension` already carries `title` and `fields`; `Based on` and `Pool` are ordinary fields there. The schema file and `docs/customizing.md` get the new values. No other TeamSpec change.

**Example**, the roles part of a spec with two support agents:

```json
"roles": {
  "support-agent":      { "source": "kit",    "enabled": true,
                          "extension": { "title": "Leo", "fields": [{ "name": "Reports to", "value": "support-lead-us" }], "sections": [] } },
  "support-agent-2":    { "source": "member", "type": "support-agent", "enabled": true,
                          "extension": { "title": "Maya", "fields": [{ "name": "Based on", "value": "support-agent" }, { "name": "Reports to", "value": "support-lead-emea" }, { "name": "Pool", "value": "2" }], "sections": [ … ] } }
}
```

### importLayer and compileLayer

- **import:** an `.extend.md` whose slug is not a kit or project role **and** that has `Based on` becomes `source: "member"`, `type: <Based on>`, `enabled: !exclude.includes(id)`. Without `Based on` it stays `missing`, as today.
- **compile:** a member writes its `.extend.md` (unchanged text if unchanged, as today), is never put in `include`, and goes in `exclude` when off. The round trip stays byte-identical.

## 3. team-model helpers (pure, kit-core-dev)

| Helper | Contract |
| --- | --- |
| `typeOf(spec, id)` | `spec.roles[id].type ?? id` |
| `membersOf(spec, type, { enabledOnly = true })` | Ids whose `typeOf` is `type`, sorted by id |
| `addMember(spec, kit, { type, title?, reportsTo? })` | Picks the id: `<type>-2`, `-3` … (the first free slug; never a slug of the title, so ids stay predictable). Writes `Based on`, `Reports to` (default: the type's), `## Owns (writes) (replace)` with `Nothing yet.` (a new member never inherits owned areas, so one writer per path holds), and `**Name:** <title>` only if `title` was given. Returns `{ spec, id }` |
| `displayName(spec, kit, id)` | The `Name` field (or a member's legacy `# ` line); else the role's title (its own extension's `# ` line, else its brief's), numbered when several members of the type have no title: the lowest id gets the plain title, the rest "<Type title> 2", "3" … in id order |
| `setDisplayName(spec, id, name)` | Sets the `Name` field (and drops a member's legacy `# ` name). Never touches the role's title. Throws `CoreError(409, 'Another teammate is already called <name>')` on a duplicate. Never touches the id |
| `listMembers(spec, kit)` | The Team page's list, section 4 |
| `handsTo`, `setHandsTo` | Section 1.3 |
| `renameRole` | Unchanged (changes the slug; CLI only). The Studio never calls it on a member |

**validate** adds:

| Check | Level |
| --- | --- |
| `Based on` names no existing type | error |
| `Based on` names a member (a chain) | error |
| A member id equal to a kit slug of a different type (the kit would shadow it) | error. `checkUpgrade` reports it when a new kit adds that slug |
| `Based on` used with a kit pin below 0.22 | error, naming the file |
| Two members with the same display name | error |
| `Pool` not an integer 1 to 10 | error |
| Two writers for one path | error (existing `pathConflicts`) |
| A `Hands to` target that is off or unknown | warning: "Maya hands to security-reviewer, which is off" |
| A `Hands to` target that is a type with several members on, none in the sender's lane | warning: "Maya hands to support-agent: pick which Support agent" |
| An **orphan**: an enabled member that nobody hands to, that has no structured `Wakes on` line, no trigger and no meeting | warning: "Nobody hands work to Maya, and nothing wakes her" |
| An **overlap**: two enabled members of one type with the same manager, the same bindings and no owned areas | warning: "Leo and Maya do the same job in the same lane; use Pool instead" |

The last four are the Publish sheet's "orphans and overlaps" warnings.

## 4. What the Studio API returns (web-dev's contract)

`GET /v1/team` keeps everything it returns today and **adds** `members` (computed by `listMembers`, never stored):

```json
"members": [
  { "id": "support-agent-2", "name": "Maya", "type": "support-agent", "typeTitle": "Support agent",
    "source": "member", "enabled": true, "reportsTo": "support-lead-emea", "lane": "support-lead-emea",
    "pool": 2, "owns": [], "handsTo": [{ "to": "support-lead-emea", "what": "refunds over the limit and angry customers" }],
    "handsToNotes": ["Escalations outside business hours wait for the morning."],
    "wakesOn": [{ "type": "handoff" }], "bindings": [{ "resource": "emea-inbox", "permission": "write" }],
    "model": "sonnet", "problems": [] }
],
"catalog": [ { "type": "support-agent", "title": "Support agent", "source": "kit", "count": 2 } ]
```

- `name` is always filled (computed when there is no title). `lane` is the top executive the member reports up to (the existing lane logic). `count` is the number of enabled members of the type ("2 teammates with this role").
- `problems` are that member's validate lines (section 3), so cards can show a dot.
- **Edits** go through the existing spec-editing path: the page edits the spec, and preview and publish compile it. The new operations it calls are `addMember`, `setDisplayName`, `setHandsTo`, and `setField(spec, id, 'Pool', n)`. "Edit the job description" opens the type and warns: "This changes the job for all 2 teammates with this role."
- The canvas (`studio.json`) keys nodes by member id. A rename never moves a node.

## 5. Run time

### 5.1 RunCreate (api-v1, additive)

`team.roles[]` gains two optional fields:

```yaml
type: { type: string, description: "The type a member is based on, when it differs from slug" }
name: { type: string, maxLength: 60, description: "The display name, for text people read (cards, email, Slack, minutes)" }
```

`slug` stays the member id. `pool` is filled from the `Pool` field (it exists in the contract already). Old runs have neither new field and keep working.

### 5.2 Briefs (sync)

Each enabled member compiles like a role today: the type's brief plus the member's extension.

- `docs/team/roles/<id>.md` and `.claude/agents/<id>.md`: one per member. When `id` differs from the type, the header gets `**Type:** Support agent (support-agent)` and the brief's own-slug references are rendered with the member id. In 0.22, kit briefs use `{{ROLE}}` for their own slug (like `{{PROJECT_NAME}}`). For project-written types without the placeholder, compile replaces the type slug with the member id in `## Every thread, every task` and in the memory path only.
- `AGENTS.md` and the brief roster list each teammate as `Maya (support-agent-2), Support agent, reports to support-lead-emea`. The Type column appears only when some member's id differs from its type, so existing teams' output is unchanged.
- `## Hands to` is rendered with names next to ids: `- Support lead EMEA (support-lead-emea): refunds over the limit …`.

### 5.3 Routing a message (`to`) — backend-dev, `apps/server/tools.mjs`

Today the server checks that `to` (before `#`) is on the roster. In 0.22 it **resolves** `to` in this order and stamps the resolved member id on the delivery. The tool result says how it resolved.

1. **A member id** (or `id#n`): that member. Unchanged.
2. **A display name**, case-insensitive exact match: that member.
3. **A type** with exactly one member on: that member. This is every existing team, so "hand to the security reviewer" keeps working.
4. **A type with several members on: by ownership.** If the message names paths (`branch` and changed files on a handoff, `where` on a bug) and exactly one member of the type owns a matching path in `ownership.json`, route to it.
5. **A type with several members on: by lane.** If exactly one member of the type is in the sender's lane, route to it.
6. **A type with several members on: by the sender's `Hands to`.** If the sender's structured `Hands to` lists exactly one member of the type, route to it.
7. Otherwise **refuse** with the existing `problems` shape: `support-agent has 2 teammates: support-agent-2 (Maya, reports to support-lead-emea), support-agent-3 (Ana, reports to support-lead-us). Pick one.` It never picks silently.

A handoff to a member not in the sender's structured `Hands to` is still delivered (the field is the drawn wiring, not a firewall). The step gets the soft note "not on the wiring" in the Work timeline, and that count feeds the org health check.

### 5.4 Publishing a change while work is running (change safety)

`diffTeams` and `impact` already key on the slug, which is the member id, so they work for members as they are. 0.22 adds these change kinds:

| Kind | When | impact |
| --- | --- | --- |
| `member-renamed` | Only the display name changed | `safe`, `apply-now`: names are resolved when shown, events keep ids |
| `member-added` | A new member (replaces `role-added` when `source` is `member`) | `safe`, and a **capability change** on the Publish sheet (ADR 0013: a new seat adds bindings and effects) |
| `type-changed` | `Based on` changed | Treated as `brief` (next task) **plus** a capability change |
| `pool` | `Pool` changed | `safe`; growing starts sessions on demand, shrinking lets the extra sessions finish their task first |
| `hands-to` | Structured targets changed | `safe`, `next-task`. If a removed target has queued handoffs from this member, `choice`: `reroute-queued` (recommended) or `keep-queued` |

`role-off` and `role-removed` keep their current choices (finish, hand off, pause), with one change: when the member being switched off has queued handoffs **addressed by type**, `impact` offers `reroute-queued`, re-resolving them with 5.3 against the new team.

After Publish, the next session of each changed member gets its regenerated brief (ADR 0004: a run stays frozen on one version, and the switch happens at the next task as `impact` chose).

## 6. Migration from today's one-agent-per-role teams

1. **Nothing to do for existing teams.** No file today has `Based on`, so every role imports with its current `source`, id equals type, the `Type` header and column don't appear, and slug rendering does nothing. `compileLayer(importLayer(layer))` is byte-identical, and the generated files are identical. The round-trip test proves it for every preset, example, this repository's team and a CoachSpotter fixture copy.
2. **Kit pin.** A team that adds its first member must be on kit 0.22 or later. The Studio's "Add another" checks the pin and, if it is older, offers the kit upgrade change first.
3. **Teams that used the copy-the-brief workaround** (a project role whose brief is a copy of a kit brief with a few edits): `agent-team members adopt <slug> --based-on <type>` turns `roles/<slug>.md` into `roles/<slug>.extend.md` with `Based on`, keeping only the differences as `append` or `replace` sections. The id stays the same, so nothing downstream moves. The Studio offers it as a suggestion when a project brief is at least 80% the same as a kit brief, never automatically.
4. **Prose `Hands to` in project briefs** stays prose. The Studio offers `Turn into wiring` on the member card, which suggests targets by matching titles in the prose to the roster ("security reviewer" → `security-reviewer`). The person confirms.
5. **CoachSpotter:** no files move (mailbox rule). The CTO bumps its pin to 0.22 before it adds a member, announced in `to-coachspotter.md` first.
6. **Rollback:** delete the member file and publish. `diffTeams` lists it as removed and `impact` handles work in flight.

## 7. Tests (each one a named test)

1. Round trip byte-identical on every preset, example, this repo's team and the CoachSpotter fixture.
2. Two members of one type: two briefs, two agent files, two AGENTS.md rows. Each brief's "Every thread" names its own id; the rest matches the type.
3. `addMember` on a type with a seat gives `<type>-2`, the computed name "<Type> 2", and `Owns: Nothing yet.`
4. `setDisplayName` changes only the `Name` field (the role's title stays, for every teammate); duplicate refused; id, ownership, bindings, triggers and canvas untouched.
5. validate: unknown `Based on`; chain; kit-shadowed id; pin below 0.22; duplicate name; bad `Pool`; orphan; overlap.
6. `handsTo` parses structured lines and keeps prose; every kit 0.21 brief parses with zero targets and zero problems.
7. Routing 5.3: each of the seven steps, including refusal text listing both members.
8. `diffTeams`/`impact`: each new kind; queued type-addressed handoffs are offered `reroute-queued` when a member goes off.
9. A kit 0.21 import of a layer with `Based on` fails validate, naming the file.
10. Runner e2e (stub model): two members of one type get two sessions with different uids, worktrees and memory files.
11. `GET /v1/team` returns `members` and `catalog` as in section 4.

## 8. Build order

| Step | What | Who | Blocks |
| --- | --- | --- | --- |
| 1 | Schema, import and compile, helpers, validate, `handsTo`, `listMembers`, tests 1 to 6 and 9 | kit-core-dev | Everything else |
| 2 | `GET /v1/team` `members` and `catalog`, test 11 | kit-core-dev | web-dev's Team page with real data (web-dev can build on the section 4 JSON now) |
| 3 | Sync output (Type header, `{{ROLE}}`, roster, Hands to names), kit briefs' structured Hands to, test 2 | kit-core-dev | Release 0.22.0 |
| 4 | RunCreate fields, routing 5.3, tests 7 and 10 | backend-dev | Running teams with members |
| 5 | Change-safety kinds, test 8 | kit-core-dev | Publishing member changes while work is running |
| 6 | `members adopt` CLI | kit-core-dev | Nothing (can follow 0.22.0) |

Security-reviewer reviews steps 4 and 5. A teammate's own change to its member file that widens its access, reviewer, checks or cap is refused (ADR 0013, ADR 0011 review 2).
