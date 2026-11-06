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
| `runs` | `id` (`run_`), `mode` (runner, subagents, agent-teams), `state` (running, paused, stopped), `reason` (owner, budget, error), `caps jsonb` (RunCreate.caps), `team_version`, `started_by`, `started_at`, `ended_at`, `version int` (bumped on each change) | runs endpoints, budget enforcement | select, insert, update |
| `sessions` | `id` (`ses_`), `run`, `role`, `instance` (null for single roles), `state` (queued, starting, running, idle, waiting, stopped, ended, unknown), `runner`, `team_version`, `branch`, `worktree`, `checkpoint jsonb` (`commit`, `memory` text up to 64 KiB, `at`), `token_hash`, `token_expires`, `last_seen`, `created_at`. Unique `(run, role, coalesce(instance, ''))`: one session per role per run, resumed rather than duplicated | the bus, runner frames | select, insert, update |
| `deliveries` | `id` (`dlv_`), `event` (the waking event id), `run`, `role`, `instance`, `session` (null until assigned), `state` (pending, sent, acked, held, dead), `attempts`, `next_at`, `created_at`. Unique `(event, role, coalesce(instance, ''))` | the bus | select, insert, update |
| `cards` | `id` (`card_`), `kind` (approval, decision, budget; unknown kinds allowed), `subject`, `session`, `card jsonb` (the full Card, clients.md section 6), `version int`, `state` (open, answered, expired, superseded), `answer jsonb` (`option`, `note`, `by`, `at`), `expires_at`, `created_at` | tool calls, answers, the tick | select, insert, update |
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
| `run.resumed` | nothing new: `held` deliveries for that run go back to `pending` | |

Messages from a role to itself, and to a role the team version does not have, are refused at the tool (section 3), so they never reach the bus.

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

**Proof:** backend-dev: `a handoff wakes the target role, and a second delivery of the same event is ignored`, `a paused run holds deliveries and resume releases them`, `the session cap queues the next session and starts it when a slot frees`. ai-engineer (stub model, see section 3): `a chief-of-staff session sends a HANDOFF, which wakes a second role, which sends a SIGNOFF; every event has the run and session ids`.

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

Message events keep the kit's report fields (`to`, `task`, `issue`, `pr`, `branch`, `commit`, `severity`, `evidence`, `detail`), so the existing sinks forward them to a team's own board unchanged. The server composes `detail` from the structured fields (for example "Changed: … Verify: … Done when: …"), and keeps the structured fields next to it in `data`. That addition is allowed (events.md: readers ignore what they do not know).

`memory_read`, `memory_write`, `open_issue`, `merge`, `meeting_*` and `checkpoint` as a tool are not in M3. In M3, memory travels in checkpoints (section 4), and a merge is an ordinary command that the approval policy gates (section 4).

**Proof:** ai-engineer: `tools/1 checks`: one passing and one refused input per tool, including a SIGNOFF with no evidence and an `ask_owner` from a role that is not the front door. backend-dev: `a tool call with a session token is recorded as that role, whatever the body claims`, `a refused tool call is audited and stores no message event`, `an expired session token gets 401`.

## 4. Runner and server: the M3 subset of `runner/1`

Owner: **ai-engineer** (runner side), **backend-dev** (server side). The frame handler on the server is transport-agnostic (frames in, frames out). M3 ships the WebSocket at `/v1/runners/connect`. The long-poll transport (`POST /v1/runners/{id}/poll`) stays in the contract for networks that block WebSockets and is not built in M3 (section 8).

### Credentials

| Credential | Minted | Held by | Can do | Cannot do |
| --- | --- | --- | --- | --- |
| Registration code | `POST /v1/runners/codes` by a person (one use, 15 minutes) | the person, once | `POST /v1/runners` | anything else |
| Runner key | `POST /v1/runners` (002, shown once, stored as a hash, revocable) | the runner process, never the agents | open `/v1/runners/connect`; send the frames below; emit events of types `session.*`, `usage.recorded`, `report.heartbeat`, and `chat.message` as the front door of a session it runs | emit `message.*`, `decision.*`, `approval.decided`, `run.*`, `card.*`, or events for a session it does not run |
| Session token | in `session.start` (15 minutes), renewed with `session.renew` | the runner's tool server, outside the agent's sandbox and environment | `POST /v1/sessions/{its session}/tools/*` | any other endpoint or session |
| Person (admin token until OIDC) | `AGENT_TEAM_ADMIN_TOKEN` | the Studio server, never the page | runs, chat, cards, budget, approvals with step-up | |

