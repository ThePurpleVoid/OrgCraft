# Agent Team runner

The data plane: the process that holds checkouts and runs role sessions on the Claude Agent SDK. It connects out to
the control plane (`apps/server`) over one WebSocket and never opens a port. The contract is
[`runner/1`](../../docs/contracts/runner-protocol.md); M3 builds the subset in
[the M3 design](../../docs/product/m3-design.md), section 4.

## Run it

```bash
cd apps/runner && npm install
node bin.mjs register --server https://studio.example --code <one-time code from the Studio>
ANTHROPIC_API_KEY=… node bin.mjs start
```

`register` trades the code for a runner key, kept in `~/.agent-team/runner/runner.json` (readable only by you).
`start` connects with it. A deployment sets `AGENT_TEAM_SERVER` and `AGENT_TEAM_RUNNER_KEY` instead.

**Run it in the container** (`Dockerfile`). That is the supported deployment: the runner runs as `runner` and every
session as `agent`. Outside it (no `AGENT_TEAM_SANDBOX_UID`), sessions share the runner's OS user and could read its
environment, so that is for development only: with `ANTHROPIC_API_KEY` set and no sandbox the runner refuses to
start (`AGENT_TEAM_RUNNER_UNSANDBOXED=1` overrides that for development). On a Mac, run it through Docker:

```sh
docker build -f apps/runner/Dockerfile -t agent-team-runner .        # from the repository root
docker run -d --name agent-team-runner --restart unless-stopped \
  -e AGENT_TEAM_SERVER=https://<control plane> -e AGENT_TEAM_RUNNER_KEY -e ANTHROPIC_API_KEY \
  -v agent-team-runner:/data agent-team-runner
```

`-e NAME` with no value passes the variable from your shell, so the keys never appear on the command line. The
volume holds the runner's folder (`/data/runner`, closed to sessions) and the sessions' (`/data/work`). CI builds this
image and runs the sandbox tests inside it (`runner-image`).

## M3 on a Mac

The M3 exit test runs everything on one Mac: the control plane on `127.0.0.1:4849`, the Studio on `127.0.0.1:4848`,
and the runner in Docker Desktop. The runner reaches the control plane as `http://host.docker.internal:4849`. Plain
http is allowed only to `localhost`, `127.0.0.1`, `::1` and `host.docker.internal`; any other host must be https,
since the runner key and session tokens travel on that link.

Once, before the first start (the owner checklist, part A, made these):

```sh
mkdir -p ~/.agent-team/runner-secrets && chmod 700 ~/.agent-team/runner-secrets
ssh-keygen -t ed25519 -f ~/.agent-team/runner-secrets/runner-deploy-key -N ""   # paste only the .pub as a deploy key
# the merger GitHub App: install it only on the team's own repositories, with Contents and Pull requests
# read and write (and Metadata read) and nothing else. Its private key, downloaded from GitHub, saved as:
mv ~/Downloads/<app>.private-key.pem ~/.agent-team/runner-secrets/merger-app.pem
```

Then, from the repository root:

```sh
# 1. The control plane, then the Studio pointed at it (each in its own terminal; the team id is yours to pick).
node apps/server/bin.mjs                  # http://127.0.0.1:4849, data in ~/.agent-team/server
T=$(cat ~/.agent-team/server/admin.token)
curl -H "authorization: Bearer $T" -H 'content-type: application/json' -d '{"id":"my-team"}' localhost:4849/v1/teams
AGENT_TEAM_SERVER=http://127.0.0.1:4849 AGENT_TEAM_SERVER_TOKEN="$T" AGENT_TEAM_SERVER_TEAM=my-team \
  node apps/studio/server.mjs --open      # http://127.0.0.1:4848

# 2. The runner image.
docker build -f apps/runner/Dockerfile -t agent-team-runner .

# 3. Redeem a one-time code (15 minutes, once), with a step-up. The key lands in the volume, never on screen.
SU=$(curl -s -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -d "{\"secret\":\"$(cat ~/.agent-team/server/step-up.secret)\"}" localhost:4849/v1/auth/step-up | jq -r .token)
CODE=$(curl -s -X POST -H "authorization: Bearer $T" -H "x-step-up: $SU" localhost:4849/v1/runners/codes | jq -r .code)
docker run --rm -v ~/.agent-team/runner-secrets:/run/agent-team:ro -v agent-team-runner:/data agent-team-runner \
  node apps/runner/bin.mjs register --server http://host.docker.internal:4849 --code "$CODE" --name my-mac

# 4. Start it. ANTHROPIC_API_KEY comes from your shell (part B of the owner checklist; not before).
docker run -d --name agent-team-runner --restart unless-stopped \
  -e ANTHROPIC_API_KEY -e AGENT_TEAM_MERGER_APP_ID \
  -v agent-team-runner:/data agent-team-runner
docker logs -f agent-team-runner          # "sandbox checked", then "connected to http://host.docker.internal:4849"
```

