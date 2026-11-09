# OrgCraft: the 10-year vision, screen by screen

> This is the product design the owner signed off on 2026-11-09. The CPO keeps it up to date, and the Now screens are being built against it. It mentions working files by name (reviews, tooltips, copy reviews). Those live with the team's planning notes, not in this repository. The short version is [the roadmap](../roadmap.md).

Status: draft 3, 2026-11-09 07:45 UTC (gap review folded in at §2.6; review 2 from every role folded in at §2.7), CPO. It answers the owner's message of 06:40 UTC: "Please account for everything. I want mockups that show our 10 year down the line VISION. I cannot have you leaving anything out". The brief is README.md. Reviewers: the chief of staff and the CTO. The architect owns every "Needs from the architecture" line and will correct them. The gap review (gap-review.md) feeds draft 2.

The mockup is one artifact, built at the same link: https://claude.ai/artifact/72jegHxVkUimaC785zcP3j.

Sources: prd.md (repo `docs/product/prd.md`), n8n-study.md, n1 and n2, role-instances.md, governance-spec.md, domain-packs-plan.md, ADRs 0001 to 0008, and the CPO lane stories D1 to D63.

---

## 0. How to read this

### 0.1 Phase tags (each screen in the mockup carries one)

| Tag | Means | Horizon |
|---|---|---|
| **Now** | Specced and in the build plan: the MVP demo (prd §4 steps 1–13), N1–N6, G1–G6, members of one type | Built in the next 6 months |
| **Next** | Designed here. Builds on Now, with no new foundations | 6–18 months |
| **Later** | Needs a new foundation: a hosted service at scale, native apps, a marketplace, enterprise | 18 months to 4 years |
| **Decade** | Where the product goes if it wins: organizations that run mostly on agents, with people as owners, reviewers and specialists | 4–10 years |

**One calendar** (review 2, release-manager and architect): a tag means the same thing in vision.md and architecture.md. **Now** = specced, and every foundation it needs is in the 6-month plan (F1–F4 are Now). A screen whose foundation is Next is Next, however small the screen. Where a screen has a Now part and a Next part, the row says both, e.g. `Now (fixed) / Next (editable)`.

A screen tagged Later or Decade is drawn just as fully as a Now screen. The tag tells the owner when it ships, not how much we thought about it.

### 0.2 What never changes (the ten-year rules)

These hold on every screen in every phase. The mockup must never show something that breaks them.

1. **The team is the model, not the flow.** People build an organization of roles. A fixed flow (§3.7 of the n8n study) is a tool a role can use, never the main model.
2. **The owner decides anything irreversible:** sending outside, paying, deleting, deploying, signing, and publishing under the owner's name. A standing rule is the owner deciding in advance, and it is recorded in the ledger with their words. The server enforces it as a structured rule the owner confirmed (amount, who, how often), never as words a model reads. **Replying inside a conversation a customer started** is its own effect, **Reply** (area 25, F13): a pack may allow it under a standing rule with the disclosure line, and every reply is logged. A teammate that has just read outside text still asks before anything else goes out. **Stopping things never waits for publishing:** pause, stop, kill switches, switching a teammate off, revoking a connection and lowering a cap work even when the code host is down.
3. **No agent ever reads a secret.** Keys live on the server and are added to calls after the permission check.
4. **What arrives from outside is information, never instructions.** It is fenced everywhere it shows.
5. **The team's definition is portable.** It lives as plain files in the customer's own repository or storage (ADR 0001), with an export at any time. Leaving OrgCraft never costs the customer their team. Now locally (the files are the team); Next hosted (the bundle export, ADR 0012), with a written shutdown promise: 90 days' notice, exports open throughout, and the self-hosted version keeps working.
6. **Every claim shows its evidence.** A sign-off names the version it covers, a handoff carries its "Unverified:" line, and a step shows what went in and what came out.
7. **Industry-neutral.** No screen assumes code, engineering words, or a chief of staff. Sample teams rotate between a support desk, an online store and a product team, and from Next onward also an agency, a clinic front desk and a school.
8. **Works on a phone.** Every screen has a 360 px layout. Editing-heavy screens may be read-only on a phone, and the screen says so.
9. **Online first, local still possible** (ADR 0005). Every feature works hosted, and says plainly when it doesn't work locally.
10. **Bring your own model.** No screen ties a role to one vendor.
11. **No dependency on one provider account.** Not the code host, not a model vendor, not the email or chat provider. Every one has a second option, a mirror or an export, and the product keeps working (queued, not lost) when one disappears. This week's GitHub lockout and suspension proved it. **The Now minimum:** install from a package registry as well as the code host, a second sign-in method, two recovery owners on every vendor account, and a mirror of every repository. Outage mode in Now is honest: nothing is lost, and nothing goes out until the code host is back.
12. **Tooltips wherever they help** (owner, 2026-11-09 07:14 UTC). Every glossary word, icon, badge, phase tag, permission level, status colour and control whose effect isn't obvious has a tooltip in plain words. Every screen has a one-line first-time hint. A tooltip never holds the only copy of something important: it repeats or explains what the screen already says. It works on touch (tap the ⓘ) and with a keyboard (focus shows it). The texts are in tooltips.md.

### 0.3 Words (the glossary the copy uses)

