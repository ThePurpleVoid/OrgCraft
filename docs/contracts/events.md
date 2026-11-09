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
| `time` | yes | When it happened, in ISO 8601 UTC. The control plane stores a `time` more than five minutes ahead of its own clock as the time it received the event. Reports may carry their own time. Otherwise it is the time we received them. |
| `actor` | yes | Who did it. `kind` is one of `role`, `person`, `runner` or `system`. `id` is a role slug, member id, runner id or service name. `instance` tells pool roles apart. `session` is the agent session. `via` says how the event arrived: `hook`, `script` (team-status.sh, report.mjs), `tool` (the team tool server), `studio` or `api`. |
| `subject` | no | What it is about: `role/<slug>`, `run/<id>`, `approval/<id>`, `pr/<n>`, `meeting/<id>`. |
| `run`, `teamVersion` | no | The run, and the published team version (commit SHA) the actor was running. Change safety and the rollout view use them (ADR 0004). A kit report (0.16 and later) fills it from the checkout: the last commit that changed `.agent-team`. |
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

Messages sent with the team tools ([team-tools.md](team-tools.md)) also carry their structured fields in `data`, next to the kit fields and a composed `detail`: `changed`, `verify`, `doneWhen`, `artifact` (handoff); `where`, `steps`, `expected`, `actual`, `build` (bug); `testedOn`, `walked`, `result`, `version`, `versionKind` (`commit`, `revision`, `draft`) and the runner's `checks` (signoff); `need`, `needFrom`, `meanwhile`, `recommendation` (blocked); and `unverified` on all four and on `report.status` (governance G1: an empty list is none, absent is not stated). Readers that only know the kit fields lose nothing they need.

The mapping is exact in both directions. That is how the webhook sink forwards these events to a board that already exists, such as a team's own `team-report` function, in the old shape with nothing lost.

### Runs and sessions (the runner)

