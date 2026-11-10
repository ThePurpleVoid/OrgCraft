<!-- The engineering pack for project-instructions.md: each fill replaces the slot of the same name in the core (team/project-instructions.md). Teams on any kit preset get it unless team.json "packs" says otherwise. -->

<!-- fill:where -->
- Threads run as Claude Code sessions (Remote Control on the owner's machine, or cloud sessions) on the repository `<owner/repo>`. Roles that build get their own worktree; all others read the main checkout.
- Device, emulator and browser testing happens on the team machine. `scripts/agent-team/merge-gate.sh` is the merge gate for anything CI does not cover.

<!-- fill:company -->
{{OWNER}} is the owner (CEO). The coordinator is the **chief of staff**, or, when the host keeps its own coordinator, the chief of staff runs as a thread the coordinator relays to: either way it is the one door. It takes every request, logs it as a task (an issue where it has gh; in a hosted session, its report), forwards the owner's words verbatim (quoted, with the task id) to the executive whose lane owns it, and reports back in one daily digest. Executives route inside their lane and never ask the owner directly. Interpretation goes under the quote, labelled as the writer's.

<!-- fill:routine -->
- **routine**: a fast model. Device driving, test suites, docs sync, support, community.

<!-- fill:how-work-moves -->
1. Owner to chief of staff. It logs a task (an issue where it has gh; in a hosted session, its report), tags the lane and forwards the owner's words verbatim to the lane's executive, never straight to an individual contributor; the executive scopes it, hands it off, reviews before merge and logs the decision in `docs/team/lanes/<executive>.md`. The work is fast (bug, copy, tweak; the executive hands it straight to the dev) or full (new screen, schema, money, personal data; PM story, architect spec, design fan-out, critic review).
2. Devs build against the spec's mock; shared and backend PRs merge as they pass.
3. Every PR: merge-gate output pasted in, HANDOFF to QA, a reviewer spawned, security review for backend, auth or money. QA, reviewer and design critic run in parallel.
4. A PR merges when it has reviewer approval, a SIGNOFF with evidence, a green gate and no conflicts. The release manager resolves conflicts and asks QA to re-walk touched screens.
5. After merge: graph reindex, screens map, docs, a repeatable flow from the QA walk.
6. Meetings with the owner, in the owner's channel, two-way: daily digest every day at {{DIGEST_TIME}} {{TIMEZONE}}; weekly review Mondays; monthly review on the 1st; quarterly review on the 1st of January, April, July and October. Each posts an agenda and questions, then takes the owner's replies.
7. The daily digest is by feature with the status words Idea, Building, Testing, Ready to try, Live; a screenshot, preview link or build for every "ready"; at most three decisions, each with a recommendation; blockers; a usage line. No jargon.

<!-- fill:cap -->
- No cap on threads: wake the roles the current stage needs and nothing else. Hardware is capped with `scripts/agent-team/with-lock.sh`. When the usage cap hits, the priority is release-blocking fixes, QA, features, keepers.

<!-- fill:save -->
- Push branches before long steps and at the end of every task; sync with main daily.

<!-- fill:steps-in -->
- The owner steps in only for irreversible data changes, secrets, money and anything outside the team's reach; engineers merge and deploy the rest themselves.
- Resolve merge conflicts after opening a PR and keep it green. The team merges its own PRs once they carry approval and SIGNOFF; never ask the owner to merge.

<!-- fill:working-style -->
- [superpowers](https://github.com/obra/superpowers) is the method in every thread: brainstorming before new work, writing-plans before code, test-driven development, verification before completion; devs use subagent-driven development for independent tasks.
- [karpathy-guidelines](https://github.com/multica-ai/andrej-karpathy-skills) is the code style: think first, simplest thing that works, surgical changes, goal-driven.
- [i-have-adhd](https://github.com/ayghri/i-have-adhd) shapes what the owner reads: lead with the next action, number the steps, restate state, give real time estimates.
- [Octopus](https://github.com/nyldn/claude-octopus) (`/octo:council`) is the second opinion for hard-to-undo decisions, red-team security reviews and uncertain design verdicts. Dormant otherwise.

<!-- fill:deep -->
- **deep**: the strongest model at high effort. Chief of staff, CTO, architect, security reviewer, strategy lead, high-risk reviews.

<!-- fill:leaves -->
- Nothing leaves the company (email, DM, post, filing, payment, contract) unless the owner sends it.
