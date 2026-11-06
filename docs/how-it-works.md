# How it works

## The org

The owner (you) is the CEO and talks to one role, the **chief of staff**. Under it sit executives, one per lane, and under them the roles that do the work. The tree is data: every brief has a `Reports to:` line, and `node scripts/agent-team/roster.mjs --tree` draws it.

| Lane | Executive | Roles |
| --- | --- | --- |
| Engineering | CTO (+ head of quality) | architect, shared core dev, backend dev, AI engineer, payments engineer, security reviewer, web dev, mobile dev, release manager, infra/secrets/on-call, knowledge graph keeper, docs keeper, code reviewer pool; QA web, QA mobile, backend tester, test automation, performance tester, bug triager |
| Product and design | CPO | product manager, design director (+ style thread pool), design critic, UX writer, content lead, analytics lead |
| Go-to-market | CMO, CRO | marketing lead, brand designer, sales lead, partnerships lead |
| Customer | CCO | customer success lead, support lead, community lead |
| Corporate | CFO, general counsel, COO | finance lead, legal and privacy owner, store and compliance owner, strategy lead, people and team ops lead |

The chief of staff routes every request to the lane's executive, whose thread opens the moment its lane has work; the chief of staff covers only a lane whose executive is not installed. Business roles start **dormant**: the brief exists, but nobody opens the thread until a request needs it.

**Pool roles** (code reviewer, style thread) are short-lived: one thread per PR or per design direction, reported as `code-reviewer#57` or `style-thread#calm`.

## The dilution rule

Every hop in a chain of agents loses a little of what you meant. So the owner's message travels down the tree **verbatim**, quoted, with its issue id. Each brief an executive writes starts with that quote; the executive's interpretation goes underneath, labelled as theirs. A dev three levels down reads exactly what you wrote.

## From request to merged PR

1. **You → chief of staff.** It opens an issue and decides the lane.
2. **Fast or full.**
   - *Fast* (a bug, a copy fix, a tweak; no schema, money or personal data): the executive hands it straight to the owning dev.
   - *Full* (everything else): the product manager writes a story with acceptance checks, the architect writes a contract-first spec with a mock, the design director fans out 3 to 5 style threads, you and the CTO pick, the design note ships with the UX writer's copy table, and the design critic reviews it.
3. **Build.** Devs build against the spec's mock in parallel, each in its own worktree, one branch and PR per issue. Before review they paste `merge-gate.sh` output into the PR.
4. **Check, in parallel.** A HANDOFF goes to QA, a code reviewer thread is spawned, the security reviewer reads anything touching the backend, auth or money, and the design critic judges QA's screenshots against the design note.
5. **Merge.** Approval + SIGNOFF with evidence + green gate + no conflicts = merge. The team merges its own PRs. The release manager resolves conflicts and asks QA to re-walk what a conflict touched.
6. **After merge.** The knowledge graph keeper reindexes, the docs keeper fixes drift, the test automation engineer turns the QA walk into a repeatable flow.

Three BUG rounds between one QA role and one dev, then the product manager decides.

## Message shapes

| Shape | Fields |
| --- | --- |
| HANDOFF | issue, from, to, branch and commit, artifact, what changed, how to verify, done when |
| BUG | issue, screen, steps, expected, actual, screenshot path, severity, build |
| SIGNOFF | issue, tested on, what was walked, result, screenshot or log paths (required) |
| BLOCKED | issue, what is needed, from whom, what happens meanwhile |

Each one is also sent to the board with `team-status.sh`, so the board shows who is waiting on whom.

## Memory

Each role keeps `roles/<slug>.md` in project memory with five sections: Identity, Current task, Open items, Decisions, Lessons. It is rewritten at the end of every task. Threads are long-lived by identity: resolve after a task, reopen with the same title and "Resume from roles/<slug>.md".

## Meetings and the digest

The chief of staff runs a daily digest and weekly, monthly and quarterly reviews, all two-way in the owner's channel (the main project chat, or the coordinator's chat when the chief of staff runs as a thread). The digest is by feature, with five status words (Idea, Building, Testing, Ready to try, Live), a screenshot or link for everything that is ready, at most three decisions (each with a recommendation), blockers and a usage line.

## Model tiers

Briefs name a tier, not a model, so the kit outlives model releases.

| Tier | Use | Example roles |
| --- | --- | --- |
| deep | hardest reasoning, high effort | chief of staff, CTO, architect, security reviewer |
| standard | strong general work | executives, builders, designers, writers |
| routine | fast, repetitive work | QA walks, test suites, docs sync, support |
| light | matching and indexing | bug triage, reindexing |

Subagent export maps tiers to Claude Code model aliases: deep and standard to `opus`, routine to `sonnet`, light to `haiku`. Override with `"models": {"standard": "sonnet"}` in `team.json`.
