# Agent Team control plane

The server behind the online product: the event log, the board, report intake for teams already on the kit, live
streams, sinks and the secret vault. It implements [`/v1/`](../../docs/contracts/api-v1.yaml) and stores
[event envelopes](../../docs/contracts/events.md). Runs and chat (the runner protocol) come next.

## Run it on your machine

```bash
cd apps/server && npm install
node bin.mjs                       # http://127.0.0.1:4849/v1, data in ~/.agent-team/server
```

Local mode keeps everything in one folder: the database (PGlite, which is Postgres compiled to WebAssembly, so
nothing else to install), a master key and an admin token, each readable only by you. The admin token is the
bearer token for every call until GitHub sign-in lands.

## Connect a team that already uses the kit

```bash
T=$(cat ~/.agent-team/server/admin.token)
curl -H "authorization: Bearer $T" -H 'content-type: application/json' -d '{"id":"my-team"}' localhost:4849/v1/teams
curl -X POST -H "authorization: Bearer $T" localhost:4849/v1/teams/my-team/report-tokens
# → { "id": "rt_…", "token": "rt_….…", "url": "http://localhost:4849/v1/teams/my-team/reports" }
```

Put `url` and `token` in the team's `~/.agent-team/<project>/team.env` as `TEAM_REPORT_URL` and
`TEAM_REPORT_TOKEN`. `team-status.sh`, `report.mjs` and the hooks report there with no other change: the body and
the answer are the hosted board's. The token is shown once, can only append reports for that one team, and can be
revoked with `DELETE /v1/teams/my-team/report-tokens/{id}`.

**Keep the team's own board.** A sink forwards every report, in the kit's own shape, to a board the team already
runs (such as `board/supabase`), with its token kept in the vault:

```bash
curl -X PUT -H "authorization: Bearer $T" -H 'content-type: application/json' -d '{"value":"<their token>"}' localhost:4849/v1/secrets/OWN_BOARD_TOKEN
curl -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"url":"https://<ref>.supabase.co/functions/v1/team-report","header":"x-team-token","secret":"OWN_BOARD_TOKEN"}' \
  localhost:4849/v1/teams/my-team/sinks
```

Sinks deliver in order, at least once, and back off from 5 seconds to an hour while the other end is down.

## Read it

