# ADR 0005: online first, built to last a decade

Status: accepted, 2026-11-06 (the owner: "customers of this product would be deploying this system online always, so let's think end game. I want an architecture that holds up a decade later"). Owner: architect. Supersedes the "local first" principle in the architecture and PRD N1. Keeps ADR 0001 (the repository is the source of truth), ADR 0002 (our own runner) and ADR 0003 (the no-build local editor, now the development and evaluation mode).

## Context

The first plan made a laptop the MVP target and treated self-hosted and hosted as later phases with "other drivers". A team that runs for months, holds meetings on a schedule, sends notifications at 3 a.m. and is steered from a phone is a service that has to be up when the laptop is closed. Customers will run it online. If the online shape is added later, the parts that are hardest to change after the fact (tenancy, identity, the data model, how long-running work survives restarts, how secrets and connectors work) get built twice.

A decade is long enough for most of our vendors, frameworks and even the model APIs to change. What lasts is the set of contracts other things depend on, and plain, widely supported infrastructure.

## Decision

### 1. One product, deployed online. Local is the same product on one machine.

The target is an online deployment: the customer's own cloud (self-hosted), or our hosted service, both from the same images. "Local" is that same build started with one command for development, evaluation and demos. It is not a separate architecture, and no feature may work only locally.

### 2. Durable contracts outlive implementations

These are versioned, documented, and changed only with a migration path. Everything behind them may be replaced.

| Contract | Format | Why it lasts |
| --- | --- | --- |
| The team | `.agent-team/` in Git, TeamSpec JSON Schema (`agent-team/team-spec@N`) with upgrade functions from every earlier `N` | Git and plain files outlive any database or vendor (ADR 0001) |
| Events | One append-only event envelope (`id`, `type`, `version`, `tenant`, `team`, `time`, `actor`, `subject`, `data`), CloudEvents-compatible | Board, audit, notifications, meetings and transitions are projections of it. New views never need a migration of history |
| Connectors | MCP for tools, plus a small capability manifest (`tools`, `notify`, `inbound`, `discover`) | An open protocol, not our plugin API. Anything that speaks MCP plugs in |
| Public API | HTTP + JSON, OpenAPI, versioned in the path (`/v1/`), with a deprecation window of at least 12 months | Integrations and the CLI depend on it, not on our UI |
| Runner protocol | Run, session, message, approval and checkpoint as API resources. Agent runtimes are adapters behind it | Model vendors and agent SDKs will change. The runner protocol is ours |

### 3. Boring, durable infrastructure

- **Postgres everywhere**, including local (an embedded or bundled Postgres), so there is one SQL dialect, one migration path and no SQLite drift. Row-level tenancy from the first table.
- **The event log is the system of record for runtime state**: runs, sessions, messages, approvals, meetings, notifications and transitions. Tables for current state are projections we can rebuild.
- **Durable workflows for anything long-running**: meetings, transitions, approvals waiting on a person, notification retries, scheduled jobs. Each one is a persisted state machine with timers, resumed after any restart. Behind a small interface, the first engine is a Postgres-backed job and timer table. A dedicated engine (Temporal or similar) can replace it without touching callers.
- **Object storage (S3 API)** for evidence: screenshots, logs, minutes attachments.
- **OpenTelemetry** for traces, metrics and logs.

### 4. Tenancy, identity and access from day one

- Every record carries `tenant` (organisation) and, where it applies, `workspace` and `team`. A local install is one tenant.
- Sign-in through OIDC (GitHub first, then Google, Microsoft, any SAML/OIDC provider for enterprise). Local mode uses a single built-in owner account, through the same code path.
- Roles for people: owner, admin, editor, viewer, approver. Approvals check the person's role, not just that someone clicked.
- Per-person settings (notification rules, channels, quiet hours) are owned by the member, never by the team, never in the repository.

### 5. Control plane and data plane are separate services

- **Control plane:** the Studio (web), the API, identity, the team model, publish, scheduler, notifier, event log. Stateless services plus Postgres.
- **Data plane:** runners that hold repository checkouts, sandboxes and released secrets, and talk to the model API. A runner connects **outbound** to the control plane over an authenticated channel and pulls work.
- This one split allows every deployment: all in one process (local), all in one cluster (self-hosted), our control plane with the customer's runners in their VPC (hosted with private data plane), or fully hosted. Code and secrets never have to leave the customer's network unless they choose that.

