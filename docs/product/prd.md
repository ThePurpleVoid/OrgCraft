# Agent Team Studio: product requirements

Owner: product manager. Status: draft 1, 2026-11-05. Working name: **Agent Team Studio** ("the Studio").

## The owner's words

> I want a tool where people click drag and drop team members into the workflow. Turn them on and off, edit their roles, details what they do, reporting, the full work. Kind of like how game devs use unity for dragging and dropping when building games. Or how you would build a pipeline using a visual tool. [...] How do you link it to projects, backends, databases, front ends, the whole deal. I want to be able to demo to a customer how using this tool how you can visually build your ENTIRE setup and team, hit publish, and then in a chat window speak to your chief of staff and let it run.

> The downfalls and cons you listed in the thread, account for those and build for these gaps.

> Let's be honest, customers of this product would be deploying this system online always, so let's think end game here. Remember I want an architecture that holds up a decade later. (2026-11-06; [ADR 0005](../adr/0005-online-first-built-to-last.md))

> Also keep in mind this is not just for engineering companies. For now our roles will be centered around my own use cases and personal products, but eventually any industry should be able to use this tool. (2026-11-06; [ADR 0005](../adr/0005-online-first-built-to-last.md) §8)

> So right now when you say the Studio do you mean the website? What if I'm on mobile and need to check up on my systems? We will need to eventually have an Android and iPhone app to go along with this in their own repos. (2026-11-06; section 6.10, [ADR 0006](../adr/0006-mobile-apps-native-per-platform.md))

> There should be a way to define custom agents and add new ones that are not predefined. There should be a way for the owner to schedule meetings with select team members, sort of like daily standup, ad hoc meetings. There should be a way to connect emails/communication systems with the owner so if they want to receive emails for certain triggers or team members they can. When making changes to the team structure/details/or any team member actively working on something or in its lane, we need to be sure that the new changes don't break any ongoing work. If something is ongoing there should be explicit UI asking the user how they want to handle the ongoing work. (2026-11-06; sections 6.6 to 6.9)

## 1. Vision

Today Agent Team Kit is a text product: you pick a preset, write `.agent-team/` files, sync, paste the instructions into a Claude project and open threads by hand. It works, and it has run a real product. But only someone who already knows Claude Code projects, worktrees, bash and markdown briefs can set it up.

The Studio makes the team something you **see and build**:

1. **Build.** On a canvas you drag roles from a library onto an org chart. You switch them on and off, draw reporting lines, and edit each role's duties, rules, model tier and tools in an inspector.
2. **Connect.** You add your systems (repositories, backends, databases, frontends and hosting, observability, any MCP server) and drag each one onto the roles that may use it, with a permission (read, write or deploy).
3. **Publish.** One button checks the team, shows the diff, and writes it to your repository as an ordinary `.agent-team/` folder, through a pull request or a local commit. The repository stays the source of truth. You can leave the Studio at any time and keep the team.
4. **Run.** A chat window opens on your chief of staff. You ask for work. The same canvas becomes the live board: roles light up as they start, hand-offs move along the edges, and SIGNOFF evidence (screenshots, logs, preview links) shows on the cards. Anything irreversible stops and asks you.

Positioning, from the comparison work: **the operating manual and control room for a long-running agent team on a real product.** It is not another library of agents and not another swarm SDK. What sets it apart is governance and visibility: one door, one writer per path, separation of duties, evidence-backed sign-off, merge gates, and a board. The Studio makes these visible and easy to edit.

## 2. Personas

| Persona | Who | What they want | What they fear |
| --- | --- | --- | --- |
| **Founder-builder** (primary) | A solo founder or tiny team shipping a real product with Claude, like this kit's first user | A whole company of agents working while they sleep, steered from a phone | Losing control, runaway cost, agents breaking production |
| **Engineering lead** | Runs 3 to 30 engineers and wants agents next to the humans | Agents that follow the team's ownership, review and CI rules | Agents that bypass review or touch code they shouldn't |
| **Agency or consultant** (demo persona) | Sets up delivery teams for clients | To show a client the whole setup in 15 minutes, then hand it over | A setup that only works on their own laptop |
| **Open-source maintainer** | Maintains a busy repository | Triage, docs and release roles that respect the project's process | Noise, and pull requests that look legitimate but are low quality |
| **Any-industry operator** (later) | Runs a marketing agency, a law practice, a support desk, a finance office or a shop | A team of agents that works in their own tools (Drive, CRM, helpdesk, email) with the same governance | A developer tool that assumes Git, code and CI |
| **Platform / AI-enablement team** (later) | Rolls agents out across a company | Standard team templates, policies, audit, SSO | Shadow agents with production credentials |

