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
| runner → | `session.renew` | `session` | Renew a session token before it expires. Answered with `session.token` |
| → runner | `session.token` | `session`, `token`, `tokenExpires` | The renewed token, for the runner's team tool server only |
| both | `nack` | `ref`, `problem` | A frame was refused (for example an event type this credential may not send). Not retried as is |
| both | `ping` / `pong` | `t` | Heartbeat. After three missed beats the control plane marks the runner's sessions `unknown`, and they are resumed when the runner reconnects |

### Additive fields (since M3)

- `welcome`: `sessions`, the sessions this runner should resume after a reconnect.
- `session.start`: `resume` (boolean), `checkpoint` (`commit`, `memory`) for a resume, `token` and `tokenExpires` (the session token), `caps.remainingToday` and `caps.remainingRun` (minor units), and `delivery` (the bus delivery it answers).
- `session.message`: `delivery`.
- `session.stop`: `reason` (owner, budget, error).
- The `ack` of `session.checkpoint` carries `commit` (the pushed head) and `memory` (the role's memory file, at most 64 KiB), which the control plane stores so the session can resume on any runner.
- The `ack` of `approval.wait` carries `approval` and `card` ids.
- `approval.wait` carries `pr` and `headSha` for an `accept`, and `approval.result` carries the approved `headSha`. The runner merges with that sha pinned, using its own merge credential, never one a session can reach; any other held call runs only if it is byte-identical to the approved call ([M3 design](../product/m3-design.md) section 12, D1 and D2).
- **Proposals are opened and accepted by the runner, not the session.** After the first checkpoint push of a session branch, the runner opens (or later updates) its proposal (for a repository, the pull request) with its own credential and emits `proposal.opened` or `proposal.updated`. To accept, the session calls `request_approval` with `action: accept`; the runner checkpoints first, so the approval names the pushed `headSha`. On `approval.result` approved, the runner itself accepts the proposal pinned to that `headSha` and emits `proposal.accepted` (with the merge commit) or `proposal.failed` (`reason`: head-moved, checks, conflict). On `head-moved` the server supersedes the approval (its card is marked superseded); the runner reads the proposal's current head and asks again with `request_approval`, naming that head, so exactly one open card names the head that is there now. Before it asks again, the runner fetches that head and puts every commit it did not push through the same checks as a checkpoint (ownership, symlinks, large files, the secret scan); if they fail, it asks nothing and emits `proposal.failed` with `reason` checks. No new op: `approval.result` is the trigger.
- **`approval.wait` after a reconnect** carries `approval` (the id from the first `ack`) and `resend: true`. The server answers with the stored approval and card ids and never raises a second card; if the approval was already decided while the runner was away, it sends `approval.result` again.

### What each credential may send

The control plane answers anything else with `nack` and audits it.

| Credential | May send |
| --- | --- |
| Runner key (the WebSocket) | the ops above, and `events` whose types are `session.*`, `usage.recorded`, `report.heartbeat`, `proposal.*` for a session it runs (`proposal.previewed` included: the deployment that is up for a merged PR, events.md), or `chat.message` from the front-door role of a session this runner runs. The control plane sets that message's `from` and `actor` from the session and ignores what the frame says. A `usage.recorded` may carry `meeting` when the turn's wake was a `meeting.turn`; the control plane checks that tag (events.md) |
| Session token (HTTP) | `POST /v1/sessions/{its session}/tools/{tool}` only ([team-tools.md](team-tools.md)) |

Messages between roles, decisions, approvals, cards and run changes are always minted by the control plane, never sent by a runner.

### The M3 subset

M3 builds `hello`, `welcome`, `session.start` (with resume), `session.message`, `session.stop`, `session.checkpoint`, `events`, `approval.wait`, `approval.result`, `session.renew`, `session.token`, `ping`, `pong`, `ack` and `nack`, over the WebSocket. `secret.get` and `secret.value`, and the long-poll transport, come later ([M3 design](../product/m3-design.md) section 4).

## Guarantees

- **Work survives restarts.** Session state that matters is in git (the branch is pushed at checkpoints) and in the role's memory file, which the control plane stores. A lost runner loses at most the work since its last checkpoint, and the control plane can reassign the session to another runner.
- **One writer per area is enforced in the runner,** by a pre-tool hook that checks every write against the team version's owned areas. The control plane does not depend on agents following the rule.
- **Versioned sessions.** A session runs one `teamVersion` until it is checkpointed onto a newer one (ADR 0004). Events carry the version.
- **Adapters, not vendors.** `agent-sdk` (Claude Agent SDK) is the first runtime adapter. The protocol names runtimes as capability strings, so another adapter can be added without touching it.
