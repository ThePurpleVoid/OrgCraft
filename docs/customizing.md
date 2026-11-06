# Customising

Your repository never edits the kit's files. It describes its differences in `.agent-team/`, and `scripts/agent-team/sync.sh` generates the team from the pinned kit plus those differences. That keeps your team small to maintain and lets kit improvements reach you on the next upgrade.

After any change below, run `scripts/agent-team/sync.sh`, then commit `.agent-team/` together with what it regenerated.

## Choose the roles

In `.agent-team/team.json`:

```json
{
  "kit": "github:PurpleGiragge/Agent-Team-Kit#v0.11.1",
  "preset": "engineering",
  "include": ["analytics-lead"],
  "exclude": ["mobile-dev", "qa-mobile"],
  "values": { "PROJECT_NAME": "My App", "OWNER": "Sam", "TIMEZONE": "UTC", "DIGEST_TIME": "08:00" },
  "subagents": false,
  "hooks": true,
  "agentTeams": false
}
```

`hooks` merges the kit's reporting hooks into `.claude/settings.json`, and `agentTeams` sets the team up for Claude Code agent teams; see [hooks and agent teams](hooks-and-agent-teams.md).

`include` adds kit roles outside the preset; `exclude` drops them. `exclude` also switches off one of your own roles (`.agent-team/roles/<slug>.md`) without deleting it: the file stays, the role is not installed, and taking it out of `exclude` brings it back as it was. The Studio does this when you switch a custom agent off. Reporting lines follow automatically: a role whose manager is not installed reports to the chief of staff, and direct-report lists show only installed roles.

`"dashboard": { "export": "<folder>", "repo": "<url>" }` also writes the team dashboard into your website's source; see [the dashboard guide](dashboard.md#3-on-your-website-readable-from-anywhere).

`values` fills `{{PROJECT_NAME}}`-style placeholders in the generated docs. You can add your own keys and use them in your own role files.

## Change a kit role: `<role>.extend.md`

Prefer an extension to a replacement, so kit improvements to the rest of the brief still reach you.

```markdown
**Model:** deep (high effort)

## Tools
Our feature-flag CLI

## Rules
- Every schema change needs the CTO's approval in the PR.

## Owns (writes) (replace)
api/, migrations/
```

- A `# Title` line renames the role.
- A `**Field:** value` line replaces that header field (or adds it).
- `## Section` appends to the kit section of the same name; a new section goes before the shared footer.
- `## Section (replace)` replaces the kit section.

## Add a role: `<new-role>.md`

Copy `docs/team/role-template.md` into `.agent-team/roles/<new-role>.md`, fill it in, add its paths to `docs/team/ownership.md` and add it to its executive with a `## Direct reports` extension. Split a generic role this way, for example `mobile-dev` into `android-dev` and `ios-dev` (see [examples/native-mobile](../examples/native-mobile)).

### Wakes on and sign-off evidence

Two sections of a brief are also read as data (kit 0.10). Both are optional, and free text keeps working.

`## Wakes on` lists the events that start a task, one `- ` line each. The runner reads lines in these forms and nothing else:

| Line | Wakes the role when |
| --- | --- |
| `- handoff` | a HANDOFF is addressed to it |
| `- meeting` | it is invited to a meeting |
| `- pr-paths: apps/web/**, tests/a11y/` | a pull request changes one of these areas (comma-separated) |
| `- label: a11y` | an issue or pull request gets this label |
| `- issue-label: bug` | an issue gets this label |
| `- schedule: mon-fri 09:30` | at this time in the team's `TIMEZONE`. Days are `mon` to `sun`, ranges (`mon-fri`), lists (`tue,thu`), `daily` or `weekdays` |

`validate` warns about a malformed line of these kinds (a bad time, a missing value). For a custom agent it also warns about lines the runner does not read; kit roles are free text today.

`## Sign-off evidence` lists, one `- ` line each, what a SIGNOFF from this role must carry (a screenshot of each changed screen, the test log, a link to the run). `validate` warns when a role whose `Hands to` mentions SIGNOFF has none.

### Share an agent: role packs

A role pack is a folder another team can import: `<slug>.md` and a `pack.json`. The Studio exports one from **Your agents**.

```json
{
  "schema": "agent-team/role-pack@1",
  "roles": ["accessibility-auditor"],
  "kit": "0.10.0",
  "needs": {
    "tools": ["Playwright", "axe"],
    "resources": ["postgres"],
    "paths": ["tests/a11y/"],
    "wakes": [{ "type": "pr-paths", "value": "apps/web/**" }]
  }
}
```

`roles` lists the briefs in the folder. `needs` says what the agent expects: tools, the types of systems it is bound to (never their details or secrets), the areas it writes and its structured wakes. `kit` and `needs.wakes` were added in 0.10; every field but `roles` is optional, and a folder of `.md` files without `pack.json` imports too. On import every brief gets the full checks, including the secret scan.

## Meetings: `meetings.json`

`.agent-team/meetings.json` defines the team's recurring and event-triggered meetings. The Studio's Meetings view edits it; you can write it by hand too. The runner holds the meetings; until a runner is connected they are definitions the chief of staff keeps as a schedule.

