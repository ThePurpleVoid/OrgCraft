# Team protocols

The rules every role follows. Role briefs hold only what is specific to the role; everything shared is here.

## The one door and the dilution rule

The owner talks to one role: the **chief of staff**. It opens an issue for every request and forwards the owner's words to the executive whose lane owns it. Executives route inside their lane and never ask the owner directly.

The owner's message travels down the tree **verbatim**, quoted, with its issue id. Every brief starts with that quote. Interpretation goes underneath, labelled as the writer's. Nobody paraphrases the owner on the way down.

**No role asks the owner directly.** No role thread asks the owner anything in its own thread, waits on the owner there, or posts a decision card for the owner; the owner never has to open a role's thread. A question, approval or design pick for the owner goes to the chief of staff as a BLOCKED with the exact question and a recommendation. The chief of staff asks in the main project chat and relays the owner's words back verbatim. The role keeps working on the recommended option meanwhile, unless the step cannot be undone.

## Chain of command

The chief of staff routes every request to the executive whose lane owns it (the CTO for engineering, the CPO for product and design, and so on), never straight to an individual contributor. The executive's thread opens the moment its lane has work. The executive quotes the owner verbatim, scopes the work, hands it to the right role with a HANDOFF and acceptance criteria, reviews the result before merge, reports its own status to the board like every role, and logs each decision in its lane log (`docs/team/lanes/<executive>.md`). Results travel back the same way: role to executive, executive to chief of staff, chief of staff to the owner. When a lane's executive is not installed (a small preset), the chief of staff covers that lane.

## When the owner steps in

The team runs without the owner. Engineers merge their own green PRs and deploy them; when the project's pipeline deploys on merge, merging is the deploy. The owner is asked only for:

- data changes that cannot be undone (dropping, truncating, deleting, retyping or renaming existing data), and any other step that cannot be undone;
- adding or changing a secret;
- money;
- anything outside the team's reach.

Those go to the chief of staff as BLOCKED. An automatic deploy never runs a destructive migration; it stops and waits for a manual run after the owner's OK. The CTO decides what counts as destructive when it is unclear.

## Fast lane and full lane

- **Fast**: a bug, a copy fix, a tweak to an existing screen. No schema change, no money, no personal data. The executive hands it straight to the owning dev.
- **Full**: everything else. Product manager story, architect spec with a mock, design fan-out (3 to 5 style threads), a design note with the copy table, a design critic review, then build.

**Architect first.** The architect writes the design (an ADR in `docs/team/lanes/`) before any engineer starts when a task:

- adds a new table, a new family of server functions, a new queue or job, or a new subsystem;
- changes a sync protocol, a shared library's public API, or a contract that more than one client or service reads;
- includes a migration that cannot be cleanly reverted (dropping or rewriting columns, data backfills, changing a key or a constraint on existing rows);
- touches tenancy, auth or row-level security design rather than one policy;
- changes environments or infrastructure (a production split, backups and point-in-time recovery, the deploy pipeline, the secrets layout);
- would cost more than about a week of engineering, or the CTO is unsure.

Everything else (a status value, a column on an existing table, a view or endpoint tweak, a bug fix inside one subsystem) the CTO scopes and hands straight to the engineer, and the hand-off says which path was chosen.

## Message shapes

Every message between roles is one of four shapes, with all of its fields.

| Shape | Fields |
| --- | --- |
| **HANDOFF** | issue, from, to, branch and commit, artifact (build path or preview URL), what changed, how to verify, done when |
| **BUG** | issue, screen, steps, expected, actual, screenshot path, severity, build |
| **SIGNOFF** | issue, tested on (device or browser, OS, commit), what was walked, result, screenshot or log paths (required) |
| **BLOCKED** | issue, what is needed, from whom, what happens meanwhile |

A SIGNOFF without screenshot or log paths is invalid. Three BUG rounds between one QA role and one dev, then the product manager decides.

## Reporting to the team board

**Report on start.** The first command of every task, before any reading or building, is a `status working` report with the task's name (and issue, when there is one). A task that changes shape gets a fresh `status working` with its new name, and a thread that resumes from its memory file reports again on resume. Work with no start report on the board has not started. After that, every HANDOFF, BUG, SIGNOFF or BLOCKED is reported with the same fields:

```sh
scripts/agent-team/team-status.sh backend-dev status working --task "Invoices API" --issue 42
scripts/agent-team/team-status.sh backend-dev handoff waiting --to backend-tester --task "Invoices API" --pr 57
scripts/agent-team/team-status.sh qa-web bug - --to web-dev --severity 2 --evidence shots/save.png --detail "Save does nothing"
scripts/agent-team/team-status.sh qa-web signoff done --to release-manager --pr 57 --evidence shots/a.png,logs/a.txt
scripts/agent-team/team-status.sh code-reviewer#57 status done
```

`scripts/agent-team/team-board.sh` shows where every role stands. The chief of staff reads the board for the daily digest instead of asking the roles.

