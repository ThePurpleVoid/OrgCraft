# The {{PROJECT_NAME}} agent team

{{PROJECT_NAME}} is built by a team of Claude Code threads, one per role. The owner talks to one door, the chief of staff, who forwards the owner's words verbatim to the executive whose lane owns the request; executives route inside their lane.

The team comes from [Agent Team Kit](https://github.com/PurpleGiragge/Agent-Team-Kit), pinned in `.agent-team/team.json`. This repository holds only what is specific to {{PROJECT_NAME}}; everything else is generated.

## What is generated and what is ours

| Path | Owner | What it is |
| --- | --- | --- |
| `.agent-team/team.json` | us | Kit version, which roles, project values |
| `.agent-team/config.sh` | us | Merge gates, hardware pools, janitor extras |
| `.agent-team/roles/` | us | Role overrides (`<role>.md`), extensions (`<role>.extend.md`) and our own roles |
| `.agent-team/protocols.extend.md`, `instructions.extend.md` | us | Project rules added to the kit's protocols and project instructions |
| `docs/team/ownership.md`, `docs/team/lanes/` | us | Who writes which path; each executive's priorities |
| `docs/team/protocols.md`, `project-instructions.md`, `roles/`, this README | generated | Do not edit; change `.agent-team/` and run `scripts/agent-team/sync.sh` |
| `scripts/agent-team/` | generated | `team-status.sh`, `team-board.sh`, `dashboard.mjs` and `dashboard/`, `merge-gate.sh`, `with-lock.sh`, `janitor.sh`, `roster.mjs`, `export-subagents.mjs`, `sync.sh` |

`scripts/agent-team/sync.sh` regenerates everything from the pinned kit. `scripts/agent-team/sync.sh check` fails when a generated file was edited by hand or is out of date; run it in CI.

## Files

| File | What it is |
| --- | --- |
| `protocols.md` | The shared rules: one door, chain of command, when the owner steps in, fast and full lanes (and when the architect goes first), message shapes, board reports and heartbeat, PR flow, memory files, dormant roles, changing the team. |
| `ownership.md` | Which role writes which path. One writer per path. |
| `project-instructions.md` | The text that goes into the Claude project's instructions (or `CLAUDE.md`). |
| `roles/<role>.md` | The kickoff brief for each role. A thread starts by reading its brief, then its memory file. |
| `role-template.md` | The shape of a brief; copy it into `.agent-team/roles/` to add a role. |
| `lanes/<executive>.md` | Each executive's priorities and decisions. |

Watch the team live with `node scripts/agent-team/dashboard.mjs` (http://localhost:4747); see the kit's [dashboard guide](https://github.com/PurpleGiragge/Agent-Team-Kit/blob/main/docs/dashboard.md) for reports from other machines and a copy on your website.

Print the org tree with `node scripts/agent-team/roster.mjs --tree` and check the briefs with `node scripts/agent-team/roster.mjs --check`.
