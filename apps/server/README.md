# Agent Team control plane

The server behind the online product: the event log, the board, report intake for teams already on the kit, live
streams, sinks and the secret vault. It implements [`/v1/`](../../docs/contracts/api-v1.yaml) and stores
[event envelopes](../../docs/contracts/events.md). Runs and chat (the runner protocol) come next.

## Run it on your machine

```bash
cd apps/server && npm install
node bin.mjs                       # http://127.0.0.1:4848/v1, data in ~/.agent-team/server
```

Local mode keeps everything in one folder: the database (PGlite, which is Postgres compiled to WebAssembly, so
nothing else to install), a master key and an admin token, each readable only by you. The admin token is the
bearer token for every call until GitHub sign-in lands.

## Connect a team that already uses the kit

```bash
T=$(cat ~/.agent-team/server/admin.token)
curl -H "authorization: Bearer $T" -H 'content-type: application/json' -d '{"id":"my-team"}' localhost:4848/v1/teams
curl -X POST -H "authorization: Bearer $T" localhost:4848/v1/teams/my-team/report-tokens
# → { "id": "rt_…", "token": "rt_….…", "url": "http://localhost:4848/v1/teams/my-team/reports" }
```

Put `url` and `token` in the team's `~/.agent-team/<project>/team.env` as `TEAM_REPORT_URL` and
`TEAM_REPORT_TOKEN`. `team-status.sh`, `report.mjs` and the hooks report there with no other change: the body and
the answer are the hosted board's. The token is shown once, can only append reports for that one team, and can be
revoked with `DELETE /v1/teams/my-team/report-tokens/{id}`.

**Keep the team's own board.** A sink forwards every report, in the kit's own shape, to a board the team already
runs (such as `board/supabase`), with its token kept in the vault:

```bash
curl -X PUT -H "authorization: Bearer $T" -H 'content-type: application/json' -d '{"value":"<their token>"}' localhost:4848/v1/secrets/OWN_BOARD_TOKEN
curl -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"url":"https://<ref>.supabase.co/functions/v1/team-report","header":"x-team-token","secret":"OWN_BOARD_TOKEN"}' \
  localhost:4848/v1/teams/my-team/sinks
```

Sinks deliver in order, at least once, and back off from 5 seconds to an hour while the other end is down.

## Read it

| Call | What it gives |
|---|---|
| `GET /v1/teams/{team}/board` | Where every role stands, the recent feed and the hand-off flow (the same shape as the kit's dashboard) |
| `GET /v1/teams/{team}/events?type=message.&cursor=…` | The log, oldest first |
| `GET /v1/teams/{team}/events/stream` | Live server-sent events; reconnects resume from `Last-Event-ID` |
| `POST /v1/teams/{team}/events` | Append envelopes (runners, integrations); ids make retries safe |

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

Not yet: live streams reach only clients of the instance that stored the event (Postgres LISTEN/NOTIFY comes
with a second instance), and people sign in with one admin token (GitHub sign-in is milestone M4).
