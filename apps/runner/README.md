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
`start` connects with it. A deployment sets `AGENT_TEAM_SERVER` and `AGENT_TEAM_RUNNER_KEY` instead. In M3 the model
key is in the runner's own environment; nothing else from that environment reaches a session but the toolchain
(`PATH`, `HOME`, proxies).

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
it calls the tools through the same checks, policy and tool server, so the tests exercise the runner itself.

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

Sandboxes beyond a local process (Docker, microVMs), `secret.get` (M4, with the GitHub App), the subagents run
mode, and the long-poll transport.
