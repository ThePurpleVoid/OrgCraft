# Contracts

These are the interfaces that other things depend on: the Studio, the runner, the CLI, the kit's hooks, connectors, and teams that already report to boards of their own. [ADR 0005](../adr/0005-online-first-built-to-last.md) explains why they come first and why they have to outlast their implementations.

| Contract | File | Version | Who depends on it |
| --- | --- | --- | --- |
| Event envelope | [events.md](events.md), [schema/event.v1.json](schema/event.v1.json) | `1` | The board, audit, notifications, meetings, transitions, the webhook sink, every runner |
| Public API | [api-v1.yaml](api-v1.yaml) (OpenAPI 3.1) | `/v1/` | The Studio, the CLI, the kit's hooks, integrations |
| Runner protocol | [runner-protocol.md](runner-protocol.md) | `runner/1` | Runners (data plane) and the control plane |
| Connector manifest | [connectors.md](connectors.md), [schema/connector.v1.json](schema/connector.v1.json) | `connector/1` | Every connector, the vault, bindings |
| Work contract | [work.md](work.md) | `work/1` | The repository connector first, then any workspace store |
| Clients | [clients.md](clients.md) | `/v1/` | The Studio on desktop and phone, the iPhone and Android apps, the CLI |
| Team | [TeamSpec](../../packages/team-model/schema/team-spec.v1.json) and `.agent-team/` | `team-spec@1` | Already shipped in kit 0.5 |

## Rules for changing them

1. **Additive only within a version.** New optional fields, new event types, new endpoints, and new enum values that readers can ignore are all fine. Renaming, removing, retyping, or making something required needs a new version.
2. **Readers ignore what they do not know.** Unknown fields and event types are kept and passed on, never rejected. This is what lets old runners talk to a newer control plane.
3. **A new version ships with a migration path.** That means an upcaster for stored events (`v1` to `v2` on read), and at least 12 months of serving both API versions.
4. **No vendor in a contract.** No model, cloud, SDK or database name appears in a field, a type or an enum. Vendors are values (`"provider": "anthropic"`), never shapes.
5. **Compatibility with what already runs.** Every team on the kit today reports with `team-status.sh`, `report.mjs` and the hooks. The API accepts those reports byte for byte (`POST /v1/teams/{team}/reports`). A team never has to change its scripts to be seen by the product.
6. **Changes go through review.** Any PR that touches this folder needs the architect's review and a line in the CHANGELOG.