## 3. Jobs to be done

- When I start a product, I want to lay out the team I need and what each role may touch, so the agents work like an organisation and not like a crowd.
- When I connect my repository and systems, I want each role to get only the access it needs, so a mistake can't reach production.
- When I ask for something, I want one conversation (the chief of staff) and a live picture of who is doing what, so I don't babysit ten threads.
- When the team finishes something, I want proof (a screenshot, a preview link, test logs) before I trust it.
- When I change my mind about the team, I want to change it visually and publish again, and see exactly what changed.
- When the kit's library has no role for what I need, I want to make my own agent in the same editor, so my team is not limited to the presets.
- When I want the team to sync up, I want to call a meeting (a daily standup or an ad hoc one about a problem) with the roles I choose, and get minutes and action items, not a transcript.
- When something needs me, I want to hear about it where I already am (email, Slack), for the triggers and roles I care about, and nothing else.
- When I change the team while it is working, I want to know exactly which work my change touches and decide what happens to it, so no task, branch or hand-off is lost.
- When I'm away from my desk, I want to see from my phone whether my teams are all right, and answer what is waiting for me in seconds, so the team never sits idle waiting for me to get back to a laptop.
- When I evaluate the product, I want evidence that a governed team does better than one agent, so I can justify the cost.

## 4. The customer demo (the end-to-end acceptance test)

This is the script for the demo the owner wants to give. Every story in the backlog says which step it moves forward. Target length: 15 minutes, on a fresh sample repository (a small web app with a backend and a database). The demo uses a **real** repository and real runs, with no canned output. That follows the kit's "no demo data" rule.

| Step | The presenter does | The customer sees | Under the hood |
| --- | --- | --- | --- |
| 1. Start | Opens the team's Studio at its URL (the customer's own deployment, or the hosted app) and signs in with GitHub | An empty workspace with "New team" | OIDC sign-in; the same build runs locally with `npx agent-team studio` for trying it out |
| 2. Template | Picks "Startup product team" | A canvas with the org chart: chief of staff on top, CTO and CPO lanes, builders, QA and reviewers, laid out automatically | A template is a kit preset plus Studio defaults |
| 3. Shape the team | Drags **AI engineer** from the palette under the CTO, switches **mobile dev** off, drags **QA web** to report to the head of quality | Nodes snap in, a switched-off node dims, edges redraw. A warning badge appears and clears: "QA web has no manager" | The team model in the browser, checked live by the same roster rules the CLI uses |
| 4. Edit a role | Clicks **Backend dev**, adds a rule "every migration has a rollback note", changes the tier to deep | Inspector with Identity, Owns, Tools, Wakes on, Hands to, Rules, and a "kit default / your change" indicator per section | An edit to a kit role becomes a `backend-dev.extend.md`, never a fork |
| 5. Connect systems | Opens **Systems**, connects the GitHub repository, a Supabase project (database and backend) and a Vercel project (frontend). Drags the database onto Backend dev (write) and QA web (read), and Vercel onto Release manager (deploy) | System nodes in a side lane, binding edges labelled read, write or deploy, and secrets shown only as names | `resources.json` and `bindings` in the team model; secrets in the Studio's vault or a local `.env`, never in the repository |
| 6. Ownership and gates | Opens **Ownership**: the Studio has read the repository tree and suggests `apps/web/` → web dev and `supabase/` → backend dev. Accepts. Opens **Gates**: suggested from `package.json` | A path-to-role table with unowned paths highlighted, and gate steps with the hardware pool each uses | `ownership.json` and `gates.json`, compiled to `ownership.md` and `config.sh` |
| 7. Publish | Clicks **Publish** | A check summary (0 errors), then a diff of every file that will change in `.agent-team/`, `docs/team/` and `scripts/agent-team/`, then a pull request link. CI runs `sync.sh check` and goes green | Compile the team model → run the pinned kit `sync` → branch → PR. The same files a text-only user would have |
| 8. Merge and go live | Merges the PR (or the Studio does, if allowed) | The team's status changes to **Live v1**, pinned to the merge commit | A published version is a commit SHA, not a database row |
| 9. Talk to the chief of staff | In the chat: "Add a dark mode toggle to the settings page, and make sure it remembers my choice." | The chief of staff answers in seconds: it opened an issue, routed it to the CTO's lane, and lists what happens next. On the canvas the CTO, then web dev and backend dev light up as **working**, and the hand-off edges animate | The runner starts the chief of staff's session. Every role session reports automatically through hooks, so the board never depends on a role remembering to report |
| 10. Watch it run | Clicks **Web dev**, then **QA web** | The live task, branch, PR link, gate output, and QA's SIGNOFF with the screenshot of the toggle in both themes | The same board events the dashboard shows today, now drawn on the editor canvas |
| 11. A decision | The chief of staff asks in the chat: "The setting needs a new column on `profiles`. Approve the migration? I recommend yes: additive and reversible." The presenter taps **Approve** | A decision card with a recommendation; nothing irreversible ran before the tap | The owner-steps-in rule is enforced by the runner as an approval gate |
| 12. Done | The chief of staff posts: "Dark mode is Ready to try", with the preview link | The PR merged with approval, SIGNOFF and a green gate; the digest line; the usage and cost line | Merge gate, separation of duties and evidence: the kit's governance, visible |
| 13. Change the team | Back on the canvas, switches on **Performance tester** and publishes again | A one-file diff (`team.json`) and a second PR | Publishing is cheap and reviewable |