### 6. Connectors are the only way to reach the outside world

Product systems (GitHub, databases, hosting) and owner channels (email, Slack, Teams) are all connectors with the same lifecycle: connect (OAuth or key), store the secret in the vault, health check, scope, revoke. A role reaches a connector only through a binding (tools). A person reaches one only through their notification rules (notify). There is no special local mode for email or Slack: you connect them the same way on a laptop and online.

### 7. Every vendor can be replaced

Model provider, agent runtime, sandbox provider (process, container, microVM), workflow engine, email provider, object store, cloud. Each sits behind one interface with at least two implementations planned, and the contracts above never mention a vendor.

### 8. The core is industry-neutral; engineering is the first pack

The owner (2026-11-06): "this is not just for engineering companies. For now our roles will be centered around my own use cases and personal products, but eventually any industry should be able to use this tool." So nothing in the core may assume that work is code.

| Today's engineering idea | The neutral core concept | Engineering is one case of it | Other industries |
| --- | --- | --- | --- |
| A Git repository | A **workspace store**: where the team's work lives, reached through connectors | A repository | A Drive or SharePoint folder, a Notion space, a CRM, a helpdesk, a design file |
| Owned paths (`apps/web/`) | **Owned areas**: patterns in any connector's namespace (`repo:apps/web/**`, `drive:/Campaigns/**`, `crm:deals/stage=proposal`, `helpdesk:queue/billing`) | Repository paths | Folders, records, queues, channels |
| Gates (build, test) | **Checks**: a command, a checklist, a reviewer role, a human approval, or a connector call that returns pass or fail | `npm test`, lint, a build | A brand checklist, a legal review, a numbers reconciliation |
| PR and merge | **Proposal and accept**: a change proposed in the store, reviewed, accepted | A pull request merged | A document version approved, a CRM change applied, an email draft sent |
| SIGNOFF evidence (screenshots, logs) | **Evidence**: any artefact with a link | Screenshots, test logs, preview URLs | The approved PDF, the sent campaign's preview, a signed contract |
| Role library (engineering preset) | **Role packs** per industry, chosen at team creation | The kit's engineering and company presets | Marketing agency, legal practice, customer support, finance office, research lab, e-commerce |
| Owner-steps-in list | A **policy** per pack, as data | Destructive migrations, secrets, production deploys | Sending to customers, payments, signing, publishing, anything regulated |

Rules that follow:

- The team definition still lives in Git (ADR 0001). A customer who never touches Git gets a **Studio-managed team repository**. The Studio creates it and hides it, and they can export it whenever they like. Git is the storage, not something the customer has to learn.
- Every engineering-specific behaviour (worktrees, branches, CI gates, the ownership pre-tool hook for file paths) is implemented as the **repository connector's** version of a neutral contract: `area`, `check`, `propose`, `accept`, `evidence`. Other connectors implement the same contract.
- Vocabulary in the UI comes from the pack (an engineering team sees "pull request", a marketing team sees "draft for approval"), over the same model.
- Engineering stays the first pack because it is the owner's use today, and the kit already runs real products with it. The next packs follow the owner's own use cases (the kit's business roles: marketing, sales, support, finance, legal) before any other industry.

## Consequences

- The MVP exit becomes the demo on an online deployment (a customer's cloud via the Compose stack or a one-click template), not only on a laptop. Local stays the fastest way to try it and to develop it.
- Phase 3 builds the control plane, data plane, Postgres, event log, workflows, tenancy and OIDC in their final shape, at small scale, instead of SQLite and single-user shortcuts that would be thrown away.
- The zero-build local editor from ADR 0003 stays as the development and evaluation editor, and its code moves into the online Studio rather than being rewritten.
- The TeamSpec gets `areas` and `checks` as the neutral form of `ownership` and `gates`. Today's `ownership.json` and `gates.json` stay valid and become the repository connector's areas and checks, with no migration for existing teams.
- More work up front in phase 3. In exchange, phases 5 and 6 become operations (scale, regions, billing), not re-architecture.

## Rejected

- **Local first, online later.** Cheapest now. But it builds tenancy, identity, durable scheduling and secrets twice, and long-running teams do not fit a laptop.
- **Hosted only.** Many customers cannot send code and secrets to a third party. The control/data plane split covers them.
- **A vendor workflow engine or database as the core contract.** Fast to start, but a decade is longer than most vendors' APIs stay stable. They sit behind interfaces instead.
