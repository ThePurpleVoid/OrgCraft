# M3 design: the runner, the bus, approvals and the chief-of-staff chat

Status: accepted for M3, 2026-11-06. Owner: architect. Issue #28. Builds on [ADR 0002](../adr/0002-runtime-agent-sdk-runner.md) (our own runner), [ADR 0005](../adr/0005-online-first-built-to-last.md) (online first, built to last) and the [contracts](../contracts/README.md).

M3's exit: the owner types a small real request in the Studio chat. The chief of staff hands it to a role, which opens a pull request. QA signs off with evidence. The owner approves the merge from a phone browser, and it merges. The run's events and cost are on the board.

This document fixes the seams so the AI engineer (`apps/runner`), the backend dev (`apps/server`) and the web dev (`apps/studio`) can build at the same time. Each section names its owner and the tests that prove it. The contract changes it makes are additive (contract rule 1) and are listed in section 9.

## 0. One picture

```
 Studio chat ──POST /v1/teams/{t}/chat──▶ control plane ──append──▶ events (system of record)
   ▲  SSE /events/stream (ids = event ids)      │  same transaction
   │                                            ├──▶ projections: runs, sessions, cards, chat_messages, budget_days, audit
   │                                            └──▶ deliveries (the bus) ──runner/1 over WebSocket──▶ runner
   │                                                                                              │
   └──────────────── card.updated, chat.message, usage.recorded, message.* ◀── events frames ─────┤
                                                       POST /v1/sessions/{s}/tools/{tool} ◀────────┘ team tool server
```

Three rules hold everything together:

1. **The event log is the system of record.** Every state change is an event appended in the same transaction as the projection rows it changes (an outbox, so nothing is half-written). Every projection table in migration 003 can be rebuilt from `events`.
2. **The control plane is the authority, the runner is the hands.** Field checks, who may do what, budgets and approvals are decided on the server. The runner enforces the same things locally for speed and as a second line, never as the only line.
3. **Nothing in M3 knows what the team works on.** Role slugs, actions and vocabulary come from the team version. The only role the server treats specially is the team's **front door**: the role whose `Reports to` is `owner` (the chief of staff in every kit preset).

## 1. Tables: migration 003

Owner: **backend-dev** (writes `apps/server/migrations/003_runs_chat_approvals.sql`, after its own `002_idempotency_runners.sql`). Every table has `tenant text not null references tenants(id)` and `team text not null references teams(id)`, row-level security with the 001 policy (`tenant = current_setting('app.tenant', true)`, using and with check), tenant work as `agent_team_app`, **no FORCE** (the owner role needs cross-tenant lookups for tokens and the tick). Ids are `<prefix>_<random>` like 001's.

