# Deploy on Vercel, Supabase and one container host

Owner: infra, secrets and on-call. Status: ready to run once the accounts exist, 2026-11-06. Issue #34.

This is one deployment target among several ([deployment](../product/deployment.md)). Nothing in the product depends on Vercel, Supabase or Fly.io: the database is plain Postgres, the API is one container image, and the site is static files. This repository's own team runs on it, which makes the kit's own team the product's second real online customer.

## What runs where

The split is the architect's (m3-design.md §8), accepted by the CTO.

| Part | Where | Why |
|---|---|---|
| Site page | **Vercel**, static files only | For now a status page that calls `/v1/health`. The Studio page talks to the local Studio server's own routes, so the hosted Studio is an M4 item (architect, web-dev). Then `build.mjs --studio` ships it. No Vercel Functions, no Vercel Cron |
| `/v1/*` and `/.well-known/agent-team` | Vercel **rewrites** them to the container | People, phones and the kit's report scripts use one host |
| The whole API, live streams, the sink worker, timers (a 15-second in-process tick), the runner's WebSocket | **One always-on `apps/server` container on Fly.io** | Serverless functions end; streams, sockets and timers are long-lived. One instance, so live fan-out needs nothing extra |
| Runner (Agent SDK sessions in git worktrees) | **A second Fly.io app** in the same organization and region, with a volume | Long sessions, a filesystem and git. It connects out to the container by WebSocket, never through Vercel |
| Postgres | **Supabase**, in a dedicated `agent_team` schema | Migrations run as they are. Row-level security per tenant, unchanged |

Streams pass through the Vercel rewrite. The deploy's smoke test proves they arrive unbuffered (first bytes at once, the server's 20-second keep-alive while open). If that check ever fails, clients must open streams on the container host directly, and discovery names that host for streams.

### Why Fly.io for the container

| Host | Fit |
|---|---|
| **Fly.io (chosen)** | Runs our Dockerfile as an always-on machine. Its proxy carries WebSockets and SSE. Volumes for the runner's worktrees. A private network between the API and the runner apps. `release_command` runs migrations in a one-off machine before any traffic moves. Region `iad` sits next to Supabase's `us-east-1`. Deploys from Actions with one token. About $4 a month for the API machine |
| Render | Also good: web service plus background worker and a pre-deploy command. Disks only on paid instances, and the worker and the API are billed separately from the start |
| Railway | Good developer experience and volumes, but usage pricing is harder to cap and there is less control over regions |
| A plain VM | The most control, but we would run TLS, restarts, patching and log shipping ourselves |
| The owner's Mac | Free, and fine as an extra runner for local devices, but it sleeps and is not online |

## Supabase specifics