Stretch steps for the team operations features and mobile (sections 6.6 to 6.10), shown after step 12 or in a second demo:

| Step | The presenter does | The customer sees |
| --- | --- | --- |
| 14. Custom agent | Clicks **New agent**, copies QA web, names it "Accessibility auditor", gives it `tests/a11y/` and a sign-off rule | A live brief preview, a path conflict caught and resolved in the editor, the new card on the canvas |
| 15. Meetings | Opens **Meetings**, sets a daily standup for the CTO lane, then in the chat asks for "backend dev and payments engineer on the checkout errors, now" | The schedule with a cost estimate; an ad hoc meeting starts, a busy role joins after its current step, minutes and action items land in the chat |
| 16. Notifications | Adds an email address, verifies it, turns on "approval needed" and "ready to try from web dev", sends a test | The test email, then a real one when the next approval comes up |
| 17. Change while running | Switches off a role that is mid-task, and moves a path a working role has a branch on. Clicks **Publish** | The "your change touches work in progress" step with per-item choices and a recommendation; after merge, the rollout view as each role moves to the new version |
| 18. From the phone | Locks the laptop. The next approval arrives on the presenter's phone as a notification; they open it, check the diff summary, approve with Face ID, then ask the chief of staff a question by voice | The approval on the lock screen with no team details until unlocked, the card, the biometric prompt, the board updating in the Studio on the projector as the work resumes |

Step 18 needs the native apps (phase 4). Until then the same step runs in the phone's browser, with the notification by email.

Stretch steps for a technical audience: export the same team to Claude Code's built-in agent teams and run it in a terminal; open the same team in another runtime (see 6.3); show the evals page comparing this team with a single agent on the same task set.

## 5. Gaps found in the comparison, and how the product closes them

The comparison of the kit with other agent-team projects (README "How this compares") found four weaknesses. The owner asked that the product account for them. Each is a requirement, with a phase in the [delivery plan](delivery-plan.md).

| Gap | Why it matters | Requirement | Phase |
| --- | --- | --- | --- |
| **G1. Reports are manual.** A role that forgets to run `team-status.sh` goes stale on the board | The live canvas (demo step 9) is worthless if it shows stale or missing cards | **R-G1.** Status is captured automatically from Claude Code hooks (session start, tool use, stop, subagent stop, notification) and sent as the same board events. Role-written reports stay, for meaning (HANDOFF, BLOCKED, the task name); hooks supply liveness (started, heartbeat, idle, stopped). The board shows both and flags a gap between them. Runs started by the Studio runner report from the runner itself, so liveness never depends on the agent | Kit 0.4 (in progress in the kit thread), Studio phase 2 |
| **G2. No use of Claude Code's built-in agent teams.** Users who already use the built-in lead/teammates feature get nothing from the kit | Meets users where they are, and gives a zero-infrastructure way to run a published team | **R-G2.** Publish can also generate the built-in agent-teams format next to `.claude/agents/`, from the same resolved roles. The Studio's runner offers three run modes: built-in agent teams (one terminal, zero infrastructure), subagents (one session), and the Studio runner (many long-lived role sessions) | Kit 0.4 (export, in progress in the kit thread), Studio phase 3 (run modes) |
| **G3. Claude Code and bash only.** Windows needs WSL; teams that use other coding agents can't use the kit | Limits who can adopt it; the team definition is useful independent of one runtime | **R-G3.** (a) The kit's scripts get Node equivalents, so the CLI and reports work on Windows without bash or `jq`; the bash scripts stay for existing teams. (b) The team model is runtime-neutral. Compile targets are *adapters*: Claude Code threads (today), Claude Code subagents, built-in agent teams, the Claude Agent SDK runner, and later `AGENTS.md`-style instructions for other coding agents. (c) The governance (ownership, gates, approvals) is enforced by the runner and by CI, not only by prompts, so it holds whatever agent is inside | (a) kit 0.5, (b) Studio phase 1 and phase 5, (c) phase 3 |
| **G4. No users and no evals.** Nothing yet shows that a governed team beats one agent | Customers, and we ourselves, need evidence before paying for many sessions | **R-G4.** (a) An evals harness: a fixed set of tasks on sample repositories, run by one agent, by subagents and by the full team, scored on tests passed, review findings, regressions, owner interventions, wall time and cost. (b) The Studio shows per-run cost, per-role usage and the outcome of every task. (c) Adoption: a 5-minute quickstart, templates for common stacks, a public demo recording, and this repository run by its own team in the open as the reference user | (a) phase 3 onwards, (b) phase 3, (c) every phase |

