# ADR 0012: Start with no repository: a managed team store that is still Git underneath, exportable at any time, attachable to a code host later

Status: **Accepted**, 2026-11-09. Decided by the owner on 2026-11-09 at 15:33 UTC (decision A1, relayed by the chief of staff at 15:37 UTC): a team can start with no code-host repository, stored in OrgCraft and exportable at any time. Owner of the document: architect. Asked for by the chief of staff from vision.md decision 5 (CPO gap 1). Implementation spec: [docs/specs/no-repository-start.md](../specs/no-repository-start.md), local PR L9. The number is taken when the ADR lands in docs/adr.

It amends ADR 0001 for teams that have no code host. It does not replace ADR 0001. It builds on ADR 0005 section 8, which already promised a "Studio-managed team repository", and on ADR 0008's `RepoBackend` interface.

## Context

Today a team is its `.agent-team/` folder in the customer's repository (ADR 0001). A non-technical customer, such as a clinic front desk, a bookkeeper or an agency, has no repository. Asking them to create a GitHub account is the first place they would quit. This week also showed that tying everything to one code-host account is a single point of failure.

**What must not change** (vision.md section 0.2 rule 5, and ADR 0001):
- the customer always owns a portable, plain-file copy of their team;
- leaving OrgCraft never costs them their team;
- a team built in the Studio works with the CLI alone;
- every change is reviewable before it is live;
- a published version is a commit SHA. `team.published` requires 40 lowercase hex characters (events.md).

## Two things that were one

ADR 0001 joined two questions that a no-repository start has to separate:

1. **Where the team's definition lives**: the `.agent-team/` files and their history.
2. **Where the team's work lands**: the workspace store from ADR 0005 section 8 and `work/1`. That is a repository for an engineering team, and a Drive folder, CRM, helpdesk or Notion space for others.

This ADR is only about question 1. A team can keep its definition in the managed store and still land its work in a GitHub repository, or the other way round.

## Options

| | Where the definition lives | Versioning | Export | Cost and risk |
| --- | --- | --- | --- | --- |
| A | The customer must connect a code host first | Git on their host | Native | It loses every non-technical customer at step one |
| B | Rows in OrgCraft's database, with our own version numbers | A custom scheme | A file dump of the current version, with history lost or in our own format | It breaks "a version is a commit SHA" and two contracts (`team.published`, the rollout view). Attaching a code host later would start with no history |
| **C** | **A managed Git store inside OrgCraft: real Git objects and refs, kept by the control plane, hidden from the customer** | **Git commits, the same SHAs, the same contracts** | **A zip of the files plus a Git bundle with the full history, at any time** | One more `RepoBackend` implementation. No contract changes |

## Decision

**C.** The Studio gets a third repository backend, `managed`, beside `local` (git and gh) and `github` (the GitHub App), behind ADR 0008's `RepoBackend` interface (`info`, `readTeam`, `listPaths`, `publish`, `prStatus`). Every mode keeps the same UI and the same publish result: byte-identical files and a version that is a commit SHA.

### Storage

- **Git objects** (blobs, trees, commits) are written by a pure-JavaScript Git implementation. There are no child processes, so the rule that "sync stays free of child processes" (ADR 0008) still holds.
  - Objects live in object storage under a per-tenant prefix, `teams/<team>/objects/<sha>`. They are content-addressed, immutable, and encrypted with the tenant's data key (architecture.md B4).
  - Small teams can keep them in Postgres instead (`managed_objects`), behind the same interface.
