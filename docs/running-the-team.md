# Running the team

## Option A: one thread per role (claude.ai projects)

This is how the kit was born, and it scales best.

1. Create a Claude project for your product and attach the repository.
2. Paste `docs/team/project-instructions.md` (below its line) into the project's instructions.
3. The project's coordinator is the chief of staff. Tell it: *"You are the chief of staff. Read docs/team/roles/chief-of-staff.md and docs/team/protocols.md."*
4. Ask for work. The chief of staff opens a thread per role it needs, titled with the role name, and gives each the first message *"Read docs/team/roles/<role>.md, then Resume from roles/<role>.md in project memory."*
5. Threads that build use the worktree option, so parallel devs never share a checkout. Everyone else reads the release manager's plain checkout.

Where threads run:

- **Remote Control on your own machine** gives threads your devices, emulators, simulators and signed-in tools. Size `AGENT_TEAM_POOLS` in `.agent-team/config.sh` for that machine.
- **Cloud sessions** are fine for roles that only read and write files (executives, writers, reviewers, business roles). Point them at the [hosted board](../board/supabase/README.md) or at your local [dashboard](dashboard.md) so their reports land in one place, or at a shared folder (below).

### One board when every thread has its own machine

Cloud threads each run in their own container, so the default event log (`~/.agent-team/<project>/events.jsonl`) is private to each thread. When the host gives every thread a shared folder, point the board there and nothing else is needed:

```sh
# ~/.agent-team/<project>/team.env, .agent-team/config.sh, or .agent-team/local.env
AGENT_TEAM_HOME=/path/to/shared-folder/agent-team-board
```

Every report then goes to `<that folder>/<project>/events.jsonl`, and `team-board.sh`, the dashboard and the hooks read and write the same file. Put it in `config.sh` when every checkout of the repository should use it, or in `team.env` or `local.env` when only some machines mount the folder. The environment still wins over all three.

### Which role a thread plays

Each role thread works in its own checkout. Give the checkout its role once, in `.agent-team/local.env` (sync adds it to `.gitignore`; it is never committed):

```sh
AGENT_TEAM_ROLE=backend-dev
```

Then `team-status.sh status working --task "..."` works without the role, and the Claude Code hooks report the thread's own session as that role. `AGENT_TEAM_ROLE` in the environment wins over the file. `doctor` prints the role a checkout reports as.

### The chief of staff as a thread

Some hosts already have a coordinator of their own (the session that answers the owner in the project chat and opens threads). Then the chief of staff runs as a thread:

- The owner keeps talking to the coordinator. The coordinator relays every request to the chief of staff's thread verbatim, quoted, and relays the chief of staff's questions and digests back. That chat is the owner's channel the briefs refer to.
- The chief of staff dispatches by asking the coordinator to open or wake role threads, or by messaging them directly where the host allows threads to message each other. Executives and roles answer the chief of staff's thread, never the owner.
- The chief of staff's own card on the board comes from its thread like any other role: `AGENT_TEAM_ROLE=chief-of-staff` in its `local.env`.

Nothing else changes: the same briefs, protocols, board and gates.

### Routines

Each routine belongs to a role, and that role's thread schedules it:

- **From a thread**: use the host's scheduler. In Claude projects that is a scheduled or recurring task (a routine) whose prompt names the role and the job, for example *"You are the docs keeper: read docs/team/roles/docs-keeper.md, then run the nightly docs drift check."* A thread that can only schedule its own next wake-up re-schedules at the end of each run.
- **On a machine you run**: cron or launchd, calling `claude -p` with the same prompt, or a script for the machine's own jobs.

A routine reports to the board like any task: `status working` first, and `done` or `idle` at the end.

| When | Who | What |
| --- | --- | --- |
| Daily, morning | chief of staff | the digest, read from the board |
| Nightly | knowledge graph keeper, docs keeper | reindex, docs drift |
| Nightly | test automation engineer | regression suite |
| Nightly | the machine | `scripts/agent-team/janitor.sh` |
| Weekly | performance tester | budgets |
| Monthly | security reviewer, people and team ops | audit, retrospective |

## Option B: subagents in one Claude Code session

Set `"subagents": true` in `.agent-team/team.json` (or `"all"` to include dormant roles) and run `scripts/agent-team/sync.sh`. Every role becomes `.claude/agents/<role>.md`, regenerated on every sync. For a one-off export of some roles:

```sh
node scripts/agent-team/export-subagents.mjs --only architect,backend-dev,qa-web,code-reviewer
```

Then start Claude Code in the repository and act as the chief of staff yourself, or ask Claude to: *"Act as the chief of staff from docs/team/roles/chief-of-staff.md. Delegate to the team's subagents."* Each subagent's final message is its HANDOFF, BUG, SIGNOFF or BLOCKED.

Change roles through `.agent-team/` and sync; never edit the generated subagent files.

## Option C: mix

Run the chief of staff, CTO and builders as threads, and keep reviewers and QA as subagents the builders call. The protocols are the same either way.

## Secrets

- Never put tokens in briefs, memory, chat or `.agent-team/config.sh`.
- The hosted board's write token lives in `~/.agent-team/<project>/team.env` (mode 600).
- When a role needs a new key, it tells you the secret's name and where to paste it, nothing more.

## Cost control

- No cap on threads, but the chief of staff wakes only the roles the current stage needs.
- When you hit a usage cap the priority is release-blocking fixes, then QA, then features, then keepers.
- The people and team ops lead reviews usage per role monthly and proposes tier changes; you approve them.