**Heartbeat.** A thread whose status is `working` reports again at least every 15 minutes, even when nothing has changed (`team-status.sh <role> heartbeat`, or a fresh `status working` when the task moved on). The moment it waits on CI, a review, another role or an answer, it reports `waiting` and names what it waits on (`--to <role>` or `--detail "CI on PR 57"`), and reports `working` again when it resumes. A thread that cannot keep this up (a long build, a long test run) says so first: `status waiting --detail "build, about 25 min"`. The dashboard shows a working thread silent for longer than `dashboard.staleMinutes.working` (and a waiting, in-review or blocked one silent for longer than its own limit) as **gone quiet**, with how long it has been silent, and the chief of staff nudges it. A scheduled check (the COO's when that role is installed, otherwise the chief of staff's) reads the board every hour and lists the quiet roles with their last task, so the nudges do not depend on someone looking.

**The chief of staff's own card.** The chief of staff reports its own status (working, waiting or idle, with the task) on every owner request it handles, so the board shows the door as well as the rooms. When the chief of staff cannot run commands itself (for example, a coordinator in a chat app with no shell), a long-lived "board reporter" thread does it: the chief of staff sends it a one-line status and it runs `team-status.sh chief-of-staff ...`. Leave the chief of staff out of the working check when a digest or reporter posts for it on a schedule.

## Pull requests

1. One branch and one PR per issue.
2. Paste the output of `scripts/agent-team/merge-gate.sh <target>` into the PR before asking for review.
3. Send a HANDOFF to the role's QA. A code reviewer thread is spawned for the PR; the security reviewer reviews anything touching the backend, auth or money. QA, reviewer and design critic run in parallel.
4. A PR merges when it has reviewer approval, a QA SIGNOFF with evidence, a green gate and no conflicts. The team merges its own PRs; the owner is never asked to merge. The release manager resolves conflicts and asks QA to re-walk the screens a conflict touched.
5. After merge: the knowledge graph keeper reindexes, the docs keeper fixes drift, the test automation engineer turns the QA walk into a repeatable flow.

## Ownership

One writer per path (`docs/team/ownership.md`). A thread edits only the paths it owns; anything else is a request to that path's owner.

## Memory and long-lived threads

Each role has a memory file `roles/<slug>.md` in project memory with five sections: Identity, Current task, Open items, Decisions, Lessons. The role rewrites it at the end of every task. A role thread is long-lived by identity: resolve it after each task, and reopen it with the same title and the first message "Resume from roles/<slug>.md".

## Dormant roles

A brief with `Status: dormant` exists on paper only. The chief of staff or the lane's executive opens it the moment a request needs that role, without asking the owner first, and says which role was opened and why in the digest. An executive opens as soon as its lane has work (see the chain of command); the chief of staff covers only lanes whose executive is not installed.

## Things that never happen

- No demo or sample data. Testers use the real test accounts the owner set up.
- No secrets in chat, memory files or briefs. When a key is needed, the owner is told the secret's name and where to paste it.
- Nothing leaves the company (email, DM, post, filing, payment, contract) unless the owner sends it. Agents draft.
- No force-push to main, and no merge without both the approval and the SIGNOFF.

## Machine rules

- Roles that build get their own git worktree; everyone else reads the release manager's plain checkout.
- There is no cap on threads, but hardware is capped: every build, emulator, simulator or local backend runs through `scripts/agent-team/with-lock.sh <pool> -- <command>`. Pools and slot counts are in `.agent-team/config.sh`.
- Push branches before long steps and at the end of every task; sync with main daily.
- `scripts/agent-team/janitor.sh` runs nightly to prune worktrees, stop daemons and free stale lock slots.

## Changing the team

The briefs, these protocols and the scripts are generated from Agent Team Kit. Never edit them in place:

- To change a role, add `.agent-team/roles/<role>.extend.md` (extra rules, a different model tier, more tools) or replace it with `.agent-team/roles/<role>.md`.
- To add a role, add `.agent-team/roles/<new-role>.md`; to drop one, list it under `exclude` in `.agent-team/team.json`.
- Project-wide rules go in `.agent-team/protocols.extend.md`.
- Then run `scripts/agent-team/sync.sh` and commit the result with the change.

A change that would help every team (a better rule, a script fix) goes upstream to Agent Team Kit as a pull request; the next kit version brings it back.

## Agent Team Kit rules

- **We run on the last release.** This repository's own team is pinned to a released kit tag in `.agent-team/team.json`, never to `main`. A change to the kit reaches this team the same way it reaches every other team: release, then bump the pin and sync. The release manager bumps the pin in the PR after each release.
- **Two kinds of folder named team.** `team/` is the kit's source (the briefs every team gets). `docs/team/` is this repository's own generated team. Fix a brief for everyone in `team/`; change this team in `.agent-team/`.
- **Nothing product-specific in the kit.** Briefs, protocols, presets and scripts name no product, company or person. The examples and this repository's own `.agent-team/` are the only places a team is made concrete.
- **The demo is the bar.** The product plan lives in `docs/product/`. The customer demo in `docs/product/prd.md` is the end-to-end acceptance test; the delivery plan in `docs/product/delivery-plan.md` says which phase moves which demo step.

<!-- Generated by Agent Team Kit 0.3.0. Do not edit: change .agent-team/ and run scripts/agent-team/sync.sh. -->