- **Refs** live in Postgres: `managed_refs (tenant, team, name, sha, version)`. Moving `main` is a compare-and-swap on `version`, so two publishes at once cannot both win.
- **What is stored:** the full layer (`.agent-team/`) **and** the generated output that sync writes (`docs/team/`, agent files, AGENTS.md). An export is then a complete working tree that the CLI can use as it is.
- **Retention:** team history is the definition, so it is **never** purged by retention jobs. It is deleted only with the tenant, after the tenant-deletion export window (30 days, with the owner's step-up). Legal holds apply as everywhere else.

### Versioning without the customer seeing Git

- A version is a commit on `main`. Its author is the person who accepted it. Its message is the Studio's change summary, the same as the plan the Studio writes for a pull request today.
- `team.published` is emitted unchanged (`version` is the SHA, `via: managed`). The rollout view, change safety (`diffTeams`, `impact`), N1 tasks and `teamVersion` on events all work with no change.
- The UI says "Version 14 · Tuesday 10:02 by Dana" (`versionName` exists already) and never says "commit".

### What changes for Publish

The `github` backend opens a pull request. The `managed` backend opens a **change request** inside OrgCraft: a branch ref plus a row in `change_requests (id, team, base, head, state, reviewers, created_by)`.

- **Review:** reviewers come from people's grants (architecture.md F7). An org change is the effect class `org-change` under policy (F5), so a team can require one reviewer, the owner, or none ("publish straight away" for a one-person organisation).
- **Checks:** the server runs the same pure `validate` and `sync` that CI runs as `sync.sh check` in a repository. A failing check blocks accept, as a red CI run does.
- **Accept:** it fast-forwards `main` to the reviewed head with the compare-and-swap above, then emits `proposal.accepted` (`connector: managed`, `ref: <change request id>`) and `team.published`. These are the existing events with a new connector value, which is additive.
- **Scheduled publish and rollback** (area 5) work the same as on any backend. Rollback is a new commit that restores an old tree. History is never rewritten.
- **Code changes** (code tools under `.agent-team/tools/`) still need `publish-code` (S1 in studio-embed.md), and the change request shows the code diff.

### Export, at any time

- `GET /v1/teams/{team}/export` (admin, audited) returns a zip with:
  - the working tree;
  - `history.bundle`, a standard Git bundle with every commit;
  - a `README.txt` that says how to use the files with the CLI or any Git host.
- The bundle opens with plain `git clone history.bundle`, with no OrgCraft software needed.
- **Optional standing export:** a scheduled job writes the same zip to the customer's own storage (a Drive folder, an S3 bucket) through a connector, daily or on every publish. Even if OrgCraft disappears, the customer's latest team is already in a place they control. That is the strongest form of "leaving never costs you your team", and the Studio offers it during setup.
- A self-hosted deployment imports a bundle with `orgcraft import <zip>`, history and all.

### Attaching a code host later

1. The owner connects a code host connector (GitHub, GitLab, and so on, as `work/1` connectors) and picks an **empty** repository, or lets OrgCraft create one.
2. OrgCraft pushes the full managed history to it. SHAs are unchanged, so every past `team.published` and `teamVersion` still points at a real commit.
3. The team's backend switches to `github`, or whichever host it is, **in one step**. From then on the repository is the source of truth (ADR 0001 as written), and publishes become pull requests. The managed store keeps its copy read-only for the export window, then deletes it.
4. **It is one way at a time, never a two-way sync** (ADR 0001 rejected that). Moving back means the reverse: import the repository's history into the managed store and switch the backend.

An open change request is refused during the switch. The Studio asks the owner to accept or close it first.

### What does not change

- The TeamSpec, the layer format, `team-model`, compile and sync are untouched.
- The runner gets briefs through `session.start` (resolved by the control plane). It needs a working copy only when the team's **work** lands in a repository, which is question 2.
- Local mode keeps `local`. A local deployment can also run `managed`, because it is the same server.

## How it keeps ADR 0001's promise

| ADR 0001 promise | Managed store |
| --- | --- |
| No lock-in: the team works with the CLI alone | The export is a working tree plus Git history, and the CLI runs on it directly |
| Publishing is reviewable | Change requests with reviewers, checks and accept, enforced by policy |
| A published version is a commit SHA | It is a real Git commit SHA |
| The database is never the only copy | Objects are immutable and content-addressed in object storage. The standing export puts a copy in the customer's own storage. The export is available at any time |
| Lossless round trip | The same `team-model` code and the same golden tests |

## Consequences

- One new backend (`managed`), one new object store prefix, two tables (`managed_refs`, `change_requests`) and three routes (export, attach, change-request actions). The connector value `managed` is added to `proposal.*`. Nothing that exists changes.
- ADR 0001's text gains one line: "or in the managed team store (ADR 0012), which is Git underneath and exportable at any time".
- vision.md rule 5 holds as written. The no-repository start becomes the default for packs outside engineering, and the engineering pack keeps "connect your code host" as its first step.
- The managed store makes OrgCraft responsible for keeping customers' team history safe. Backups and restore drills (infra-secrets-oncall's gap review) must cover object storage, not only Postgres.
- Security review: the export route, the attach push (it writes to a customer's repository through their connector), and the change-request accept path (compare-and-swap, step-up for `publish-code`).

## Rejected

- **A: code host required.** It loses non-technical customers and keeps the single point of failure.
- **B: database rows with custom versions.** It breaks the commit-SHA contracts and loses history when a code host is attached later.
- **Running real `git` binaries on the server.** That means child processes in the Studio handler (ADR 0008 forbids them) and a heavier image. A pure-JS implementation writes the same object format.
- **Two-way sync between the managed store and a code host.** It was rejected in ADR 0001 for the same reason as before: conflicts that can't be explained to a person.

## Review 2 (security), 2026-11-09

- **Change requests in the managed store** get the same server-computed capability diff as pull requests (ADR 0013). Accepting a non-empty diff needs a passkey and writes a ledger row.
- **A rollback never restores access removed on purpose** (S2-19). It is diffed against the current version, and restored grants need the passkey.
- **Export and attach are interactive-only routes** (S2-26). The export is a bulk export: it needs a passkey and is announced on every channel (S2-27).

## Decision record, 2026-11-09

- **Accepted by the owner** on 2026-11-09 at 15:33 UTC as decision A1 ("first choice for all three"), relayed by the chief of staff at 15:37 UTC. Option C stands as written above, with the review-2 security additions.
- **One implementation detail fixed at acceptance:** the "pure-JavaScript Git implementation" is a small module of our own (`packages/git-store/`) on `node:crypto` and `node:zlib`, not a third-party library. The kit has no runtime dependencies today, and writing loose objects, a non-delta pack and a v2 bundle is a few hundred lines. Real `git` is used only in tests, to prove that what we write is what Git reads.
- **Build:** local PR L9 (kit-core-dev, reviewed by the CTO and security-reviewer), from [docs/specs/no-repository-start.md](../specs/no-repository-start.md).
