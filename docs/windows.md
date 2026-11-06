# Windows, and machines without bash or jq

Everything that keeps the team in sync and on the board runs on Node alone:

| Job | Command | Needs |
| --- | --- | --- |
| Set up, sync, check | `npx --yes github:PurpleGiragge/Agent-Team-Kit#v0.8.0 init` then `node scripts/agent-team/sync.mjs [check]` | Node 18+, git |
| Report to the board | `node scripts/agent-team/report.mjs web-dev status working --task "Login page"` | Node |
| Automatic reports | the Claude Code hooks (`"hooks": true`) | Node |
| See the board | `node scripts/agent-team/dashboard.mjs` | Node |
| Smoke test | `npx --yes github:PurpleGiragge/Agent-Team-Kit#v0.8.0 doctor` | Node |

`report.mjs` takes exactly the arguments of `team-status.sh` and writes the same event, so a brief's `team-status.sh` line works with `node scripts/agent-team/report.mjs` in its place. On a machine with bash but no `jq`, `team-status.sh` hands over to `report.mjs` by itself.

What still needs bash: the merge gate (`merge-gate.sh`), hardware locks (`with-lock.sh`), `team-board.sh` and `janitor.sh`, and your own gates in `.agent-team/config.sh`, which are bash functions. On Windows run those from Git Bash (installed with Git for Windows) or WSL. The hooks are a single `node` command each, so they do not depend on which shell Claude Code runs them in.

Put `TEAM_REPORT_URL` and `TEAM_REPORT_TOKEN` in `%USERPROFILE%\.agent-team\<project>\team.env` (or the environment); `report.mjs` reads the same `KEY=value` lines `team-status.sh` sources.
