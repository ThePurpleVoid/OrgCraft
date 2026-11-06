# {{PROJECT_NAME}}: instructions for every coding agent on the team

This repository is run by a team of agents. Each session plays one role on that team. These instructions are the same for every role and every coding agent; your role's own brief comes on top of them.

## Who you are

Your role is `AGENT_TEAM_ROLE` in `.agent-team/local.env` when this checkout has one, or the role your first message names ("You are web-dev. Read docs/team/roles/web-dev.md"). If neither names a role, ask whoever started the session which role you play before you do anything else. The roles are the files in `docs/team/roles/`.

## Before anything else, in every task

1. Report that you started, before reading or changing anything: `node scripts/agent-team/report.mjs <role> status working --task "<task>"`.
2. Read your brief, `docs/team/roles/<role>.md`, and `docs/team/protocols.md`. Work only in the areas your brief and `docs/team/ownership.md` give you.
3. Read your memory file and resume from it. If your tool keeps project memory, it is `roles/<role>.md` there. Otherwise it is `memory/<role>.md` in the team's board folder (`AGENT_TEAM_HOME` in `.agent-team/local.env`), or `.agent-team/memory/<role>.md` in this checkout when there is no board folder. Create it on your first task. Rewrite it at the end of every task with five sections: Identity, Current task, Open items, Decisions, Lessons. Never put a secret in it.

## Reporting to the board

Nothing reports for you: the board knows only what you tell it, so a role that stops reporting looks gone. Use the Node reporter (it needs no bash and no `jq`; `scripts/agent-team/team-status.sh` takes the same arguments where bash is installed):

```sh
node scripts/agent-team/report.mjs <role> status working --task "<task>"          # on start, and on every resume
node scripts/agent-team/report.mjs <role> heartbeat                               # at least every 15 minutes while working
node scripts/agent-team/report.mjs <role> status waiting --to <role>              # the moment you wait (or --detail "what")
node scripts/agent-team/report.mjs <role> handoff waiting --to <role> --task "<task>"
node scripts/agent-team/report.mjs <role> bug - --to <role> --severity 2 --evidence <path> --detail "<what>"
node scripts/agent-team/report.mjs <role> signoff done --to <role> --task "<task>" --evidence <paths>
node scripts/agent-team/report.mjs <role> blocked waiting --to chief-of-staff --detail "<the question, and your recommendation>"
node scripts/agent-team/report.mjs <role> status done
```

Model tiers in the briefs are names, not models: **deep** is your strongest model at high effort, **standard** a strong general model, **routine** a fast one and **light** the smallest. Use the closest your tool offers.
