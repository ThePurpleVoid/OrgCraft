# Team protocols

The rules every role follows. Role briefs hold only what is specific to the role; everything shared is here.

## The one door and the dilution rule

The owner talks to one role: the **chief of staff**. It opens an issue for every request and forwards the owner's words to the executive whose lane owns it. Executives route inside their lane and never ask the owner directly.

The owner's message travels down the tree **verbatim**, quoted, with its issue id. Every brief starts with that quote. Interpretation goes underneath, labelled as the writer's. Nobody paraphrases the owner on the way down.

## Fast lane and full lane

- **Fast**: a bug, a copy fix, a tweak to an existing screen. No schema change, no money, no personal data. It goes straight to the owning dev.
- **Full**: everything else. Product manager story, architect spec with a mock, design fan-out (3 to 5 style threads), a design note with the copy table, a design critic review, then build.

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

Every task starts with a status report, and every HANDOFF, BUG, SIGNOFF or BLOCKED is reported with the same fields:

```sh
scripts/agent-team/team-status.sh backend-dev status working --task "Invoices API" --issue 42
scripts/agent-team/team-status.sh backend-dev handoff waiting --to backend-tester --task "Invoices API" --pr 57
scripts/agent-team/team-status.sh qa-web bug - --to web-dev --severity 2 --evidence shots/save.png --detail "Save does nothing"
scripts/agent-team/team-status.sh qa-web signoff done --to release-manager --pr 57 --evidence shots/a.png,logs/a.txt
scripts/agent-team/team-status.sh code-reviewer#57 status done
```

`scripts/agent-team/team-board.sh` shows where every role stands. The chief of staff reads the board for the daily digest instead of asking the roles.

**Heartbeat.** A thread whose status is `working` reports again at least every 15 minutes, even when nothing has changed (`team-status.sh <role> heartbeat`, or a fresh `status working` when the task moved on). The moment it waits on CI, a review, another role or an answer, it reports `waiting` and names what it waits on (`--to <role>` or `--detail "CI on PR 57"`), and reports `working` again when it resumes. A thread that cannot keep this up (a long build, a long test run) says so first: `status waiting --detail "build, about 25 min"`. The dashboard shows a working thread silent for longer than `dashboard.staleMinutes.working` (and a waiting, in-review or blocked one silent for longer than its own limit) as **gone quiet**, with how long it has been silent, and the chief of staff nudges it.

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

A brief with `Status: dormant` exists on paper only. The chief of staff or the lane's executive opens it the moment a request needs that role, without asking the owner first, and says which role was opened and why in the digest. An executive is active when any role in its lane is active; until then the chief of staff covers the lane.

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
