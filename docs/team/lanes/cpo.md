# Product and design lane: priorities and decisions

Owner of this file: cpo. Last updated 2026-11-06.

## Baseline

[docs/product/prd.md](../../product/prd.md). It replaces every earlier product note.

## Status by feature (2026-11-06)

| Feature | Status |
|---|---|
| Custom agents (PRD 6.6, A1 to A7, issue #30) | Building: story confirmed below, handed to web-dev and kit-core-dev |
| Change safety part 1 (PRD 6.9, mockup 06, issue #30) | Building: story confirmed below; library to kit-core-dev, screens to web-dev |
| Meeting definitions editor (PRD 6.7 M8, mockup 03, issue #30) | Building: story confirmed below; sync side to kit-core-dev, editor to web-dev |
| Team templates (PRD E6, demo step 2, issue #30) | Building: story confirmed below; kit side to kit-core-dev, picker to web-dev after meetings |
| Neutral protocols for business-function teams (issue #30 follow-up) | Idea: story confirmed below, not yet scheduled |
| Other coding agents (PRD G3 b, issue #30 follow-up) | Idea: story confirmed below; kit-core-dev after "PR through gh" |
| Email notifications (PRD 6.8 O1 to O7, phase 3) | Building: story and copy confirmed below; kit-core-dev builds the email sink |

## Priorities, in order

1. **The customer demo is the acceptance test**: every story names the demo step it moves forward.
2. **Canvas visual language** (phase 2): the design director runs 3 to 5 style threads for the canvas, nodes, edges and the live board; the owner and the CTO pick one.
3. **First-run experience**: from `npx agent-team studio` to a published team in under 10 minutes, tested with 5 people.
4. **Evidence over claims**: the evals page and the cost line are product features, not internal tools.

## Decisions made

1. **Open source first, local first** (2026-11-05): the owner asked for open source for now; the MVP runs on one laptop with no account. Superseded on 2026-11-06 by ADR 0005: online first, and local is the same build on one machine.
2. **The four comparison gaps are requirements** (2026-11-05, the owner: "account for those and build for these gaps"): G1 to G4 in the PRD.
3. **Custom agents story confirmed** (2026-11-06, issue #30): the story below is what web-dev builds and qa-web walks. Where the mockups and the PRD differ, the story wins.
4. **Change safety part 1 story confirmed** (2026-11-06, issue #30): board-only warnings and a recorded plan; nothing is stopped or restarted by the Studio until the runner's part 2 (phase 3).
5. **Meeting definitions story confirmed** (2026-11-06, issue #30): the editor half only; meetings are defined and published in phase 2 and run from phase 3.
6. **Team templates story confirmed** (2026-11-06, issue #30): a template is a whole starting team, applied once; a role pack adds agents to a team that exists. Two of the first templates are not engineering teams.
7. **Neutral protocols story confirmed** (2026-11-06): kit 0.12.0 ships the support and content templates without it. The shared protocols and project instructions get a neutral core plus an engineering pack, so a business-function team never reads about PRs, merge gates or deploys.
8. **Other coding agents story confirmed** (2026-11-06): the first cut is one vendor-neutral `AGENTS.md` target, not one adapter per tool. Claude Code stays the default and loses nothing.
9. **Email notifications copy confirmed** (2026-11-06): every email is short, names the team, carries one link, and never lets an email reply approve anything.

## Story: custom agents (issue #30, demo step 14)

The owner's words (2026-11-06, PRD header): "There should be a way to define custom agents and add new ones that are not predefined."

What follows is the CPO's reading, labelled as mine.

**As** a team owner in any industry, **when** the kit's library has no role for what I need, **I want** to make my own agent in the same editor, check it like any other role and publish it, **so** my team is not limited to the presets and my agent is governed like every other role.

The model helpers already exist in `packages/team-model/index.mjs` (`checkSlug`, `draftRole`, `addAgent`, `briefSection`, `setBriefSection`, `ownsPaths`, `pathConflicts`, `rolePack`, `readPack`, and custom-agent checks inside `validate`). This story is mostly Studio screens on top of them, plus a small kit side.

### Product decisions that fill gaps in the PRD and mockups

- **D1. The slug is fixed at first publish.** Before the agent has been published once, name and slug can both change. After that, the name can change but the slug cannot: it is the file name and the board name, and renaming it would orphan history. Renaming means making a copy and switching the old one off.
- **D2. Imported agents arrive switched off.** An import shows in **Your agents** with the tag "imported" and is not on the team until the owner switches it on. The "imported" tag lasts until the next publish or reload, then reads "custom": the layer does not record where a brief came from (amended 2026-11-06 on review of #69). Switching on is refused while the agent has an error from the checks. A blank or copied agent arrives switched on, as in mockup 01.
- **D3. Switch off keeps, remove deletes.** Switching an agent off keeps its file and lists it in `exclude` (kit 0.9.1). **Remove agent** deletes the file at the next publish, after a confirm that names the file. Both are undoable until publish.
- **D4. "Try it on a task" is hidden in this build.** A8 needs a registered runner. The button appears only when the Studio has a runner connected; there is no disabled teaser.
- **D5. "Move the path to this agent" ships now, with a board check.** If the board shows the current owner working or with an open branch on that path, the choice says so in amber and needs a second click. When change safety part 1 lands, the same choice goes through the impact step in Publish (PRD 6.9) instead.
- **D6. Industry-neutral words.** The editor section is "What it owns" (the mockup's "Work and paths"); rows are "areas", meaning a folder or a file, which matches the Studio's existing "Owned areas" view. No copy may assume code, Git or engineering: the blank template's sample text, hints and empty states must read correctly for a legal, marketing or support team. "Pull request" appears only in the optional `pr-paths` wake-on choice.
- **D7. The kit version in copy is the pinned version**, read from the team, never a fixed string (mockup 01 shows "0.6.0").
- **D8. Custom groups.** The group field suggests existing groups and accepts a new name. A new group gets a colour picked from the Studio's palette by a stable hash of its name, so it keeps the same colour across reloads and machines, and shows as its own library section.
- **D9. Big screens only for editing.** The New agent sheet and the editor need a desktop-width window. On a phone, Your agents is a read-only list (amended on review of #69: Publish is desktop-only, so a switch made on a phone would be lost); the editor shows "Open on a larger screen to edit". This follows the mobile plan (PR #25): canvas editing stays on big screens.
- **D10. No sample agents ship.** The Studio starts with an empty Your agents section. Data in the mockups is invented and must not appear in the product (the kit's no-demo-data rule).
- **D11. Import formats in this build:** a single `.md` role file, several files picked at once, or a folder (with or without `pack.json`). No zip, and no import from a URL. Every imported brief runs the full checks, including the secret scan, before it is listed. An import that contains a secret-shaped value is refused, not cleaned.

### Acceptance criteria

Each criterion names its PRD item. qa-web walks all of them in light and dark at 1440 × 900, and the phone ones at 390 wide.

1. **Start sheet (A1, A5, mockup 01).** **New agent** in the library opens a sheet with three starts: Blank, Copy a role (any role on the team or in the kit; searchable, shows each role's group), Import a file. Name fills the slug (`slugify`), the slug is checked as you type (`checkSlug`) with the message under it, group and reports-to are set here. **Continue to the brief** is disabled while the slug check fails. The footer shows the file publish will write.
2. **Copy matches what the team runs.** Copying a kit role that has an extension on this team produces the extended text, not the kit's plain text. The copy is a separate role: the kit role and its extension are unchanged.
3. **Replace a kit role, on purpose only.** Typing a kit slug offers "Replace the kit's <role> on this team" as an explicit choice; without it the slug is refused. Choosing it shows the replace warning from the checks in the editor and on the card.
4. **Guided editor (A2, mockup 02).** Left: the sections (Identity, Place in the team, What it owns, Tools and systems, Wakes on, Hands to, Rules, Sign-off evidence) each with done, optional or "N to fix". Middle: the fields. Right: **Brief preview**, the exact file publish writes (compile of that one role), updated on every keystroke, and the checks list. For a copy, the left column says what it was copied from and the preview marks lines that differ from the source.
5. **Tier and status.** Model tier as a segmented choice (light, routine, standard, deep) with the cost hint; status On or Dormant until asked.
6. **Wakes on, structured.** Checkboxes for: a HANDOFF to this agent, a meeting it is invited to, a pull request that changes chosen areas, an issue or task with a label, a schedule. Each writes a machine-readable line (`handoff`, `meeting`, `pr-paths: …`, `label: …`, `schedule: …`). Free text below them is kept as is. Unknown lines show a warning, never an error.
7. **Sign-off evidence.** A list of what this agent must attach to a SIGNOFF (screenshots, logs, links, a document). If Hands to includes SIGNOFF and the list is empty, a warning shows.
8. **Live checks (A3).** In the editor and on Publish: slug valid and free; reports-to and hands-to name roles on the team; one writer per area; evidence present for an agent that signs off; no secrets in any text. Errors block **Add to the team**; warnings do not.
9. **Path conflicts in place (A4, mockup 02).** Adding an area another role writes shows the conflict inline with three choices: **Read only, send fixes to <owner> as BUG** (adds a reads line), **Take a narrower area** (a sub-folder input, checked again), **Move the whole area to this agent** (rewrites the ownership row, with D5). There is never a state where two roles write one area, even for a moment in the draft.
10. **Tools and systems.** Chips for tools, and systems shown with their binding (read, write, deploy). Binding a system here is the same binding as dragging it in the Systems view. Secrets appear only as names.
11. **Your agents (A6, mockup 01).** A library section at the top listing this team's custom agents, tagged custom or imported, each with its on/off box. Clicking one opens the editor. Each row has **Export as a role pack**, which downloads a folder (`<slug>.md` and `pack.json`) with no secrets and no binding details beyond resource types.
12. **Import a role pack.** Importing a pack lists each agent with its checks. `needs.resources` is shown as "needs a database: connect one or skip", mapped to bindings only when the owner confirms. Paths in `needs.paths` go through the conflict choices of criterion 9.
13. **Custom groups (A5).** An agent with a new group name gets its own library section and colour (D8); canvas cards use the same colour.
14. **Kit upgrades (A7).** When the pinned kit (or a kit the owner is upgrading to) has a role with the same slug as a custom agent that is not marked as replacing it, the Studio shows an error on that agent with two fixes: **Rename mine** (new slug, D1 copy rule) or **Use the kit's role** (removes the custom file at publish). `agent-team sync` reports the same clash as an error. A custom agent is never silently replaced.
15. **Round trip.** Publish writes `.agent-team/roles/<slug>.md`, and re-opening the repository shows the same agent with the same text: zero diff (PRD E7). Undo and redo cover every editor action.
16. **Industry-neutral walk.** Besides the demo's "Accessibility auditor" copied from QA web, qa-web makes one agent from Blank for a non-engineering team (for example a "Contract reviewer" owning `contracts/` and signing off with a document), and checks that no copy on the way assumes code or Git.
17. **Phone (D9).** At 390 wide, Your agents lists agents read-only; the editor shows the larger-screen message; nothing overflows.

### Out of scope for this story

A8 Try it on a task (needs the runner), change safety's impact step (its own story next), meetings, templates, PR through `gh`.

### Build split (agreed with the CTO's plan for #30)

- **kit-core-dev** (kit side, first): `## Sign-off evidence` and structured `## Wakes on` documented in the role template and checked by `validate` (unknown wake lines warn); `pack.json` schema `agent-team/role-pack@1` documented; `sync` reports a custom slug that clashes with a kit role as an error (criterion 14).
- **web-dev** (Studio, in small PRs, in this order): start sheet and Your agents (1 to 3, 11, 17); guided editor with preview and checks (4 to 8, 10, 15); path conflicts, custom groups, pack export and import (9, 12, 13); kit-upgrade clash (14).
- **qa-web**: SIGNOFF per PR with screenshots, then demo step 14 end to end and criterion 16.
- **CPO**: reviews each PR against this story before merge, and signs off the copy.

### Still open, owned by the chief of staff

The delivery plan's phase 2 exit asks for a usability test with 3 people that includes making one custom agent. That needs real people, so it waits for the owner; it does not block the build.

## Story: change safety part 1 (issue #30, demo step 17 in board-only form)

The owner's words (2026-11-06, PRD header): "When making changes to the team structure/details/or any team member actively working on something or in its lane, we need to be sure that the new changes don't break any ongoing work. If something is ongoing there should be explicit UI asking the user how they want to handle the ongoing work."

What follows is the CPO's reading, labelled as mine.

**As** a team owner editing a team that is working, **I want** to see which of my edits touch work in progress, and to say what happens to that work before I publish, **so** no task, branch or hand-off is lost and nothing changes under a role mid-task without my choice.

Part 1 covers PRD X1, X5 and X9, plus the impact step in board-only form (delivery plan, phase 2). Part 2 (phase 3, runner) carries out the choices automatically: X2 to X8 and X10. Mockup 06 is the reference; 07 and 08 are part 2.

### Product decisions

- **D12. Board-only means warn and record, never act.** In part 1 the Studio does not stop, pause or restart anything. The owner's choices are written into the publish commit message (and the PR body once publish opens PRs) under a heading "Work in progress", as instructions the chief of staff carries out. The copy says so: "Your chief of staff carries these out when this change is merged."
- **D13. Choices offered in part 1 are the ones a thread can carry out by itself:** let it finish (default), hand off now (to a chosen role), pause. For a moved area: move after its open PR merges (default), or move now and hand the files over. "Apply now" and "stop and drop" wait for the runner (part 2), because they need a supervisor to restart or close work safely.
- **D14. Where "in flight" comes from.** The board (local event log, or the control plane's `/v1/team/board`) and, when the Studio has GitHub access, open PRs and their branches. A role counts as working when its last status is working, review, waiting or blocked, or it has an open PR. A role whose last report is older than 2 hours shows its age ("last heard 3 h ago") in grey, not green, and every impact list carries the note "Based on board reports; may be out of date" with the time of the newest report (X9).
- **D15. In-flight items never block Publish.** Every item has a recommended choice, and **Use the recommendations** sets them all in one click. Only check errors block Publish, as today. A team with no board reports at all shows no marks and no impact step.
- **D16. Versions are named by commit until numbering exists.** Copy says "the team keeps running the live version (abc1234, published 5 Nov) until you publish", not "v7". A friendly version number is a later decision.
- **D17. Safe changes are listed, not asked.** Wording, a new role, a tier or rule change on an idle role, and anything on a switched-off role go under "Applies at each role's next task" with no choice (X5).
- **D18. Neutral words.** Items are "work", "task" and "hand-off". "Branch" and "PR" appear only when the item has one.

### Acceptance criteria

1. **Live state on cards (X1).** With a running team, each canvas card shows its board state (working, waiting, blocked, idle, in a meeting) and the task's issue and title, with the D14 age rule. The library rows show the same word.
2. **Draft banner.** While the draft differs from the live version, the canvas header says the team keeps running the live version until you publish (D16).
3. **Amber marks.** A draft change that touches a role with work in flight outlines that card in amber with a short reason under its name ("switched off in this draft", "area moves away", "rules changed").
4. **In-place explanation.** Clicking an amber card, or making the change, opens a popover listing what is in flight for that role: task, branch and PR, queued hand-offs to it, approvals it is waiting on, locks it holds (when the board reports them), and scheduled meetings. Two buttons: **Undo <change>** and **Review the impact**.
5. **Inspector "Now, on the live version".** The selected role's panel lists the same in-flight items as cards, above the role's fields.
6. **Top bar count.** A pill reads "N changes · M touch work in progress"; it opens the impact step. It hides when M is 0.
7. **`diffTeams` and `impact` (library).** `diffTeams(published, draft)` lists changes by the kinds in architecture 12.4 (role off or removed, dormant, reporting, area moved, binding removed or narrowed, tier, brief section, gate, meeting). `impact(changes, inventory)` returns items with severity safe, choice or blocking, the allowed choices and the recommended one, following the 12.4 table limited to D13. Pure functions, with unit tests for each change kind, including a role both moved and switched off.
8. **Impact step in Publish (X2, board-only).** Between the checks and the file review: items grouped by role, each with its choices (D13) and the recommendation pre-selected, linked items listed under their role, the safe changes listed (D17), the staleness note (D14), and **Use the recommendations**.
9. **Recorded plan (D12).** Publishing writes the chosen plan into the commit message under "Work in progress", one line per item: role, work, choice, target role when there is one. The file review shows that text before publishing. No `.agent-team/` file holds the plan.
10. **Hand-off target.** "Hand off now" asks for a target role on the new version, defaulting to the role that will own the area; the list excludes roles that are off in the draft.
11. **Never two writers.** Moving an area with "move after its open PR merges" keeps the old writer in the published files until the owner publishes again; the impact step says the follow-up publish is needed and the check panel keeps a reminder until it is done.
12. **Nothing running, nothing shown.** With no board reports, the canvas has no live states or amber marks and Publish has no impact step (D15).
13. **Walk.** qa-web walks demo step 17 in board-only form on a team with real board reports from this project's board: switch off a working role, move an area a working role has a PR on, change a rule on an idle role; screenshots of the marks, the popover, the impact step and the commit message, light and dark at 1440 × 900.

### Build split (agreed with the CTO)

- **kit-core-dev**: `diffTeams` and `impact` in `packages/team-model` with tests (criterion 7).
- **web-dev**: criteria 1 to 6, then 8 to 12, after the custom agents PRs.
- **qa-web**: criterion 13.
- **CPO**: reviews against this story and signs off the copy.

## Story: meeting definitions editor (issue #30, demo step 15, editor half)

The owner's words (2026-11-06, PRD header): "There should be a way for the owner to schedule meetings with select team members, sort of like daily standup, ad hoc meetings."

What follows is the CPO's reading, labelled as mine.

**As** a team owner, **I want** to define my team's recurring and event-triggered meetings (who attends, when, the agenda, what happens to busy attendees, the cost cap) and publish them with the team, **so** the team syncs up on a rhythm I chose and the runner can hold those meetings once it is live.

Phase 2 is the editor half (PRD M8, mockup 03): definitions in `.agent-team/meetings.json`, checks and the cost estimate. Running meetings, minutes and ad hoc meetings are phase 3 (M1 to M7, mockup 04).

### Product decisions

- **D19. Define now, run later.** The Meetings view edits definitions only. **Start a meeting now** and the Today and Earlier lists appear only when a runner is connected and meetings have run; until then the left column shows the definitions and an empty state that says meetings run once the team's runner is connected. No sample meetings or minutes ship.
- **D20. One time zone per team.** Meeting times are wall-clock times in the team's `TIMEZONE` value. The editor shows it under the time ("Team time zone: UTC") with a link to change it; if the team's zone is UTC and the browser's differs, a one-line hint suggests the browser's zone.
- **D21. Two kinds of trigger:** a schedule (days and a time) or an event (an issue or pull request gets a label; worded "When an item gets the label …"). Event triggers are part of the definition now; they fire from phase 3.
- **D22. Attendees** by role, by whole lane, or by the rule "everyone who worked since the last one". A lane that contains dormant roles shows "Dormant roles in this lane are not woken unless you name them" (M3). The facilitator ("Run by") defaults to the chief of staff and can be any role on the team.
- **D23. Discussion format is definable, with an honest note.** Written round is the default. Choosing Discussion (2 to 5 rounds) is allowed and shows a warning: "Discussion meetings run as a written round until the runner supports them." The minutes will say so too (phase 3).
- **D24. Busy attendees** default to "answer at its next pause"; the other choices are "answered for it from the board" and "leave it out" (M5).
- **D25. The owner's part:** "Send me the minutes" (default on) and "I join and can speak" (default off), stored per meeting. Who receives the minutes by email is a notification rule (6.8), not part of the meeting.
- **D26. Cost estimate** comes from the model tiers of the facilitator and the attendees and a dated price table that ships with the kit, labelled "Estimate, prices as of <date>". It shows per meeting and per month for schedules. The per-meeting cap defaults to $1.00 and cannot be above the team's daily cap when one is set.
- **D27. Saving changes the draft; Publish writes the file.** The mockup's "Save to the team" button reads **Save to the draft**. Minutes are never committed (owner decision, 2026-11-06).
- **D28. Phone.** At 390 wide, the Meetings view lists definitions read-only; editing is on big screens (same rule as D9).

### Acceptance criteria

1. **List and new (M8).** The Meetings view lists definitions with their trigger, attendee count and format; **New meeting** offers blank or a starter (daily standup, weekly planning, release readiness, retro), each prefilled with an agenda written in neutral words.
2. **Schedule.** Day toggles and a time, in the team's zone (D20); "Skipped when nothing changed since the last one" as a switch, on by default for standups (M7).
3. **Event trigger.** "When an item gets the label …" with the label name (D21).
4. **Attendees (D22).** Chips for roles, a picker for roles or whole lanes, and the rule option; the dormant hint; "Run by" selector.
5. **Format (D23)** and **busy attendees (D24)** as radio cards with one line of explanation each.
6. **Agenda** as free text; empty agendas are a check error.
7. **Owner and limits (D25, D26).** The two switches and the cap field.
8. **What happens.** The right column shows the timeline of a run in words (opens, asks, minutes, action items), from the definition, without invented data.
9. **Estimate (D26)** per meeting and per month, updating as attendees and format change.
10. **Checks.** Every attendee and the facilitator are on the team and switched on; ids unique; times valid; cap above zero and within the daily cap; a warning when two meetings share attendees at the same time; a warning for a meeting with fewer than two attendees.
11. **Publish and round trip.** Publishing writes `.agent-team/meetings.json`; re-opening the repository shows the same meetings with zero diff. A team without the file behaves as today, and CoachSpotter's team is unchanged.
12. **Sync side (kit).** `sync` reads `meetings.json`, adds a "Meetings" section to the project instructions, and adds "a meeting it is invited to" to each attendee's Wakes on; `validate` runs the checks of criterion 10.
13. **Walk.** qa-web walks demo step 15's editor half (a daily standup for the CTO lane), light and dark at 1440 × 900, the phone list at 390 (D28), and the published file.

### Build split (agreed with the CTO)

- **kit-core-dev**: criteria 11 (library side) and 12.
- **web-dev**: criteria 1 to 10, after change safety part 1.
- **qa-web**: criterion 13.
- **CPO**: reviews against this story and signs off the copy, including the starter agendas.

## Story: team templates (issue #30, demo step 2)

The owner's words: "a visual drag-and-drop team builder ... add members, toggle on/off, edit roles/duties/reporting" (2026-11-05), and "not just for engineering companies ... the model, vocabulary and UI must let any industry use the tool eventually" (2026-11-06, as recorded in project memory).

What follows is the CPO's reading, labelled as mine.

**As** someone starting a team, **I want** to pick a ready-made team that fits my kind of work, see it on the canvas before I commit, and then shape it, **so** I start from a sensible organisation in a minute instead of building one role at a time.

### Template or role pack

| | Template | Role pack |
|---|---|---|
| What it makes | A whole new team | One or more agents added to a team that exists |
| When | Once, when the team is created | Any time |
| What it holds | A role list (a kit preset or its own), which roles start dormant, role extensions, custom agents, reporting lines, placeholder values (project, owner, time zone), suggested systems to connect, suggested owned areas and checks, starter meetings, and the canvas layout | `<slug>.md` files and `pack.json` (what the agents need) |
| Afterwards | No link back. The team is ordinary `.agent-team/` files, and kit upgrades reach it through its roles like any team | The agents are ordinary custom agents |

A template may carry custom agents inside it, in the role pack format, so a non-engineering template can bring roles the kit library does not have.

### Product decisions

- **D29. Templates that ship first.** Three must ship together, so the gallery is never engineering-only:
  - **Startup product team** (demo step 2): the engineering preset, with chief of staff, CTO and CPO lanes, builders, QA and reviewers.
  - **Customer support team**: chief of staff, support lead, customer success lead and bug triager from the kit, plus two custom agents, a support responder (drafts replies from the knowledge base; the owner or the support lead approves what goes out) and a knowledge base writer (owns the help articles and saved replies). Owned areas such as `support/replies/` and `support/articles/`. Starter meeting: a weekly top-issues review.
  - **Content studio**: chief of staff, content lead, marketing lead, brand designer and analytics lead from the kit, with extensions that point them at published content rather than in-product content, plus two custom agents, an editor (owns the editorial calendar and signs off every piece) and a fact checker (reads only; sends corrections to the writer as BUG). Owned areas such as `content/drafts/`, `content/published/` and `content/calendar.md`. Starter meeting: a weekly editorial planning round.
  
  The same release, if they are cheap: **Small product team** (the minimal preset), **Whole company** (the company preset, business roles dormant), **Native mobile app** (from `examples/native-mobile`), **Open-source maintainers** (maintainer roles plus community lead and bug triager), and **Web app on Supabase and Vercel** (the startup team with those systems suggested and areas and checks pre-filled).
- **D30. Neutral templates are honest about Git for now.** The support and content templates publish to a repository like every team today. Their areas are folders of documents, their checks are sign-offs rather than test runs, and no copy in them mentions code, branches or CI. A team repository the Studio manages for people who never use Git (ADR 0005) is a later phase; the picker does not promise it.
- **D31. Preview before create.** Picking a template shows its canvas, the roles that start on and dormant, the systems it suggests and its starter meetings, before anything is written. **Use this template** asks only for the project name, owner name and time zone, then opens the editor with the team as an unpublished draft.
- **D32. Never overwrite a team.** If the repository already has `.agent-team/`, the picker does not offer templates: it says the repository has a team and opens it. The picker also offers **Open an existing team** and **Start almost empty** (a chief of staff only).
- **D33. Grouping without jargon.** The gallery groups templates as "Build a product", "Run a business function" and "Maintain open source", with a search box. Each card shows a one-line purpose, the number of roles on and dormant, and the systems it suggests.
- **D34. No demo data.** Templates hold no invented tasks, issues, people or minutes. Placeholders are filled from the create form.
- **D35. Where a team came from is recorded, not enforced.** `team.json` records the template id and kit version (for example `"from": "content-studio@0.11.0"`) for the evals and analytics pages only. Nothing changes when the template changes later.
- **D36. Out of scope:** saving your own team as a template, sharing templates between workspaces, and a template marketplace. These belong with the platform-team persona later.

### Acceptance criteria

1. **Template format (kit).** A template is a folder with `template.json` (schema `agent-team/team-template@1`: id, title, summary, group, roles or preset, dormant roles, values, extensions, suggested systems by type, suggested areas and checks, meetings, layout) and an optional `roles/` folder of custom agents in the role pack format. `validate` checks a template like a team: every role resolves, one writer per area, reporting has no loops, no secrets.
2. **CLI parity (kit).** `agent-team init --template <id>` creates the same files the Studio would, so a text-only user gets the same team.
3. **The shipped templates (kit).** The three must-ship templates of D29 exist and pass `validate` with zero errors and no warnings. Each custom agent in them has an Identity, owned areas, Hands to and, where it signs off, Sign-off evidence.
4. **Neutral copy (kit).** No text in the support or content templates (briefs, extensions, meeting agendas, suggested checks) assumes code, Git, CI or engineering roles. The CPO signs off this copy.
5. **Picker (Studio).** "New team" opens the gallery (D33) with search; the three must-ship templates are visible without scrolling at 1440 × 900.
6. **Preview (D31).** Selecting a card shows the canvas preview and the lists; nothing is written until **Use this template**.
7. **Create form (D31).** Project name, owner name, time zone (defaulting to the browser's); the team opens as a draft with no check errors.
8. **Existing team (D32).** On a repository that has `.agent-team/`, the picker opens that team and offers no templates.
9. **Round trip.** Publishing a team made from a template, then re-opening it, shows zero diff; the published files match `agent-team init --template` for the same inputs.
10. **Suggested systems.** Systems a template suggests show as "to connect" in the Systems view, with no secrets and no bindings until the owner connects them.
11. **Walk.** qa-web creates one team from each must-ship template, publishes each, and re-opens each; screenshots of the gallery, a preview and each canvas, light and dark at 1440 × 900, and the gallery at 390 wide (read-only browsing is enough on a phone).

### Build split (for the CTO to confirm)

- **kit-core-dev**: criteria 1 to 4, then the optional templates of D29.
- **web-dev**: criteria 5 to 10, after the meetings editor.
- **qa-web**: criterion 11.
- **CPO**: signs off the copy of every shipped template (criterion 4) and reviews the picker against this story.

## Story: neutral protocols for business-function teams (follow-up to the templates story)

The owner's words (2026-11-06, as recorded in project memory): "not just for engineering companies ... the model, vocabulary and UI must let any industry use the tool eventually."

What follows is the CPO's reading, labelled as mine.

**As** the owner of a support team or a content studio, **I want** my agents' shared rules to talk about my work (drafts, approvals, sign-offs, sending and publishing), not pull requests, merge gates and deploys, **so** the team follows rules that fit what it does, and nothing in its instructions is noise or wrong.

Found during the copy review of kit #79: every team gets the same `protocols.md` and `project-instructions.md`, and both assume engineering (section "Pull requests", HANDOFF fields "branch and commit, artifact (build path or preview URL)", BUG fields "screen, build", SIGNOFF "tested on (device or browser, OS, commit)", worktrees, hardware locks, the janitor). The four custom agents in the templates are neutral; the shared files around them are not.

### Product decisions

- **D37. A neutral core plus packs.** `protocols.md` and `project-instructions.md` split into a core every team gets (one door, the dilution rule, owner-steps-in, ownership and one writer per area, the four message kinds, reporting to the board, memory files, digest and meetings) and an **engineering pack** (pull requests, merge gate, worktrees, hardware locks, janitor, deploys, migrations). A team's packs come from its template or preset; existing teams get the engineering pack automatically, so CoachSpotter's and this kit's generated files do not change in meaning.
- **D38. The four message kinds keep their names; their fields become neutral.** HANDOFF: task, from, to, **what changed and where it is** (a link, a file or a branch), how to check it, done when. BUG: task, **where** (a screen, a document, a page), steps or quote, expected, actual, evidence, severity. SIGNOFF: task, **what was checked and on what version**, result, evidence (required). The engineering pack adds its fields back (branch and commit, build, device and OS).
- **D39. Owner-steps-in gets business examples.** Next to "data changes that cannot be undone", the core names: sending to customers or the public without an approved policy, spending money, legal commitments, and anything published under the owner's name. The engineering pack keeps destructive migrations and production deploys.
- **D40. "Push before long steps" becomes "save your work where the team can see it before long steps".** In a repository that still means push; the core does not say so.
- **D41. No behaviour change for engineering teams.** A team on the engineering preset gets generated files with the same rules as today (wording may move, not meaning); `sync.sh check` on CoachSpotter and on this kit's own team shows only the expected moves, reviewed by the CPO and the CTO.

### Acceptance criteria

1. The core files contain none of: pull request, PR, merge, branch, commit, deploy, CI, build, worktree, migration (a test enforces this, like the template copy test).
2. The engineering pack holds every rule removed from the core; a diff review shows no rule lost.
3. The support and content templates generate instructions with the core only; their briefs' "Every thread, every task" footer uses D40's wording.
4. Existing teams (presets engineering, minimal, company) get core plus the engineering pack with no rule lost (D41).
5. The Studio shows a team's packs in its settings, and the template gallery says which packs a template uses (no new choice for the owner yet).
6. The CPO signs off the core copy; the CTO signs off the engineering pack.

### Build split (for the CTO to confirm)

- **kit-core-dev**: criteria 1 to 4, as a kit minor release after 0.12.0.
- **web-dev**: criterion 5, small, alongside the template picker.
- **CPO and CTO**: criterion 6.

## Story: other coding agents (PRD G3 b, follow-up to #30)

Context: PRD gap G3, "Claude Code and bash only". Part (a) shipped (Node scripts, so reporting works without bash). This story is part (b) for the instructions: the same team, read by a coding agent other than Claude Code.

What follows is the CPO's reading, labelled as mine.

**As** a team whose members, or whose company, use a coding agent other than Claude Code, **I want** sync to write the instruction files that agent reads, with the same roles, rules and board reporting, **so** the team works the same way whichever agent runs a role, and I can see honestly what is weaker without Claude Code's hooks.

### Product decisions

- **D42. First cut: one vendor-neutral target, `AGENTS.md`.** Many coding agents read a root `AGENTS.md` as their project instructions, so one file reaches the most tools with the least per-vendor code. Sync writes it from the same sources as the Claude project instructions: the company, how work moves, the standing rules, a pointer to `docs/team/protocols.md`, and how a session finds its role (D43). No tool-specific files (per-vendor rule folders, settings, hooks) in the first cut.
- **D43. How a session knows its role.** The same way as today, written for any agent: the role comes from `.agent-team/local.env` (`AGENT_TEAM_ROLE`) or from the first message ("You are <role>. Read docs/team/roles/<role>.md"). `AGENTS.md` says to read the role brief and the protocols before anything else, and to report `status working` first.
- **D44. Reporting without hooks uses the Node reporter.** `AGENTS.md` names `node scripts/agent-team/report.mjs` (no bash, no `jq`) for every board report. The `team-status.sh` examples stay for teams that have bash.
- **D45. Turned on per team, off by default.** `team.json` gets `"targets": ["claude-code", "agents-md"]`; existing teams have only `claude-code` and see no change on sync. In the Studio, team settings get one switch, "Also write instructions for other coding agents (AGENTS.md)". If a repository already has a hand-written `AGENTS.md`, sync does not overwrite it: it writes the kit's text between start and end markers inside the file and leaves the rest alone, as it does for other shared files.
- **D46. What degrades without hooks, said plainly.** These Claude Code features have no equivalent in the first cut:
  1. **Automatic liveness**: no automatic start, heartbeat, idle and stop events, so the board relies on the role's own reports.
  2. **The ownership guard before each edit**: one writer per area is still checked by the merge gate and CI (and by the runner in hosted runs), but not live while the agent edits.
  3. **Subagent and teammate reports.**
  4. **Built-in agent teams export.**

  The board marks a role that reported with no hook events as "self-reported", so the owner can see why a card may go quiet. The README and `docs/hooks-and-agent-teams.md` get a short table of what works with Claude Code and what works with other agents.
- **D47. Tools in scope for the first cut.** The target is the `AGENTS.md` convention itself, not a list of vendors. Acceptance is proven with **two coding agents other than Claude Code that read a root `AGENTS.md`**, picked by kit-core-dev from what can be installed and run in CI or a cloud sandbox. The PR names them and records the exact versions. Per-tool adapters (that tool's own rule files or hook equivalents) come later, one story per tool, and only where the tool documents a stable mechanism.
- **D48. Vendor-neutral words.** `AGENTS.md` names no vendor and no model. Model tiers stay as tier names (deep, standard, routine, light) with the tier descriptions from the project instructions, and each tool maps them however it can.

### Acceptance criteria

1. With `agents-md` in `targets`, `sync` writes `AGENTS.md` at the repository root; `sync.sh check` fails when it is stale, like every generated file.
2. `AGENTS.md` holds the project instructions' content in tool-neutral words (D42, D48), how to find your role (D43), and the Node reporter commands (D44). It mentions no vendor or model name (a test checks a list of vendor names).
3. A team without `agents-md` gets byte-identical output to the release before (D45).
4. An existing hand-written `AGENTS.md` keeps every line outside the kit's markers after sync (D45).
5. Walk with two agents (D47): in a sample repository with `agents-md` on, each agent, told only "You are web-dev; start the task 'Add a footer'", reads its brief, reports `status working` with the Node reporter, and the board shows it as "self-reported". Logs and board output are kept as evidence. Until the owner sets a model key there are no real model calls: the proof is offline, showing that each agent loads `AGENTS.md` (from the tool's own way of listing or printing the instructions it loaded) and that the reporter commands in it work. The live walk is recorded as pending and is run once a key exists (CTO, 2026-11-06).
6. The board's "self-reported" mark (D46) shows on a role card with reports and no hook events, in the dashboard and in the Studio's live board.
7. The README and `docs/hooks-and-agent-teams.md` have the table of what works with Claude Code and with other agents (D46), and the PRD's G3 row points to it.
8. The Studio's team settings have the switch (D45); turning it on shows `AGENTS.md` in the publish diff.

### Build split (for the CTO to confirm)

- **kit-core-dev**: criteria 1 to 5 and 7, after "PR through gh".
- **web-dev**: criteria 6 (Studio side) and 8; kit-core-dev does the dashboard side of 6.
- **CPO**: signs off the `AGENTS.md` copy and the table.

## Story: email notifications (PRD 6.8, phase 3)

The owner's words (2026-11-06, PRD header): "There should be a way to connect emails/communication systems with the owner so if they want to receive emails for certain triggers or team members they can."

What follows is the CPO's reading, labelled as mine.

**As** a team owner away from the Studio, **I want** an email when something needs me or is going wrong, only for the things I chose, **so** the team never waits on me for long and my inbox is not flooded.

### Product decisions

- **D49. Opt-in, per person, per kind.** Nothing is emailed until the person adds and verifies an address and switches on at least one kind (O2, O7). The first time, the Studio suggests "Approval needed" and "Budget at 100%" switched on, everything else off.
- **D50. One email, one link.** Every email has a subject under 70 characters that starts with the team's name in square brackets, a body of at most four short lines, and exactly one button-style link into the Studio. Links expire after 7 days (approval links after 24 hours) and open the sign-in page first when the person is signed out.
- **D51. Never an action in the email.** An approval email links to the card; approving needs the signed-in Studio and its step-up (O4). No email says "reply to approve". The verification code is the only thing a person types back.
- **D52. Text from outside the team** (issue titles, PR titles, agent text) is shown in quotes and cut to 120 characters (architecture 12.3). Role names are shown as their titles ("Web dev"), not slugs.
- **D53. Neutral words.** No email mentions branches, commits or CI; an approval's link opens the card, which shows those details for engineering teams.
- **D54. The unsubscribe link turns off only that kind**, in one click with no sign-in, and lands on a confirmation page that offers "Turn it back on" and "Manage all emails" (the latter signs in). The address stays verified.

### Copy

Placeholders in braces are filled by the sink. `{team}` is the team's name, `{role}` a role's title, `{link}` the one link.

**Approval needed** (breaks through quiet hours)
- Subject: `[{team}] Approval needed: {summary}`
- Body:
  > {role} needs your approval before it can go on.
  > "{summary}"
  > Recommendation: {recommendation}
  > Nothing happens until you approve in the Studio.
- Link: `Review in the Studio`

**Budget at 80%**
- Subject: `[{team}] 80% of today's budget used`
- Body:
  > Your team has used {spent} of its {cap} daily budget.
  > Work carries on. At 100% only release-blocking fixes and checks keep running.
- Link: `See today's usage`

**Budget at 100%** (breaks through quiet hours)
- Subject: `[{team}] Daily budget reached, new work paused`
- Body:
  > Your team has used its {cap} daily budget.
  > New work is paused until {reset_time}. Raise the cap in the Studio to resume sooner.
- Link: `See usage and the cap`

**BLOCKED**
- Subject: `[{team}] {role} is waiting on a decision`
- Body:
  > {role} is blocked on: "{question}"
  > Recommendation: {recommendation}
  > It keeps working on the recommendation unless the step cannot be undone.
- Link: `Answer in the Studio`

**Meeting minutes**
- Subject: `[{team}] Minutes: {meeting} ({date})`
- Body:
  > {decisions_count} decisions and {actions_count} action items.
  > {first_decision_or_"No decisions this time."}
  > {needs_you_line, e.g. "1 item needs you." or nothing}
- Link: `Read the minutes`

**Verify your address**
- Subject: `Your code for Agent Team Studio: {code}`
- Body:
  > Enter this code in the Studio to get team emails at this address:
  > {code}
  > It expires in 15 minutes. If you did not ask for it, ignore this email; nothing will be sent.
- No link.

**Footer on every email except verification**
> You get this because you turned on "{kind}" emails for {team}. [Turn off these emails]({unsubscribe_link}) · [Manage all emails]({settings_link})

**Unsubscribe confirmation page**
- Heading: `You won't get "{kind}" emails for {team}`
- Text: `Other emails you turned on still arrive. Your address stays verified.`
- Buttons: `Turn it back on` · `Manage all emails`

**Opt-in, in the Studio's Notifications page**
- Heading: `Emails`
- Text: `Get an email when something needs you. Nothing is sent until you verify your address and choose what you want.`
- Address field label: `Your email address` · button `Send a code`
- After the code: `Verified. Choose what to email you about:` then switches labelled: `Approval needed`, `Budget at 80%`, `Budget at 100%`, `A role is blocked`, `Meeting minutes`
- Under the approval switch: `The email links to the Studio. You always approve there, never by replying.`

### Acceptance criteria

1. Every template renders with real event data in under four body lines, one link, and the footer (D50); a test checks subject length and link count per kind.
2. No template offers an action by reply; approval links expire in 24 hours and require sign-in plus step-up (D51).
3. Outside text is quoted and cut to 120 characters; role titles, not slugs (D52).
4. Unsubscribe turns off one kind for one team without sign-in, lands on the confirmation page, and "Turn it back on" works (D54).
5. Nothing is sent before verification and opt-in (D49); a code expires in 15 minutes.
6. The CPO signs off the rendered emails from a test send of each kind (screenshots of the HTML and the plain-text part).

### Build split

- **kit-core-dev** (as the CTO assigned): the email sink, templates from this copy, criteria 1 to 5.
- **web-dev**: the opt-in section of the Notifications page with this copy.
- **CPO**: criterion 6.