- **Its own login and schema.** [`deploy/supabase/bootstrap.sql`](../../deploy/supabase/bootstrap.sql) runs as `postgres` and creates two roles. `agent_team_app` is the role all tenant work runs as. `agent_team_owner` is the login, with `search_path = agent_team`, membership in `agent_team_app`, and **no CREATEROLE**. On Supabase, CREATEROLE would let it grant itself built-in roles such as `service_role`, so the migrator refuses a login that still has it. The migrator creates the schema, so that login owns everything in it. Nothing goes in `public`, which Supabase's Data API exposes to `anon` and `authenticated`.
- **Checked on every deploy.** [`deploy/server/migrate.mjs`](../../deploy/server/migrate.mjs) refuses to migrate into a schema those roles can use, and after migrating it fails if they can reach any table. It also refuses migrations with a DROP, TRUNCATE, DELETE FROM, a rename or a column type change unless the owner approves (the Deploy workflow's `allow_destructive` input).
- **The connection.** Use the **Session pooler** string (port 5432, user `agent_team_owner.<project-ref>`). It works over IPv4 and IPv6, from Fly and from Actions. The server holds its own pool (`DATABASE_POOL=5`). The transaction pooler (6543) also works: the server's full test suite passes behind pgbouncer in transaction mode, because all tenant state is per transaction (`set_config(…, true)`, `set local role`, transaction advisory locks) and statements are unnamed. It is just not needed by an always-on server. The direct connection is IPv6-only on Supabase unless you buy the IPv4 add-on.
- **TLS, verified.** Append `?sslmode=verify-full&sslrootcert=deploy/supabase/prod-ca-2021.crt`. That file is Supabase's public root CA ("Supabase Root 2021 CA", valid to 2031). It is committed and copied into the image, and the path works from the image's `/app` and from the repository root. The Deploy workflow refuses a `DATABASE_URL` without `verify-full`. If Supabase ever rotates its CA, replace the file with the one from Database Settings → SSL Configuration.
- **The password stays out of the logs.** Supabase logs DDL by default, which would include `ALTER ROLE … PASSWORD`. The bootstrap turns statement logging off for its own connection first.
- **One control plane per Postgres cluster.** `agent_team_app` is a cluster-wide role. On Supabase each project is its own cluster, so this never matters there.
- **Backups.** Free plan: none you can restore yourself. Pro ($25 a month): daily backups kept 7 days, and point-in-time recovery as an add-on. The team files are in Git either way. What would be lost is the event log, board history and vault.

## The owner's checklist

Thirteen steps, about 30 minutes. Values go only where a step says. Never into chat, issues, files or memory.

**Supabase**
1. Create a project at supabase.com: name `agent-team-kit`, region **East US (North Virginia)**, plan Free (or Pro, for backups). Keep the generated `postgres` password in your password manager. Nothing here uses it after step 2.
2. Open SQL Editor → New query, paste [`deploy/supabase/bootstrap.sql`](../../deploy/supabase/bootstrap.sql), and replace `REPLACE_WITH_A_GENERATED_PASSWORD` with a new password from your password manager (letters and digits, 32 or more). Run it, then delete the query from the editor's snippet list. The script turns statement logging off first, so the password does not reach the Postgres logs.
3. Click **Connect** → Session pooler and copy the URI. Change the user to `agent_team_owner.<project-ref>`, use the password from step 2, and append `?sslmode=verify-full&sslrootcert=deploy/supabase/prod-ca-2021.crt`. This is the value for **`DATABASE_URL`** (step 7).

**Fly.io**
4. Sign up at fly.io and add a card (pay as you go, about $4 a month to start). Go to Tokens → Create token (an org token for `personal`). This is **`FLY_API_TOKEN`**.

**Vercel**
5. Sign up at vercel.com (Hobby is fine while this is non-commercial). Go to Account Settings → Tokens → Create, with full account scope. This is **`VERCEL_TOKEN`**. Do not import the repository into Vercel: the workflow deploys after CI and creates the project itself.

**Two keys you make yourself**
6. Run `openssl rand -base64 32` twice. The first is **`AGENT_TEAM_MASTER_KEY`**: it seals the vault, so losing it loses every stored secret. Keep it in your password manager. The second is **`AGENT_TEAM_ADMIN_TOKEN`**: it is how you sign in until GitHub sign-in lands. Keep it too. Third, marked **M3 exit** (step 10 deploys without it): choose a step-up secret, the phrase you will type each time you approve something, at least 12 characters. Keep it in your password manager, then run `node deploy/server/step-up-hash.mjs` in a clone of the repository (Node 20+). It asks for the phrase without showing it and prints **`AGENT_TEAM_STEP_UP_SECRET_HASH`**. Only the hash goes into GitHub.

**GitHub** (repository Settings)
7. Go to Environments → New environment → `production`. Set **Deployment branches and tags** to Selected → `main`, and tick **Required reviewers** → yourself, so that every deploy waits for your click. Both are required: they keep production secrets away from any other branch. Then, under Environment secrets, add the five values: `DATABASE_URL`, `FLY_API_TOKEN`, `VERCEL_TOKEN`, `AGENT_TEAM_MASTER_KEY`, `AGENT_TEAM_ADMIN_TOKEN`. At the M3 exit, add a sixth: `AGENT_TEAM_STEP_UP_SECRET_HASH`.
8. Go to Secrets and variables → Actions → Variables and add `FLY_APP` = a globally unique name such as `purplegiragge-agent-team` (the API becomes `https://<FLY_APP>.fly.dev`) and `VERCEL_PROJECT` = `agent-team-kit`. If that Vercel name is taken, also set `AGENT_TEAM_PUBLIC_URL` to the address Vercel gives the project. Optional: `FLY_REGION` (default `iad`), `FLY_ORG` (default `personal`), `VERCEL_SCOPE` (a Vercel team slug), `AGENT_TEAM_TENANT` (default `main`).
9. Add the variable `AGENT_TEAM_DEPLOY` = `on`. Until it exists, the Deploy workflow does nothing.

**First deploy**
10. Go to Actions → Deploy → Run workflow on `main`. It checks that every name is set, creates the Fly app, stages the server secrets on Fly (the step-up hash too, once it is set), migrates Supabase, starts the container, publishes the site, and smoke-tests both. If a later migration is flagged destructive, the deploy stops. Once you have agreed to it, re-run with `allow_destructive` ticked: that runs the migration once from Actions, and no running machine ever carries the flag. It takes about 5 minutes. After this, every green CI run on `main` asks for your approval in the Actions tab, then deploys.
11. Tell the chief of staff it is green. The team then connects the kit's own team to it: it creates the team, mints a report token, and puts `TEAM_REPORT_URL` and `TEAM_REPORT_TOKEN` in the shared board's `team.env`. You paste nothing for this.

**Later, when the chief of staff asks (M3 and M4)**
12. `ANTHROPIC_API_KEY`, with a daily spend cap set in the Anthropic console, as an environment secret for the runner app.
13. The GitHub App (sign-in and pushes): its app id, private key and client secret, by the names the chief of staff gives.

## Costs to expect

| | Start | When it grows |
|---|---|---|
| Supabase | Free | Pro $25 a month (backups, no pausing, 8 GB) |
| Fly.io API machine (shared-cpu-1x, 512 MB) | about $4 a month | a bigger size before a second instance |
| Fly.io runner (shared-cpu-2x, 4 GB, 20 GB volume), from M3 | about $25 a month | more machines, one per parallel load |
| Vercel | Hobby $0 | Pro $20 a month once this is commercial |
| Model usage | the daily cap you set | |

Prices are as of November 2026; check each provider's page.

## What breaks if a part is missing

| Missing | What you see |
|---|---|
| The container (Fly) | The status page says the control plane is not reachable, and every `/v1` call through Vercel returns a 5xx. Reports from the kit's scripts fail and are logged locally only (the scripts never block) |
| Supabase | The container fails its release command (`migrate:` errors in the Fly logs), so the old version keeps serving. A running server answers 500 on data calls and `/v1/health` still answers |
| Vercel | The status page is gone, but the API still works at `https://<FLY_APP>.fly.dev`. People, phones and report URLs that name the Vercel host fail |
| The runner | The board, reports and approvals work. Chat and runs wait in the queue until a runner connects |
| `AGENT_TEAM_MASTER_KEY` changed | Stored secrets cannot be opened. Put the old key back, or re-enter every secret |

## Files

| Path | What |
|---|---|
| [`deploy/server/Dockerfile`](../../deploy/server/Dockerfile) | The control plane image, the same for every host |
| [`deploy/server/migrate.mjs`](../../deploy/server/migrate.mjs), [`guard.mjs`](../../deploy/server/guard.mjs) | Migrate with the destructive guard and the Data API check |
| [`deploy/server/step-up-hash.mjs`](../../deploy/server/step-up-hash.mjs) | Hashes the owner's step-up secret (scrypt) without echoing it |
| [`deploy/supabase/bootstrap.sql`](../../deploy/supabase/bootstrap.sql) | The one-time login and schema setup |
| [`deploy/fly/server.toml`](../../deploy/fly/server.toml), [`runner.toml`](../../deploy/fly/runner.toml) | Fly configs (the runner's is a draft until apps/runner lands) |
| [`deploy/runner/Dockerfile`](../../deploy/runner/Dockerfile) | The runner image (draft) |
| [`deploy/vercel/build.mjs`](../../deploy/vercel/build.mjs) | Writes the static site and its rewrites |
| [`deploy/smoke.mjs`](../../deploy/smoke.mjs) | The read-only post-deploy check |
| [`deploy/env/`](../../deploy/env/) | Every secret and variable, by name only |
| [`.github/workflows/deploy.yml`](../../.github/workflows/deploy.yml) | The deploy, after CI on `main` or by hand |

CI's `deploy-path` job runs the bootstrap, the migrator and the server behind pgbouncer in transaction mode on a Postgres set up like Supabase, then the smoke test, on every PR.

## Rollback

- **Container:** `flyctl releases --app <FLY_APP>`, then `flyctl deploy --image <previous image>`. Migrations are additive within a major version, so the previous image runs on the newer schema.
- **Site:** Vercel → Deployments → the previous one → Promote.
- **Database:** restoring a backup needs Pro. A destructive migration only runs with the owner's explicit OK.