The server rejects an event a credential may not emit with a `nack` frame naming the rule, and audits it.

### Ops in M3

| `op` | Direction | M3 | Additions in M3 (additive) |
| --- | --- | --- | --- |
| `hello` / `welcome` | runner → / → runner | yes | `welcome.body.sessions`: sessions this runner should resume after a reconnect |
| `session.start` | → runner | yes | `resume` (boolean), `checkpoint` (`commit`, `memory`), `token`, `tokenExpires`, `caps.remainingToday` and `caps.remainingRun` (minor units), `delivery` |
| `session.message` | → runner | yes | `delivery` |
| `session.stop` | → runner | yes, `finish-step` (pause, budget) and `now` (stop) | `reason` (owner, budget, error) |
| `session.checkpoint` | → runner | yes, before every stop and pause | the runner's `ack` body carries `commit` (the pushed branch head) and `memory` (the role's memory file), which the server stores in `sessions.checkpoint` |
| `events` | runner → | yes, with the allowlist above | |
| `approval.wait` / `approval.result` | runner → / → runner | yes | `approval.wait` is answered with an `ack` whose body is `{ approval, card }` |
| `session.renew` / `session.token` | runner → / → runner | **new** | renew the session token before it expires: `{ session }`, answered with `{ session, token, tokenExpires }` |
| `ping` / `pong` | both | yes | |
| `ack` / `nack` | both | yes | `nack` is **new**: `{ ref, problem }`, for a refused frame |
| `secret.get` / `secret.value` | | **not in M3** | The runner reads its model key from its own environment. Secret release comes with the GitHub App in M4 |

### Approvals: one path for both triggers

A session reaches an approval two ways, and both end the same way:

