<!-- The engineering pack for protocols.md: each fill replaces the slot of the same name in the core (team/protocols.md). Teams on any kit preset get it unless team.json "packs" says otherwise. -->

<!-- fill:door -->
The owner talks to one role: the **chief of staff**. It opens an issue for every request and forwards the owner's words to the executive whose lane owns it. Executives route inside their lane and never ask the owner directly.

<!-- fill:verbatim -->
The owner's message travels down the tree **verbatim**, quoted, with its issue id. Every brief starts with that quote. Interpretation goes underneath, labelled as the writer's. Nobody paraphrases the owner on the way down.

<!-- fill:chain -->
The chief of staff routes every request to the executive whose lane owns it (the CTO for engineering, the CPO for product and design, and so on), never straight to an individual contributor. The executive's thread opens the moment its lane has work. The executive quotes the owner verbatim, scopes the work, hands it to the right role with a HANDOFF and acceptance criteria, reviews the result before merge, reports its own status to the board like every role, and logs each decision in its lane log (`docs/team/lanes/<executive>.md`). Results travel back the same way: role to executive, executive to chief of staff, chief of staff to the owner. When a lane's executive is not installed (a small preset), the chief of staff covers that lane.

<!-- fill:steps-in -->
The team runs without the owner. Engineers merge their own green PRs and deploy them; when the project's pipeline deploys on merge, merging is the deploy. The owner is asked only for:

<!-- fill:steps-in-more -->
- anything outside the team's reach.

<!-- fill:steps-in-after -->
Those go to the chief of staff as BLOCKED. An automatic deploy never runs a destructive migration; it stops and waits for a manual run after the owner's OK. The CTO decides what counts as destructive when it is unclear.

<!-- fill:lanes -->
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

<!-- fill:handoff -->
| **HANDOFF** | issue, from, to, branch and commit, artifact (build path or preview URL), what changed, how to verify, done when |

<!-- fill:bug -->
| **BUG** | issue, screen, steps, expected, actual, screenshot path, severity, build |

<!-- fill:signoff -->
| **SIGNOFF** | issue, tested on (device or browser, OS, commit), what was walked, result, screenshot or log paths (required) |

<!-- fill:blocked -->
| **BLOCKED** | issue, what is needed, from whom, what happens meanwhile |

<!-- fill:shapes-after -->
A SIGNOFF without screenshot or log paths is invalid. Three BUG rounds between one QA role and one dev, then the product manager decides.

<!-- fill:start -->
**Report on start.** The first command of every task, before any reading or building, is a `status working` report with the task's name (and issue, when there is one). A task that changes shape gets a fresh `status working` with its new name, and a thread that resumes from its memory file reports again on resume. Work with no start report on the board has not started. After that, every HANDOFF, BUG, SIGNOFF or BLOCKED is reported with the same fields:

<!-- fill:examples -->
```sh
scripts/agent-team/team-status.sh backend-dev status working --task "Invoices API" --issue 42
scripts/agent-team/team-status.sh backend-dev handoff waiting --to backend-tester --task "Invoices API" --pr 57
scripts/agent-team/team-status.sh qa-web bug - --to web-dev --severity 2 --evidence shots/save.png --detail "Save does nothing"
scripts/agent-team/team-status.sh qa-web signoff done --to release-manager --pr 57 --evidence shots/a.png,logs/a.txt
scripts/agent-team/team-status.sh code-reviewer#57 status done
```

<!-- fill:heartbeat -->
**Heartbeat.** A thread whose status is `working` reports again at least every 15 minutes, even when nothing has changed (`team-status.sh <role> heartbeat`, or a fresh `status working` when the task moved on). The moment it waits on CI, a review, another role or an answer, it reports `waiting` and names what it waits on (`--to <role>` or `--detail "CI on PR 57"`), and reports `working` again when it resumes. A thread that cannot keep this up (a long build, a long test run) says so first: `status waiting --detail "build, about 25 min"`. The dashboard shows a working thread silent for longer than `dashboard.staleMinutes.working` (and a waiting, in-review or blocked one silent for longer than its own limit) as **gone quiet**, with how long it has been silent, and the chief of staff nudges it. A scheduled check (the COO's when that role is installed, otherwise the chief of staff's) reads the board every hour and lists the quiet roles with their last task, so the nudges do not depend on someone looking.

<!-- fill:pull-requests -->
## Pull requests

1. One branch and one PR per issue.
2. Paste the output of `scripts/agent-team/merge-gate.sh <target>` into the PR before asking for review.
3. Send a HANDOFF to the role's QA. A code reviewer thread is spawned for the PR; the security reviewer reviews anything touching the backend, auth or money. QA, reviewer and design critic run in parallel.
4. A PR merges when it has reviewer approval, a QA SIGNOFF with evidence, a green gate and no conflicts. The team merges its own PRs; the owner is never asked to merge. The release manager resolves conflicts and asks QA to re-walk the screens a conflict touched.
5. After merge: the knowledge graph keeper reindexes, the docs keeper fixes drift, the test automation engineer turns the QA walk into a repeatable flow.

<!-- fill:never-merge -->
- No force-push to main, and no merge without both the approval and the SIGNOFF.

<!-- fill:machine -->
## Machine rules

- Roles that build get their own git worktree; everyone else reads the release manager's plain checkout.
- There is no cap on threads, but hardware is capped: every build, emulator, simulator or local backend runs through `scripts/agent-team/with-lock.sh <pool> -- <command>`. Pools and slot counts are in `.agent-team/config.sh`.
- Push branches before long steps and at the end of every task; sync with main daily.
- `scripts/agent-team/janitor.sh` runs nightly to prune worktrees, stop daemons and free stale lock slots.

<!-- fill:sync-commit -->
- Then run `scripts/agent-team/sync.sh` and commit the result with the change.

<!-- fill:upstream -->
A change that would help every team (a better rule, a script fix) goes upstream to OrgCraft as a pull request; the next kit version brings it back.

<!-- fill:hooks -->
Where the repository has the kit's Claude Code hooks (`.claude/settings.json`), Claude Code also reports for you: `working` when your session starts or gets a message, a heartbeat while you use tools, `idle` when your turn ends, and each subagent or teammate as its own role. That is a safety net, not a substitute: report your start, your waits and every message yourself, because only you know the task's name and whom you wait on. Without bash or `jq`, `node scripts/agent-team/report.mjs` takes the same arguments as `team-status.sh`. When your checkout's `.agent-team/local.env` names your role (`AGENT_TEAM_ROLE`), you can leave the role out: `team-status.sh status working --task "..."`.

<!-- fill:no-demo -->
- No demo or sample data. Testers use the real test accounts the owner set up.

<!-- fill:one-writer -->
One writer per path (`docs/team/ownership.md`). A thread edits only the paths it owns; anything else is a request to that path's owner.

<!-- fill:leaves -->
- Nothing leaves the company (email, DM, post, filing, payment, contract) unless the owner sends it. Agents draft.
