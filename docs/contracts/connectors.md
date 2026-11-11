# Connector manifest, `connector/1`

A connector is how the team reaches anything outside itself: product systems (GitHub, a database, hosting, monitoring) and the owner's channels (email, Slack, a webhook). Every connector has the same lifecycle: connect (OAuth or a key), the secret goes into the vault, health check, scope, revoke. A role can use one only through a binding with a permission (read, write, deploy). A person can use one only through their own notification rules.

Tools are **MCP**. The manifest is the small part MCP does not cover: what the connector is, what it needs, and which capabilities it offers.

```json
{
  "schema": "connector/1",
  "id": "webhook",
  "name": "Webhook",
  "version": "1.0.0",
  "types": ["webhook"],
  "auth": { "kind": "header-secret", "secrets": ["WEBHOOK_TOKEN"] },
  "config": { "url": { "type": "string", "format": "uri", "required": true }, "header": { "type": "string", "default": "x-team-token" }, "format": { "enum": ["envelope", "kit-report"], "default": "envelope" } },
  "capabilities": {
    "notify": { "events": ["*"] },
    "sink": { "events": ["report.*", "message.*"] }
  },
  "permissions": { "read": [], "write": [], "deploy": [] }
}
```

| Capability | Meaning |
| --- | --- |
| `tools` | An MCP server: `{ "command" }` or `{ "url" }`, plus which tools each permission grants (`permissions.read` and so on list tool names or globs) |
| `notify` | Can deliver messages to a person (email, Slack, webhook) |
| `sink` | Receives a copy of matching events. With `format: "kit-report"`, each `report.*` and `message.*` event is posted in the kit's old report shape, so a board a team already runs, such as its own `team-report` function, keeps working unchanged |
| `inbound` | Can send events in: webhooks from GitHub, replies to emails |
| `discover` | Can suggest things for the Studio: folders for owned areas, build files for checks, projects and databases for systems |
| `work` | Implements the work contract verbs ([work.md](work.md)) for a workspace store |
| `export` | Can receive a file: `{ "putFile": true, "target": "<what the target names>" }`. Used by a managed team's standing export (Google Drive, S3). The server calls it only through the connector gateway's put-file effect, which has the vault release the connection's value for that one write (purpose `standing-export`: the team's active connection, with the reserved grant `<team>/standing-export`, which no team system may use as its id), paces it per connection and per tenant, records it as an effect so a written file is never written twice, and lets it reach only the connector's own hosts over https |

Rules: a manifest never holds a secret value, only names. Values live in the vault and are released only to a session whose role is bound to the resource, or to the notifier for a channel. Every release is audited.
