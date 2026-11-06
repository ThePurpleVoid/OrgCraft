# Event envelope, version 1

Everything that happens in a team is one append-only stream of events: a role's report, a message between roles, an owner's chat message, an approval, a run starting, a publish. The board, the audit log, notifications, meetings, transitions and evals are all **projections** of this stream. Current-state tables can be dropped and rebuilt from it. History is never rewritten.

The envelope is compatible with [CloudEvents 1.0](https://cloudevents.io), so any CloudEvents tool can carry it.

```json
{
  "specversion": "1.0",
  "id": "01JC8Z7Q6V9W3X2Y1Z0A9B8C7D",
  "type": "report.status",
  "version": 1,
  "source": "/tenants/acme/teams/my-app",
  "tenant": "acme",
  "team": "my-app",
  "time": "2026-11-06T01:12:03.120Z",
  "actor": { "kind": "role", "id": "web-dev", "instance": null, "session": "ses_4k2…", "via": "hook" },
  "subject": "role/web-dev",
  "run": "run_7h1…",
  "teamVersion": "3f9c2ab",
  "data": { "status": "working", "task": "Login page", "issue": 12, "branch": "web/12-login" }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `specversion` | yes | Always `"1.0"` (CloudEvents). |
| `id` | yes | Unique per tenant. Sortable by time (ULID) when we mint it. A client may send its own id, and a repeated id is stored once, which makes retries safe. |
| `type` | yes | What happened, as `<area>.<name>`. See the catalogue below. |
| `version` | yes | Version of `data` for this `type`. Readers upcast older versions on read. |
| `source` | yes | `/tenants/{tenant}/teams/{team}`, or `/tenants/{tenant}` for workspace events. |
| `tenant`, `team` | yes, `team` when it applies | Copied out of `source` for indexing. Every stored event has `tenant`. |
| `time` | yes | When it happened, in ISO 8601 UTC. Reports may carry their own time. Otherwise it is the time we received them. |
| `actor` | yes | Who did it. `kind` is one of `role`, `person`, `runner` or `system`. `id` is a role slug, member id, runner id or service name. `instance` tells pool roles apart. `session` is the agent session. `via` says how the event arrived: `hook`, `script` (team-status.sh, report.mjs), `tool` (the team tool server), `studio` or `api`. |
| `subject` | no | What it is about: `role/<slug>`, `run/<id>`, `approval/<id>`, `pr/<n>`, `meeting/<id>`. |
| `run`, `teamVersion` | no | The run, and the published team version (commit SHA) the actor was running. Change safety uses them (ADR 0004). |
| `data` | yes | The event's own fields. Its shape depends on `type` and `version`. |

Limits: an event is at most 64 KiB, and evidence is links, not payloads. Secrets never appear in any field. The ingest redacts anything that matches the secret patterns `validate` uses, and records that a redaction happened.

## The catalogue (version 1)

### Reports: the kit's board, unchanged

These are the reports teams on the kit send today. `data` holds the kit report fields (`tools/board.mjs` `toRow`) without `id`, `at` and `role`, which move to the envelope.

| `type` | From kit `kind` | `data` |
| --- | --- | --- |
| `report.status` | `status` | `status` (idle, working, waiting, blocked, review, done), `task`, `issue`, `pr`, `branch`, `commit`, `platform`, `detail` |
| `report.heartbeat` | `heartbeat` | as `report.status`, with `status` optional |
| `report.note` | `note` | `detail`, plus any of the above |
| `message.handoff`, `message.bug`, `message.signoff`, `message.blocked` | `handoff`, `bug`, `signoff`, `blocked` | `to` (role slug, `#instance` allowed), `task`, `issue`, `pr`, `branch`, `severity` (bug, 1 to 4), `evidence` (links, at most 20), `detail` |

Messages sent with the team tools ([team-tools.md](team-tools.md)) also carry their structured fields in `data`, next to the kit fields and a composed `detail`: `changed`, `verify`, `doneWhen`, `artifact` (handoff); `where`, `steps`, `expected`, `actual`, `build` (bug); `testedOn`, `walked`, `result` (signoff); `need`, `needFrom`, `meanwhile`, `recommendation` (blocked). Readers that only know the kit fields lose nothing they need.

The mapping is exact in both directions. That is how the webhook sink forwards these events to a board that already exists, such as a team's own `team-report` function, in the old shape with nothing lost.

### Runs and sessions (the runner)

| `type` | `data` |
| --- | --- |
| `run.started`, `run.paused`, `run.resumed`, `run.stopped` | `mode` (subagents, runner, agent-teams), `by` (member), `caps` (cost per run and per day, concurrency), `reason` |
| `session.queued` | `role`, `instance`, `reason` (the run's session cap), `position` |
| `session.started`, `session.idle`, `session.ended` | `role`, `instance`, `worktree`, `branch`, `model` (provider and name, as values), `reason` |
| `session.tool` | `tool`, `target` (path, command or MCP server and tool), `decision` (allowed, refused, needs-approval), `rule` |
| `proposal.opened`, `proposal.updated`, `proposal.accepted`, `proposal.failed` | `connector` (for example `github`), `ref` (for a repository, the pull request number), `url`, `branch`, `headSha`, `approval` (on accepted and failed), `result` (the merge commit, on accepted), `reason` (on failed: head-moved, checks, conflict). Emitted by the runner, which proposes and accepts for its sessions (work contract `propose` and `accept`) |
| `usage.recorded` | `inputTokens`, `outputTokens`, `cost` (in the currency's minor unit), `currency` |
| `budget.warned` (at 80% of the day's cap), `budget.exhausted` | `scope` (day, run), `day` (UTC date), `spent`, `cap` (minor units), `currency`, `cardId` (string: the budget card's id, on exhausted) |
| `budget.updated` | `currency`, `perDay`, `perRun` (minor units, or null), `sessions`, `by` (member): the team's caps after a change |

### Owner, chat and approvals

| `type` | `data` |
| --- | --- |
| `chat.message` | `from` (member or role), `text` (verbatim for the owner; the dilution rule), `replyTo`, `attachments` (links), `clientId` (the id the client made, so a resend is stored once) |
| `decision.requested`, `decision.answered` | `question`, `options`, `recommended`, `answer`, `by`, `cardId` (string), `session` (the session that asked, which the answer wakes) |
| `approval.requested` | `action` (a classification from the policy), `command` or `call`, `why`, `summary` and `recommendation` (optional, shown in the approval email), `risk`, `expires`, `cardId` (string), `session`, `pr` and `headSha` (for `accept`: the approval is for that exact head) |
| `approval.decided` | `approval`, `decision` (approved, denied, expired, superseded: the head moved), `by` (member), `note`, `session`, `headSha` |
| `card.updated` | `card` (object): the whole card at its new `version` ([clients.md](clients.md) section 6). Emitted on every change (created, answered, expired, superseded); a client keeps the latest per card id |

### Team and connectors

| `type` | `data` |
| --- | --- |
| `team.published` | `version` (commit SHA), `pr`, `changes` (paths), `by` |
| `team.transition` | `from`, `to`, `items` (per in-flight item: role, choice, state). See ADR 0004 |
| `connector.connected`, `connector.health`, `connector.revoked` | `connector`, `resource`, `status`, `detail` |
| `notification.sent`, `notification.failed` | `channel`, `to` (member), `event` (the id it was about), `attempt` |
| `meeting.minutes` | `meeting` (its name), `meetingId`, `date`, `decisions` (each `{ text }`), `actions`, `needsYou` (how many items need the owner). Emitted by the meeting's clerk when it publishes the minutes; the email sink sends it to people who switched on "Meeting minutes" |

New types are added to this catalogue in the same PR that first emits them.

## Ordering and delivery

- Events of one `(team, actor.id, actor.instance)` are delivered in `time` order. Nothing is promised across actors. The board sorts by `time`.
- Ingest is at-least-once with idempotent ids. Consumers (projections, sinks, notifications) keep a cursor per consumer and must be idempotent.
- The live stream (`GET /v1/teams/{team}/events/stream`, server-sent events) replays from `Last-Event-ID`, so a dropped connection loses nothing.
