# Hosted team board (optional)

Out of the box, `scripts/agent-team/team-status.sh` appends every report to `~/.agent-team/<project>/events.jsonl` and `scripts/agent-team/team-board.sh` reads it. That is enough when every thread runs on one machine.

When threads run on several machines or in the cloud, or you want a dashboard you can open from your phone, point them at a hosted board. This folder is one on [Supabase](https://supabase.com): one append-only table, two views and one Edge Function.

## Set it up

```sh
# 1. Copy the migration and the function into your Supabase project, then apply and deploy.
cp board/supabase/migrations/*.sql   <your-repo>/supabase/migrations/
cp -r board/supabase/functions/team-report <your-repo>/supabase/functions/
supabase db push
supabase functions deploy team-report --no-verify-jwt

# 2. Make two tokens: one that can only write, one that can only read.
supabase secrets set TEAM_REPORT_TOKEN="$(openssl rand -hex 32)" TEAM_READ_TOKEN="$(openssl rand -hex 32)"

# 3. On each machine that runs threads, put the write token next to the event log (never in the repo).
mkdir -p ~/.agent-team/<project> && chmod 700 ~/.agent-team/<project>
cat > ~/.agent-team/<project>/team.env <<'ENV'
TEAM_REPORT_URL=https://<project-ref>.supabase.co/functions/v1/team-report
TEAM_REPORT_TOKEN=<the write token>
ENV
chmod 600 ~/.agent-team/<project>/team.env
```

`<project>` is `AGENT_TEAM_PROJECT` from `.agent-team/config.sh`. Reports still go to the local log too, so `team-board.sh` keeps working offline.

## Read it

```sh
curl -s -H "x-team-read-token: $TEAM_READ_TOKEN" "https://<project-ref>.supabase.co/functions/v1/team-report?days=7" | jq
curl -s -H "x-team-read-token: $TEAM_READ_TOKEN" "https://<project-ref>.supabase.co/functions/v1/team-report?role=backend-dev" | jq .role
```

The response has `current` (where every role stands, with `stale` and `waiting_on`), `recent` (the last 200 events), `flow` (hand-off edges over 7 days, for a diagram) and `role` (one role's last 100 events). Build your dashboard on it, or let the chief of staff read it for the daily digest.

## Security

- RLS is on and only the service role has grants, so the anon and authenticated keys see nothing.
- The write token can only append rows; the read token can only read. Rotate either with `supabase secrets set`.
- Each role is limited to 30 reports a minute. Events are kept 90 days if you schedule `team_events_purge()`.
