# Runner protocol, `runner/1`

A **runner** is the data plane: a process that holds checkouts, sandboxes and released secrets, runs agent sessions and talks to the model API. The **control plane** (the Studio's server) decides what should run. A runner can sit on the owner's laptop, in the same cluster as the control plane, or inside a customer's network. The protocol is the same in all three ([ADR 0005](../adr/0005-online-first-built-to-last.md) §5).

## Shape

- **Runners connect outbound.** A runner opens one WebSocket to `wss://<control-plane>/v1/runners/connect`. Nothing ever connects in to a runner, so no inbound port is opened in the customer's network. If the WebSocket is blocked, long-polling `POST /v1/runners/{id}/poll` carries the same messages.
- **Authentication.** A runner is registered once with a one-time code (`agent-team runner register --code …`), which gives it a runner key. It is scoped to one tenant and, optionally, a list of workspaces, and can be revoked. Each session the runner starts gets its own short-lived token (15 minutes, renewed), and the session uses that token for the team tool server. Agents never see the runner key.
- **Messages** are JSON frames `{ "op", "id", "ref"?, "body" }`. Every request op is acknowledged (`ack` with `ref`). Ops are idempotent by `id`, so a reconnect can resend safely.

## Ops

| Direction | `op` | `body` | Meaning |
| --- | --- | --- | --- |
| runner → | `hello` | `runner`, `version`, `capabilities` (sandboxes: process, container, microvm; slots per pool; agent runtimes: `agent-sdk`, `agent-teams`; max sessions) | Sent first on every connect. The control plane answers with `welcome` (the protocol version it speaks, heartbeat interval, the runner's assignments) |
| → runner | `session.start` | `session`, `run`, `team`, `teamVersion` (commit SHA), `role`, `instance`, `repo` (connector resource and ref), `worktree` (branch to create or reuse), `prompt` (brief, protocols, instructions, memory: resolved by the control plane), `tools` (team tool server URL, MCP servers of bound resources), `secrets` (names only; values come through `secret.get`), `caps` (cost, time, tool policy), `wake` (the message that woke it, verbatim) | Start, or resume, a role session |
| → runner | `session.message` | `session`, `message` | Deliver a message to a session that is running |
| → runner | `session.checkpoint` | `session`, `reason` | Bring the session to a safe point: push the branch, write memory, report. Used by change safety (ADR 0004) and upgrades |
| → runner | `session.stop` | `session`, `mode` (finish-step, now) | Stop |
| runner → | `events` | `events[]` (envelopes, [events.md](events.md)) | Everything the session does is reported this way. The runner itself emits liveness (`session.*`, heartbeats) even if hooks are off |
| runner → | `approval.wait` | `session`, `approval` (`action`, `command` or `call`, `why`) | A pre-tool policy check matched. The session is paused until `approval.result` arrives |
| → runner | `approval.result` | `approval`, `decision`, `by` | Continue or refuse the paused call |
| runner → | `secret.get` | `session`, `name` | Ask for one secret value. Only answered for bound resources of that session's role, and every release is audited |
| → runner | `secret.value` | `name`, `value`, `ttl` | Held in memory and never written to disk or logs |
| both | `ping` / `pong` | `t` | Heartbeat. After three missed beats the control plane marks the runner's sessions `unknown`, and they are resumed when the runner reconnects |

## Guarantees

- **Work survives restarts.** Session state that matters is in git (the branch is pushed at checkpoints) and in the role's memory file, which the control plane stores. A lost runner loses at most the work since its last checkpoint, and the control plane can reassign the session to another runner.
- **One writer per area is enforced in the runner,** by a pre-tool hook that checks every write against the team version's owned areas. The control plane does not depend on agents following the rule.
- **Versioned sessions.** A session runs one `teamVersion` until it is checkpointed onto a newer one (ADR 0004). Events carry the version.
- **Adapters, not vendors.** `agent-sdk` (Claude Agent SDK) is the first runtime adapter. The protocol names runtimes as capability strings, so another adapter can be added without touching it.