| Table | Columns (beyond tenant, team) | Written by | Grants to `agent_team_app` |
| --- | --- | --- | --- |
| `runs` | `id` (`run_`), `mode` (runner, subagents, agent-teams), `state` (running, paused, stopped), `reason` (owner, budget, error), `caps jsonb` (RunCreate.caps), `team_version`, `roster jsonb` (the team version's roles, frozen at start: `slug`, `reportsTo`, `areas`, `model`, `pool`; sent by a person in `RunCreate.team` until publish lands, then read from the published version; exactly one role reports to `owner`), `started_by`, `started_at`, `ended_at`, `version int` (bumped on each change) | runs endpoints, budget enforcement | select, insert, update |
| `sessions` | `id` (`ses_`), `run`, `role`, `instance` (null for single roles), `state` (queued, starting, running, idle, waiting, stopped, ended, unknown), `runner`, `team_version`, `branch`, `worktree`, `checkpoint jsonb` (`commit`, `memory` text up to 64 KiB, `at`), `token_hash`, `token_expires`, `last_seen`, `created_at`. Unique `(run, role, coalesce(instance, ''))`: one session per role per run, resumed rather than duplicated | the bus, runner frames | select, insert, update |
| `deliveries` | `id` (`dlv_`), `event` (the waking event id), `run`, `role`, `instance`, `session` (null until assigned), `state` (pending, sent, acked, held, dead), `attempts`, `next_at`, `created_at`. Unique `(event, role, coalesce(instance, ''))` | the bus | select, insert, update |
| `cards` | `id` (`card_`), `kind` (approval, decision, budget, ready; unknown kinds allowed), `subject`, `session`, `card jsonb` (the full Card, clients.md section 6), `version int`, `state` (open, answered, expired, superseded), `answer jsonb` (`option`, `note`, `by`, `at`), `expires_at`, `created_at` | tool calls, answers, the tick | select, insert, update |
| `approvals` | `id` (`apr_`), `run`, `session`, `role`, `action` (a policy classification), `call jsonb` (command or tool call, redacted), `why`, `risk`, `card`, `state` (pending, approved, denied, expired), `decided_by`, `decided_at`, `expires_at` | `request_approval`, `approval.wait`, answers | select, insert, update |
| `chat_messages` | `event` (the `chat.message` event id, primary key with team), `client_id`, `from_kind` (person, role), `from_id`, `text` (verbatim), `reply_to`, `at`. Unique `(team, client_id)` where `client_id` is not null | chat endpoint, front-door session output | select, insert |
| `budgets` | `currency` (ISO 4217), `per_day` (minor units, null means no cap), `per_run`, `sessions` (live session cap, default 3), `updated_by`, `updated_at`. Primary key `(team)` | budget endpoint | select, insert, update |
| `budget_days` | `day date` (UTC), `spent` (minor units), `warned_at`, `exhausted_at`, `raised` (minor units added for this day by the owner). Primary key `(team, day)` | usage ingest, budget cards | select, insert, update |
| `audit` | `seq bigserial`, `at`, `actor_kind`, `actor_id`, `session`, `action` (tool, approval, secret, run, card), `target`, `decision` (allowed, refused, needs-approval, approved, denied), `rule`, `event` (id), `detail jsonb` | every tool call, approval, answer and run control | **select, insert only** (append-only, like `events`) |

The day is UTC in M3, so a cost line and its cap mean the same thing on every client. A team time zone is an additive column later.

Indexes: `sessions(team, run, state)`, `deliveries(state, next_at)`, `cards(team, state)`, `approvals(team, state)`, `chat_messages(team, at desc)`, `audit(team, seq)`.

**Proof** (backend-dev, `apps/server/test/`): `tenants cannot see or write each other's M3 rows`, which loops over all nine tables exactly as the 001 isolation test does (a rival tenant reads nothing and an insert claiming another tenant fails with a row-level security error), on PGlite and on Postgres in CI as a non-superuser; `the projections rebuild from the event log` (drop the rows of runs, sessions, cards, chat_messages and budget_days for a team, replay its events, compare); `audit is append-only` (update and delete as `agent_team_app` are refused).

## 2. The bus: how a message wakes a session

Owner: **backend-dev** (dispatcher and deliveries, in `apps/server`); **ai-engineer** (taking `session.start` and `session.message` in the runner).

### What wakes whom

When the server appends one of these events, the **dispatcher** writes a `deliveries` row in the same transaction:

| Event | Wakes | Notes |
| --- | --- | --- |
| `chat.message` from a person | the front-door role | The owner's text travels verbatim in `wake` (the dilution rule) |
| `message.handoff`, `message.bug`, `message.signoff`, `message.blocked` | `data.to` (a role slug, `#instance` allowed) | `blocked` with no `to` goes to the sender's `Reports to` role |
| `decision.answered`, `approval.decided` | the session that asked (`data.session`) | An approval answer also releases the paused call (section 4) |
| `meeting.turn` | `data.to`: the role whose turn it is, delivered to its lowest-numbered live instance, otherwise `#1` | Emitted by the server's meeting sequencer (below). With `ifBusy: next-pause` it queues like any message; with `skip` or `proxy` a busy role gets `meeting.skipped` and the next turn goes out. A paused run holds it like any delivery |
| `run.resumed` | every role whose session is in state `stopped` in this run (a stopped run never resumes, so these are exactly the sessions a pause stopped) | Each gets its own delivery row keyed on the `run.resumed` event and the role, so acks and retries apply, and is resumed from its last checkpoint: `session.start` with `resume: true`, the stored `checkpoint`, and a `wake` naming the resume (`run.resumed`, with its reason). `held` deliveries for the run go back to `pending` and are delivered to the resumed sessions as usual. Applies to an owner's resume and to the budget's next-day resume alike |

Messages from a role to itself, and to a role the team version does not have, are refused at the tool (section 3), so they never reach the bus.

**Meetings** (written round or discussion, no new runner op). A run carries its meetings in `RunCreate.team.meetings`, with attendees already resolved by the Studio (`meetingAttendees`, the facilitator left out; a missing facilitator is the front door). `POST /v1/teams/{team}/meetings` opens an instance (`meeting.opened`), refused with 409 when no run is running, the definition is already open, or today's budget has less left than the meeting's cap. The server then sends one `meeting.turn` per attendee in order; each `meeting_reply` sends the next, and after the last the facilitator gets the closing turn and calls `meeting_close` (section 3, team-tools.md). Usage tagged with the meeting counts toward its `cap` (minor units) when the session was given one of its turns. At the cap every turn still to come gets `meeting.skipped` (`capped`) and the closing turn says `capped: true`. A completed or capped close emits `meeting.closed`, the minutes as `chat.message` (when `owner.minutes`), a `report.note`, `meeting.minutes` for the email sink, and the action items and decisions. A stopped run closes an open meeting as `abandoned`. **Ad hoc meetings:** the front door starts one with `meeting_start`, and a person starts one with `POST /v1/teams/{team}/meetings { adhoc }`. Either way the cap is at most the budget's `meetingCap` (a tenth of `perDay` when null; only a person raises it, with step-up). Every open meeting holds what is left of its cap against today's budget, so several at once cannot overrun it. **Discussions** (`format: discussion`, `rounds` 2 to 5, #152): the same sequence runs once per round. Every turn carries the whole transcript; past 40 KB, an attendee's earlier-round replies are dropped before anyone's latest. An attendee who replies with `done: true` (with `text` still required) is not asked again, and when everyone is done the facilitator's closing turn comes early. A missed turn skips only that turn. At the cap, each attendee still to speak gets one `meeting.skipped` (`capped`, `fromRound`). A discussion also has an overall deadline, rounds × attendees × the turn deadline and at most 4 hours, kept by the tick: past it the closing turn comes early with `timedOut: true`. Ad hoc meetings stay a written round. Code: `apps/server/meetings.mjs`; proofs: `apps/server/test/meetings.test.mjs`.

### Delivering

A delivery is processed on append and again by the tick (section 7) until it is acked or dead:

1. **The run is paused or stopped**, or today's budget is exhausted: the delivery is `held`. Nothing starts.
2. **The target has a live session** (`running`, `idle` or `waiting`): send `session.message` with the event verbatim. The runner hands it to the session at its next turn boundary, never in the middle of a tool call.
3. **It has no live session**: if the run is at its `sessions` cap, mark the session `queued` (and emit `session.queued`); otherwise pick a connected runner of the tenant with a free slot and send `session.start`. If a `sessions` row exists for that role in this run, it is a resume: `resume: true`, the stored `checkpoint`, and the prompt's first line "Resume from roles/<slug>.md" followed by the waking message.
4. **The runner acks** the frame: the delivery is `acked`. With no ack within 30 seconds, it goes back to `pending` with backoff (5 s, 30 s, 2 min, then every 10 min). After 10 attempts it is `dead`, an `audit` row is written, and a `message.blocked` from `system` goes to the front door.

At-least-once: the runner deduplicates by the waking event id, so a resent frame never wakes a session twice. Queued sessions start in the kit's priority order when a slot frees (fix in production first, then the oldest delivery).

### Who consumes what

| Consumer | Reads | Writes |
| --- | --- | --- |
| Dispatcher (server) | chat.message, message.*, decision.answered, approval.decided, run.* | deliveries, sessions |
| Budget (server) | usage.recorded | budget_days, budget.*, run.paused, cards |
| Cards (server) | decision.requested, approval.requested, answers, the tick | cards, card.updated |
| Board projection (existing) | report.*, message.*, session.* | the board |
| Sinks (existing) | report.*, message.* | the team's own board |
| Runner | session.start, session.message, session.stop, session.checkpoint, approval.result | events frames, tool calls |
| Studio chat | chat.message, decision.*, approval.*, card.updated, run.*, budget.*, usage.recorded | chat, cards, runs |

**Proof:** backend-dev: `a handoff wakes the target role, and a second delivery of the same event is ignored`, `a paused run holds deliveries and resume releases them`, `after a budget pause, run.resumed restarts every stopped session from its checkpoint`, `a pause handler that finds the run already resumed (a newer runs.version) stops nothing`, `the session cap queues the next session and starts it when a slot frees`. ai-engineer (stub model, see section 3): `a chief-of-staff session sends a HANDOFF, which wakes a second role, which sends a SIGNOFF; every event has the run and session ids`.

## 3. The team tool server

Owner: **ai-engineer** (the MCP server inside the runner, one per session); **backend-dev** (the endpoint that checks and records each call). The schemas are the contract [team-tools.md](../contracts/team-tools.md) (`tools/1`).

How a call flows:

1. The model calls a tool. The runner's MCP server checks the input against `tools/1` (quick feedback, no round trip).
2. It sends `POST /v1/sessions/{session}/tools/{tool}` with the session token. **The server checks again** (it is the authority), mints the envelope itself (`actor` from the token: role, instance, session; `run` and `teamVersion` from the session; `via: "tool"`), appends it with its projections and deliveries, writes an `audit` row, and answers with the result.
3. A refused call answers `422` with `problems` (plain sentences). The runner returns them to the model as the tool's error, so the role can fix the call and retry. A `session.tool` event with `decision: refused` and `rule: tools/1` is recorded.

The seven tools in M3 (field lists are in team-tools.md):

| Tool | Who may call | Emits | Wakes | Result |
| --- | --- | --- | --- | --- |
| `report` | every role | `report.status` | nobody | `{ event }` |
| `handoff` | every role | `message.handoff` | `to` | `{ event }` |
| `bug` | every role | `message.bug` | `to` | `{ event }` |
| `signoff` | every role | `message.signoff` (refused without evidence links) | `to` | `{ event }` |
| `blocked` | every role | `message.blocked` and `report.status` `blocked` | `to`, or the sender's `Reports to` | `{ event }` |
| `ask_owner` | the front door only (others get "send a BLOCKED to <front door>", protocols: no role asks the owner directly) | `decision.requested` and `card.updated` (a `decision` card) | the asker, when answered | `{ card }`, at once: the role keeps working on its recommendation |
| `request_approval` | every role | `approval.requested` and `card.updated` (an `approval` card) | the asker, when decided | `{ approval, decision }`, after the decision: the runner holds the call (section 4) |
| `ready_to_try` | the front door only, after the PR merged (`proposal.accepted`) | `ready.posted`, a `chat.message` and `card.updated` (a `ready` card with the runner's preview link) | nobody | `{ card, event, preview }` (team-tools.md) |

Message events keep the kit's report fields (`to`, `task`, `issue`, `pr`, `branch`, `commit`, `severity`, `evidence`, `detail`), so the existing sinks forward them to a team's own board unchanged. The server composes `detail` from the structured fields (for example "Changed: … Verify: … Done when: …"), and keeps the structured fields next to it in `data`. That addition is allowed (events.md: readers ignore what they do not know).

`memory_read`, `memory_write`, `open_issue`, `merge`, `meeting_*` and `checkpoint` as a tool are not in M3. In M3, memory travels in checkpoints (section 4), and a merge is an ordinary command that the approval policy gates (section 4).

**Proof:** ai-engineer: `tools/1 checks`: one passing and one refused input per tool, including a SIGNOFF with no evidence and an `ask_owner` from a role that is not the front door. backend-dev: `a tool call with a session token is recorded as that role, whatever the body claims`, `a refused tool call is audited and stores no message event`, `an expired session token gets 401`.

## 4. Runner and server: the M3 subset of `runner/1`

Owner: **ai-engineer** (runner side), **backend-dev** (server side). The frame handler on the server is transport-agnostic (frames in, frames out). M3 ships the WebSocket at `/v1/runners/connect`. The long-poll transport (`POST /v1/runners/{id}/poll`) stays in the contract for networks that block WebSockets and is not built in M3 (section 8).

### Credentials

| Credential | Minted | Held by | Can do | Cannot do |
| --- | --- | --- | --- | --- |
| Registration code | `POST /v1/runners/codes` by a person (one use, 15 minutes) | the person, once | `POST /v1/runners` | anything else |
| Runner key | `POST /v1/runners` (002, shown once, stored as a hash, revocable) | the runner process, never the agents | open `/v1/runners/connect`; send the frames below; emit events of types `session.*`, `usage.recorded`, `report.heartbeat`, and `chat.message` as the front door of a session it runs (the server sets `from` and `actor` from that session's role and ignores any value in the frame, so a runner can never speak as the owner or another role) | emit `message.*`, `decision.*`, `approval.decided`, `run.*`, `card.*`, or events for a session it does not run |
| Session token | in `session.start` (15 minutes), renewed with `session.renew` | the runner's tool server, outside the agent's sandbox and environment | `POST /v1/sessions/{its session}/tools/*` | any other endpoint or session |
| Person (admin token until OIDC) | `AGENT_TEAM_ADMIN_TOKEN` | the Studio server, never the page | runs, chat, cards, budget, approvals with step-up | |

The server rejects an event a credential may not emit with a `nack` frame naming the rule, and audits it.

### Ops in M3

| `op` | Direction | M3 | Additions in M3 (additive) |
| --- | --- | --- | --- |
| `hello` / `welcome` | runner → / → runner | yes | `hello.body.sessions`: the sessions the runner still runs (none after a restart); `welcome.body.sessions`: only those of them it should resume (#168, below) |
| `session.start` | → runner | yes | `resume` (boolean), `checkpoint` (`commit`, `memory`), `token`, `tokenExpires`, `caps.remainingToday` and `caps.remainingRun` (minor units), `delivery` |
| `session.message` | → runner | yes | `delivery` |
| `session.stop` | → runner | yes, `finish-step` (pause, budget) and `now` (stop) | `reason` (owner, budget, error, and after a reconnect run-stopped, run-paused or stopped) |
| `session.checkpoint` | → runner | yes, before every stop and pause | the runner's `ack` body carries `commit` (the pushed branch head) and `memory` (the role's memory file), which the server stores in `sessions.checkpoint` |
| `events` | runner → | yes, with the allowlist above | |
| `approval.wait` / `approval.result` | runner → / → runner | yes | `approval.wait` is answered with an `ack` whose body is `{ approval, card }` |
| `session.renew` / `session.token` | runner → / → runner | **new** | renew the session token before it expires: `{ session }`, answered with `{ session, token, tokenExpires }` |
| `ping` / `pong` | both | yes | |
| `ack` / `nack` | both | yes | `nack` is **new**: `{ ref, problem, error }`, for a refused frame; `error: no-session` means the runner does not have the session a `session.message` was for |
| `secret.get` / `secret.value` | | **not in M3** | The runner reads its model key from its own environment. Secret release comes with the GitHub App in M4 |

**Reconnects** (#168, runner-protocol.md). The control plane trusts `hello.sessions`.
- A session the runner no longer names was lost (a restart or a crash). The control plane marks it stopped and delivers again what was acked to it since its last `session.idle` or `session.ended`. It restarts through `deliver()`, like `run.resumed`: `session.start` with `resume: true`, the stored checkpoint when there is one, and the unfinished message as the wake. The marker is idle, not the checkpoint, because a checkpoint is stored only on a pause, and work finished before idle is already pushed or handed off.
- A named session whose run stopped meanwhile gets `session.stop` `now`. If the run paused meanwhile, it takes the pause path: `session.checkpoint`, then `session.stop` `finish-step` with `run-paused`, acting only if the run is still paused at the version read (section 6).
- A `session.message` the runner cannot place gets `nack` `no-session`, and the session restarts with that message as its wake.
- While the link is down, a runner starts no model turn and merges nothing. The server sends an approved `accept`'s `approval.result` only while the run is running, so no merge lands on a stopped or paused run.

**Proofs:** `tests/e2e/m3-resilience.e2e.mjs` (restart, control plane away, link cut, budget pause, and a run stopped during a partition merges nothing), plus the reconnect cases in `apps/server/test/bus.test.mjs`.

### Approvals: one path for both triggers

A session reaches an approval two ways, and both end the same way:

- **The policy** (the runner's pre-tool hook) classifies a call from the owner-steps-in list in `docs/team/protocols.md`: destructive data changes, production deploys, secret writes, payments, outbound messages to people outside the team, and in M3 **accepting a proposal** (the `accept` verb of the work contract; for a repository, merging a pull request). The runner sends `approval.wait`.
- **The role asks** with `request_approval`. The server records it and the runner then waits as above.

Either way the server writes `approvals` and an `approval` card (option `approve` with `stepUp: true`, option `deny`), emits `approval.requested` and `card.updated`, and the session's state becomes `waiting`. When the owner answers, the server emits `approval.decided` and `card.updated`, and sends `approval.result`. The runner continues or refuses the held call. An approval expires after 24 hours by default (the tick marks it `expired`, the call is refused, and the session is told why).

**Step-up stub until OIDC** (clients.md section 3; security reviewer reviews it): `POST /v1/auth/step-up` with the person's bearer token **and** a separate step-up secret typed by the person in the body (`{ "secret": "…" }`) returns a step-up token (`su_…`, 5 minutes, stored as a hash). `POST /v1/approvals/{id}` and any card option with `stepUp: true` need it in `x-step-up`. Without it, or with an old one, the answer is `401` with problem type `step-up-required`, never a silent approval. The step-up secret is set once by the owner (at least 12 characters). The deployment holds only its scrypt hash, `AGENT_TEAM_STEP_UP_SECRET_HASH`, and the plaintext is never put in any environment, the Studio's and the runner's included (section 12, D3). That way whoever holds the bearer token (the Studio process, a page driving it, a thief) still cannot approve without a person typing it. The admin bearer token is refused as the secret. The Studio asks the person to type the step-up secret in a dialog, forwards it from its own server, holds the step-up token per browser session, and drops it after one use (section 12, D5). In M4, OIDC's `auth_time` and the device-key step-up replace the stub; the header stays accepted.

**Proof:** ai-engineer: `the runner pauses a merge until approval.result, and refuses it on deny`, `session.stop finish-step checkpoints first (branch pushed, memory sent)`, `a reconnect resumes the sessions in welcome`, `the session token never appears in the agent's environment or prompt`. backend-dev: `a stale card version gets 409 with the current card`, `an approval without a fresh step-up gets 401 step-up-required`, `a runner key cannot emit message or approval events`, `a runner's chat.message is stored as the front-door role whatever its from says, and one for a session it does not run is nacked`, `the admin bearer token is refused as the step-up secret`, `three missed pings mark the runner's sessions unknown`.

## 5. Chat

Owner: **web-dev** (the panel), **backend-dev** (the endpoints), **ai-engineer** (posting the front door's replies).

### Events in the chat

The chat is a projection of these event types, in log order: `chat.message`, `decision.requested`, `decision.answered`, `approval.requested`, `approval.decided`, `card.updated`, `run.started`, `run.paused`, `run.resumed`, `run.stopped`, `budget.warned`, `budget.exhausted`. Clients show any other type they are sent as a plain timeline line (clients.md section 9).

- **The owner's messages.** `POST /v1/teams/{team}/chat` with `text` (stored byte for byte: no trimming, no normalising) and a `clientId` the client makes (a ULID). A repeat of the same `clientId` returns the first message with `200` instead of `201`, so a message sent twice appears once. `Idempotency-Key` also works.
- **The front door's replies.** The runner posts each completed assistant text block of the front-door session as a `chat.message` from that role. Other roles' text stays in their session log and never reaches the chat; they talk to the owner only through the front door. Replies stream **by message, not by token** in M3: the log is the system of record, and token deltas would bloat it. An ephemeral typing channel can be added later without a contract change (a new event type readers can ignore).
- **Live.** The panel reads `GET /v1/teams/{team}/chat`, then opens `GET /v1/teams/{team}/events/stream` from the response's `asOf`. Missing nothing between the two is the clients.md guarantee.

`GET /v1/teams/{team}/chat` answers (pages backwards with `before`, an event id):

```json
{
  "asOf": "<event id>",
  "items": [ { "...": "envelopes of the types above, oldest first" } ],
  "cards": { "card_…": { "...": "the current Card for every card the items mention" } },
  "run": { "id": "run_…", "state": "running", "version": 4 },
  "cost": { "today": 412, "capPerDay": 2000, "currency": "USD", "state": "ok" },
  "next": "<cursor>"
}
```

### Cards from events

A card is never HTML from the server. Every change to a card (created, answered, expired, superseded) emits `card.updated` whose `data.card` is the **whole Card** at its new `version`. A client keeps the latest `card.updated` per card id, and renders that. `decision.requested`, `approval.requested` and `budget.exhausted` carry the card's id as `cardId` (a string; `card` is only ever the whole object, on `card.updated`), so the timeline line and the card meet. Answers send the `version` they saw; a stale one gets `409` with the current card, which the panel shows in place.

### The cost line

Source: `budget_days.spent` for today (UTC) against `budgets.per_day`, kept by the server from `usage.recorded` events. It is in the chat response and in `GET /v1/me/summary` (`cost`, as already in the contract). Live, the panel adds each `usage.recorded` it sees and replaces the totals on `budget.*` events. Amounts are integers in minor units with a currency; the client formats them.

**Proof:** web-dev: the Playwright round trip against a control plane with a stubbed runner (send, see the reply arrive live, answer a decision card, answer a stale card and see the refreshed one), screenshots at desktop and 360 px, light and dark. backend-dev: `a chat message repeated with the same clientId is stored once`, `chat pages backwards and its asOf resumes the stream with nothing missed`, `owner text round-trips byte for byte` (with leading spaces, emoji and a trailing newline).

## 6. Budget

Owner: **backend-dev** (enforcement), **ai-engineer** (usage reporting and the local stop).

- **Caps.** `PUT /v1/teams/{team}/budget` sets `perDay`, `currency`, and optionally `perRun` and `sessions`. A run can lower them for itself (`RunCreate.caps`), never raise them. With no `perDay` set, a run does not start: `POST /runs` answers `409` "set a daily cap first". For this repository's own team, the owner chooses the number when M3 asks for the model key.
- **Usage.** The runner reports `usage.recorded` after every model turn: `inputTokens`, `outputTokens`, and `cost` in whole minor units. It carries the fraction over to the next report, and rounds up on the session's last report, so the day's total is exact to one minor unit per session.
- **Where it is enforced.** On the server, in the transaction that appends `usage.recorded`: it adds to `budget_days.spent` and compares with `per_day + raised`. The runner also gets `caps.remainingToday` and `caps.remainingRun` in `session.start`, and stops a session on its own when its count reaches them (second line, and the only line while it is offline).
- **At 80%**: once a day, `budget.warned` (`spent`, `cap`, `currency`, `day`). A timeline line in the chat and a notification, nothing stops.
- **Pause and resume handlers check the run first.** Anything that stops sessions for a pause (owner, budget) checks the run's current `state` and `version` and acts only if the run is still paused at the version that paused it. The check runs **after** the `session.checkpoint` ack returns (which can take minutes, outside any transaction), in the same transaction that sends `session.stop` and writes `stopped`, so a resume that lands during the checkpoint wait is never undone. A pause whose run has since been resumed, or paused again for another reason, stops nothing. The same check guards `run.resumed`, so a late resume never restarts sessions of a run that was paused again or stopped.
- **At 100%**: once a day, `budget.exhausted`. The run is paused with `reason: budget` (`run.paused`), every live session gets `session.checkpoint` and then `session.stop` `finish-step`, and new deliveries are `held`. A `budget` card goes to the owner: `tomorrow` (recommended: resume at 00:00 UTC) or `raise` (add half the daily cap again for today; `stepUp: true`, because it spends money). Unanswered, the run stays paused past midnight: nothing spends without the owner. Spend can overshoot by at most the turn each live session was in. Raising or clearing a cap, and resuming a run paused for budget, need step-up (section 12, D4).
- **Known limit (D7).** Usage is reported by the runner, which holds the model key, so a compromised runner could under-report. Accepted for M3; M4's secret release and a server-side metering proxy for the model key close it.
- **Per run**: the same at the run's `perRun`, scoped to that run.

**Proof:** backend-dev: `the budget pauses the run at the cap and sends one card`, `80% warns once a day`, `the tomorrow answer resumes the run at the next UTC day, from the tick`. ai-engineer: `the runner stops a session at remainingToday even when the server is unreachable`.

## 7. Timers: the tick

Owner: **backend-dev**. Everything time-based runs in one idempotent function, `tick(now)`, exported by `apps/server`:

- retry `pending` deliveries whose `next_at` has passed, and `sent` ones with no ack
- expire cards and approvals past `expires_at` (`card.updated`, `approval.decided` `expired`)
- the UTC day rollover for budgets (resume runs whose budget card was answered `tomorrow`)
- mark sessions `unknown` when their runner missed three pings
- the existing sink worker's due retries
- meeting turns past their deadline (30 minutes, counted from delivery): `meeting.skipped` with `missed`, and the next turn goes out
- discussions past their overall deadline: the facilitator's closing turn, early, with `timedOut: true`

Each step takes its rows with `for update skip locked`, so two ticks at once do no harm. Every long-running server (local, Compose, the hosted container) calls it every 15 seconds in-process. A serverless-only deployment would call `POST /internal/tick` from a scheduler, with `Authorization: Bearer <CRON_SECRET>`. `/internal/` is not part of `/v1/` and never reachable with a person's or runner's token. `CRON_SECRET` is compared in constant time, an unset or empty secret refuses every call, and `/internal/` is never in the Vercel rewrite (section 12, D8).

**Proof:** `two ticks at once deliver each pending delivery once`, `an expired approval refuses the held call`.

## 8. The hosting split for issue #34 (Vercel and Supabase), checked against ADR 0005

The CTO's draft is in `plans/m4-vercel-supabase-handoff.md`. Infra found that Vercel Functions cannot accept a WebSocket, and that a Vercel rewrite does not proxy one, and recommended running the realtime half as one always-on `apps/server` container (their option B). I agree, and go one step further: **the whole `/v1` API runs in that container**, and Vercel serves the Studio and forwards `/v1` to it. One server process means no split of live fan-out across instances, no serverless limits on streams or timers, and the same image Compose and Helm need anyway (ADR 0005). A request-handler export for serverless stays possible later; nothing here depends on it.

My answer on each row, so infra can write the deploy docs:

| Row | Answer | Conditions |
| --- | --- | --- |
| Studio page on Vercel | **Yes** | Plain files (ADR 0003). Vercel rewrites `/v1/*` and `/.well-known/agent-team` to the container's HTTPS URL, so the discovery document names one host |
| `/v1` request-response routes on Vercel Functions | **No for M4**, in the container instead | Revisit only if the container becomes a cost or scale problem. If it does: a request-handler export, a per-instance report rate limit, and NOTIFY from the functions to the container's listener |
| Live streams: (a) streaming function plus reconnect, (b) always-on service, (c) Supabase Realtime | **(b)**, served by the container; **no** to (c) | Streams are long-lived HTTP from the container, passed through Vercel's rewrite (infra verifies that SSE passes through unbuffered; if not, clients take the stream URL straight from the container's host, named in the discovery document). (c) is refused because it ties the stream contract to one vendor and bypasses our RLS and projections (ADR 0005, contract rule 4) |
| The runner's connection | **Yes, WebSocket, straight to the container** | The runner never goes through Vercel. `runner/1`'s long-poll transport stays in the contract for networks that block WebSockets; it is not needed for this target |
| Vercel Cron calling `/internal/tick` | **Not needed** | The container runs `tick()` in-process every 15 seconds (section 7). `/internal/tick` stays for a future serverless-only deployment |
| Runner on a container host | **Yes** | The same host as the server is fine for our own instance (Fly.io, Render, Railway, any VM, or the owner's Mac to start). Outbound only. The model key lives only on the runner |
| A dedicated Postgres schema on Supabase | **Yes** | Schema `agent_team`. Revoke `anon` and `authenticated` on it and keep it out of the API's exposed schemas, so nothing reaches our tables around RLS. The db layer sets `set local search_path to agent_team` inside each transaction, because a transaction pooler does not keep connection options |
| Pooler rules | **Yes** | The API uses the transaction pooler: all tenant work is already inside one transaction with `set_config(..., true)` and `set local role`, which infra has verified through pgbouncer in transaction mode. No session state outside a transaction, no named prepared statements. Migrations and the container's LISTEN connection (live fan-out, if more than one container ever runs) use the direct or session URL |

Nothing in the product changes shape for this target. Compose and plain Postgres stay first-class, and the same tests run on both.

## 9. Contract changes in this PR (all additive)

Later, in section 12: step-up became required on four existing writes (`PUT /secrets/{name}`, `PUT /teams/{team}/budget` when raising, `POST /runs/{run}/resume` after a budget pause, `POST /runners/codes`). That is a tightening, not an additive change: a recorded exception before 1.0, made before any client calls them (contracts README, rule 7).

- [team-tools.md](../contracts/team-tools.md), **new**: `tools/1`, the seven tools, their fields and checks, and the events each emits.
- [events.md](../contracts/events.md): new types `card.updated`, `budget.warned`, `budget.exhausted`, `session.queued`; new optional fields `chat.message.clientId`, `cardId` and `session` on `decision.requested`, `decision.answered` and `approval.requested`, `approval.decided.session`, `budget.exhausted.cardId`, and the structured message fields from team-tools.md.
- [runner-protocol.md](../contracts/runner-protocol.md): the M3 subset, `session.renew` and `session.token`, `nack`, the additive body fields above, and the event allowlist per credential.
- [api-v1.yaml](../contracts/api-v1.yaml): `POST /runners/codes`, `POST /sessions/{session}/tools/{tool}`, `POST /auth/step-up`, `GET` and `PUT /teams/{team}/budget`; `clientId` on chat; the chat response; `x-step-up` on approvals and cards.

## 10. Order of work and what each mock returns

All three builders can start now. Until the real piece exists, each one uses the mock named here.

| Order | Role | Task | Until it lands, others use |
| --- | --- | --- | --- |
| 1 | backend-dev | 002 (idempotency, runner registration), then 003 and the isolation test | PGlite with 003 applied from this doc |
| 1 | ai-engineer | `tools/1` checks as a pure module, then the runner's frame loop against a **stub control plane** (a WebSocket server in the test that sends `session.start` and records frames) | backend-dev tests the tool endpoint with recorded tool inputs |
| 1 | web-dev | the chat panel against a **stub `/v1`** (fixtures of the chat response, `card.updated` and a `409`) | |
| 2 | backend-dev | chat, cards, approvals with the step-up stub, budget, tool endpoint, dispatcher, tick | the ai-engineer's stub model drives it in an end-to-end test |
| 2 | ai-engineer | the Agent SDK adapter, worktrees, checkpoints, approvals, usage, the stub model test | |
| 3 | all | end to end on this repository's own team, with the real model key (the chief of staff asks the owner for the key and the daily cap) | |

**Mocks, exactly:**

- Stub control plane (ai-engineer's tests): answers `hello` with `welcome { protocol: "runner/1", heartbeat: 20, sessions: [] }`, sends one `session.start` for the front door with a `wake` holding a `chat.message`, acks every frame, answers `approval.wait` with `approval.result { decision: "approved" }` after 50 ms.
- Stub model (ai-engineer): a scripted adapter that, given a wake, returns the next scripted tool calls (`handoff` from the front door, `signoff` from the woken role), with fixed usage numbers, so tests are deterministic and need no key.
- Stub `/v1` (web-dev): the chat response above with one owner message, one front-door reply and one open decision card at version 1; answering it returns `409` with version 2 once, then `200`.

## 11. Decisions made here

- **Tool calls go over HTTP with a session token, not over the runner's socket.** The server then sets the actor from the token, so a role cannot speak as another role even if the runner has a bug. The socket stays for supervision and liveness.
- **Replies stream by message in M3,** not by token (section 5).
- **Merging is approval-gated by policy in M3,** rather than by a `merge` tool, so the exit's "the owner approves the merge" works with the seven tools.
- **Memory travels in checkpoints** and is stored on the control plane, so a session can resume on another runner.
- **No secret release over the protocol in M3.** The runner's model key is in the runner's own environment.
- **The front door is the role that reports to the owner,** not a hard-coded slug, so any industry's team works.
- **Merges and pushes are done by the runner, not the agent, and sessions run sandboxed** (section 12, D2 and D9). This supersedes "merging is approval-gated by policy": the policy still raises the approval, but the security line is the credential split and branch protection.

## 12. Security requirements for part 2

From the security reviewer's review of this design on issue #28 (D1 to D8), and of runner PR #42 (D9, decided by the CTO). They are binding on backend-dev's part 2 and the ai-engineer's runner. The baseline still holds: RLS on `app.tenant` for all nine tables, and no secret values in events, cards or audit.

| | Requirement | Owner | Proof |
| --- | --- | --- | --- |
| **D1** | **An approval is bound to the exact call.** For `accept` (a merge), the approval stores `{ pr, headSha }`, the card shows the sha, and `approval.result` carries it. The runner merges with the head sha pinned (`gh pr merge --match-head-commit <sha>`, or the API's `sha`). If the head moves, the approval is void: the merge fails, the approval is marked superseded (`card.updated`), and a new approval and card go out for the new head. Any other held call runs only if it is byte-identical to the approved `call`, otherwise it is refused | ai-engineer (runner), backend-dev (storing and voiding) | *a push after approval makes the held merge fail and asks again*; *a held call that differs from the approved call is refused* |
| **D2** | **The agent holds no credential that can merge, or push at all.** The runner process, outside the sandbox, pushes the session's branch at each checkpoint (D9), opens or updates its pull request, and merges only after `approval.result` (D1), each with credentials no session can reach. Rulesets on the repository are the backstop. **No agent or runner GitHub credential** (deploy key, GitHub App installation token or fine-grained token) ever gets `actions: write`, or write on environments or secrets, so nothing a run holds can dispatch or re-run a deploy workflow (for example with `allow_destructive`). The pre-tool classifier stays as a convenience that raises the approval early; it is not the security line. Setup for this repository: the owner checklist below | ai-engineer (runner), infra-secrets-oncall (ruleset and credentials) | *the runner opens the pull request after the first checkpoint and merges it pinned to the approved head on approval.result, emitting proposal.* events* (runner-protocol.md); *a resent approval.wait after a reconnect raises no second card*; *the agent's environment holds no credential that can merge*; *a merge attempted with the push credential is refused by the ruleset* (checked once against the live repository) |
| **D9** | **Sessions run in a sandbox, never as the person's own OS user** (from the review of runner PR #42, R1 to R4; CTO decision). Each session gets a throwaway `HOME`; an environment built from an allowlist (no model key, no `GH_TOKEN`, no runner settings); no ambient credentials (no `gh`, ssh agent, git credential helper or `runner.json` reachable); git run with hooks off and config pinned (`core.hooksPath=/dev/null`, no includes, no repository-local config honoured during checkpoint); the branch's own `.claude/` settings not loaded. The model call goes through the runner, so the key stays outside. **The checkpoint diff is the enforcement point**: the runner checks every changed path against the role's owned areas and runs the secret scan, and refuses to push if either fails (`session.tool` refused, a BLOCKED to the front door). The supported setup is the runner in a container; on the owner's Mac that means Docker, never a bare runner under their user | ai-engineer | *a session's env has only allowlisted names and its HOME is empty at start*; *a git hook or `core.hooksPath` planted by the agent does not run at checkpoint*; *a branch's `.claude/settings.json` is not loaded*; *a checkpoint with a secret in the diff, or a path outside the role's areas, is not pushed* |
| **D3** | **The step-up secret has a slow hash and attempt limits.** scrypt (`crypto.scrypt`, N at least 2^15) with a random salt, compared in constant time. The deployment supplies `AGENT_TEAM_STEP_UP_SECRET_HASH`; the plaintext never sits in any environment setting. At least 12 characters when set. After 5 failures in 15 minutes for a tenant: `429`, an `audit` row, and a notice to the owner | backend-dev | *the 6th wrong secret within 15 min gets 429 and is audited*; *the stored value is not a plain SHA-256*; *the admin bearer token is refused as the step-up secret* |
| **D4** | **Step-up also gates money and trust.** `x-step-up` is required on `PUT /teams/{team}/budget` when it raises or clears `perDay`, `perRun` or `sessions`; on `POST /runs/{id}/resume` when the run was paused with `reason: budget`; on `POST /runners/codes`; on `PUT /secrets/{name}`; and on the budget card's `raise` option. Lowering caps, pause, stop and revoke stay one tap, so the owner can always brake fast | backend-dev | *raising the cap without step-up gets 401 step-up-required; lowering it does not*; the same pair for budget resume, runner codes and secrets |
| **D5** | **A step-up token is scoped and never replayed.** It is bound to the principal that minted it and stored only as a hash. It never appears in a stored idempotency response. Answers are audited with the step-up token's id, never the token. The Studio holds it per browser session and drops it after one use | backend-dev, web-dev | *a step-up token minted by one principal is refused for another*; *a replayed idempotent approval response contains no step-up token* |
| **D6** | **A session token cannot answer cards or approvals.** `POST /approvals/{id}` and `POST /cards/{id}` take a person's credential only. `approval.result` is sent only by the server after a person's answer; nothing a runner or session sends can produce one | backend-dev | *a session token on `POST /approvals/{id}` or `/cards/{id}` gets 403*; *a role cannot `request_approval` and have its own runner answer `approval.result`* |
| **D7** | **Runner-reported usage is trusted in M3** (a known limit, section 6). Closed in M4 by secret release and a server-side metering proxy for the model key | backend-dev (M4) | none in M3; noted in section 6 |
| **D8** | **`/internal/tick` is closed by default.** `CRON_SECRET` compared in constant time; an unset or empty secret refuses every call; `/internal/` is never in the Vercel rewrite | backend-dev, infra-secrets-oncall | *the tick refuses every call when CRON_SECRET is unset*; *a wrong CRON_SECRET gets 401* |

### Owner checklist item for D2 and D9 (this repository, minimum for M3)

The goal: runner sessions cannot push to or merge into `main`, the runner itself can push the session's branch and merge after an approval, and the role threads that act as the owner today keep merging their own pull requests the way they do now.

1. **A deploy key for pushing** (Settings, Deploy keys, Add, allow write). The runner process holds the private key, outside every session's sandbox. It can push branches but, with the rulesets below, never `main`.
2. **A GitHub App for opening and merging pull requests** ("merger": Contents read and write, Pull requests read and write, Metadata read; private, installed on this repository only). Its private key lives only in the runner process's own settings. M4's GitHub App replaces both items 1 and 2.
   Do not give the merger app Actions, Environments, Secrets or Administration permissions: no run credential may dispatch a workflow or touch deploy secrets.
   A fine-grained personal access token will not do for either: a token of your own account carries your admin bypass, so the rulesets would not apply to it.
3. **Ruleset on `main`** (Settings, Rules, Rulesets, New branch ruleset, the default branch): *Restrict updates*, *Restrict deletions*, *Block force pushes*, *Require a pull request before merging* (0 approvals), *Require status checks to pass* (`test`, `server`). Bypass list: *Repository admin* (you, and the role threads that act as you, so today's flow is unchanged) and the **merger** app. Not the deploy key.
4. **Ruleset on every other branch except `team/**` and `claude/**`**: *Restrict creations*, *Restrict updates*, *Restrict deletions*, with the same bypass list. The deploy key can then push only to `team/**` and `claude/**`; the runner names session branches `team/<role>/<issue or task>` and pushes only the session's own ref. `claude/**` is excluded because today's role threads push their `claude/project-thread-*` branches, possibly as the Claude GitHub App rather than as you, and this ruleset must not stop them. Merges by those threads go through the GitHub API as you, so the admin bypass on `main` covers them.
5. **Run the runner in Docker**, not as yourself on the Mac (D9). The image and command come with the runner (ai-engineer, infra).

What it costs: about 15 minutes and no new accounts. What it leaves open until M4: a thread acting as you can still merge without an approval card, exactly as today. That is by your standing instruction (full autonomy), and it does not apply to runner sessions. Scoping a push to one branch, rather than to `team/**`, is enforced by the runner, not by GitHub, until the M4 App.
