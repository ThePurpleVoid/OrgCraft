# Windows, and machines without bash or jq

Everything that keeps the team in sync and on the board runs on Node alone:

| Job | Command | Needs |
| --- | --- | --- |
| Set up, sync, check | `npx --yes github:PurpleGiragge/Agent-Team-Kit#v0.11.1 init` then `node scripts/agent-team/sync.mjs [check]` | Node 18+, git |
| Report to the board | `node scripts/agent-team/report.mjs web-dev status working --task "Login page"` | Node |
| Automatic reports | the Claude Code hooks (`"hooks": true`) | Node |
| See the board | `node scripts/agent-team/dashboard.mjs` | Node |
| Merge gate | `node scripts/agent-team/merge-gate.mjs web` (targets in `.agent-team/gates.json`) | Node |
| Hardware locks | `node scripts/agent-team/with-lock.mjs build -- npm run build` | Node |
| Smoke test | `npx --yes github:PurpleGiragge/Agent-Team-Kit#v0.11.1 doctor` | Node |

`report.mjs` takes exactly the arguments of `team-status.sh` and writes the same event, so a brief's `team-status.sh` line works with `node scripts/agent-team/report.mjs` in its place. On a machine with bash but no `jq`, `team-status.sh` hands over to `report.mjs` by itself.

`merge-gate.mjs` and `with-lock.mjs` take the arguments of `merge-gate.sh` and `with-lock.sh` and give the same summary, logs, lock folders and exit codes (64 for usage, 75 when no slot frees up), so the two kinds can run side by side on one machine. The Node gate runs the targets in `.agent-team/gates.json`; each step's command goes to `bash -c` when bash is installed and to the system shell (`cmd.exe` on Windows) otherwise, so write steps that both shells understand, such as `npm ci && npm run build`. A target that is only a `gate_<name>` bash function in `.agent-team/config.sh` still needs bash: with bash installed, `merge-gate.mjs` hands the run to `merge-gate.sh`; without it, it stops and asks you to move the target into `gates.json`.

What still needs bash: `team-board.sh` and `janitor.sh`, and gates written as bash functions in `.agent-team/config.sh`. On Windows run those from Git Bash (installed with Git for Windows) or WSL. The hooks are a single `node` command each, so they do not depend on which shell Claude Code runs them in.

Put `TEAM_REPORT_URL` and `TEAM_REPORT_TOKEN` in `%USERPROFILE%\.agent-team\<project>\team.env` (or the environment); `report.mjs` reads the same `KEY=value` lines `team-status.sh` sources.
