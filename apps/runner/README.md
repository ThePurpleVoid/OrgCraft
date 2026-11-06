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

## Not yet

A user per session (today all sessions share `agent`, so one session could change another's working copy before
its checkpoint), microVM sandboxes, merging and opening pull requests with the runner's
own credential after an approval, `secret.get` (M4, with the GitHub App), the subagents run mode, and the long-poll
transport.