The keys are mounted only into the one-off `register` container (step 3), never into the runner that runs sessions:
Docker Desktop does not keep a Mac file's owner and mode inside the container, so a session could read the mount. At
start, as root and before dropping to the runner user, the entrypoint copies `runner-deploy-key` and `merger-app.pem`
from the mount into the volume's `/data/runner` (owned by the runner, `0600`; sessions cannot read that folder) and
writes a git config that pushes over ssh with the deploy key and checks GitHub's published host key (`known_hosts`,
never trust on first use). To replace a key later: `docker run --rm -v ~/.agent-team/runner-secrets:/run/agent-team:ro
-v agent-team-runner:/data agent-team-runner true`, then `docker restart agent-team-runner`. Mount only
`runner-secrets`, never all of `~/.agent-team`: that also holds the control plane's data. Do not add
`--security-opt no-new-privileges` (the sandbox needs its file capabilities).

- `AGENT_TEAM_SERVER` is not needed after `register`: the server is kept with the key in the volume.
- With the merger app's key and `AGENT_TEAM_MERGER_APP_ID`, the runner opens each session's pull request after its
  first checkpoint push and merges it itself, pinned to the head the owner approved (`proposal.*` events). The
  session never holds a credential that can merge: it asks with `request_approval`, action `accept`.
- If the runner cannot connect, check the control plane from inside Docker:
  `docker run --rm agent-team-runner node -e "fetch('http://host.docker.internal:4849/v1/health').then(r=>r.text()).then(console.log)"`.
- What is tested: CI builds this image, runs the sandbox tests in it, and checks the key copy and the git config
  (`runner-image`); `register` and `start` against a local control plane are tested outside Docker. Docker Desktop on a
  Mac itself is not in CI.

## What a session can reach

The agent is the untrusted part: it reads repository content, issues and web pages, so the runner assumes its shell
may be under someone else's control.

- **Another OS user.** Each session's Claude Code process, and every command it runs, starts as `agent`
  (`sandbox.mjs`), with no capabilities and no way to gain any. It cannot read the runner's process environment
  (the runner key, the model key) or the data folder (`/data`, 0700: the key file, the push credential, the
  caches). It works in `/work`, shared with the runner through a group, so the runner can check what it made.
  The runner never follows a link there: the folders on the way to a session's own are the runner's and closed to
  its writes, and the memory file, `.gitconfig` and `.git` are opened without following links. Stopping a session
  signals its whole process group, as the agent, and kills it after a grace period.
