# Automatic reporting and Claude Code agent teams

## Hooks: the board stays current without the roles remembering

Every brief tells its role to report: `status working` first, a heartbeat while it works, `waiting` when it waits. A role that forgets goes quiet on the board. With hooks on, Claude Code reports for it.

`"hooks": true` in `.agent-team/team.json` (the default for new projects) makes sync add the kit's hooks to `.claude/settings.json`. Sync owns only its own handlers there: your permissions, env and other hooks are kept, and `sync.sh check` fails when the kit's handlers are missing or out of date. Each handler runs `node scripts/agent-team/report.mjs hook`, which reads the hook event and writes the same report `team-status.sh` would, to the same places (the local event log, and `TEAM_REPORT_URL` when set), with `"source": "hook"`.

| Claude Code event | Report |
| --- | --- |
| `SessionStart`, `UserPromptSubmit` | `status working`, keeping the last task. A role that said it is `waiting`, `blocked` or in `review` keeps that status and gets a heartbeat. |
| `PostToolUse`, `PreCompact` | `heartbeat`, at most one every 5 minutes |
| `Stop` (end of a turn), `SessionEnd` | `status idle` when the role was working; a waiting role keeps its status |
| `SubagentStart` / `SubagentStop` | the subagent's role: `working`, then `done` with its final message as the detail |
| `TeammateIdle` / `TaskCompleted` | the teammate's role: `idle`, or `done` with the task's subject |

Who the report is for:

- A **subagent or teammate** is its agent type. The kit's subagents are named after their roles, so a `code-reviewer` subagent reports as `code-reviewer`. Built-in agents (Explore, Plan) and anything that is not one of your roles are not reported.
- The **main session** is the role in `AGENT_TEAM_ROLE` (and `AGENT_TEAM_INSTANCE` for a pool instance). Start a role's session with it, or put it in that thread's environment: `AGENT_TEAM_ROLE=backend-dev claude`. Without it, the main session is not reported; its subagents still are.

The hooks never print anything (output from `SessionStart` would reach the model), never fail, and run in the background except at the end of a turn, which reports before Claude Code moves on. Hooks do not replace the roles' own reports: a HANDOFF, BUG, SIGNOFF or BLOCKED still comes from the role, because only the role knows whom it hands to and why. Hooks make sure the board never says "working" about a thread that stopped hours ago, or nothing about one that never reported.

Turn them off with `"hooks": false` and sync removes the kit's handlers.

## Claude Code agent teams

Claude Code's [agent teams](https://code.claude.com/docs/en/agent-teams) (experimental) run a lead session and several teammates that share a task list and message each other. `"agentTeams": true` in `team.json` sets the team up for it:

- every active role becomes a teammate type in `.claude/agents/<role>.md` (the same files `"subagents": true` writes);
- `.claude/settings.json` gets `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` and the hooks above, including `TeammateIdle` and `TaskCompleted`;
- `docs/team/agent-teams.md` explains how to start a team and gives each lead (the chief of staff and every role with direct reports) a prompt that spawns its reports by agent type.

```sh
AGENT_TEAM_ROLE=cto claude
> Create an agent team for the invoices API. You are the CTO: read docs/team/roles/cto.md ... Spawn ... backend-dev, code-reviewer ...
```

Claude Code keeps an agent team's state in `~/.claude/teams/` and builds it at run time; there is no project file for the team itself, which is why the kit exports the roles and the prompts, not a team file. Agent teams need an interactive session, allow one team per session and no nested teams, so they suit a lead working on one job with its reports. Long-running work across many lanes is still better as [threads](running-the-team.md), and both report to the same board.

## Check the setup

```sh
npx --yes github:PurpleGiragge/Agent-Team-Kit#v0.8.0 doctor
```

`doctor` checks the tools the scripts need, that the generated files and the hooks match `.agent-team/`, the roster and its hand-offs, and runs a hook event through the reporter into a scratch board to prove the pipeline works. `--ping` also posts a note to `TEAM_REPORT_URL`. It exits 1 when anything fails, so it can run in CI next to `sync.sh check`.