```json
{ "meetings": [ {
  "id": "standup", "title": "Daily standup",
  "when": { "days": ["mon", "tue", "wed", "thu", "fri"], "at": "09:00" },
  "attendees": { "roles": ["web-dev", "backend-dev"], "lanes": ["cto"], "rule": null },
  "facilitator": "chief-of-staff", "format": "round", "rounds": 1,
  "agenda": "1. Done since last time\n2. Next\n3. Blocked on",
  "ifBusy": "next-pause", "owner": { "minutes": true, "speaks": false },
  "capUsd": 1.0, "skipIfQuiet": true
} ] }
```

- `when` is days and a wall-clock time in the team's `TIMEZONE`, or `{ "label": "design" }` for a meeting that starts when an item gets that label.
- `attendees` names roles, whole lanes (an executive and everyone reporting up to it; dormant roles only when named) and optionally the rule `"worked-since-last"`. `facilitator` runs it.
- `format` is `round` (each attendee answers once) or `discussion` (2 to 5 `rounds`). `ifBusy` is `next-pause`, `proxy` (answered for it from the board) or `skip`.
- `capUsd` is the most one meeting may cost; it must be above zero and not above the team's daily cap.

`sync` adds a **Meetings** table to the project instructions and `- meeting` to the `Wakes on` of every role a meeting names. `validate` checks that attendees and the facilitator are on the team, ids are unique, days and times are valid, the agenda is not empty and the cap is in range. It warns when two meetings share a role at the same time and when a meeting has fewer than two attendees besides the facilitator.

Cost estimates use the kit's dated price table, [`packages/model-prices/prices.json`](../packages/model-prices), and each role's model tier.

## Replace a kit role: `<role>.md`

A file with a kit role's name replaces that brief entirely. Use it only when an extension cannot express the change.

**When a new kit adds a role with your custom agent's name**, sync stops and says so, instead of letting your file silently replace the new kit role (kit.lock.json records which roles the kit had at your last sync). Rename your file to a new slug (and the `team-status.sh <slug>` lines inside it), delete it to use the kit's role, or keep it as a deliberate replacement by listing it in `team.json`:

```json
{ "replaces": ["qa-web"] }
```

## Project-wide rules

- `.agent-team/protocols.extend.md` is appended to the protocols as "<Project> rules".
- `.agent-team/instructions.extend.md` is appended to the project instructions.

## Merge gates and hardware pools

Gates can be data in `.agent-team/gates.json` (see [the data files](#ownership-gates-and-systems-as-data-optional)), which both `merge-gate.sh` and the bash-free `node scripts/agent-team/merge-gate.mjs` run, or bash functions in `.agent-team/config.sh`, which need bash ([Windows](windows.md)).

`.agent-team/config.sh` is plain bash, sourced by every script. Gates are functions:

```bash
AGENT_TEAM_GATES_ALL="api web"
AGENT_TEAM_POOLS="build:3 browser:4 backend:1"

gate_api() {
  run "api: tests" locked backend bash -c "cd api && go test ./..."
}
gate_web() {
  run "web: build" locked build bash -c "cd web && npm ci && npm run build"
}
```

`scripts/agent-team/merge-gate.sh web` runs one target, `all` runs `AGENT_TEAM_GATES_ALL`, `--list` shows what is defined. `with-lock.sh <pool> -- <command>` waits for a free slot (up to `WITH_LOCK_TIMEOUT`, default 20 minutes) and exits 75 if none frees up, so the thread can send BLOCKED instead of hanging. Environment variables override the config, which helps in CI. A `janitor_extra` function adds project cleanup to the nightly janitor.

## Ownership and lanes

`docs/team/ownership.md` and `docs/team/lanes/` belong to your repository. `init` seeds them once; sync never touches them.

## Upgrade the kit

Change `"kit"` in `team.json` to the new tag, run `scripts/agent-team/sync.sh`, and review the diff of `docs/team/` and `scripts/agent-team/` like any dependency upgrade. `sync.sh check` in CI fails if someone edits a generated file by hand or forgets to sync.

## Improve the kit for everyone

If a change would help every team (a better rule, a script fix, a new generic role), open a pull request on Agent Team Kit instead of keeping it in your overlay. See [CONTRIBUTING.md](../CONTRIBUTING.md).

## Ownership, gates and systems as data (optional)

Three optional files in `.agent-team/` hold, as data, what you would otherwise write by hand. The visual team builder edits these files, and you can edit them by hand too. Run `scripts/agent-team/sync.sh` after a change, and `agent-team validate` to check the team.

```jsonc
// .agent-team/ownership.json: sync generates docs/team/ownership.md from it (and owns that file from then on)
{ "rows": [ { "path": "apps/web/", "writer": "web-dev", "notes": "" } ] }

// .agent-team/gates.json: sync generates scripts/agent-team/gates.sh; a target here replaces gate_<target> in config.sh
{ "all": ["web"], "pools": { "build": 2 }, "targets": { "web": [ { "name": "build", "run": "npm ci && npm run build", "pool": "build" } ] } }

// .agent-team/resources.json: a Systems table in the project instructions, and a Systems section in each bound role's brief
{ "resources": [ { "id": "db", "type": "postgres", "name": "Main database", "config": { "database": "app" }, "secrets": ["DATABASE_URL"] } ],
  "bindings": [ { "role": "backend-dev", "resource": "db", "permission": "write" } ] }
```

Secrets appear only by name. Their values go in the environment (for example `~/.agent-team/<project>/team.env`), never in these files.

`agent-team import` prints the whole team, these files included, as one JSON document (see [packages/team-model](../packages/team-model)). `agent-team compile <spec.json>` writes it back.