- **No credentials.** Each session gets its own empty `HOME` and an allowlisted environment (`PATH`, locale, `TERM`;
  more only by the runner's `sessionEnv`). The model key stays in the runner: sessions reach the model through a
  loopback proxy, with a token of their own that dies with the session and works only for the messages API
  (`modelproxy.mjs`). The runner key and the
  session's tool token never enter it.
- **No pushing.** The session's environment holds nothing that can push. The runner pushes at checkpoints, with its
  own credential (`AGENT_TEAM_RUNNER_GITCONFIG`, a token that can push branches but not the default branch), and only
  after it has checked every commit since the base it recorded when the session started (paths touched in any
  commit, the lines each commit adds, and the commit messages) against the owned areas and the secret scan, and
  refused symlinks that leave the copy (`worktree.mjs`, `secrets.mjs`). If git cannot read that history, nothing
  is pushed. Settings that steer agents or CI
  (`.claude/`, `.mcp.json`, `.github/workflows/`, `.git*`) leave only when an area names them.
- **No planted code.** Each session has its own clone, sharing nothing with other sessions. Before every git command
  the runner runs there, it rewrites `.git/config` from its own template and clears the hooks, and it runs git with
  hooks and fsmonitor off and no user or system config. The branch's own `.claude` settings are not loaded.
- **Approvals.** `policy.mjs` holds the steps the owner keeps (a merge must name `--match-head-commit`). It is a
  convenience, not the security line: what makes those steps safe is that the session has no credential for them.

## What a session is

The control plane sends `session.start` when a message wakes a role. The runner then:

- **checks out the team repository** (one clone per repository) into **a git worktree per session** on the
  session's branch, or a detached read-only checkout for a role that builds nothing (`worktree.mjs`);
- runs the role as **an Agent SDK session**: the generated brief, the protocols, the project's instructions and the
  role's memory file as the system prompt, appended to Claude Code's own; the model from the brief's tier
  (`deep`, `standard`, `routine`, `light`, overridable); the waking message as the prompt, with the owner's words
  verbatim and quoted (`session.mjs`);
- gives it **the team tool server**: the seven tools of [`tools/1`](../../docs/contracts/team-tools.md), checked
  locally (`tools.mjs`) and then sent to `POST /v1/sessions/{session}/tools/{tool}` with the session's token, so the
  control plane re-checks each call and mints the event as that role (`toolserver.mjs`). The token stays in the
  runner process, never in the agent's environment or prompt;
- puts **every tool call through the policy** in a pre-tool hook (`policy.mjs`): writes outside the role's owned
  areas are refused, and the steps `docs/team/protocols.md` keeps for the owner (destructive data changes, a merge,
  a production deploy, a secret, money, a message to people outside the team) pause the session on `approval.wait`
  until a person decides;
- reports **liveness and usage** itself (`session.*`, `report.heartbeat`, `usage.recorded` in whole minor units),
  and posts the front door's replies to the chat as `chat.message`. Nothing else is sent as the runner;
- **checkpoints** on `session.checkpoint` and before every stop: commits what is uncommitted on the session's branch,
  pushes it, and hands the head and the memory file back in the ack, so the session can resume on any runner;
- **stops** on `session.stop` (`finish-step` or `now`) and on its own when its budget (`caps.remainingToday`,
  `caps.remainingRun`) runs out, even while the control plane is unreachable.

Messages reach a session at a turn boundary, never in the middle of a tool call, and each waking event wakes it
once. After a reconnect the runner says hello again, resends every frame not yet acknowledged, and resumes the
sessions `welcome` lists.

## Adapters

`adapters/agent-sdk.mjs` is the runtime (`agent-sdk`). `adapters/stub.mjs` is a scripted stand-in for the model:
it calls the tools through the same checks, policy and tool server, so the tests exercise the runner itself. Before a HANDOFF, BUG, SIGNOFF or
BLOCKED, the runner checkpoints and pushes the branch, so the next role finds the work there; if the branch holds
something that may not leave, the message is not sent and the session is told why.

## Tests

```bash
npm test
```

Against a stand-in control plane on a real WebSocket and real git (`test/fake-control-plane.mjs`): the chief of
staff hands off, the second role wakes and signs off, and every event carries its run and session; a merge waits
for its approval and a denied one never runs; checkpoints push and return memory; the token never reaches the
agent; the budget stops a session offline; reconnects resume. The real-model smoke test is opt-in: it runs only with both
`RUNNER_SMOKE=1` and `ANTHROPIC_API_KEY` set (a real model call, a few cents), and says so when it skips. Without a
key in the runner's own environment the SDK adapter refuses to start a turn, so it never falls back on credentials
the machine happens to have.

## The M3 dry run

The whole M3 exit test on one machine with no model and no key (Pass A): the control plane, the Studio, and this
runner with the scripted fake model in `adapters/dryrun.mjs` (a chief of staff, a builder and QA), against a fresh team
whose remote is a bare repository on disk.

```bash
npm ci --prefix apps/server && npm ci --prefix apps/runner
node tools/dry-run/m3.mjs up --dir /tmp/m3          # prints the Studio link and the step-up secret
node tools/dry-run/m3.mjs signoff --dir /tmp/m3     # QA's SIGNOFF, when QA waits for it (step 6)
node tools/dry-run/m3.mjs hold --dir /tmp/m3        # then approve: the merge waits ...
node tools/dry-run/m3.mjs move-head --dir /tmp/m3   # ... someone pushes to the pull request (step 9b) ...
node tools/dry-run/m3.mjs release --dir /tmp/m3     # ... it fails head-moved, and a new card asks again
node tools/dry-run/m3.mjs spend 6 --dir /tmp/m3     # the next turn costs $6 (step 11)
node tools/dry-run/m3.mjs status --dir /tmp/m3      # pull requests, heads, merge results and the step log
```

`--runner docker` runs the runner image instead (build it first, see the top of the Dockerfile). CI runs both through
`tests/e2e/m3-dry-run.e2e.mjs`.

## Not yet

A user per session (today all sessions share `agent`, so one session could change another's working copy before
its checkpoint), microVM sandboxes, `secret.get` (M4, with the GitHub App), the subagents run mode, and the long-poll
transport.