| `type` | `data` |
| --- | --- |
| `run.started`, `run.paused`, `run.resumed`, `run.stopped` | `mode` (subagents, runner, agent-teams), `by` (member), `caps` (cost per run and per day, concurrency), `reason` |
| `live.changed` | A live change to the team, kept by the control plane and never in Git (L18): `op` (set, lifted, published), `override` (its id), `kind` (halt: Stop everything; member: one teammate), `member` (for member), `state` (paused, off), `by` (member), `reason`, `stepUp` (on lifted), `resumed` (on a lifted halt: the run ids it resumed). Written by the control plane only |
| `session.queued` | `role`, `instance`, `reason` (the run's session cap), `position` |
| `session.started`, `session.idle`, `session.ended` | `role`, `instance`, `worktree`, `branch`, `model` (provider and name, as values), `reason` |
| `session.tool` | `tool`, `target` (path, command or MCP server and tool), `decision` (allowed, refused, needs-approval), `rule`; set by the runner (N1, additive): `call` (an id per tool call, pairing the decision with its result), `effect` (read, write, send, destructive, payment, deploy; absent for a connector tool until its manifest says), `io` (the input's `step_io` id), `retryOf` (the `call` of an earlier failed or refused call with the same tool and input, within the session's last 20) |
| `session.result` | Once per allowed call when it finishes (N1): `call`, `tool`, `ok`, `durationMs`, `summary` (at most 300 characters, redacted, made from the call's tool and input only: never from its output, which stays in the deletable `io`), `io` (the output's `step_io` id), `outside` (true when the output came from outside the team: a web fetch or a connector). A refused call has none. A call that failed still has one, with `ok: false` |
| `proposal.opened`, `proposal.updated`, `proposal.accepted`, `proposal.failed` | `connector` (for example `github`), `ref` (for a repository, the pull request number), `url`, `branch`, `headSha`, `approval` (on accepted and failed), `result` (the merge commit, on accepted), `reason` (on failed: head-moved, checks, conflict, installation), `phase` (with installation: push, open, merge or preview), `detail`. Emitted by the runner, which proposes and accepts for its sessions (work contract `propose` and `accept`) |
| `proposal.previewed` | `connector`, `ref` (the pull request number), `sha` (the commit deployed: refused unless it is the full merge commit, `result`, of that PR's `proposal.accepted` on this team), `url` (https, no user or password), `environment`, `state` (always `success`: only a deployment that is up is sent), `deployment` (the provider's deployment id). Emitted by the runner after `proposal.accepted`, from the repository's deployment statuses. The control plane stores one per deployment (id `previewed-<ref>-<deployment>`, whatever the frame said) and adds the URL to that PR's open `ready` card |
| `usage.recorded` | `inputTokens`, `outputTokens`, `cost` (in the currency's minor unit), `currency`, `io` (optional: the turn's own text as a `step_io` id, when the team captures `all`), `meeting` (optional: the meeting whose turn this was; the server counts it toward that meeting's cap only when the session was given one of its turns, and otherwise ignores the tag) |
| `budget.warned` (at 80% of the day's cap), `budget.exhausted` | `scope` (day, run), `day` (UTC date), `spent`, `cap` (minor units), `currency`, `cardId` (string: the budget card's id, on exhausted) |
| `budget.updated` | `currency`, `perDay`, `perRun` (minor units, or null), `sessions`, `meetingCap` (minor units, or null for a tenth of `perDay`; at most `perDay`, and lowering `perDay` below it lowers it too), `by` (member): the team's caps after a change |

### Owner, chat and approvals

| `type` | `data` |
| --- | --- |
| `chat.message` | `from` (member or role), `text` (verbatim for the owner; the dilution rule), `replyTo`, `attachments` (links), `clientId` (the id the client made, so a resend is stored once), `meeting` (optional: set on a meeting's minutes) |
| `decision.requested`, `decision.answered` | `question`, `options`, `recommended`, `answer`, `by`, `cardId` (string), `session` (the session that asked, which the answer wakes) |
| `approval.requested` | `action` (a classification from the policy), `command` or `call`, `why`, `summary` and `recommendation` (optional, shown in the approval email), `risk`, `expires`, `cardId` (string), `session`, `pr` and `headSha` (for `accept`: the approval is for that exact head) |
| `approval.decided` | `approval`, `decision` (approved, denied, expired, superseded: the head moved), `by` (member), `note`, `session`, `headSha` |
| `ready.posted` | `pr`, `title`, `summary`, `commit` (the merge commit), `preview` and `environment` (when the deployment was already up), `issue`, `task`, `cardId`, `session`. The front door's `ready_to_try` ([team-tools.md](team-tools.md)); the email and Slack kind "Ready to try" (`ready`) follows it |
| `ready.previewed` | `pr`, `cardId`, `url`, `environment`: a preview arrived after the card went out, and the open card now links it |
| `card.updated` | `card` (object): the whole card at its new `version` ([clients.md](clients.md) section 6). Emitted on every change (created, answered, expired, superseded); a client keeps the latest per card id |

### Meetings

A meeting runs as a written round or, with `format: discussion`, as a discussion of up to `rounds` rounds in which every turn carries the whole transcript so attendees answer each other; an attendee that replies with `done: true` is not asked in later rounds, and when nobody is left the facilitator closes early. A missing `round` means 1 ([team-tools.md](team-tools.md), `meeting_reply` and `meeting_close`; [M3 design](../product/m3-design.md) section 2). Every one of these has `subject: meeting/<id>` and `data.meeting` (the instance, `mtg_…`) and `data.definition` (the id in `meetings.json`). Events a meeting causes elsewhere (`chat.message`, `report.note`, `message.handoff`, `message.blocked`, `decision.requested`, `usage.recorded`) carry the optional `data.meeting` too. A completed or capped close also emits `meeting.minutes` (below) for the email sink, in its existing shape, where `meeting` is the title and `meetingId` the instance. A facilitator that misses its closing turn gets `meeting.skipped` with `missed` and `closing: true`, then `meeting.closed` with outcome `abandoned`.

| `type` | `data` |
| --- | --- |
| `meeting.opened` | `title`, `agenda`, `facilitator`, `attendees` (role slugs, in turn order), `format`, `rounds` (1 for a written round, 2 to 5 for a discussion), `ifBusy`, `cap` (minor units), `currency`, `by` (member), `adhoc` (true for an unscheduled meeting, whose `definition` is `adhoc-<id>`) |
| `meeting.turn` | `to` (a role), `turn` and `of` (within the round: `of` counts the attendees asked this round, after those done), `round`, `rounds`, `title`, `agenda`, `closing` (the facilitator's closing turn), `capped`, `replies` so far (`{ role, text }`, plus `round` and `done` in a discussion; past 40 KB an attendee's earlier-round replies go first, then the oldest, with `dropped` and `note`), `timedOut` (on a closing turn that came early because a discussion passed its overall deadline: rounds × attendees × the turn deadline, at most four hours), `skipped` (on the closing turn). Wakes `to` |
| `meeting.replied` | `role`, `turn`, `round`, `text` (verbatim), `done` (true when the attendee has nothing more to add) |
| `meeting.skipped` | `role`, `turn`, `reason` (`busy` with `ifBusy` skip or proxy, `missed` past the turn deadline, `capped`: once the cap is reached, one per attendee still to speak, the current one first, with `fromRound`, the round it would have spoken in next; readers accept reasons they do not know), `proxy` (true when `ifBusy` is proxy), `closing` (the facilitator missed its closing turn) |
| `meeting.closed` | `title`, `outcome` (completed, capped, abandoned), `minutes` (not on abandoned), `why` (on abandoned), `replies` (a count), `rounds` (the rounds held), `timedOut`, `skipped`, `spent`, `cap`, `currency`, `actionItems` and `decisions` (counts), `url` (the meeting page) |

### Team and connectors

| `type` | `data` |
| --- | --- |
| `team.published` | `version` (commit SHA), `pr`, `changes` (paths), `by`; optional `publishedAt` (when it merged, else the event's time), `roles` (the slugs the team runs), `off` (slugs switched off, removed or made dormant), `plan` (the change step's choices, `{ [role]: { choice, to? } }`). The rollout view (`GET /teams/{team}/rollout`) reads the latest one. One per commit: the id is `published-<version>` (40 lowercase hex), whoever posts it, so the repository's CI (`report.mjs published` through the report route, `actor` `system`/`repository`, `data.via` `repository`) and the Studio collapse into one event |
| `team.transition` | `from`, `to`, `items` (per in-flight item: role, choice, state). See ADR 0004 |
| `connector.connected`, `connector.health`, `connector.revoked` | `connector`, `resource`, `status`, `detail` |
| `notification.sent`, `notification.failed` | `channel`, `to` (member), `event` (the id it was about), `attempt` |
| `meeting.minutes` | `meeting` (its name), `meetingId`, `date`, `decisions` (each `{ text }`), `actions`, `needsYou` (how many items need the owner). Emitted by the meeting's clerk when it publishes the minutes; the email sink sends it to people who switched on "Meeting minutes" |

New types are added to this catalogue in the same PR that first emits them.

## Ordering and delivery

- Events of one `(team, actor.id, actor.instance)` are delivered in `time` order. Nothing is promised across actors. The board sorts by `time`.
- Ingest is at-least-once with idempotent ids. Consumers (projections, sinks, notifications) keep a cursor per consumer and must be idempotent.
- The live stream (`GET /v1/teams/{team}/events/stream`, server-sent events) replays from `Last-Event-ID`, so a dropped connection loses nothing.