| Use | Not | Note |
|---|---|---|
| Organization, team | workspace, tenant | An organization owns one or more teams |
| Role (the job in the catalog) | type, persona, agent type | Answers role-instances open point 1 |
| Teammate (one seat on the chart) | member, instance, agent | "Support agent 2" is a teammate whose role is Support agent. Specs and code may say `member`; nothing a person reads does |
| Extra hands | pool, instance #2 | "Same job, more hands" |
| Person | human, user | People sit on the chart next to teammates |
| System | integration, connector, resource | "Connector" only in the catalog, for the thing you install |
| Trigger | wake-up, hook, event | |
| Task | run, job, session | A run is the window a team is working in. People see tasks |
| Standing rule | standing approval, policy | |
| Check | gate, eval, test | "Evaluation set" only on the quality screens |
| Publish | deploy, merge, commit | |
| Ready to try | shipped, deployed, merged | The stage words (Idea, Building, Testing, Ready to try, Live) are the default pack's. Each pack renames them, e.g. clinic: Drafted · Being checked · Ready for you · Sent |
| The team's lead (shown by its role name) | front door, chief of staff (as a given) | Setting: `Who answers first`. Most templates use a chief of staff, but none may assume one |
| AI teammate (when contrasting with people) | agent, bot | "Agent" only inside a role title, e.g. Support agent |
| Start the team · Working · Paused · Stopped | start a run, run states | |
| Read · Change · Act (permissions); Reads · Changes · Sends · Deletes · Pays · Goes live (what a step did) | write, destructive, deploy | Act covers sending, paying, deleting and going live |
| Version 2, draft 2, commit 3fa21c0 (from the pack) | r2 | Never print "r2" |
| From another app (webhook); Code host | Webhook, GitHub (as a source name) | |
| Ignore repeats · At most N an hour · Matches a pattern (advanced) | dedupe, rate limit, regex | |
| Backup model · Stays on version X · How it's scored · Try on one team first | fallback, pinned, graders, canary | |
| Read outside text · From outside | taint, trust boundary | |
| Where the work runs (a runner is a machine where your teammates work) | runner (unexplained) | |
| Organization | workspace | Also in security and recovery screens. An agency's account sits above its client organizations |
| Reply (what a step did, inside a customer's conversation) | send | Shown with the Sends badge's colour but its own word |
| Decided by you · by {person} · by {lead role} · in a meeting | decision (unqualified) | Only the first two bind the team (AI-17) |
| Custom role | custom agent | |

**Acronyms** (LTS, SSO, SAML, SCIM, DPA, KMS, RPO, RTO, SBOM, WAF) appear only on admin and compliance screens, spelled out on first use with a plain line underneath. **Spelling:** American English in the product (organization, program, color). **Money and dates:** the organization's currency, the viewer's locale, the team's time zone.

---

## 1. The map

The top bar has one switcher (organization ▸ team) and seven tabs. The phone layout collapses them into a bottom bar with five items: Home, Work, Approvals, Chat and More.

| Tab | What lives there | Areas |
|---|---|---|
| **Home** | The owner's start page: Needs you, New, In progress, cost today, team health | 13, 23, 24 |
| **Team** | The organization builder, each teammate's wiring view, the role catalog, templates, publish | 1–5 |
| **Work** | Tasks and the run inspector, Try a role, meetings, board views | 9, 12, 13 |
| **Chat** | The team's lead (whichever role answers first; the chief of staff in most templates) and any teammate | 10 |
| **Approvals** | Cards, the ledger, standing rules, delegation | 11, 14 |
| **Connections** | Systems catalog, credentials, triggers | 6–8 |
| **Settings** | Budget, people and access, security, compliance, memory, deployments, notifications, billing, data | 15–22, 25+ |

There are also a global search and command palette (`/` or ⌘K) and an organization switcher for owners with several companies (area 22).

---

## 2. Every area, every screen

Each area lists its screens with a phase tag, the key copy, and what it needs from the architecture. The first column is the screen ID that web-dev uses in the mockup.

### BUILD

#### Area 1. Organization builder

| ID | Screen | Phase | What it shows |
|---|---|---|---|
| B1.1 | Org chart canvas | Now | Drag a role from the catalog to add a teammate, and drop it on a manager to set the reporting line. Switch teammates on or off. Draft changes show dashed. Mocked in v7 |
| B1.2 | Role catalog (left palette) | Now | Roles grouped by department, each with a count of teammates on the team ("2 on the team"). Dragging a role always adds a new teammate |
| B1.3 | Teammate card + inspector | Now | Name, role underneath in small text when the two differ, reports to, duties, "Always asks you about", systems, woken by, model, extra hands. "Edit the job description" opens the role and warns that the change applies to everyone with that role |
| B1.4 | Departments and lanes | Next | Group boxes on the canvas ("Support", "EMEA", "Growth"), each with a lead, a budget line and its own digest. Collapse or expand |
| B1.5 | People on the chart | Next | A person card (name, photo; it points to the person in People and access, never stores an email of its own, K8) next to teammates. People can be managers, reviewers and approvers, and receive handoffs in their inbox. Their card shows "Person". They are never woken or billed |
| B1.6 | Vacancies and hiring suggestions | Later | A dashed "Open seat" card. The team's lead suggests seats from the work: "Billing questions waited 2 days on average. Add a Billing specialist?" with **Add it** / **Not now** |
| B1.7 | Auto-layout and views | Now | Chart, list and by-department views. Fit to screen. A phone list view with drag handles, read-only by default |
| B1.8 | Org history | Later | A time slider: the chart as it was on any date, with each publish as a tick |
| B1.9 | Org health check | Next | One panel of warnings: no manager, nobody checks this role's work, a system with Change access and no reviewer, a role off but still named in a trigger, a single person approving everything |
| B1.10 | Several organizations, one owner | Later | See area 22 |
| B1.11 | Decade: the self-organizing team | Decade | The team's lead proposes org changes as a draft publish ("Split Support into Orders and Product questions; here's why"), with numbers from the reports. The owner reviews it like any publish |

Copy:
- Empty canvas: `Drag a role from the left onto the canvas to add it. Drop it on another role to make it report there.` (v7)
- Duplicate name: `Another teammate is already called {name}.`
- Extra hands: `Same job, more hands` (number) · `Add another, set up differently` (creates a teammate).
- Person card: `{name} · Person` · menu `Send handoffs to their email` / `Ask them for approvals`.
- Health check heading: `Things to look at before you publish`.

Needs from the architecture:
- teammates and roles: `Based on`, display names (role-instances §2–3);
- structured `Hands to` (a CPO decision, see below);
- `people[]` in the team spec, with email, role on the chart and notification address, and no runner seat;
- departments as `group` with a lead and a budget;
- a history read of the team at a commit (exists: versions are SHAs, ADR 0004).

**CPO decisions on role-instances §11.**
1. The words are **role** (in the catalog) and **teammate** (a seat).
2. Done by the owner.
3. **Yes** to structured `Hands to`: it powers the wiring view and the health check.

#### Area 2. Per-teammate wiring view (n8n-style)

| ID | Screen | Phase | What it shows |
|---|---|---|---|
| B2.1 | Wiring view | Now (mockup pending) | Opens from a teammate card. Inputs on the left (triggers, handoffs in, meetings, chat). The teammate is in the middle. Outputs on the right: systems with Read/Change/Act, handoffs out, people it asks. Every wire can be dragged, deleted and labelled |
| B2.2 | Wire inspector | Now | Click a wire: for a system, the permission and the tools it allows, each with its effect; for a handoff, what is handed over and the check expected; for a trigger, the filter and the wake text |
| B2.3 | Team wiring overview | Next | The whole team's inputs and outputs at once, filterable by system ("Who can pay?") |
| B2.4 | Test a wire | Next | **Test** on a trigger wire sends a sample through (N2 test listener). **Test** on a system wire runs a read-only call and shows the result |
| B2.5 | Decade: suggested wiring | Decade | "Support lead reads Payments 40 times a week through Support agent. Give Support lead read access directly?" |

Copy:
- Column headings: `What wakes it` · `{teammate}` · `What it can use and who it hands to`.
- Empty input column: `Nothing wakes this teammate yet. Add a trigger, or have another teammate hand work to it.`
- Explainer box (owner Q&A, 2026-11-09), shown in the wiring view and in Connections: `Triggers are what wakes a teammate: an email, a form, a time of day. Systems are what a teammate can use once it's awake, and how far it can go: Read, Change or Act.`
- **Handoffs become structured** (owner Q&A). Today a role's "Hands to" is a sentence in its brief. It becomes a list with one target per line (a teammate or a role), drawn as wires here. Publish warns about a handoff to a teammate who is off, a role with two teammates and no rule for choosing, and a teammate nobody hands work to. Example warning: `Support agent hands work to Support lead, who is switched off. Turn Support lead on, or pick someone else.` (architect: role-instances §8)

Needs from the architecture: `Hands to` as data; bindings per teammate in `resources.json`; triggers per teammate in `triggers.json`. These already exist, apart from `Hands to`.

#### Area 3. Custom roles, skills, models and quality

| ID | Screen | Phase | What it shows |
|---|---|---|---|
| B3.1 | Guided role editor | Now (shipped D1–D11) | New role from scratch, from a copy, or from a file. Live brief preview, path and area conflicts caught as you type |
| B3.2 | Skills and knowledge | Next | Attach knowledge: documents, help articles, a folder, a website. Attach skills: reusable procedures. Each shows its source, size, last refresh, and which teammates use it |
| B3.3 | Model per teammate | Next | Model picker with **Claude**, **other vendors**, **open models** and **your own (local or hosted)**. Each shows its price per typical task, its quality score on this role's evaluation set, and its privacy notes. Fallback model |
| B3.4 | Evaluation sets | Next | Saved sample tasks per role ("Save as a check" from Try a role), with a pass/fail rule each. Runs whenever the brief or the model changes. A history chart |
| B3.5 | Compare models | Later | Run one evaluation set on 2–4 models side by side, with cost, time, pass rate and the outputs next to each other. **Use this model** |
| B3.6 | Role versions | Next | The role's brief history, with a diff between versions, which teammates use which version, and rollback |
| B3.7 | Decade: roles that learn | Decade | Lessons from G6 "Lesson:" lines become proposed brief edits. The owner reviews them like a publish, and the evaluation set must pass before they apply |

Copy:
- Model card: `{model} · about {cost} a task · passes {n} of {m} checks for this role`.
- Privacy note on a model: `Runs on {vendor}'s servers` / `Runs on your own machine. Nothing leaves it.`
- Evaluation run: `{n} of {m} checks passed. {k} got worse since the last version.`

Needs from the architecture:
- a model adapter interface in the runner (vendor, endpoint, keys in the vault);
- a per-role evaluation store, with fixtures from N4;
- knowledge sources with indexing, refresh and access by teammate (never cross-team);
- cost estimates per model, from a price table that can be updated without a release.

#### Area 4. Templates and domain packs

| ID | Screen | Phase | What it shows |
|---|---|---|---|
| B4.1 | Template gallery | Now (mocked) | Grouped by what the business does. Each card shows its roles and "Asks to connect: …" |
| B4.2 | Connect its systems | Now (mocked) | After "Use this template", one row per needed system: Connect, or Skip ("To connect", dashed on the canvas) |
| B4.3 | All industries | Next | Wave 1–3 packs: product, support, content, store, agency, coaching and education, recruiting, bookkeeping, real estate. **Later:** legal operations, clinic admin, nonprofits, hospitality, trades and field service, local government. Each card says `Drafts only: a qualified person decides` where it applies |
| B4.4 | Community packs | Later | Packs published by others, with author, installs, last update, a "Checked by OrgCraft" badge, and a report button |
| B4.5 | Import | Next | Import roles from persona libraries and agent files (Claude Code agents, AGENTS.md, BMAD, wshobson) with a mapping preview: `14 roles found. 11 map to our catalog, 3 become new roles.` |
| B4.6 | Publish your own pack | Later | Turn your team into a pack. Remove names, data and secrets (an automatic check), add a README, pick a licence, publish to the community or to your organization only |
| B4.7 | Pack preview | Next | Before using a pack: its org chart, triggers, standing rule suggestions, what the owner always decides, and an estimated monthly cost at typical volume |

Copy:
- Regulated pack badge: `Drafts only. A qualified person makes the decision.`
- Community badge: `Checked by OrgCraft` / `Not checked yet`.
- Export check: `We removed 4 names and 2 email addresses. Check the result before publishing.`

Needs from the architecture: the pack format (domain-packs §1); a pack registry (Later); a scrubber that removes data, names and secrets; and importers per source format.

#### Area 5. Publish with change safety

| ID | Screen | Phase | What it shows |
|---|---|---|---|
| B5.1 | Publish sheet | Now (mocked v7) | "Publish {n} changes", one line per change, a work-in-progress choice per affected teammate, and the approval hint |
| B5.2 | Rollout view | Now (D61–D63) | Which teammates have picked up the new version |
| B5.3 | Versions and rollback | Next | A list of published versions (date, who, summary) with **Compare** and **Go back to this version**. Rolling back is itself a publish |
| B5.4 | Scheduled publish | Next | `Publish at [Mon 09:00]` and `Publish when no task is running` |
| B5.5 | Review the org change | Next | Another person reviews a publish (two-person rule for org changes), with comments on each change |
| B5.6 | Policy checks | Later | Rules every publish must pass: "No role may pay without a checker", "Every customer-facing role has a reviewer". A failing check blocks Publish, with the reason |
| B5.7 | Staging team | Later | A copy of the team that runs on sample data. Publish there first, run its evaluation sets, then promote it |
| B5.8 | Freeze | Next | `Freeze changes until {date}`, for a busy season or an audit |

Copy:
- Publish hint: `Publishing sends the change for approval. Once it's approved, each role picks up the new version at its next task, and the Rollout page shows which roles have.` (v7)
- Rollback confirm: `Go back to the team as it was on {date}? This publishes a new version that matches it. Work in progress follows the choices below.`
- Policy block: `Can't publish yet: {rule}. {what to change}.`

Needs from the architecture: versions as commits (exists); the scheduled publish job; policy rules as data evaluated in validate; and a staging team as a second team that shares the definition.

### CONNECT

#### Area 6. Connections catalog

| ID | Screen | Phase | What it shows |
|---|---|---|---|
| C6.1 | Catalog | Now (mocked) | Search and categories. Tiers Verified / Community / Yours. Each connector lists its tools with their effect, and what it can wake |
| C6.2 | Connector detail | Now | Tools, effects, permissions per teammate, inbound kinds, auth, and version |
| C6.3 | Any web API (HTTP / OpenAPI) | Next | Paste an OpenAPI file or a URL. Pick operations, give each an effect, test one |
| C6.4 | Code tool | Next | A small sandboxed function (JavaScript or Python) with declared inputs, outputs and effect, and a network allow-list. Tested in place |
| C6.5 | n8n bridge | Next (N5) | "Wake a role from n8n" and "Run an n8n workflow as a tool", against the owner's own n8n |
| C6.6 | Marketplace | Later | Paid and free connectors and packs from others. Revenue share. Security review status |
| C6.7 | Connector health | Next | Every connector's error rate, latency, and the last failure, with **Open the failed step** (N1) |
| C6.8 | Fixed flows | Later | A small drawn flow (n8n style) for something that must run the same way every time ("every invoice: extract, check total, file"). A role calls it as one tool. Steps show in the run inspector |
| C6.9 | Computer use and browser | Later | A connector type for systems with no API: the role works in a sandboxed browser or desktop. Every click is recorded as a step, and anything on the Act list still asks |

Copy:
- Tier texts (v2, signed off): `Verified: made by the service itself, or shipped with OrgCraft.` · `Community: written by someone else. We pin the version we checked, and it can reach only its own service.` · `Yours: built by your team. Changes to it are reviewed like any other change to the team.`
- Code tool hint: `Runs on its own, with no access to keys or other systems except the ones you list.`
- Fixed flow hint: `Use a fixed flow when the steps must never change. Use a role when it needs judgment.`

Needs from the architecture: the tool gateway (n8n study §3.3), MCP tiers (§3.5), the HTTP connector, a code sandbox, a flow runner (Later), a computer-use sandbox (Later), and a marketplace registry with billing (Later).

#### Area 7. Credentials

| ID | Screen | Phase | What it shows |
|---|---|---|---|
| C7.1 | Credentials list | Now (mocked) | Name, service, how it signs in, health, last used, which teammates use it, who added it |
| C7.2 | Add a credential | Now | OAuth sign-in or a key. Test connection. Asks for a passkey |
| C7.3 | Rotation and expiry | Next | `Sign-in expires in 6 days` with **Renew**. Rotation reminders. The old key keeps working for 24 hours |
| C7.4 | Per-team and shared | Next | Use one credential across teams in the organization, with a list of which teams use it |
| C7.5 | Bring your own vault | Later | Keep keys in the customer's own secret store; OrgCraft only holds a reference |
| C7.6 | Access log | Next | Every use of a credential: when, which teammate, which tool, allowed or refused |

Copy:
- Hint (v2, signed off): `Keys and sign-ins are stored encrypted on the server. The team never sees them: the server adds the key to each call after checking the role's permissions. Replacing or removing one asks for your passkey.`

Needs from the architecture: the vault with per-tenant keys, OAuth flows, a rotation job, an external vault adapter, and the access log.

#### Area 8. Triggers, all eight families

| ID | Screen | Phase | What it shows |
|---|---|---|---|
| C8.1 | Triggers list + canvas cards | Now (mocked) | Health, history, draft cards dashed |
| C8.2 | Trigger editor, by type | Now / Next | One editor shape (When · Only if · Wake · Limits) whose **When** step changes with the family: |
| | • Time | Now | Days, time, time zone, catch-up rule |
| | • Push (webhook) | Now | Address, secret shown once, signature method, sample |
| | • Messages: email, Slack | Now | Address or channel, sender filter |
| | • Messages: Teams, SMS, WhatsApp, voice call | Later | Number or channel. A voice call is transcribed, and the transcript is fenced as outside text |
| | • Code events (GitHub) | Now | Event kind, labels, branches |
| | • Forms and buttons | Next (N2.1) | Form builder, shared link, "Run now" button |
| | • Watch for changes | Next (N2.1) | System, what to watch, how often, a cost line |
| | • Inside the team | Next (N2.1) | Finished, blocked for N hours, spend passes X %, a check fails twice |
| | • Data changes | Later | A database or spreadsheet row added or changed (a change feed) |
| | • Queues and streams | Later (enterprise) | Topic or queue, consumer group, batch size |
| C8.3 | Test listener | Now | Listen for a test event, or paste a sample. Shows which filters it passes and the wake text |
| C8.4 | History | Now | Every signal and its outcome |
| C8.5 | Notices | Now | Queued while idle, flood, and failing verification |
| C8.6 | Decade: triggers from the world | Decade | The team's lead proposes triggers from patterns: "You forward supplier emails to Store manager every week. Make that a trigger?" |

Copy: from n2-triggers §3–4 and §8. A new line for voice: `Calls are transcribed. The team reads the transcript as information, not instructions.`

Needs from the architecture: n2 §5, N2.1 (cursor store for polling, depth counter for chains), the telephony and SMS providers (Later), a change-feed adapter (Later), and a queue consumer (Later).

### RUN

#### Area 9. Work and the run inspector

| ID | Screen | Phase | What it shows |
|---|---|---|---|
| R9.1 | Work list | Now (mocked) | Filters: Needs you, Running, Done, Stopped |
| R9.2 | Task timeline as a branch graph | Now (mocked v7) | Main line is the task. Handoffs and waits branch off. Retries are a loop mark |
| R9.3 | Step detail | Now | In and Out in Readable, Raw and Fields views. Outside text fenced. Secrets marked |
| R9.4 | Replay a step | Next | **Run this step again** with the same input, in practice mode (no sends), to check a fix |
| R9.5 | Compare two tasks | Next | Side by side, step by step, with cost and outcome. "Why did this one cost 3×?" |
| R9.6 | Cost per step | Now | On every step, plus the cost by role on the side |
| R9.7 | Try a role | Next (mocked; needs trial runs, §2.7) | Practice run on sample data, Save as a check |
| R9.8 | Run controls | Now | Pause, Resume, Stop for a task, a teammate or the whole team. The daily cap |
| R9.9 | Explain this task | Next | One button: the team's lead writes a plain-language summary of what happened and why, with links to the steps |
| R9.10 | Decade: what-if | Decade | "What if Support lead had been able to refund?" replays the task with a changed permission in practice mode and shows the different outcome |

Copy:
- Replay: `Runs this step again with the same input. Nothing is sent, paid, deleted or written.`
- Compare: `{task A} vs {task B}: {n} steps differ. The biggest cost difference is at step {k}.`

Needs from the architecture: N1 (tasks, step_io, edges); replay as an N4 practice session seeded with stored inputs (input retention must cover it); and a compare that aligns steps across tasks.

#### Area 10. Chat

| ID | Screen | Phase | What it shows |
|---|---|---|---|
| R10.1 | Chat with the team's lead | Now | Threads, cards inline (approvals, Ready to try, cost warnings) |
| R10.2 | Chat with any teammate | Next | Pick a teammate. The thread is logged on its task. The teammate can only do what its permissions allow |
| R10.3 | Files | Next | Drop a file into chat. It becomes knowledge for that task only, unless you say otherwise |
| R10.4 | Voice | Later | Talk to the team's lead on the phone or in the app. A transcript is kept, and approvals still need a tap and a passkey |
| R10.5 | Group chat | Later | The owner, two people and three teammates in one thread, for example a launch room |
| R10.6 | Search chat | Next | Across all threads, with filters for teammate and date |

Copy: `Ask {lead's role name} anything, or pick a teammate.` For voice: `Saying "yes" doesn't approve anything. You'll get a card to confirm.`

Needs from the architecture: chat threads keyed to tasks (exists for the front door), per-teammate chat sessions, file attachments with scope, a voice pipeline (Later), and multi-party threads (Later).

#### Area 11. Approvals

| ID | Screen | Phase | What it shows |
|---|---|---|---|
| R11.1 | Approval card | Now (mocked) | Lettered asks, option 1 recommended, Do it, one passkey per card |
| R11.2 | Ledger | Now (mocked) | When, ask, the owner's words, how it arrived, what it covers, status, export |
| R11.3 | Standing rules | Now (fixed list, enforced by the server) / Next (owner-written rules, compiled and confirmed) | List, add, edit, expire, withdraw. Each shows how often it was used |
| R11.4 | Delegation | Next | `Let {person} approve {kind} up to {amount}` with dates. Shown on the chart as a dotted line |
| R11.5 | Out of office | Next | `I'm away {dates}. Send approvals to {person}, or hold them.` |
| R11.6 | Approval inbox (phone) | Now (web) / Later (native) | A swipeable stack. Face ID or passkey |
| R11.7 | Approval wait report | Next | Average wait, longest wait, cost of waiting |
| R11.8 | Decade: approval budgets | Decade | The owner sets a risk budget ("up to $500 a week of refunds and 20 outbound emails without me") instead of single rules. The team spends against it, and the ledger shows the balance |

Copy:
- Delegation: `{person} can approve {kind} up to {amount} until {date}. Their decisions go in the ledger as theirs.`
- Out of office: `Held approvals wait for you. The team keeps working on everything else.`

Needs from the architecture: G3 and G4, delegation as approver records with limits, out-of-office routing, native push (ADR 0006), and a risk budget as a ledger-backed counter (Decade).

#### Area 12. Meetings

| ID | Screen | Phase | What it shows |
|---|---|---|---|
| R12.1 | Meetings list and editor | Now (shipped D19–D28) | Recurring and ad hoc, a written round, a cost estimate |
| R12.2 | Discussion meeting | Now (shipped, #152) | Rounds, "read each other's answers" |
| R12.3 | Minutes, decisions, action items | Now | Each action item becomes a task, and each decision goes to memory (area 18) |
| R12.4 | People in meetings | Next | A person joins by email or Slack. Their answer counts as a round |
| R12.5 | Calendar sync | Next | ICS and Google/Microsoft calendar: a meeting shows in the owner's calendar, with a link to the minutes |
| R12.6 | Live voice meeting | Decade | The owner talks with the team live, with a transcript and minutes. Decisions still go through cards |

Needs from the architecture: meetings.json (exists), action items as tasks, a calendar connector, and people as attendees.

#### Area 13. Live board and dashboards

| ID | Screen | Phase | What it shows |
|---|---|---|---|
| R13.1 | Home | Now | Needs you, New, In progress (G7 digest shape), cost today, team health |
| R13.2 | By stage | Next (§2.7) | Idea, Building, Testing, Ready to try, Live, using the industry's words from the pack |
| R13.3 | By teammate | Now | The live canvas, where cards light up |
| R13.4 | By cost | Next | Today, this week, by teammate, by task kind, against the cap |
| R13.5 | By customer | Later | For support desks and agencies: work and cost per end customer or client |
| R13.6 | Department view | Next | A department lead sees their lane only: its work, budget and approvals |
| R13.7 | Build your own dashboard | Later | Tiles from any metric, shareable, with a TV mode |
| R13.8 | Embed | Now (ADR 0008) | The board mounted inside the customer's own admin |

Needs from the architecture: board events (exist), cost aggregation, customer tags on tasks, a metrics API, and an embed contract (exists).

### GOVERN

#### Area 14. Governance

| ID | Screen | Phase | What it shows |
|---|---|---|---|
| G14.1 | Unverified line on handoffs | Now (G1) | Amber when something is unverified, grey for "none" |
| G14.2 | Sign-offs tied to a version, stale when it changes | Now (G2) | Ship card with Fresh and Stale |
| G14.3 | Plan → build → review → check → ship → learn | Now (G6) | Each task shows where it is on the path, in the pack's words |
| G14.4 | Separation of duties map | Next | Who makes and who checks every customer-facing output. Gaps shown in red |
| G14.5 | Lessons | Next | Every "Lesson:" line, grouped, with **Turn into a rule** or **Turn into a brief edit** |

Needs from the architecture: the governance spec §8 contract notes.

#### Area 15. Budget and spend

| ID | Screen | Phase | What it shows |
|---|---|---|---|
| G15.1 | Caps | Now (daily cap) / Next (per department, teammate, task) | A tree of caps with what happens at each one: warn, pause, ask |
| G15.2 | Cost warning | Now (G5) | Mocked |
| G15.3 | Forecast | Next | "At this pace you'll spend about $X this month", with the trend |
| G15.4 | Invoices and billing | Later | OrgCraft plan, usage, model costs (pass-through or your own keys), invoices, payment method |
| G15.5 | Price changes | Later | "Model X got 20 % cheaper. Switching Support agent would save about $Y a month." **Try it on the checks first** |
| G15.6 | Cost per outcome | Later | Cost per resolved ticket, per published article, per shipped change, against a person-hour baseline the owner sets |

Copy:
- Cap reached: `{scope} reached its {period} cap of {amount}. {what happens}.`
- Forecast: `About {amount} this month at the current pace. Last month: {amount}.`

Needs from the architecture: hierarchical budgets, a forecast job, a billing provider (Later), a price table, and outcome tags on tasks.

#### Area 16. Compliance pack

| ID | Screen | Phase | What it shows |
|---|---|---|---|
| G16.1 | Audit log | Next | Every action by people and teammates, filterable, exportable (CSV, JSON), signed |
| G16.2 | "What AI teammates can never do" (merged into G38.1) | Now | A single page that the policy enforces and an auditor can read: never read secrets, never approve their own work, never pay without the owner, and so on |
| G16.3 | Data retention | Next | Per data kind: step details, chat, minutes, inbound signals, with day counts and legal holds |
| G16.4 | Data residency | Later | Choose the region where data and runs live |
| G16.5 | Evidence for audits (SOC 2, ISO 27001, others) | Later | A control list, each control linked to live evidence (settings, logs), with export for an auditor |
| G16.6 | Legal hold | Later | Freeze deletion for a matter, with a reason and who placed it |
| G16.7 | AI rules by region | Later | Records that regional AI laws ask for (transparency notices, risk records, human oversight), filled from the ledger and the audit log |
| G16.8 | Auditor access | Later | A read-only person who sees the audit log, ledger and controls, nothing else |

Copy: `This page is what OrgCraft enforces, not a promise. Each line links to the setting or check that enforces it.`

Needs from the architecture: an append-only audit store with signing, retention per data kind, region pinning, a controls registry, and legal holds that override retention.

#### Area 17. Security and people's access

| ID | Screen | Phase | What it shows |
|---|---|---|---|
| G17.1 | People and roles | Now (invite-only) / Next | Owner, admin, department head, editor, viewer, auditor, each with a plain list of what they can do |
| G17.2 | Sign-in | Now (GitHub, passkeys) / Later (SSO with SAML and OIDC, SCIM) | |
| G17.3 | Devices and sessions | Next | Each device, its last use, and **Sign out** |
| G17.4 | Security events | Next | Failed sign-ins, refused tool calls, signature failures, unusual spending |
| G17.5 | Incident view | Now (Stop everything, works without the code host) / Later (incident report) | **Stop everything** (one button with a passkey), what ran in the last hour, which keys to rotate, and a report |
| G17.6 | Teammate isolation | Now | Each teammate's sandbox, network reach, and what it can touch (from the runner, read-only) |

Copy: `Stop everything: all tasks pause, no tool calls run, and triggers queue. Nothing is deleted. Resume when you're ready.`

Needs from the architecture: roles for people (exists, partly: #50, #59), SSO and SCIM (Later), a sessions table, a security event stream, and a global kill switch.

#### Area 18. Long-term memory

| ID | Screen | Phase | What it shows |
|---|---|---|---|
| G18.1 | Decisions | Next | Every owner decision (from the ledger), ADR-style decision, and meeting decision, searchable, with links to its source |
| G18.2 | "This touches an old decision" | Next | When a task or publish touches something decided before, a card appears: "On 6 Nov you decided {X}. This change goes against it. Keep, or update the decision?" |
| G18.3 | Team memory per teammate | Next | What each teammate remembers, with edit and forget. Forgetting is logged |
| G18.4 | Search everything | Next | Tasks, chat, minutes, decisions and documents in one place |
| G18.5 | Mailboxes between teams | Next | Mailboxes between teams, or between two companies' teams, built in. Moving one needs both sides to agree |
| G18.6 | Decade: institutional memory | Decade | Ten years of decisions, with "why did we do this?" answered from sources, and an onboarding brief generated for any new person or teammate |

Copy: `{teammate} remembers this because {source}. Forget it?`

Needs from the architecture: a decision store with links, a semantic index over the team's data (per tenant, deletable), memory per teammate with edit and forget, and a mailbox as a first-class object.

### OPERATE

#### Area 19. Deployments

| ID | Screen | Phase | What it shows |
|---|---|---|---|
| O19.1 | Where it runs | Now | Local, hosted, or self-hosted, with health |
| O19.2 | Runners | Now (one) / Later (many, in the customer's own cloud) | Each runner's location, capacity, version and health |
| O19.3 | Upgrade OrgCraft itself | Next | "OrgCraft 1.4 is available. What changes for your team: {list}." Upgrades use the same change safety as a publish |
| O19.4 | Hybrid | Later | Control plane hosted, runs and data in the customer's cloud |
| O19.5 | Status page | Next | Ours, public. Theirs, for self-hosted |

Needs from the architecture: ADR 0005, runner registration, upgrade checks (checkUpgrade exists), and the hybrid data plane.

#### Area 20. Notifications and channels

| ID | Screen | Phase | What it shows |
|---|---|---|---|
| O20.1 | Channels | Now (email, Slack) / Later (Teams, SMS, push, WhatsApp) | |
| O20.2 | Rules | Now | Which events go to which channel, per person |
| O20.3 | Digest settings | Now | Time, what it contains, and quiet hours |
| O20.4 | Delivery log | Now | Every notification and whether it arrived |

Needs from the architecture: notifications (#101, #110) plus new channel adapters.

#### Area 21. Mobile

| ID | Screen | Phase | What it shows |
|---|---|---|---|
| O21.1 | Phone control room (web) | Now | Home, Work, Approvals, Chat, More |
| O21.2 | Native apps | Later (ADR 0006) | Push, Face ID approvals, a lock-screen summary with no details until unlocked, widgets and Live Activities |
| O21.3 | Pause and stop | Now | One tap, no passkey. Resume needs a passkey (S2-40) |
| O21.4 | Watch | Decade | Approve a lettered ask from a watch, for low-risk cards only |

#### Area 22. Several teams and several companies

| ID | Screen | Phase | What it shows |
|---|---|---|---|
| O22.1 | Organization switcher | Next | One owner, several companies, each kept separate |
| O22.2 | Agency mode | Later | An agency runs teams for clients. The client sees their team, and the agency sees all of them. Billing per client. Hand the team over to the client |
| O22.3 | Teams that talk | Next | Mailboxes between teams (area 18), with "who may send to whom" |
| O22.4 | Shared roles and packs in an organization | Next | One catalog for all of a company's teams |
| O22.5 | Decade: a federation of companies | Decade | Two companies' teams work together under a contract: a supplier's team takes orders from a store's team, with both owners' rules applied |

Needs from the architecture: organization → teams (tenancy exists), cross-tenant client access for agencies, mailbox permissions, and federation with signed messages between deployments (Decade).

#### Area 23. Reports

| ID | Screen | Phase | What it shows |
|---|---|---|---|
| O23.1 | Weekly report | Next | In the team lead's voice: what shipped, cost per task, approval wait, where the team got stuck, lessons, next week |
| O23.2 | Role report card | Next | Per teammate: tasks, pass rate on checks, cost, rework, review findings |
| O23.3 | Export and share | Next | PDF, email, a link |
| O23.4 | Benchmarks | Later | "Teams like yours resolve tickets 20 % faster", only with consent and from aggregated data |

#### Area 24. Help and onboarding

| ID | Screen | Phase | What it shows |
|---|---|---|---|
| O24.1 | First-run guide | Now | Pick a template, connect one system, add a trigger, ask the team's lead for something, see it in Work |
| O24.2 | The two-minute video | Now | On Home until watched |
| O24.3 | In-product tips | Next | One tip per screen, dismissible |
| O24.4 | The 13-step demo mode | Now | A presenter mode with a sample team and real runs. Merged with R36.3: **Reset the demo** is Now, the "last walked on" badge is Next |
| O24.5 | Help center and ask-a-question | Next | Docs search, plus "Ask OrgCraft" (a support teammate of ours) |

### 2.5 Areas the brief didn't list (CPO additions, for the gap review to confirm)

| # | Area | Phase | Screens |
|---|---|---|---|
| 25 | **Teammates that talk to your customers** | Next / Later | A chat widget for the customer's website, an email reply-as-the-business, and phone answering later. A disclosure line (`You're talking with an AI assistant for {business}.`), handover to a person, and a transcript in Work |
| 26 | **Quality and evaluations, team level** | Next | Team evaluation sets on whole tasks, not single roles (prd G4), with "this team vs one agent" |
| 27 | **Portability and the developer platform** | Now (CLI, files) / Next (API, SDK) | Export the whole team, API keys for people (never for teammates), webhooks out, CLI parity, and run the same team in another runtime |
| 28 | **Account and plans (our own billing)** | Later | Plans, seats for people, usage, invoices, upgrade and downgrade, cancel (keep your files) |
| 29 | **End-customer data rights** | Later | Find and delete everything about one person (an email or customer id) across tasks, memory and step details, with a receipt |
| 30 | **Accessibility and languages** | Next | Interface languages, right-to-left, high contrast, screen-reader checks. Each teammate answers in the language its brief sets |
| 31 | **Incidents and on-call for the team itself** | Next | When a system breaks or a teammate keeps failing: an incident card, who is on call (a person), status updates, a post-incident report written by the team's lead |
| 32 | **Sandbox and practice mode, team level** | Next | Practice mode for the whole team (all systems on sample data) for demos, training and the usability test |
| 33 | **Search and command palette** | Next | `/` or ⌘K: go to any screen, teammate, task or setting, or run an action |
| 34 | **Trust centre (public)** | Later | Our own security and compliance page, for buyers |

### 2.6 Added from the gap review (all 12 roles, merged in gap-review.md)

Every item below is either a new screen (with an ID for the mockup) or a change to a screen above. Items that only matter to how we build are left in gap-review.md and architecture.md, and aren't repeated here. Each line names the role that raised it.

#### New screens

| ID | Screen | Phase | What it shows | From |
|---|---|---|---|---|
| R35.1 | **Review queue** | Next | Work waiting for a person to review: filters for role, risk and age. Diff and document views, inline comments that wake the author, "Request changes", and random spot checks | code-reviewer |
| R35.2 | **Finding detail** (in the run inspector) | Now (detail) / Next (holds) | Where the finding is, the failure scenario, severity, fix, and its state (open, fixed, verified, won't fix with a reason). Blocking findings hold the approval card, and the card says which one | code-reviewer |
| R36.1 | **Checks and evidence** | Next | A sign-off with its evidence inline, a map from each acceptance criterion to the step that proved it ("not checked" is never "passed"), run history with flaky markers, compare two check runs, and the coverage map | qa-web |
| R36.2 | **Ready to try checklist** | Next | The card carries the steps to try, each with **Works** / **Problem**. A problem becomes a bug with the person's screenshot | qa-web |
| R36.3 | **Practice run / Demo mode** | Next | The whole team on scripted, sample systems, with no spend and no real data. **Reset the demo**. A badge reads "This demo was last walked on version X, all 13 steps pass" | qa-web, architect (B5) |
| O37.1 | **Where OrgCraft runs** | Now (tiles for local and self-hosted) / Next (hosted, hybrid) / Later (dedicated, sovereign, **Move**) | The modes side by side (local, self-hosted, hosted, hybrid, dedicated, sovereign), the current one marked, the region, and **Move** (local → hosted, hosted → self-hosted as the exit path) with a dry-run diff | infra |
| O37.2 | **Runner fleet** | Next | Each runner: where it runs, version, health, capacity, what it's busy with, which models it can reach. Drain, retire, rotate key, assign to departments | CTO, infra |
| O37.3 | **Topology and health** | Next | Control plane, database, runners, Studio and edge as a diagram, each green, degraded or down. Third-party status in words ("GitHub is limiting us; pushes are queued") | CTO, infra |
| O37.4 | **Backups and restore** | Next | Schedule, retention, "Last restore tested: 12 days ago ✓", restore to a point in time (owner + passkey), and a code-host mirror with "Repoint to a new host" | infra, CTO, kit-core-dev |
| O37.5 | **Secrets and keys inventory** | Next | Every secret by name, never by value: who can use it, last rotated, expiry, **Rotate now**, the master-key escrow check | infra, security |
| O37.6 | **Incidents and on-call** | Later | Declare an incident, who's on call (a person), updates in the team lead's voice, the post-incident report filed to memory. The infra teammate triages first | infra, security |
| O37.7 | **Cost of running** | Next | Hosting cost per part (separate from model spend), the forecast, and the biggest saving ("Your runner idles 20 hours a day: scale to zero between runs") | infra |
| O37.8 | **Outage mode** | Now / Next / Later | **Now:** a banner and a page, writes paused, everything readable: `{code host} can't be reached. Publishing waits until it's back. Nothing already published is affected, and nothing is lost.` **Next:** publishes wait in a paced queue (ADR 0012). **Later:** one-click move to a new account, with a dry run listing the connections to sign in again | kit-core-dev, infra, architect A3 |
| O37.9 | **Setup wizard** | Next | Replaces the 13-step owner checklist: create accounts or paste tokens, generate keys in the browser, check every name, first deploy, then the smoke test's green ticks | infra |
| G38.1 | **What AI teammates can never do** (expands G16.2) | Now | The 12 lines from the security review, each linked to the code that enforces it, next to **What a person must do** | security |
| G38.2 | **Threat model** | Next | The security review's table of threats, readable by a buyer, linked from Security | security |
| G38.3 | **Permission matrix** | Next | Actions by people's roles: yes, no, or yes with passkey. Generated from the server, so it can't drift | security |
| G38.4 | **Kill switches** | Now (pause, stop) / Next | One screen: pause all, stop all, **pause outbound writes only** (reading goes on), revoke runner keys, revoke linked sites, read-only organization. Each needs a passkey and is audited | security, infra, ai-engineer |
| G38.5 | **Capability card** on every teammate | Next | "Can reach…", "Can never…", model and its provider's data policy, budget, who it hands to. Taint marker after reading outside text | security, ai-engineer |
| G38.6 | **Data requests** | Later | Export or erase everything about one person across tasks, memory, minutes and step details, with a receipt | security, CPO |
| G38.7 | **Subprocessors and terms** | Next | Hosting, database, model providers, email, Slack, with change notices. DPA acceptance per organization | security |
| G38.8 | **Security settings** | Next | Per organization: session length, passkey required for everyone, allowed sign-in methods, IP allowlist (enterprise), export limits | security |
| G38.9 | **Recover this organization** | Next | Two recovery owners, several sign-in methods per person, and the break-glass flow with its audit row | backend-dev, architect (B15) |
| D39.1 | **Developer platform** | Next | API reference, scoped tokens for people (never for teammates), webhooks out with a delivery log and replay, SDKs, CLI, the team schema at a stable URL | CTO, backend-dev, architect |
| D39.2 | **Event browser** | Next | Filter the log by team, actor (person, teammate, site, system), kind and time, then export | backend-dev |
| D39.3 | **Versions** | Next | One row per thing installed (OrgCraft, each pack, each connector, the runner image, the phone app): pinned to what, behind by how much, channel (Stable, Early access, LTS) | release-manager |
| D39.4 | **What's new** | Next | A card after each upgrade, in plain words, each item marked "affects your team" or not, in the industry's own words | release-manager |
| D39.5 | **Fleet versions** (agencies, several teams) | Next | Every team's version, channel, how far behind, last upgrade. Staged waves with a canary team | release-manager |
| D39.6 | **Team format upgrade** | Next | "Your team file is on format v1; v2 adds X. Upgrade?" with a preview | kit-core-dev |
| D39.7 | **Import report** | Next | What came across, what had no match (kept word for word), what we guessed. No silent drops. **Export** to other formats too | kit-core-dev |
| A40.1 | **Memory viewer** (expands G18.3) | Next | Typed items (facts, decisions, preferences, open threads), each with its source, confidence, last used, scope (teammate, department, team, company) and **Forget** | ai-engineer |
| A40.2 | **Role-by-model table** (expands B3.5) | Next | Quality from real work (approval rate, rework, findings) and cost per model, with suggestions: "About −$40 a week, −2% on checks. Try it on 10% of tasks?" | ai-engineer |
| A40.3 | **Who woke whom** (expands R9.2) | Next | The causal tree across teammates, with delegation details on each handoff: inputs, expected output, deadline, budget, and accept / decline / counter | ai-engineer |
| A40.4 | **A question mid-step** | Next | A step pauses for one question ("which of these two suppliers?") and carries on with the same context. Answerable from the phone | ai-engineer |
| W41.1 | **Flow lens** (the third canvas view) | Next | How work actually moved last week: edges weighted by handoff count, so bottlenecks are visible | web-dev |
| W41.2 | **Draft diff** before Publish | Now | Before and after charts side by side, changes highlighted | web-dev |
| W41.3 | **Embed** | Next | Embed only the approvals inbox, or only the board. "Check my embed" for blocked pages | web-dev |
| W41.4 | **White-label** | Later | Logo, name, colours, domain, email sender, "Powered by OrgCraft" switch, with a contrast check | web-dev |
| O42.1 | **Operator console** (hosted, ours only) | Later | Tenants, regions, abuse, billing and support access that is logged, time-limited and agreed to by the customer | architect |

#### Changes to screens above

- **B1.1 Org chart:** a **"Where work lands"** choice for each department: a code host, or a documents, CRM or tickets space (CTO). Undo and redo on every edit (web-dev). A keyboard path for every drag (web-dev). An org health score from validate (kit-core-dev). Who may change each department (kit-core-dev).
- **B1.3 Teammate inspector:** the capability card (G38.5), and a sender identity for teammates that email or post as the business, with the disclosure line (architect).
- **B2.1 Wiring view:** wires that cross a trust boundary (outside email, an incoming webhook, a community connector) are drawn differently (security). A sandbox line per teammate: network, CPU, time (CTO).
- **B3.3 Model picker:** a capability gate ("This role needs tools; this model has none"), the provider's data terms, a pinned version, a fallback, and a cheaper model for simple steps (CTO, ai-engineer).
- **B3.4 Evaluation sets:** graders (checks, a rubric, a person, side by side), their own budget cap, red-team sets for roles that read outside text, and drift checks (ai-engineer, security).
- **B4.x Packs:** a version, author, licence, minimum OrgCraft version and changelog. Packs combine, and conflicts are shown. Signed community packs. "What it can run" before install (kit-core-dev, security, release-manager).
- **B5.1 Publish:** a one-line promise that the team stays plain files in your own storage. A "Try this change on last week's work" practice run (kit-core-dev). Weakening review shows up in the impact view (code-reviewer).
- **B5.3 Rollback:** a plain list of what rollback can't undo (messages sent, money moved, data changed), shown before, not after (release-manager).
- **C6.2 Connector detail:** an Act policy per connection: always ask, ask above an amount, or never (backend-dev). Proof of ownership with "the person who proved this has left" (backend-dev).
- **C7.1 Credentials:** OAuth scopes listed, with "scopes beyond what roles use" (security). Leak alert: "This secret appeared in a log", with revoke and rotate in one tap (security).
- **C8.x Triggers:** a trigger inbox per team with a dead-letter list and replay, a spend cap per trigger, "next 5 runs" for schedules across daylight-saving changes, and "Anyone can trigger this" on public forms (backend-dev, security).
- **R9.x Work:** each step's trace shows which memories and documents it used (ai-engineer). "Reported at" and "received at" when they differ (backend-dev). Stuck detection raises a card instead of spending (ai-engineer).
- **R11.x Approvals:** a **Checks** row on every card (`Checks: 3 of 3 passed`) and a logged override with the person's reason (code-reviewer). Standing rules have limits they can never cover (security). After a teammate read outside text, its next outward act needs a person, not a standing rule (security, ai-engineer).
- **G15.x Budget:** two ledgers kept apart (model spend vs the OrgCraft plan), the cap tree with "why did this stop", a currency per company (backend-dev).
- **G17.1 People:** department head, approver-only, billing-only, auditor (backend-dev, security, architect B3). Agents never appear in the people table (security).
- **O19.x Deployments:** release channels, scheduled upgrades in a maintenance window, preflight checks, signed releases with a parts list (release-manager, infra).
- **O21.x Phone:** an installable web app with push before the native apps; answers queued offline ("not sent yet"), never for passkey approvals (web-dev).
- **O24.x Help:** sign-in with Google, Microsoft or an email link, so a non-engineer never needs a GitHub account (backend-dev). A start with no repository at all (CPO, needs an architecture decision against ADR 0001).

#### Not doing, and why

- **Hosting or embedding n8n.** Its licence forbids it (n8n study). We connect to the owner's own n8n instead.
- **A general workflow engine.** Fixed flows (C6.8) stay a tool a role calls (prd non-goals).
- **Tuning models on customer data by default.** Only with explicit consent, only from approved work, evaluated first (ai-engineer), and Decade at the earliest.
- **Badges we don't have.** Compliance screens show "Not yet certified" until it's true (security).

### 2.7 Review 2 changes (draft 3)

The owner asked at 07:12 UTC for "another full review of our design, architecture, ui/ux, feature set". Every role's review is in review-2/. This section lists what changed in the vision because of it. Mechanism-only findings (ids, indexes, leases, journals) live in architecture.md, and the architect owns them. Rejected findings and the reasons are at the end.

#### Phase calendar (release-manager, architect)

| Screen or feature | Was | Now tagged | Why |
|---|---|---|---|
| F1–F4 foundations and the screens on them | Next in architecture | **Now** | They are in the 6-month plan; one calendar |
| Work and the task timeline (N1 core: list, branch graph, step detail) | mixed | **Now** | Specced in N1 and ADR 0009, on F1–F4 |
| Replay, compare, explain (R9.x) | Now | **Next** | Replay re-runs the task from its root as a trial: `Available for {n} days after the task` (W5) |
| Try a role | Now | **Next** | Needs trial runs (B5) (W2) |
| Standing rules written by the owner, delegation, out of office | Now | **Next** | Waits for the policy floor F5 (W3, AI-9) |
| A simple per-period limit on every amount rule | Decade (R11.8) | **Now** | Without it every amount rule can be split (AI-9) |
| "What AI teammates can never do" (G38.1, with G16.2 merged in) | Next | **Now**, written by hand "as of version X"; generated from the policy in Next | (W4, release-manager) |
| By stage, quiet hours | Now | **Next** | (W6, W7) |
| "This touches an old decision" | Now | **Next** for publishes, **Later** for tasks | (W8, AI-18) |
| People on the chart, department view, department head | Next | **Next, after scoped grants (B3)** | They can't ship before B3 (A4) |
| Move between modes, hosted restore per organization | Now / Next | **Next** (needs B12), one-click repoint **Later** | (W9, A5, infra 9) |
| Taint tracking | Next | **Now in the runner**; the `Read outside text` marker on screen is Next | release-manager |
| Spend leases, so a cut-off runner can't overspend | — | **Next**, with F10 | (CTO R4) |
| Kill switches and Stop everything | Later | **Now**, as control-plane state that never waits on Git | (CTO R2, code-reviewer A14) |
| Community tier for connectors and packs | Later | **Next** | release-manager |
| Go back to the previous version | Next | **Now** | release-manager C3 |
| Recovery owners and a non-code-host sign-in | Later | **Now** | rule 11 minimum (C1, C9) |
| A tested restore | Later | **Before the first hosted customer** | release-manager C2, infra 5 |
| Data requests (operator erase), DPA and subprocessors as documents | Next | **Now** | release-manager C6, C7 |
| B3.2, G18.x extras, A40.1, O22.1/3/4 | Next | **Later**, or split Next / Later per row | release-manager |

Every change line in §2.6 now carries a tag; web-dev shows the tag on the mockup's dashed note.

#### New or changed screens and copy

- **Approval cards (R11.1, AI-5, architect A2).** The card's **effect line is written by the server from the actual pending action**: `Sends to 1,240 addresses · from support@ · in Email`. The teammate's own words show only under **Why**. Approving binds to that exact action; if it changes, a new card is raised (`This changed since you were asked. Look again.`). A card holds at most 5 asks. **Do it** lists what it covers (`Do it: covers A and B. C is yours to decide.`), and each irreversible item is listed again on the passkey prompt. In an embedded inbox, `Approving opens OrgCraft to confirm with your passkey.`
- **Declines stick (AI-10).** A new ask for the same thing shows `You declined this on {date}. What changed: {reason}.` Asking someone else after a decline goes to the person who declined.
- **Relayed approvals (AI-8).** A teammate that passes on your words must point to your message. The ledger shows the server's copy: `Your words, from Chat, 09:12`. A quote without one shows `Not verified: no message from you matches this.`
- **Who sets the size of a job (AI-7).** The manager or the trigger sets kind and size, not the builder. Shown on the task: `Sized by Support lead: small fix`.
- **Standing rule editor (AI-9).** The owner writes the rule in words, then confirms the structured form: `Refunds · up to $20 each · at most $60 per customer per week · Payments`. Only the confirmed form is in force.
- **Delegation ends at people (AI-14).** The delegate picker lists people only, with no re-delegation.
- **Memory (G18, AI-16, AI-17, AI-20, AI-21).** Every memory item shows where it came from and **who decided it**: `Decided by you` or `by {person}` bind the team; `by {lead role}` and `in a meeting` are shown as context only. Items learned from outside text carry `From outside`. Memory never crosses a team or a client. Forgetting leaves `Forgotten by {person} on {date}` in the log, never the content.
- **Backup model (B3.3, AI-22).** The list only offers models that passed this role's checks and meet the team's data rules. If none qualifies: `Waiting on {provider}. No backup model passed this role's checks.` Each switch shows on the step, and the sign-off names the model used.
- **"Unverified: none" (AI-1, AI-2).** A sign-off that claims nothing is unverified links its evidence (a check run, a screenshot, a document version). An honest partial sign-off can ship when each open item has an owner and a date.
- **Re-checks (AI-3).** After 3 rounds between the same two teammates, the work goes to their manager: `Support lead and Writer disagree after 3 rounds. Your call.`
- **Reply effect (A1).** The step badge **Replies** sits next to Sends. The customer conversation view (area 25) shows the disclosure line and every reply.
- **Live overrides on Publish (CTO R2).** Anything paused, stopped or capped outside a publish appears on the next publish's diff: `Live change: Support agent 2 switched off at 14:02 by you. Keep it?`
- **Restore (A5, infra 5–6, CTO R5).** `Restore your organization to {time}. We prepare a copy first and show what changes before anything is replaced.` Below it, the outside world: `Emails sent and payments made after {time} still happened. We match them up before the team starts again.` O37.4 shows one row per store (database, files, keys, directory) with how much could be lost, how long a restore takes, and the last drill. Erasures made since the backup are applied again: `Erasures re-applied ✓`.
- **Secrets inventory (O37.5, infra 8, 12).** Each secret shows `Both valid until {time}` during a rotation, and a list of vendor accounts with `Second admin ✓ / ✗`.
- **Status and alerts (O19.5, O37.3, O37.6, infra 11).** The status page notes `Hosted separately from OrgCraft`. On-call shows `Last alert delivered at {time}`, from a daily heartbeat.
- **Versions (D39.3, infra 7, CTO R13).** Upgrades show the path (`From your version, go via 1.9`) and the supported window (the current release and the two before it).
- **Templates and packs (B4.x, K6).** A team built from a pack remembers which pack and version. **Make it my own** detaches it. A pack upgrade shows a merge with your edits, like any publish.
- **Import and export (D39.7, K7, K9, K10).** Import says whether ids are kept or new. After a move, the report lists `After the move: sign in again to Email, Payments; new webhook addresses for 2 triggers`. Every export to another format includes a list of what it couldn't carry.
- **Exports scrub people (K8).** Community packs and exports list personal data found before you share them.
- **Trigger fan-out (CTO R7).** One cause can wake at most 50 tasks by default; more is held and shown: `Held 120 wake-ups from one cause. Release them?`
- **Budget day (CTO R14).** The budget day follows the team's time zone; invoices use UTC, and the budget screen labels both clocks.
- **Bring your own code-host app and model key (CTO R1).** Supported on every plan. Whether it is required for business plans goes to the owner with pricing (decision 6).
- **Control plane unreachable (code-reviewer C1).** One shared banner on every live screen: `Can't reach your team right now · last update {time} · Retry`, plus what still works: everything is readable, and approvals wait, never lost.
- **View as (code-reviewer D1).** The mockup's review banner gains a **View as** switch: Owner, Admin, Department head, Auditor, Client (agency). Each screen hides or disables what that person can't do and says why.
- **"How" on the never page (code-reviewer D2).** Each line names what enforces it: the runner, the server or a checker. A rule only a prompt enforces can't appear on that page.

#### One demo story (code-reviewer A1–A15)

Every screen tells the same moment of the same sample day. Web-dev keeps one roster and one event list in the mockup and derives every count, state, date and report total from them. The fixes that matter most: approval A is pending everywhere (or approved everywhere), its refund is over the standing rule's limit, Work and the Board show one state per task, a stale sign-off disables Approve (`Waiting for Knowledge base writer to re-check version 2`), and the checks shown on a version match its data. One version scheme: OrgCraft 0.22, not "1.4".

#### Rejected or changed, and why

| Finding | Decision | Why |
|---|---|---|
| Release-manager: N1 screens Now; architect W1: N1 Next | **Split.** N1 core is Now; replay, compare and explain are Next | The core sits on F1–F4, now Now. The extras need trial runs |
| CTO R1(b): bring-your-own required on paid tiers by default | **Not decided here** | Pricing and onboarding are the owner's (decision 6). Recommendation for the owner: shared for free and the first paid tier, required for business and enterprise |
| Code-reviewer B6: templates always show a chief of staff, "it is in every team" | **Rejected** | Rule 7 and the glossary: a team may have no chief of staff. Templates show their lead, whatever its role |
| Code-reviewer B2: give AI teammates and people different naming schemes | **Changed** | Names stay the owner's choice. People and AI teammates are marked differently on every screen (an avatar ring and the word "person" on hover), not only on the chart |
| AI-9: bring R11.8 risk budgets forward | **In part** | Only a simple per-period counter moves to Now. Full risk budgets stay Decade |
| Infra 1: drop "queued" from Outage copy | **Accepted, reworded** | Now copy says nothing goes out until the code host is back; "queued" returns in Next with the paced queue |
| AI-12, AI-24, AI-25, D-series mechanism findings | **Not in the vision** | Runner and server behaviour with no screen; the architect and backend-dev own them |

### 2.8 Addendum: security-reviewer and qa-web (review 2)

Added 2026-11-09 15:20 UTC. Sources: review-2/security-reviewer.md and review-2/qa-web.md. All four security Blocks are accepted. The mockup strings are in mockup-copy-review.md.

#### Security (accepted)

- **Verified customers (S2-01), area 25.** Each customer conversation gets an identity from the server: a token the business's own site signs, a verified email reply, or a one-time code. Tools that look up one customer take that id from the conversation, never from the teammate. A new memory scope, **this customer**, is never recalled into another customer's conversation and is erased with G38.6. Each transcript shows `Verified as {customer}` or `Not verified: answers general questions only`. Phase: with area 25 (Next).
- **No teammate widens its own access (S2-09).** B1.11, B2.5, B3.7, C8.6, G14.5, A40.2 and R11.8 all show a server-computed **Widens access** block above any proposal (systems and effects gained, standing rules added, caps raised, reviewers or checks removed, model changed), with `{teammate}'s reasoning` below it. A teammate can never propose a change to its own access, reviewer or cap. Anything that widens access needs a passkey and a ledger row. A partial rollout is a publish. Phase: Now as a rule, and each screen gets it when it's built.
- **What you see is what you sign (S2-12).** This confirms §2.7's approval-card change: the facts are fixed fields from the pending call (system, action, effect, amount, recipient, `First time sending here`), and the passkey signs a hash of the exact calls. Swipe and watch can approve only cards the **server** classes as low risk (S2-46, written once in G38.3).
- **Who approves is passkey-protected (S2-23).** Delegation, out of office, approval and security notification routing, recovery owners, sign-in methods, adding an owner or admin, and security settings all need a fresh passkey. Changes that widen access wait 24 hours and are announced on every existing channel with **Undo**: `Starts {time}. We've told you on every channel.` A delegate accepts with their own passkey. Phase: Now for what exists (notifications, sign-in), and with each screen after that.
- **Stop is cheap, resume is expensive (S2-40).** Stop everything and Pause take one tap. Resume needs a passkey and records who resumed. Freeze never blocks Stop (S2-39). Pause outbound only also holds sends that were already approved (S2-41).
- **The never page** (G38.1) gains `Ask for more access for themselves`, `Treat your answer to a question as an approval` and `Use a customer's identity they were told, in place of the verified one` (S2-48). Each line still names what enforces it.
- **Weakens items with a screen consequence**, each added to its row when that screen is built:
  - S2-02 and S2-15: the outside-text marker follows the data, including into memory;
  - S2-04: sender filters say `Unverified sender` when the sender can't be proven;
  - S2-05: a public form or push trigger gets its own slice of the daily cap;
  - S2-10: compiled standing rules (already in §2.7);
  - S2-11: an answer mid-step is never an approval;
  - S2-18: separation of duties needs one person, not two teammates checking each other;
  - S2-19: rollback never restores access that was removed on purpose, and says so on the diff;
  - S2-24: a pack can't install standing rules or Act;
  - S2-27: bulk export needs a passkey and is announced;
  - S2-29: offboarding removes a person's reach everywhere;
  - S2-31 and S2-32: embedded and white-label approvals open OrgCraft's own address, and approvals always name the organization;
  - S2-36: changing a model or endpoint counts as changing where the data goes, so it is a capability change;
  - S2-37: the audit log is out of reach of the people it records;
  - S2-38: calendar, notification and share links can be revoked;
  - S2-42 to S2-47 are polish, and go in with their screens.
- **Mechanism-only** (no screen): S2-03, S2-06 to S2-08, S2-13, S2-14, S2-16, S2-17, S2-20 to S2-22, S2-25, S2-26, S2-28, S2-30, S2-33 to S2-35. These go to the architect and the build PRs, and security-reviewer checks each one there.

#### qa-web (accepted)

- **The demo team is the template's team (R2-N1, Q2).** "Use this template" opens the full product org from prd §4 (CTO and CPO with their reports), not the six-role sample. This is the demo's acceptance test, so it is Now.
- **Checks before you publish (Q3, R2-N3).** One check list feeds both "Areas and checks" and the Publish sheet. It includes the structure checks: a teammate with no manager, a loop in "reports to", and an area nobody owns.
- **Role editor (Q4).** Every field shows `Kit default` or `Your change`, with **Reset to default**, and the role shows its model tier.
- **The first Live version (Q7) and the demo's order (Q8).** Versions shows the moment a team first goes Live, as version 1. The order is decision, then publish, then Ready to try, never the reverse.
- **Sign-off evidence (Q9).** A sign-off step shows its evidence (screenshots in both themes, check runs) and the version it covers on the card itself.
- **Each screen has its own address (Q13).** Opening a task changes the address, so reloading or sharing a link keeps it.
- **Only this team's systems and triggers (Q11, Q12).** The palette shows the team's own systems, then `Browse all connections…`. A code-host trigger shows only when a code host is connected.
- **No engineering words (Q15).** Inputs shown as "Readable" are a table, never raw JSON.
- **Accessibility is a promise (Q19–Q24, my gap item 7).** Every screen keeps 44 px touch targets on phones, announces live changes (`aria-live`), behaves as a dialog where it is one (focus returns to its opener), has a skip link, passes contrast in both themes, and keeps heading levels in order. qa-web tests every new screen against this list.

#### Rejected

None. Two are narrowed. S2-23's 24-hour wait applies only to changes that **widen** who can approve; narrowing takes effect at once, as security proposed. S2-09's passkey covers a capability change only, not every proposal a teammate makes.

---

## 3. Build order for the mockup (web-dev)

The order follows the owner's walkthrough: build, connect, run, govern, operate. Screens already in v7 are only extended.

1. **Navigation shell**: seven tabs, the org switcher, ⌘K, phase tags on every screen, the industry switcher (add an agency and a clinic front desk to the existing support desk, store and product team), and the phone bottom bar.
2. **Home** (R13.1): Needs you, New, In progress, cost today, team health, and the first-run guide (O24.1).
3. **Team**: B1.1–B1.9 (departments, people on the chart, vacancies, health check, history slider), then the wiring view B2.1–B2.4, then the catalog of roles with "2 on the team", then the role editor with skills, models and evaluation sets (B3.1–B3.6), then Publish with versions, rollback, schedule, review, policy and freeze (B5.1–B5.8).
4. **Templates and packs**: B4.1–B4.7, with every industry card, community, import and publish your own.
5. **Connections**: catalog, detail, HTTP, code tool, n8n bridge, marketplace, health, fixed flows, computer use (C6.x), credentials C7.x, and triggers with the editor by family (C8.2), every family drawn.
6. **Work**: R9.x, adding replay, compare, explain and what-if.
7. **Chat**: R10.x with a teammate picker, files, voice (Later) and group chat (Later).
8. **Approvals**: R11.x, adding delegation, out of office, the phone inbox, the wait report and risk budgets (Decade).
9. **Meetings**: R12.x.
10. **Board and dashboards**: R13.2–R13.8.
11. **Settings ▸ Governance**: G14.x.
12. **Settings ▸ Budget**: G15.x.
13. **Settings ▸ Compliance**: G16.x.
14. **Settings ▸ People and security**: G17.x.
15. **Memory**: G18.x.
16. **Settings ▸ Deployments, Notifications**: O19.x and O20.x.
17. **Phone**: O21.x (the phone frame toggle on every screen).
18. **Organizations and agency mode**: O22.x.
19. **Reports**: O23.x.
20. **Help**: O24.x.
21. **Additions 25–34, everything in §2.6, and the §2.7 changes** (new screens R35–O42, the changes to existing screens, the shared roster and event list, View as, and the unreachable banner).
22. **A "Decade" walkthrough**: a second strip next to today's six steps, showing an organization ten years on. It has a self-organizing proposal (B1.11), roles that learn (B3.7), triggers from the world (C8.6), what-if (R9.10), risk budgets (R11.8), institutional memory (G18.6) and a federation (O22.5).

The pending items fold in: the wiring view is step 3; the catalog of roles and named teammates is step 3; trigger steps by type are step 5.

Each screen keeps its dashed "what this is" note, which is mockup-only, now with its ID and phase.

---

## 4. Decisions

The chief of staff decided 1, 2, 3, 4 and 7 as recommended on 2026-11-09 06:48 UTC, under the team's autonomy. The owner decided 5, 6 and hosted tiers (8) on 2026-11-09 at 15:33 UTC, all as recommended.

### The list

1. **Words:** "role" for the job in the catalog and "teammate" for a seat. CPO recommendation: yes.
2. **People on the chart** (B1.5) in Next, not Later. CPO recommendation: yes. Agencies and support desks need a person as reviewer early.
3. **Teammates that talk to customers** (area 25) in Next, with a mandatory disclosure line. CPO recommendation: yes, support and store packs depend on it.
4. **Fixed flows** (C6.8) as Later, kept as a tool and never the main model. CPO recommendation: yes. It keeps the n8n decision intact.
5. **A start with no repository** (CPO gap 1): the team kept in OrgCraft's own storage, exportable as files any time, with GitHub optional. It changes ADR 0001 for non-technical customers. **Decided by the owner (A1): yes.** The architect's ADR 0012 draft is the basis.
6. **Pricing on a plan screen** (area 28). **Decided by the owner (B1): placeholder prices** on the plans screen, marked as placeholders. The copy is in mockup-copy-review.md.
7. **Our own marketplace** (C6.6, B4.4) as Later, with a revenue share. Pricing is the owner's call. CPO has no recommendation on the share yet.
8. **Hosted tiers and accounts** (CTO R1(b)). **Decided by the owner (C1):** free and the first paid tier use OrgCraft's shared code-host app and model key, behind the governor, with a spare ready. Business and enterprise bring their own code-host app and model key. Bring-your-own is available on every tier.

---

## 5. What's next for this document

- Draft 2 is done: all 12 roles' gap reviews are merged into gap-review.md and folded in at §2.6.
- Draft 3 is done: review 2 is folded in at §2.7 and in the rows above. Security-reviewer's and qa-web's reviews are folded in at §2.8.
- The architect fills or corrects every "Needs from the architecture" line, with a decade-proof check per area (ADR 0005 §13).
- The chief of staff reads draft 2 before the owner sees the mockup.
