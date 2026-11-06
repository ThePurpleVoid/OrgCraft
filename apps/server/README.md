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
SU=$(curl -s -H "authorization: Bearer $T" -H 'content-type: application/json' -d "{\"secret\":\"$(cat ~/.agent-team/server/step-up.secret)\"}" localhost:4849/v1/auth/step-up | jq -r .token)
curl -X PUT -H "authorization: Bearer $T" -H "x-step-up: $SU" -H 'content-type: application/json' -d '{"value":"<their token>"}' localhost:4849/v1/secrets/OWN_BOARD_TOKEN
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
one-time code. A person mints it, with a step-up (below), since a runner is another pair of hands; the runner redeems it for its key, which is shown once and kept only as a hash:

```bash
curl -X POST -H "authorization: Bearer $T" -H "x-step-up: $SU" localhost:4849/v1/runners/codes   # → { "code": "K7QM-…", … }
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
to resume tomorrow or add half the cap again. While the day is spent no run resumes, whoever paused it. A run's own
`caps.costPerRun` and `caps.costPerDay` pause just that run, and raising one gives that run more without changing the
team's caps. Every budget change is a `budget.updated` event. One run per team at a time is held by a unique index.

**Step-up.** Approving, raising or clearing a cap, resuming a run the budget paused, and adding to the budget need a
fresh step-up: `POST /v1/auth/step-up` with `{ "secret": "…" }` returns a token for `x-step-up`, valid 5 minutes and
once. Without it the answer is `401` with `"type": "step-up-required"`. The secret is not the sign-in token (that is
refused); the server keeps only its scrypt hash, from `AGENT_TEAM_STEP_UP_SECRET_HASH`:

```bash
printf '%s' 'a secret of 12 characters or more' | node bin.mjs --hash-step-up   # → scrypt$32768$8$1$…
```

Five wrong secrets in 15 minutes lock step-up for the tenant (`429`), and every try is audited. Each try is
counted, under a per-tenant lock, before the slow check runs, and one check per tenant runs at a time (`429` while one
does), so parallel guesses gain nothing. The hash may use scrypt N from 2^15 to 2^17 and r up to 8: at most 128 MiB a check. With no hash set,
step-up is refused (`401 step-up-required`), never passed. A notification to the owner on lockout comes with the
notification channels (M4). Local mode makes a
secret in `--data/step-up.secret`. M4's sign-in replaces the secret; the header stays.

## The bus: waking roles on runners

A run's roles live on runners. The control plane decides who an event wakes and sends it:

- the owner's chat message wakes the front door (the one role that reports to `owner`);
- a HANDOFF, BUG, SIGNOFF or BLOCKED wakes its `to` (a BLOCKED with no `to` goes up the chain);
- an answered decision card or a decided approval wakes the session that asked.

Each wake is a `deliveries` row written with the event. It goes out as `session.message` to a live session, or as
`session.start` (with the roster, the role's brief and areas, its worktree branch, a 15-minute session token and the
tools URL) to the least busy connected runner. A run at its session cap queues the role (`session.queued`). Unacked
sends are retried after 5 s, 30 s, 2 min, then every 10 min; after ten tries the delivery is dead and the front door
gets a BLOCKED. While a run is paused or the day's budget is spent, deliveries are held and go out on resume. Pausing
asks each live session for a checkpoint (its branch pushed, its memory file) and then stops it after the current step;
the next start resumes from the checkpoint.

A session's branch is `team/<role>/<run id>`, or the waking message's `branch` when that is the role's own `team/<role>/…`
branch: never `main`, a `claude/**` branch or another role's.

Sessions call the team tools at `POST /v1/sessions/{session}/tools/{tool}` with `Authorization: Bearer st_…`. The
control plane checks `tools/1` again (it is the authority), takes the actor from the token, and audits each call. A
session token is refused (`403`) on every person endpoint. An `accept` approval must name the `pr` and `headSha`, and
`approval.result` carries the approved head.

Runners may send `session.*`, `usage.recorded`, `report.heartbeat`, `proposal.*` and (the front door only)
`chat.message` events, for sessions they run; the server sets the actor, run and team. Anything else is nacked and
audited.

**The tick** runs in-process every 15 s (`tickMs`): retries, expired approvals and cards (closed, with
`approval.result` to the session), budget-paused runs on the next UTC day, queued sessions, and sockets of revoked
runners. Rows are taken with `skip locked`, so instances can tick at once. A host without a long-lived process calls
`POST /v1/internal/tick` with `Authorization: Bearer $CRON_SECRET`; with `CRON_SECRET` unset that path does not exist.

## Signing in (hosted, M4)

Off unless `GITHUB_APP_CLIENT_ID` is set, so local mode is unchanged. Then the control plane is the deployment's
own OIDC issuer ([ADR 0007](../../docs/adr/0007-deployment-is-its-own-identity-provider.md), spec
[m4-sign-in.md](../../docs/specs/m4-sign-in.md)), built on [oidc-provider](https://github.com/panva/node-oidc-provider), an
OpenID-Certified library: `identity.mjs` holds its storage adapter and our policy, and no protocol code of our own.

- **Web.** The Studio opens `/oauth/authorize?client_id=agent-team-web&return=<path>`. With no session, that leads to
  `/sign-in?interaction=<uid>` (the Studio's page), then GitHub (`/oauth/interaction/<uid>/github`), then the
  issuer's callback. The web leg's code is consumed on the server, which sets `__Host-agent-team` (HttpOnly, Secure,
  SameSite=Lax; 12 hours idle, 7 days in all) and returns to `return`, checked with the Studio's own `safeReturn`.
  Unsafe methods with the cookie need this deployment's `Origin` and `content-type: application/json`. Sign out is
  `POST /oauth/revoke` with the cookie and `{}`.
- **Apps and the CLI.** The authorization code flow with PKCE (S256) and exact redirect URIs. Refresh tokens rotate
  and are bound to the device's DPoP key. Reusing one revokes its whole family and writes an `identity_audit` row.
- **Who gets in.** A member, someone with an open invitation (by numeric GitHub user id, or a verified primary email),
  or, on a deployment with no members yet, `AGENT_TEAM_OWNER_GITHUB`, whose first sign-in makes them the owner.
  Anyone else gets `/sign-in?error=not-invited` and nothing is stored. The person's GitHub token is used once to
  read who they are, and dropped.
- **Settings:** `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, an https `AGENT_TEAM_PUBLIC_URL` (the issuer),
  `AGENT_TEAM_OWNER_GITHUB`, and `AGENT_TEAM_PROXY_HOPS` with `AGENT_TEAM_EDGE_SECRET` so rate limits read the caller's IP from our own proxies (from the right of `x-forwarded-for`), never from a client. The signing key is made on
  first start and sealed in the vault.

- **Passkeys and step-up** (`passkeys.mjs`, on @simplewebauthn/server). A person adds a passkey at
  `/v1/me/passkeys`: the first one within 5 minutes of signing in, later ones with step-up. Step-up is
  `GET /v1/auth/step-up/challenge`, then `POST /v1/auth/step-up { webauthn }`, which returns a single-use `su_` for
  this person in this workspace. The typed secret is refused once sign-in is on.

- **Roles on every route** (`roles.mjs`). viewer < editor < approver < admin < owner, each including the ones before
  it: a viewer reads, an editor chats and runs, an approver answers approvals and cards, an admin manages teams,
  budgets, runners, tokens, secrets and members, an owner makes owners. Every route a person can call is listed with
  its minimum, `api-v1.yaml` states the same as `x-min-role` (a test checks they agree), and an unlisted route is
  refused. Step-up never lifts a role: a viewer with a fresh `su_` still cannot approve.
- **Members and invitations** (`members.mjs`). `GET /v1/members`, `PATCH`/`DELETE /v1/members/{id}`, and
  `GET`/`POST`/`DELETE /v1/invitations` (`{ github: login or id, role }`; the login is resolved to its numeric id
  once). Changes need step-up and are audited. Only an owner makes or removes an owner, and nobody removes or demotes
  the last one. Membership is read on every request, so a removed member is refused on their next one; a person left
  in no workspace is signed out everywhere, app tokens included.
- **The admin token is retired** once anyone owns the deployment (401, `admin-token-retired`). The host's way back in
  when no owner can sign in is `agent-team-server admin reset-owner <github-user-id>` (on Fly:
  `fly ssh console -C "agent-team-server admin reset-owner 1234"`), an owner invitation valid for one day.

Still to come (order 2): bearer tokens from the apps on `/v1`, and the `oidc-conformance` CI job.

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