| Call | What it gives |
|---|---|
| `GET /v1/teams/{team}/board` | Where every role stands, the recent feed and the hand-off flow (the same shape as the kit's dashboard) |
| `GET /v1/teams/{team}/events?type=message.&cursor=…` | The log, oldest first |
| `GET /v1/teams/{team}/events/stream` | Live server-sent events; reconnects resume from `Last-Event-ID` |
| `POST /v1/teams/{team}/events` | Append envelopes (runners, integrations); ids make retries safe |

## Your view across teams

| Call | What it gives |
|---|---|
| `GET /v1/me/summary` | Each team at a glance: roles working, waiting, blocked and idle, today's cost in minor units. `asOf` and an `ETag` |
| `GET /v1/me/stream` | Live events for every team of yours, as server-sent events; resumes from `Last-Event-ID` (an event id) |

The run state, live version, daily cap and inbox count in the summary fill in as runs, budgets and cards land (M3).

## Register a runner

A runner (the process that runs agent sessions, `docs/contracts/runner-protocol.md`) is registered once with a
one-time code. A person mints it; the runner redeems it for its key, which is shown once and kept only as a hash:

```bash
curl -X POST -H "authorization: Bearer $T" localhost:4849/v1/runners/codes      # → { "code": "K7QM-…", "expires": … }
curl -H 'content-type: application/json' -d '{"code":"K7QM-…","name":"my laptop","capabilities":{"runtimes":["agent-sdk"]}}' localhost:4849/v1/runners
# → { "id": "rnr_…", "key": "rnr_….…", … }
```

Codes last 15 minutes and work once. `GET /v1/runners` lists runners (never keys) and `DELETE /v1/runners/{id}`
revokes one.

## Retries are safe

Every write takes an `Idempotency-Key` header. The first answer is kept for a day, and a retry with the same key gets
it back with `Idempotent-Replayed: true`, so a request sent twice from a bad connection acts once. The same key on a
different request is a `422`. Report intake needs none: the kit's report ids already make its retries safe.

## Runs, chat, cards and approvals (M3)

| Call | What it does |
|---|---|
| `GET`/`PUT /v1/teams/{team}/budget` | The daily cap (`perDay`, minor units), `perRun`, live `sessions` and today's spend. A run needs a daily cap |
| `POST /v1/teams/{team}/runs` | Start a run, frozen on `team: { version, roles: [{ slug, reportsTo, areas }] }` with exactly one role reporting to `owner` (the front door) |
| `POST /v1/runs/{run}/pause`, `/resume`, `/stop` | Pause and stop are always one tap |
| `GET`/`POST /v1/teams/{team}/chat` | The chat page (items, current cards, run, cost line); a message is stored byte for byte, and a repeated `clientId` once |
| `POST /v1/approvals/{id}`, `GET`/`POST /v1/cards/{id}` | Answer with the `version` you saw; a stale one gets `409` with the current card |
| `GET /v1/me/inbox` | Every open card across teams, approvals first, with `asOf` and an `ETag` |

At 80% of the daily cap the team gets `budget.warned`; at 100% its runs pause and one `budget` card asks the owner
to resume tomorrow or add half the cap again.

**Step-up.** Approving, raising or clearing a cap, resuming a run the budget paused, and adding to the budget need a
fresh step-up: `POST /v1/auth/step-up` with `{ "secret": "…" }` returns a token for `x-step-up`, valid 5 minutes and
once. Without it the answer is `401` with `"type": "step-up-required"`. The secret is not the sign-in token (that is
refused); the server keeps only its scrypt hash, from `AGENT_TEAM_STEP_UP_SECRET_HASH`:

```bash
printf '%s' 'a secret of 12 characters or more' | node bin.mjs --hash-step-up   # → scrypt$32768$8$1$…
```

Five wrong secrets in 15 minutes lock step-up for the tenant (`429`), and every try is audited. Local mode makes a
secret in `--data/step-up.secret`. M4's sign-in replaces the secret; the header stays.

## Host it in another server

`createHandler(opts)` from `server.mjs` is the API as a plain `(req, res)` handler, for serverless functions or a
framework; `createControlPlane(opts)` wraps it in `node:http`. Open streams read the log every `pollMs` (2 seconds by
default) as well as listening in process, so on many instances a stream still sees every append.

## Deploy it

Set `DATABASE_URL` to a Postgres (16 or later) and pass the keys in the environment:

| Variable | |
|---|---|
| `DATABASE_URL` | `postgres://…`. The user owns the schema and needs CREATEROLE once, to create `agent_team_app` |
| `AGENT_TEAM_MASTER_KEY` | 32 bytes, base64 (`openssl rand -base64 32`). Seals secrets; keep it in your secret manager |
| `AGENT_TEAM_ADMIN_TOKEN` | Bearer token for people until sign-in lands |
| `AGENT_TEAM_TENANT` | The tenant people sign in to (default `local`) |
| `AGENT_TEAM_PUBLIC_URL` | How others reach the server, for report URLs |

Migrations run on start, one instance at a time.

## How tenants are kept apart

Every tenant-owned table has row-level security on `app.tenant`. The server does all tenant work in a transaction
as `agent_team_app` with `app.tenant` set, so a missing filter in the code still cannot read or write another
tenant's rows. Only the schema owner sees across tenants, for migrations, report-token lookup and the sink
worker's scan. The tests check this against the database directly, on PGlite and on a real Postgres:

```bash
npm test                                                   # PGlite, in memory
TEST_DATABASE_URL=postgres://… npm test   # a real Postgres; wipes its public schema
```

Not yet: events from other instances reach a stream within `pollMs` rather than at once (Postgres LISTEN/NOTIFY can
come with always-on instances), and people sign in with one admin token (GitHub sign-in is milestone M4).

Appends take a per-tenant advisory lock so that `seq` is commit order and a stream never skips an event. That
puts one tenant's appends in a line: each is one short transaction (a few milliseconds), so the ceiling is a few
hundred events a second per tenant, far above an agent team's rate. Tenants do not wait for each other.

Tests on a real Postgres run one file at a time, since each test wipes the schema.