- **The policy** (the runner's pre-tool hook) classifies a call from the owner-steps-in list in `docs/team/protocols.md`: destructive data changes, production deploys, secret writes, payments, outbound messages to people outside the team, and in M3 **accepting a proposal** (the `accept` verb of the work contract; for a repository, merging a pull request). The runner sends `approval.wait`.
- **The role asks** with `request_approval`. The server records it and the runner then waits as above.

Either way the server writes `approvals` and an `approval` card (option `approve` with `stepUp: true`, option `deny`), emits `approval.requested` and `card.updated`, and the session's state becomes `waiting`. When the owner answers, the server emits `approval.decided` and `card.updated`, and sends `approval.result`. The runner continues or refuses the held call. An approval expires after 24 hours by default (the tick marks it `expired`, the call is refused, and the session is told why).

**Step-up stub until OIDC** (clients.md section 3; security reviewer reviews it): `POST /v1/auth/step-up` with the person's bearer token **and** the same admin token typed again in the body (`{ "secret": "…" }`) returns a step-up token (`su_…`, 5 minutes, stored as a hash). `POST /v1/approvals/{id}` and any card option with `stepUp: true` need it in `x-step-up`. Without it, or with an old one, the answer is `401` with problem type `step-up-required`, never a silent approval. The Studio asks the person to type the token in a dialog, forwards it from its own server, and keeps the step-up token server-side for 5 minutes. In M4, OIDC's `auth_time` and the device-key step-up replace the stub; the header stays accepted.

**Proof:** ai-engineer: `the runner pauses a merge until approval.result, and refuses it on deny`, `session.stop finish-step checkpoints first (branch pushed, memory sent)`, `a reconnect resumes the sessions in welcome`, `the session token never appears in the agent's environment or prompt`. backend-dev: `a stale card version gets 409 with the current card`, `an approval without a fresh step-up gets 401 step-up-required`, `a runner key cannot emit message or approval events`, `three missed pings mark the runner's sessions unknown`.

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

A card is never HTML from the server. Every change to a card (created, answered, expired, superseded) emits `card.updated` whose `data.card` is the **whole Card** at its new `version`. A client keeps the latest `card.updated` per card id, and renders that. `decision.requested` and `approval.requested` carry the `card` id, so the timeline line and the card meet. Answers send the `version` they saw; a stale one gets `409` with the current card, which the panel shows in place.

### The cost line

Source: `budget_days.spent` for today (UTC) against `budgets.per_day`, kept by the server from `usage.recorded` events. It is in the chat response and in `GET /v1/me/summary` (`cost`, as already in the contract). Live, the panel adds each `usage.recorded` it sees and replaces the totals on `budget.*` events. Amounts are integers in minor units with a currency; the client formats them.

**Proof:** web-dev: the Playwright round trip against a control plane with a stubbed runner (send, see the reply arrive live, answer a decision card, answer a stale card and see the refreshed one), screenshots at desktop and 360 px, light and dark. backend-dev: `a chat message repeated with the same clientId is stored once`, `chat pages backwards and its asOf resumes the stream with nothing missed`, `owner text round-trips byte for byte` (with leading spaces, emoji and a trailing newline).

## 6. Budget

Owner: **backend-dev** (enforcement), **ai-engineer** (usage reporting and the local stop).

- **Caps.** `PUT /v1/teams/{team}/budget` sets `perDay`, `currency`, and optionally `perRun` and `sessions`. A run can lower them for itself (`RunCreate.caps`), never raise them. With no `perDay` set, a run does not start: `POST /runs` answers `409` "set a daily cap first". For this repository's own team, the owner chooses the number when M3 asks for the model key.
- **Usage.** The runner reports `usage.recorded` after every model turn: `inputTokens`, `outputTokens`, and `cost` in whole minor units. It carries the fraction over to the next report, and rounds up on the session's last report, so the day's total is exact to one minor unit per session.
- **Where it is enforced.** On the server, in the transaction that appends `usage.recorded`: it adds to `budget_days.spent` and compares with `per_day + raised`. The runner also gets `caps.remainingToday` and `caps.remainingRun` in `session.start`, and stops a session on its own when its count reaches them (second line, and the only line while it is offline).
- **At 80%**: once a day, `budget.warned` (`spent`, `cap`, `currency`, `day`). A timeline line in the chat and a notification, nothing stops.
- **At 100%**: once a day, `budget.exhausted`. The run is paused with `reason: budget` (`run.paused`), every live session gets `session.checkpoint` and then `session.stop` `finish-step`, and new deliveries are `held`. A `budget` card goes to the owner: `tomorrow` (recommended: resume at 00:00 UTC) or `raise` (add half the daily cap again for today; `stepUp: true`, because it spends money). Unanswered, the run stays paused past midnight: nothing spends without the owner. Spend can overshoot by at most the turn each live session was in.
- **Per run**: the same at the run's `perRun`, scoped to that run.

**Proof:** backend-dev: `the budget pauses the run at the cap and sends one card`, `80% warns once a day`, `the tomorrow answer resumes the run at the next UTC day, from the tick`. ai-engineer: `the runner stops a session at remainingToday even when the server is unreachable`.

## 7. Timers: the tick

Owner: **backend-dev**. Everything time-based runs in one idempotent function, `tick(now)`, exported by `apps/server`:

- retry `pending` deliveries whose `next_at` has passed, and `sent` ones with no ack
- expire cards and approvals past `expires_at` (`card.updated`, `approval.decided` `expired`)
- the UTC day rollover for budgets (resume runs whose budget card was answered `tomorrow`)
- mark sessions `unknown` when their runner missed three pings
- the existing sink worker's due retries

Each step takes its rows with `for update skip locked`, so two ticks at once do no harm. Every long-running server (local, Compose, the hosted container) calls it every 15 seconds in-process. A serverless-only deployment would call `POST /internal/tick` from a scheduler, with `Authorization: Bearer <CRON_SECRET>`. `/internal/` is not part of `/v1/` and never reachable with a person's or runner's token.

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

- [team-tools.md](../contracts/team-tools.md), **new**: `tools/1`, the seven tools, their fields and checks, and the events each emits.
- [events.md](../contracts/events.md): new types `card.updated`, `budget.warned`, `budget.exhausted`, `session.queued`; new optional fields `chat.message.clientId`, `decision.requested.card` and `session`, `approval.requested.card` and `session`, `approval.decided.session`, `decision.answered.card` and `session`, and the structured message fields from team-tools.md.
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
