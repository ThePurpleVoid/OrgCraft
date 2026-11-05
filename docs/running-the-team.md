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
- **Cloud sessions** are fine for roles that only read and write files (executives, writers, reviewers, business roles). Point them at the [hosted board](../board/supabase/README.md) or at your local [dashboard](dashboard.md) so their reports land in one place.

### Routines

Schedule these as recurring tasks (or cron on the team machine):

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