## 6. Requirements

### 6.1 Editor (build)

- E1. Canvas with three views of one team: **Org** (reporting lines), **Flow** (who hands work to whom, from `Hands to`), **Systems** (resources and bindings). Pan, zoom, auto-layout, minimap, undo and redo.
- E2. Palette of the kit's role library, grouped by lane, with search. "New role" from the template.
- E3. Node actions: add, remove, switch on/off (off means excluded; "dormant" is a third state for business roles), duplicate as a custom role, and drag to change the manager.
- E4. Inspector for every brief field and section. A kit role shows the kit text with your changes on top; you can reset any section to the kit's text.
- E5. Live checks with the kit's own rules: one role reports to the owner, no loops, every manager installed, tiers valid, every path owned by exactly one role, no role writing a generated path, no secrets in text.
- E6. Templates: the kit presets plus stack templates (web + Supabase, web + Postgres + Vercel, native mobile, open-source maintainer).
- E7. Import: open any repository that already has `.agent-team/`, and the canvas shows that team exactly. This round trip is a hard requirement (see architecture §3).

### 6.2 Systems (connect)

- S1. Resource types: repository (GitHub first), backend (Supabase, any HTTP API with OpenAPI), database (Postgres, Supabase), frontend and hosting (Vercel, Netlify, Cloudflare Pages), observability (Sentry), and **any MCP server** as the escape hatch.
- S2. Bindings: role × resource × permission (read, write, deploy). A binding gives the role that resource's tools and environment in a run, and adds it to the role's brief under Tools. Without a binding a role has no access.
- S3. Secrets are entered once, stored encrypted (local: OS keychain or `.env` outside git; hosted: a KMS-backed vault), and appear in the repository only by name.
- S4. Ownership suggestions from the repository tree; gate suggestions from the build files (`package.json`, `Cargo.toml`, `go.mod`, `build.gradle`, `Package.swift`).

### 6.3 Publish

- P1. Publish compiles the team to `.agent-team/` and runs the pinned kit `sync`, so the output equals what the CLI would produce.
- P2. A diff review before anything is written. Publishing goes through a pull request by default, or a direct commit in local mode.
- P3. A published version is the merge commit SHA. Roll back means publishing an earlier version as a new PR.
- P4. Compile targets (adapters), chosen per team: Claude Code threads (project instructions), subagents, built-in agent teams, Studio runner. Later: other agents' instruction formats.

### 6.4 Run and chat

