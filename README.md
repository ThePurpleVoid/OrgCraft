# Agent Team Kit

**Run a whole company of Claude Code agents on your repository.** One door for you, an executive per lane, and 48 role briefs (CTO, architect, devs, QA, reviewers, release manager, designers, marketing, sales, support, finance, legal and more) that hand work to each other in fixed shapes, sign off with evidence, and report to a board you can watch.

The kit grew out of a real product built by a team of Claude threads. It is the operating manual that made that team work, with the project-specific parts taken out.

```
Owner
└─ chief-of-staff                      the one door; daily digest
   ├─ cto ─ Engineering                architect, backend, web, mobile, AI, payments, security, release, infra, docs
   │  └─ head-of-quality               QA web and mobile, backend tests, automation, performance, triage
   ├─ cpo ─ Product and design         product manager, design director + style threads, critic, UX writer
   ├─ cmo, cro ─ Go-to-market          marketing, brand, sales, partnerships        (dormant until needed)
   ├─ cco ─ Customer                   onboarding, support, community               (dormant until needed)
   └─ cfo, general-counsel, coo        finance, legal, compliance, strategy, team ops (dormant until needed)
```

## Why

Give one agent a big task and it does everything at once, badly. Give ten agents the same task and they trip over each other. The kit adds the parts a real team relies on:

- **One door.** You talk to the chief of staff only. Your words travel down the tree verbatim, quoted, with an issue id, so nothing gets lost in paraphrase.
- **One writer per path.** Every folder has an owner. Everything else is a request.
- **Fixed message shapes.** HANDOFF, BUG, SIGNOFF and BLOCKED, each with required fields. A SIGNOFF without screenshots or logs is invalid.
- **Separation of duties.** The author never approves their own work: a QA role walks it, a reviewer reads it, a critic judges the visuals, the security reviewer reads anything touching auth or money.
- **Memory that survives threads.** Every role keeps a five-part memory file and resumes from it.
- **A board.** Every role reports what it is doing, so you (and the chief of staff's daily digest) see the whole team at a glance.
- **Shared hardware without melting it.** Builds, emulators and local backends run through lock slots.

## Use it in your repository

The kit is a dependency, not a template. Your repository keeps only what is specific to it, in `.agent-team/`; the briefs, protocols and scripts are generated from a pinned kit version. Improve the kit once and every team picks it up on the next sync.

Requirements: git, bash, `jq` and Node 18+. Claude Code with project threads (claude.ai) or the CLI.

```sh
cd ~/code/my-app
npx --yes github:PurpleGiragge/Agent-Team-Kit#v0.1.0 init --preset engineering --project "My App" --owner "Sam" --timezone "Pacific"
```

Then:

1. Edit `docs/team/ownership.md` so the paths match your layout.
2. Edit the gates and hardware pools in `.agent-team/config.sh`.
3. Paste `docs/team/project-instructions.md` into your Claude project's instructions (or into `CLAUDE.md`).
4. Commit `.agent-team/`, `docs/team/` and `scripts/agent-team/`, and add `scripts/agent-team/sync.sh check` to CI.
5. Open the chief of staff: *"You are the chief of staff. Read docs/team/roles/chief-of-staff.md and docs/team/protocols.md, then tell me what you need from me."*
6. Ask for something. Watch it live with `node scripts/agent-team/dashboard.mjs` (a web dashboard at http://localhost:4747) or `scripts/agent-team/team-board.sh` in the terminal.

### What lives where

```
your-repo/
  .agent-team/                  yours: the project layer
    team.json                   kit version, preset, include/exclude, project values
    config.sh                   merge gates, hardware pools, janitor extras
    roles/<role>.extend.md      change a kit role: extra rules, another model tier, a replaced section
    roles/<role>.md             your own roles (or a full replacement of a kit role)
    protocols.extend.md         project-wide rules
    kit.lock.json               what sync generated, for "sync.sh check"
  docs/team/
    ownership.md, lanes/        yours: who writes which path, each executive's priorities
    protocols.md, roles/, ...   generated, do not edit
  scripts/agent-team/           generated: team-status, team-board, dashboard, merge-gate, with-lock, janitor, roster, sync
```

`scripts/agent-team/sync.sh` regenerates from `.agent-team/`. To upgrade, change `"kit"` in `team.json` to a newer tag and run it. `scripts/agent-team/sync.sh roles` shows every role and whether it comes from the kit, an extension or your repository.

[examples/native-mobile](examples/native-mobile) is a complete project layer for a product with Android and iOS apps: it adds four roles, replaces two direct-report lists, extends three roles and defines Gradle and Xcode gates, without copying anything from the kit.

### Presets

| Preset | Roles | For |
| --- | --- | --- |
| `minimal` | 11 | A small product: chief of staff, CTO, PM, architect, backend, web, reviewer, security, QA, release, docs |
| `engineering` (default) | 28 | The full product and engineering organisation |
| `company` | 48 | Everything, with business roles dormant until a request needs them |

## Two ways to run the team

**Threads (the original setup).** Each role is its own long-lived Claude Code thread in a claude.ai project, running as Remote Control or cloud sessions on your repository. The chief of staff is the project coordinator and wakes roles as the work needs them. Best for long-running products: roles work in parallel, each in its own worktree, and keep their own memory.

**Subagents (one session).** Set `"subagents": true` in `team.json` (or pass `--subagents` to `init`) and sync writes every active role to `.claude/agents/`. One Claude Code session can then delegate to `architect`, `backend-dev`, `qa-web` or `code-reviewer` on demand. Best for trying the kit or for smaller projects.

See [docs/running-the-team.md](docs/running-the-team.md) for both.

## What is in this repository

```
bin/agent-team.mjs              the CLI: init, sync, check, roles, dashboard
presets/                        role lists for minimal, engineering, company
team/                           the framework: protocols, project instructions, ownership seed, 48 role briefs
scripts/                        runtime scripts generated into scripts/agent-team/
tools/                          roster checker, subagent export and the dashboard (server + page), generated into scripts/agent-team/
templates/                      config.sh, sync.sh and the roles README for new projects
examples/native-mobile/         a full project layer for native Android and iOS apps
board/supabase/                 optional hosted board (table, views, Edge Function)
docs/                           how it works, running the team, customising, the dashboard
tests/                          tests for the CLI, scripts and tools
```

## Anatomy of a role brief

```markdown
# Backend dev

**Model:** standard                 tier: deep, standard, routine or light
**Group:** engineering              board band
**Reports to:** cto                 the org tree is built from this line
**Status:** dormant until ...       (optional) opened only when a request needs it

## Identity        what this role owns and how it is judged
## Owns (writes)   its paths; everything else is a request
## Tools           skills, plugins, MCP servers
## Wakes on        what starts a task
## Hands to        who it sends work to
## Rules           two to five role-specific rules
## Every thread, every task   the shared footer: memory, protocols, board reports
```

`node scripts/agent-team/roster.mjs --check` validates every brief (tiers, reporting lines, loops, direct reports) and `--tree` prints the org.

## The board and the live dashboard

Every task starts with a report and every message is reported with the same fields:

```sh
scripts/agent-team/team-status.sh web-dev status working --task "Login page" --issue 12
scripts/agent-team/team-status.sh web-dev handoff waiting --to qa-web --task "Login page" --pr 14
```

Open the dashboard and leave it open. It draws your team from the role briefs, as an org chart and as a flow of hand-offs, and each role lights up the moment its thread reports. Click a role for its task, links, brief and history.

```sh
node scripts/agent-team/dashboard.mjs            # http://localhost:4747
npx --yes github:PurpleGiragge/Agent-Team-Kit dashboard --demo   # see it work with made-up reports first
```

![The team dashboard: org chart coloured by each thread's last report](docs/images/dashboard-org.png)

No setup: the threads write to `~/.agent-team/<project>/events.jsonl` and the dashboard watches that file. Threads on other machines or in the cloud set `TEAM_REPORT_URL=http://<your machine>:4747/api/report` and report straight to it. To see the team from anywhere, put the same dashboard on your website, reading a [hosted board](board/supabase/README.md). [docs/dashboard.md](docs/dashboard.md) covers all three.

In a terminal, `scripts/agent-team/team-board.sh` shows the same thing:

```
ROLE     STATUS   AGE  TASK              WAITING ON
web-dev  waiting  0m   Login page PR 14  qa-web
cto      working  3m   Plan Q1
```

## Recommended plugins

The briefs work on their own and get better with these: [superpowers](https://github.com/obra/superpowers) (the method: brainstorm, plan, TDD, verify), [karpathy-guidelines](https://github.com/multica-ai/andrej-karpathy-skills) (code style), [i-have-adhd](https://github.com/ayghri/i-have-adhd) (messages to the owner lead with the next action), and [Octopus](https://github.com/nyldn/claude-octopus) (`/octo:council` second opinions on hard-to-undo decisions).

## Docs

- [How it works](docs/how-it-works.md): the org, the lanes, how a request becomes a merged PR
- [Running the team](docs/running-the-team.md): threads or subagents, worktrees, meetings
- [Customising](docs/customizing.md): extend or add roles, gates and pools, upgrade the kit
- [The dashboard](docs/dashboard.md): run it locally, report from other machines, put it on your website

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