- C1. A chat with the chief of staff. Your messages are stored verbatim with ids (the dilution rule), and the chief of staff quotes them down the tree.
- C2. Decision cards for questions; approval cards for everything on the owner-steps-in list (irreversible data changes, secrets, money, production deploys of destructive migrations, anything outside the team's reach). The runner blocks those actions until approved.
- C3. The live board drawn on the canvas, from hook and role reports, with evidence on the cards.
- C4. Budgets: a cost cap per run and per day, a concurrency cap on role sessions, a pause button and a stop button. When a cap is hit, the order is release-blocking fixes, then QA, then features, then keepers (the kit's rule).
- C5. A daily digest in the chat, in the kit's format.
- C6. Run modes: built-in agent teams, subagents, Studio runner (see G2).

### 6.5 Non-functional

- N1. Online first ([ADR 0005](../adr/0005-online-first-built-to-last.md)): the product is deployed online, in the customer's cloud (one command or a one-click template) or as our hosted service, from the same images. The same build also runs on one laptop with `npx` for trying it and for development, with no feature that works only there.
- N2. No lock-in: everything the team needs is in the repository; the Studio is optional after publish.
- N3. Open source (MIT) for the editor, the runner and the self-hosted server. A hosted service, if we build one, runs the same code.
- N4. Security: least privilege per role, a full audit log of tool calls and approvals, prompt-injection defences on anything read from issues, PRs and web pages (see architecture §8).
- N5. Platforms: macOS, Linux and Windows (native, without WSL) for the Studio and the CLI.
- N6. Built to last a decade: versioned contracts (team files, TeamSpec schema, event envelope, connector manifest over MCP, public API, runner protocol) with migration paths; every vendor behind an interface. See architecture section 13.
- N7. Multi-tenant and multi-user from the first release: organisations, workspaces, members with roles, OIDC sign-in.
- N8. Industry-neutral core: ownership over areas in any connector, checks of any kind, propose and accept, evidence, a policy per pack, and role packs per industry. Engineering (the owner's use today) is the first pack; business packs from the kit's existing roles come next. No core feature may require Git, code or CI from the customer; a team that never touches Git gets a Studio-managed team repository.

### 6.6 Custom agents

The kit already supports project roles (`.agent-team/roles/<slug>.md`, `source: "project"` in the TeamSpec). Today you write that markdown by hand. The Studio makes a custom agent a first-class thing to build. Mockups: [01](mockups/01-new-agent-start.png), [02](mockups/02-custom-agent-editor.png).

- A1. **New agent** in the library, with three starts: blank (the kit's role template), copy a kit role (a new, separate role; the kit role is untouched), or import a file (a role `.md` or a role pack folder another team shared).
- A2. A guided editor with the same sections as every brief: identity, model tier, status (on or dormant), place in the team (group, reports to), work and paths, tools and systems, wakes on, hands to, rules, and sign-off evidence. A live preview shows the exact file publish will write.
- A3. Live checks, the same as for kit roles, plus: the slug is unique and does not shadow a kit role (unless you choose "replace the kit role", which is `project-replaces-kit`); every path has one writer; "hands to" names roles on the team; the evidence list is not empty for a role that signs off; no secrets in text.
- A4. **Path conflicts are resolved in place**, never by allowing two writers. Options: read only (send fixes to the owner as BUG), take a narrower sub-path, or move the path (which goes through the change-safety step in 6.9 if the current owner has work on it).
- A5. Custom groups: a custom agent may use a new group name; the library shows it as its own section with its own colour.
- A6. **Your agents** section in the library: custom roles in this team, and imported ones not yet switched on. Export any custom agent as a role pack (a folder with the `.md` and a `pack.json` listing what it needs: tools, systems, the paths it expects).
- A7. Kit upgrades: if a newer kit adds a role with the same slug as a custom agent, the upgrade check says so and offers to rename yours or switch to the kit's. Your role is never silently replaced.
- A8. **Try it on a task** (with the runner, phase 3): run the agent on one sample task in a throwaway worktree, with no write access outside it and a small cost cap, and see its output and SIGNOFF before adding it.

### 6.7 Meetings

A meeting is a structured conversation the runner holds between chosen roles, run by a facilitator (the chief of staff by default), that ends with minutes, action items and decisions. Mockups: [03](mockups/03-meetings.png), [04](mockups/04-chat-minutes-adhoc.png).

- M1. **Recurring meetings** (daily standup, weekly planning, release readiness, retro) with a schedule in the team's time zone, and **event-triggered meetings** (for example a design review when a PR gets the `design` label).
- M2. **Ad hoc meetings** from the Meetings view or by asking in the chat ("get backend dev and payments engineer on the checkout errors, now"). The chief of staff proposes attendees and an agenda, and starts it.
- M3. Attendees by name, by lane, or by rule ("everyone who worked since the last standup"). Dormant roles are never woken for a meeting unless named. The owner can attend: receive the minutes only, or join and speak.
- M4. Two formats. **Written round**: each attendee answers the agenda once from its board and memory file; cheap, no cross-talk; the default for standups. **Discussion**: attendees read each other and reply, up to N rounds, for planning and trade-offs.
- M5. **Meetings never break running work.** If an attendee is mid-task, the default is that the question waits until its current step ends. Other choices: the facilitator answers for it from its board reports (marked as such in the minutes, no cost), or it is left out.
- M6. Outputs: minutes in the chat; each action item becomes an issue or a HANDOFF to its owner; anything that needs the owner becomes a decision or approval card. Nothing a meeting decides skips the normal gates.
- M7. Cost: an estimate before saving, a per-meeting cap (the meeting ends and writes partial minutes at the cap), and meetings count toward the run and daily budgets. A recurring meeting is skipped when nothing changed since the last one.
- M8. Meeting definitions are part of the team (`.agent-team/meetings.json`), published and reviewed like any change. Minutes are run data, kept by the Studio and in the chat, not committed.

### 6.8 Notifications and owner channels

The owner chooses where the team reaches them and for what. Mockup: [05](mockups/05-notifications.png).

- O1. Channels are **connectors** (architecture section 7), connected the same way on a laptop and online: email first (through the workspace's email provider, or a person's own Gmail or Microsoft 365 account; each address verified by a code) and a webhook, then Slack, then Microsoft Teams, Discord and phone push. Each channel shows its health; a failing channel falls back to the next one and says so.
- O2. Rules: **when** (approval needed, decision waiting, ongoing work needs a choice, ready to try, blocked longer than N minutes, stuck or silent role, gate failed, budget at 80% and 100%, run failed, meeting minutes, daily digest, team version published or rolled out), **about** (anyone, a lane, specific roles), **to** (channels), **how** (at once, batched every N minutes, hourly or daily summary).
- O3. Quiet hours in the owner's time zone; approvals and budget stops can break through, everything else waits for the digest.
- O4. Replies: a reversible decision card can be answered by replying to the email or with Slack buttons. **An approval is never taken from an email reply**: the message links to the Studio, which asks the owner to sign in. Links expire.
- O5. Agents cannot send notifications or add recipients. The Studio sends them from team events, only to verified addresses. A notification never contains secrets, and text from outside the team (issue titles, PR comments) is quoted and shortened.
- O6. A delivery log with status and retries, and "send a test" for each rule.
- O7. Notification settings belong to a person, not to the team: each member's rules and channels are kept by the Studio's control plane, never in the repository.

### 6.9 Changing a team that is working

A published team version is a commit. The runner knows which version every live session started on. A change to the team never takes effect in the middle of someone's work without the owner choosing how. Mockups: [06](mockups/06-canvas-live-edit.png), [07](mockups/07-ongoing-work-dialog.png), [08](mockups/08-applying-change.png).

- X1. **Live status while editing.** When the team is running, the canvas shows each role's live state. A change that touches a working role marks the card and explains in place what is in flight: task, branch, PR, queued hand-offs, pending approvals, locks, scheduled meetings. Editing is a draft; the team keeps running the published version.
- X2. **Impact step in Publish.** Between the checks and the file review, Publish lists every piece of in-flight work the change affects, grouped by role, with a recommended choice for each.
- X3. Choices for a role's current task: **let it finish** (keeps its current version until SIGNOFF, HANDOFF or idle, takes no new work if it is being removed), **hand off now** (push, HANDOFF to a chosen role, stop), **pause** (push, stop, wait for reassignment), **apply now** (push, restart the session on the new version, resume from memory), **stop and drop** (closes the PR; the branch is kept 30 days; typed confirmation). For path moves: **move after the PR merges**, **move now with a one-time exception for the files already changed**, or **move now and hand the files over**.
- X4. Linked items get their own small choices: queued hand-offs (re-route to whom), pending approvals (keep, cancel), held locks (release on stop), meeting invitations (removed automatically), assigned issues (move with the path).
- X5. **Safe changes need no choice.** Wording changes, a new role, a tier change on an idle role, or a rule change apply at each role's next task. They are listed so the owner sees them.
- X6. **Invariants the runner enforces whatever is chosen**: nothing is lost (push and memory write before any stop); every path has exactly one writer at every moment; no hand-off is left addressed to a role that no longer exists; a secret binding is revoked only between tool calls; a pending approval for a removed role is never run by nobody.
- X7. The plan takes effect when the publish PR merges. Work that started between the preview and the merge gets "let it finish". The **rollout view** shows each role moving to the new version and what each is still waiting on; a role still on an old version after 24 hours raises a notification.
- X8. "Apply only when idle" applies the whole change when none of the affected roles has work in progress. "Freeze the team" pauses new work for a large restructure.
- X9. Without the runner (threads mode, or the CLI only) the Studio has no live sessions. It uses board reports and open PRs to warn, says that the data can be stale, and the new briefs take effect when each thread next resumes.
- X10. The same rules apply when the change does not come from the Studio: a commit that edits `.agent-team/` directly (by the owner or by a role like kit core dev) is detected on merge, and the runner raises the same impact card in the chat before it applies.

### 6.10 Mobile apps

The Studio is a web app. People also need to look after their teams from a phone: see what is happening, answer what is waiting for them, talk to the chief of staff, and follow meetings. Building the team stays on a large screen. The decision on how the apps are built is [ADR 0006](../adr/0006-mobile-apps-native-per-platform.md); what the server guarantees every client is the [clients contract](../contracts/clients.md). Mockups: [09](mockups/09-mobile-inbox-approvals.png), [10](mockups/10-mobile-board-chat.png).

**What the apps are for**

- MB1. **Home: all my teams at a glance.** Every team the person can see, across every deployment they have connected (the hosted service, their company's own Studio): live version, run state, how many roles are working, waiting and blocked, today's cost against the cap, and how many things wait for them.
- MB2. **Inbox: what needs me.** Approvals, decisions, ongoing-work choices from a team change (6.9), and channel failures, across all teams, most urgent first. Each is a card with the recommendation, the options and the links (PR, preview, evidence).
- MB3. **Answer from the phone.** Decide a card in one tap. Approve with a biometric check (Face ID, Touch ID, fingerprint), never with a tap alone. Choose what happens to ongoing work (let it finish, hand off, pause) for a published change, using the same choices as the Publish step.
- MB4. **Board as a list.** Roles grouped by lane with their status, current task, PR and how long since they last reported; filters for working, waiting and blocked. A role's page shows its recent reports, hand-offs, evidence (screenshots load as thumbnails first), and the meetings it is in.
- MB5. **Chat with the chief of staff,** with the same verbatim history as the Studio, decision and approval cards inline, dictation through the phone's keyboard, and photos or files attached as evidence links.
- MB6. **Meetings:** today's schedule, minutes and action items, start an ad hoc meeting by asking in the chat, and join a running meeting to read along and speak (text first; voice in phase 5).
- MB7. **Run controls:** pause, resume and stop a run or one role, see the cost line and budget, and the workspace kill switch for admins. Stopping never needs a step-up; it is always safe.
- MB8. **Notifications on the phone** are a channel like email and Slack (6.8): the person's own rules, quiet hours, breakthrough for approvals and budget stops, a test send. The lock screen shows no team content unless the person allows previews.
- MB9. **Every link opens in the right place.** A link in an email, Slack or a notification opens the app if it is installed and the mobile web Studio if not, on the same thing.
- MB10. **Works on a bad connection.** The last state of home, inbox, board and chat is readable offline, marked with when it was last updated. Chat messages queue and send when back online. Approvals and decisions are never queued: they need a live, current card.

**What the apps are not for**

- Editing the team on a canvas, editing briefs, connecting systems or entering secrets, and publishing. On a phone these open read-only with a note to use a larger screen. Choosing what happens to ongoing work for a change that is already published is the exception (MB3), because it is a decision, not an edit.

**The mobile web, first and always**

- MB11. The Studio's control-room screens (home, inbox, board list, role page, chat, cards, meeting minutes, run controls) are responsive and usable in a phone browser, from the MVP. This is the interim before the apps, and the fallback for anyone who never installs them.

**Platforms and repositories**

- MB12. Two native apps, iPhone (Swift, SwiftUI; iPad gets the same app with a two-column layout) and Android (Kotlin, Jetpack Compose), each in its own repository, open source (MIT). They use only the public API, so they work with every deployment: hosted, self-hosted and a laptop on the same network.
- MB13. Sign-in with the deployment's own sign-in (OIDC in the system browser), several deployments in one app, sign out and "remove this device" from the Studio. Enterprise device management (managed app configuration, the deployment URL pushed by the company) in phase 5.

## 7. MVP scope and later

**MVP = the demo, steps 1 to 12, on an online deployment (the customer's cloud through the Compose stack or a one-click template), on GitHub, with Claude Code.** The same build runs locally for trying it and for development.

| In the MVP | Later |
| --- | --- |
| Online Studio from day one: organisations, workspaces, members, OIDC (GitHub), control plane and data plane, Postgres; local mode from the same build | Our hosted service, SAML SSO, regions, customer-run data plane in their VPC |
| Org and Flow views, palette, inspector, toggles, reporting lines, live checks, import | Systems auto-discovery beyond GitHub, visual gate builder, design-system theming |
| Systems: GitHub repository, Supabase, Postgres, Vercel, generic MCP server | Netlify, Cloudflare, Sentry, Linear, Slack, Jira and more |
| Publish via PR or local commit; versions as SHAs | Scheduled publishes, policy checks ("no role may deploy without QA") |
| Run modes: subagents and Studio runner (chief of staff + on-demand role sessions); built-in agent teams export | Other coding agents as adapters; remote run machines |
| Hook-based reporting, approvals, budgets, cost line | Per-role usage optimisation suggestions |
| Engineering pack on the neutral core (areas, checks, propose and accept) | Business packs (marketing, sales, support, finance, legal) with Drive, CRM and helpdesk connectors; then other industries |
| Evals harness, internal only, on 3 sample repositories | Public leaderboard, customer-defined eval sets |
| Custom agents: new, copy a kit role, import a file; live checks; path conflicts | Role pack sharing site, "try it on a task" in the hosted service |
| Meetings: written round, recurring and ad hoc, minutes and action items | Discussion format beyond 3 rounds, voice, calendar sync (ICS) |
| Notifications: email and webhook, rules, quiet hours, delivery log | Slack, Teams, Discord, push, SMS; reply-to-decide in Slack |
| Change safety: live status on the canvas, impact step in Publish, rollout view | Freeze mode, policy ("never apply now to a role with an open migration") |
| Node equivalents of the core scripts (Windows) | |
| Mobile web control room (MB11); the API, push channel and deep links ready for the apps (clients contract) | Native iPhone and Android apps (MB1 to MB13), push through the relay (phase 4); widgets, Live Activities, voice in meetings, enterprise device management (phase 5) |

**Non-goals:** a general workflow engine (Zapier, n8n), a new LLM SDK, hosting customers' production apps, or replacing GitHub as the place where code is reviewed.

## 8. Success measures

- The demo runs end to end, live, in 15 minutes or less, on a fresh sample repository, three times in a row without intervention outside the script.
- Time from `npx agent-team studio` to the first published team: under 10 minutes for a new user (measured in usability tests with 5 people).
- Round trip: 100% of the kit's examples and every known real `.agent-team/` layer import and republish with zero diff.
- Board freshness: every running role session appears on the board within 10 seconds of starting, with no role-written report needed.
- Evals: the full team beats a single agent on tests-passed and regressions for the sample task set at a cost the cost line shows plainly. If it does not, we say so in the README.
- From the phone: an approval that arrives while the owner is away is answered in under 60 seconds from the notification, and nothing about the team appears on a locked screen unless the owner turned previews on.
- Adoption (after launch): repositories with a `.agent-team/` folder, weekly active Studio installs, and the kit repository itself run by its own team.

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| Cost surprises from many long-lived sessions | Budgets and caps (C4), dormant by default, the cost line in every digest, evals that report cost |
| The canvas becomes a second source of truth that drifts from the repository | The repository is the source of truth; the Studio's import is lossless; `sync.sh check` in CI |
| Agents with database or deploy access cause damage | Bindings with least privilege, read-only database roles by default, migrations only through the repository and CI, approval gates in the runner |
| Prompt injection through issues, PR comments and web content | Content from outside is marked untrusted in role prompts, tools that act outside the repository need approval, egress allowlist per run |
| Dependence on one model vendor's features (hooks, agent teams) | Adapters (G3); the team model is neutral; the runner enforces governance itself |
| Meetings multiply cost and noise | Written round by default, skip when nothing changed, caps per meeting, dormant roles never woken |
| Notifications become spam, or a phishing vector | Few defaults (approvals, decisions, ongoing work), batching and quiet hours; agents cannot send them; approvals never by reply |
| A team change corrupts in-flight work | Sessions pinned to a version, the impact step, the runner's invariants (6.9 X6), and "let it finish" as the default |
| Custom agents weaken governance (two writers, no evidence) | The same checks as kit roles, path conflicts must be resolved, sign-off evidence required |
| A phone makes approving too easy, or a lost phone approves things | Biometric step-up for every approval, cards that refuse stale answers, contentless pushes, remove a device from the Studio, short-lived tokens |
| Old app versions in the stores break when the server changes | Apps use only `/v1/`, ignore what they do not know, and are tested against conformance fixtures; the discovery document's minimum version is raised only for security |
| The demo looks good but the team underdelivers on real work | Evals (G4), and this repository built by its own team in the open |

## 10. Open questions

1. ~~Runtime for the MVP's "let it run".~~ **Decided 2026-11-05: our own runner on the Claude Agent SDK.** The reasoning: our own runner on the Claude Agent SDK, with built-in agent teams and subagents as zero-infrastructure modes. The other option, driving claude.ai projects and cloud sessions as today, can't be controlled from our own app. See [ADR 0002](../adr/0002-runtime-agent-sdk-runner.md). The owner chose it.
2. Hosted service: whether, when and how to charge. Not needed for the MVP; [deployment](deployment.md) keeps the door open.
3. Name: "Agent Team Studio" is a working name.
4. ~~How notifications are sent in local mode.~~ **Decided 2026-11-06:** there is no local special case. Email and Slack are connectors, connected the same way locally and online: the workspace's email provider by API key (SMTP as a fallback), or a person's own mail account through OAuth.
5. ~~Committing meeting minutes.~~ **Decided 2026-11-06:** off by default, with a per-meeting switch to commit them under `docs/team/meetings/`.
