# Spec L9: start with no repository (managed team store)

Owner: architect. Builder: kit-core-dev. Reviewers: CTO and security-reviewer. Decision: [ADR 0012](../adr/0012-no-repository-start.md), accepted by the owner on 2026-11-09 at 15:33 UTC (A1). Security rules: [ADR 0013](../adr/0013-what-you-see-is-what-you-sign.md) and the vision architecture (project plans, vision/architecture.md) §8. Local PR queue row: L9 in `/mnt/project-files/git/queue.md`.

Written against `main` b27e99d of the shared local repository (`/mnt/project-files/git/orgcraft.git`). File and line references are to that commit.

## 1. What the owner gets

- A new team can be created in the Studio with **no GitHub account and no repository**. "Connect your code host" stops being step one, except in the engineering pack.
- Every publish is still reviewable (a change request), still versioned ("Version 14 · Tuesday 10:02 by Dana"), and still a real Git commit underneath.
- **Download your team** at any time: a zip with the files and the full history, usable with the CLI or any Git host, with no OrgCraft software.
- Later, **Move to GitHub** in one step, keeping every version.

Nothing here changes the TeamSpec, the layer format, `team-model`, compile or sync.

## 2. Where it plugs in today

- `apps/studio/github.mjs` `githubBackend()` returns `{ kind, info, readTeam, listPaths, readRootFile, publish, prStatus }`. That object is the `RepoBackend` interface from ADR 0008. The managed store is a third implementation with exactly this shape.
- `apps/studio/handler.mjs:192` builds the backend. It becomes a choice by the team's `backend` (see 4.1): `github` as today, `managed` for the new one. The `cp` proxy path (embedded Studio) is unchanged and simply forwards to the deployment, which picks the backend.
- `apps/studio/core.mjs` `READ_SET`, `inReadSet`, the size limits and `commitMessage` are reused as they are. The managed backend enforces the same read set and the same limits (`MAX_FILES`, 20 MB).
- The kit has **no runtime dependencies** (package.json). Keep it that way: see section 3.

## 3. `packages/git-store/`: Git objects without `git`

A small module of our own on `node:crypto` (sha1) and `node:zlib`. No child processes (ADR 0008), no third-party library.

| Export | What it does |
| --- | --- |
| `hashObject(type, bytes)` | `sha1("<type> <len>\0" + bytes)`. `blobId` in github.mjs already does this for blobs: move it here and import it back |
| `writeTree(entries)` / `readTree(bytes)` | Tree encoding: `<mode> <name>\0<20-byte sha>`, sorted the way Git sorts (directories compare as `name/`). Modes `100644` and `100755` only. No symlinks, no submodules (E5), the same as `readTeam` today |
| `writeCommit({ tree, parents, author, committer, message })` / `readCommit` | Author is the person who accepted, committer is `OrgCraft <noreply@…>` with the deployment's domain. Times in seconds plus the offset |
| `applyChanges(store, baseTree, changes)` | Takes the `changes` list the handler already builds (`{ path, mode, content | null }`) and returns the new root tree, writing only changed subtrees |
| `packObjects(store, wants, haves)` | A version 2 pack, **non-delta** objects only, plus its trailing sha1. Simple and valid; size is not a concern at team scale |
| `writeBundle(store, refs)` | `# v2 git bundle\n`, one `<sha> refs/heads/main` line per ref, a blank line, then the pack of everything reachable |
| `readBundle(bytes)` | For `orgcraft import` and moving back from a code host (6.4). Must accept delta objects (`OFS_DELTA`, `REF_DELTA`), because real Git writes them |

**Object store interface** (`store`): `get(sha) → bytes | null`, `put(sha, bytes)`, `has(sha)`. Two implementations:

- `objectStorage({ bucket, prefix })`: key `tenants/<tenant>/teams/<team>/objects/<sha>`, zlib-compressed loose object, encrypted with the tenant's data key once B4 lands (until then, the server's current sealing, the same as other tenant data). Objects are immutable: `put` of an existing key is a no-op.
- `pgObjects(db)`: table `managed_objects` for local mode and small deployments.

**Tests** (`tests/git-store.test.mjs`): golden hashes for a blob, a tree and a commit; then, using the real `git` binary **in tests only**, write a repository's objects with our module, `git fsck --strict` the result, `git clone` a bundle we wrote, and check `git log` and the working tree. Read a bundle real Git wrote (with deltas). Skip with a message if `git` is missing.

## 4. Server side

### 4.1 Migration `022_managed_store.sql (014 to 021 are taken: runner health, step-up scope, approval calls and the claimed L18–L27 numbers)`

013 is taken by `fix/deliveries-team-scope` (L3). Use the next free number when this lands. Expand-only, as the migration rule says.

```sql
alter table teams add column backend text not null default 'github' check (backend in ('github', 'managed', 'local'));
-- teams.repo (010) stays; it is null while backend = 'managed'.

create table managed_refs (
  tenant text not null references tenants(id),
  team text not null references teams(id),
  name text not null check (name ~ '^(main|cr/[a-z0-9-]{1,64})$'),
  sha text not null check (sha ~ '^[0-9a-f]{40}$'),
  version bigint not null default 1,
  updated_at timestamptz not null default now(),
  primary key (tenant, team, name)
);

create table change_requests (
  id text primary key,                         -- cr_<random>
  tenant text not null references tenants(id),
  team text not null references teams(id),
  number int not null,                         -- 1, 2, 3 per team, shown to people
  base text not null check (base ~ '^[0-9a-f]{40}$'),
  head text not null check (head ~ '^[0-9a-f]{40}$'),
  title text not null,
  body text not null,
  state text not null check (state in ('open', 'accepted', 'closed')),
  checks jsonb,                                -- validate + sync result at head
  capability_diff jsonb not null,              -- server-computed (ADR 0013)
  needs_code boolean not null default false,   -- publish-code (S1)
  created_by text not null references people(id),
  accepted_by text references people(id),
  accepted_sha text check (accepted_sha ~ '^[0-9a-f]{40}$'),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  unique (tenant, team, number)
);

create table managed_objects (                 -- only used when no object storage is configured
  tenant text not null references tenants(id),
  team text not null references teams(id),
  sha text not null check (sha ~ '^[0-9a-f]{40}$'),
  body bytea not null,
  primary key (tenant, team, sha)
);

create table standing_exports (
  tenant text not null references tenants(id),
  team text not null references teams(id),
  connection text not null,                    -- a connection id (connector bindings); never a credential
  target text not null,                        -- folder or bucket path, shown to people
  cadence text not null check (cadence in ('daily', 'on-publish')),
  last_sha text, last_at timestamptz, last_error text,
  primary key (tenant, team)
);
```

Row-level security follows the existing tenant pattern (`agent_team_app` sees only its tenant's rows). `managed_objects` and `managed_refs` are **excluded from every retention job** (ADR 0012, "Retention"); they go only with tenant deletion after the 30-day export window. Register all four tables in the erasure registry as `tenant-lifetime` stores.

Rollback: drop the four tables, drop `teams.backend`, delete the `schema_migrations` row.

### 4.2 Moving `main`: compare-and-swap

```sql
update managed_refs set sha = $new, version = version + 1, updated_at = now()
 where tenant = $1 and team = $2 and name = 'main' and sha = $expected and version = $v
returning version;
```

Zero rows means someone else published first: answer 409 `stale` with the same text the GitHub backend uses ("the team changed since you opened it; reload"). Never retry automatically. Creating the first `main` is an insert that fails on conflict.

### 4.3 The `managed` backend (`apps/studio/managed.mjs`)

`managedBackend({ tenant, team, db, store })` returns the RepoBackend shape:

| Method | Behaviour |
| --- | --- |
| `kind` | `'managed'` |
| `info()` | `{ repo: null, defaultBranch: 'main', head: { sha, at }, pr: true, managed: true }`. A team with no `main` yet returns `head: null` and the page shows the template picker, as `noTeam` does now |
| `readTeam(base)` | Walks the tree at `base`, keeps `inReadSet` paths and regular files, applies the same limits, returns `{ files, base }` |
| `listPaths(base)` | Every blob path at `base` |
| `readRootFile(base, path)` | As github.mjs |
| `publish({ base, into, branch, message, changes, pr })` | Writes objects, a commit on `base`, a ref `cr/<n>`, and a `change_requests` row (state `open`, checks and capability diff computed, 4.4). Refuses with 409 `stale` if `main` moved from `base`. Returns `{ branch: 'cr/<n>', commit, tree, files, pr: { state: 'opened', number: n, url: '/studio/changes/<n>', branch, base: 'main' } }` so the page needs no change |
| `prStatus(branch)` | From the row: `{ state: 'open' | 'merged' | 'closed', number, url, checks }`. `accepted` maps to `merged` for the page |

`publish` is guarded by the same limiter keys as today, with `repo` replaced by `managed:<tenant>/<team>`.

### 4.4 Checks and the capability diff

Run at `publish` and again at `accept` against the head:

1. **Checks:** the pure `validate` and `sync` from `team-model` over the head tree, the same thing `sync.sh check` runs in CI. Generated files (`docs/team/`, agent files, AGENTS.md) are stored in the commit, so the check is "sync output equals what is committed". A failing check blocks accept, like red CI.
2. **Capability diff (ADR 0013 rule 2):** `capabilityDiff(baseSpec, headSpec)` from the policy package. If it is not there yet when L9 is built, add the function to `team-model` with this minimum: tools and connector bindings per member, effects and egress, models and endpoints, triggers, caps, reviewers and checks, standing rules. The result is stored in `capability_diff` and shown first on the change page as **Widens access**.
3. **Self-widening is refused:** a change whose author is a teammate (actor `agent`) that touches that teammate's own capabilities, reviewer, checks or caps is refused at `publish` with 403 and type `self-widening`.
4. **`needs_code`:** set when the change touches `.agent-team/tools/` or anything `core` flags today as code (`p.needsCode`). Accept then needs the `publish-code` grant, exactly as the handler gates it now.

### 4.5 Routes

All under the existing api-v1 conventions, admin or reviewer grants per F7. Add to `docs/contracts/api-v1.yaml` (additive). Mark the starred ones `x-interactive-only` (ADR 0013): person tokens and session tokens can never reach them.

| Route | Who | Notes |
| --- | --- | --- |
| `GET /v1/teams/{team}/changes?state=` | read | List change requests |
| `GET /v1/teams/{team}/changes/{n}` | read | Title, body, file diff, capability diff, checks, code diff when `needs_code` |
| `POST /v1/teams/{team}/changes/{n}/accept` * | reviewer per policy (`org-change`) | Re-runs checks and the diff at head. Non-empty capability diff: **passkey** step-up bound to `{ tenant, team, n, head, diffHash }`, and a ledger row in the owner's words. `needs_code`: `publish-code` grant. Then CAS on `main` (fast-forward only: `base` must equal current `main`, else 409 `stale` and the owner rebuilds the change from the Studio) |
| `POST /v1/teams/{team}/changes/{n}/close` | author or reviewer | State `closed`, ref `cr/<n>` kept for history |
| `POST /v1/teams/{team}/rollback` * | admin | Body `{ to: sha }`. A **new** commit whose tree is the old tree. Diffed against **current** `main` (S2-19): any access it restores needs the passkey. It goes through a change request like any other change, never straight to `main` |
| `GET /v1/teams/{team}/export` * | admin | Section 5. Passkey, audited, announced |
| `PUT /v1/teams/{team}/standing-export` * | admin | Section 5.2 |
| `POST /v1/teams/{team}/attach` * | owner | Section 6 |

Policy may say "publish straight away" for a one-person organisation: then `publish` accepts in the same request, but the capability-diff passkey rule still applies (ADR 0013 rules are in the floor).

### 4.6 Events (additive)

- `proposal.opened`, `proposal.accepted`, `proposal.failed` with `connector: 'managed'`, `ref: <n>`, `url: /studio/changes/<n>`, `branch: cr/<n>`, `headSha`, `result` (the new `main` sha on accepted), `reason` (`head-moved`, `checks`, `self-widening`). Emitted by the server, actor the person.
- `team.published` exactly as today, id `published-<sha>`, `version` the sha, `data.via: 'managed'`. Add `managed` to the documented `via` values in events.md.
- `team.exported` (new type, additive): `{ by, sha, kind: 'download' | 'standing', target? }`. `team.attached`: `{ by, host, repo, sha }`.

## 5. Export

### 5.1 Download (`GET /v1/teams/{team}/export`)

- Needs a passkey (bulk export, S2-27). Rate limit 10 per team per day. An audit row and `team.exported` are written, and the export is announced on every channel the tenant has (S2-27), with "Not you? Lock the account" in the notice.
- Response: `application/zip`, streamed, named `<team>-v<number>-<yyyy-mm-dd>.zip`:
  - the working tree at `main`, every file of the commit (the layer and the generated files);
  - `history.bundle` from `writeBundle` with `refs/heads/main` only (change-request refs are not exported; their accepted commits are on `main`);
  - `README.txt`: three steps, `git clone history.bundle my-team`, `npx github:ThePurpleVoid/OrgCraft` in it (or `agent-team` once renamed), and "push it to any Git host".
- The zip writer is ours too (stored entries plus deflate from `node:zlib`; the format is small). Put it in `packages/git-store/zip.mjs`.

### 5.2 Standing export

- Configured during setup and in Settings. Target is an existing **connection** (Drive folder or S3 bucket first) by id; the export job never sees a credential, it calls the connector gateway's `put-file` effect.
- `cadence`: `daily` (a scheduled job, slot id `export-<team>-<date>` so it runs once) or `on-publish` (a durable job after each `team.published`). Same zip as 5.1.
- Turning it on, changing the target or turning it off is an approver-level setting: passkey bound to the change, and a **new target** takes effect after 24 hours with announcements (ADR 0013 rule 3), because a new target is a way to copy the team out.
- Failures go to `last_error` and to the owner's notifications once per day, never silently.

### 5.3 Import (self-hosted and moving back)

`orgcraft import <zip>` (CLI) and the server function behind 6.4: `readBundle`, verify every object hash, write objects, set `main`. Refuse a bundle whose tree fails `validate`.

## 6. Attach a code host (one way)

1. **Pre-checks:** no open change request (else 409 `open-changes` and the Studio asks to accept or close them). A code-host connection exists and its installation is bound to the tenant (010).
2. **Target:** an **empty** repository the owner picks, or one OrgCraft creates through the connection. A non-empty repository is refused (no merging histories).
3. **Push:** the full `main` history through the code host's API (for GitHub, the Git Data API: blobs, trees, commits, then the ref; or a pack upload where the host offers one). SHAs must come out identical; compare `main` after the push and refuse to switch if not. The push is paced by the outbound governor (architecture.md B16a), as every write to a code host is.
4. **Switch in one transaction:** `teams.backend = 'github'`, `teams.repo = <owner/name>`, `team.attached` event. From then on publishes are pull requests (ADR 0001 as written).
5. **After:** the managed refs become read-only; objects are kept for the 30-day export window, then deleted by a job that writes an audit row.
6. **Moving back** is the reverse: import the repository's history (5.3) and switch `backend` to `managed`. Never a two-way sync.

Attach needs the owner's passkey, is `x-interactive-only`, and is announced on every channel (it writes the team to an outside system).

## 7. Studio changes (web-dev, small)

- Team creation: "Where should this team live?" **In OrgCraft (recommended)** or **In my GitHub repository**. Default by pack: engineering pack defaults to GitHub; every other pack to OrgCraft.
- The publish button text stays "Publish". The result links to `/studio/changes/<n>` instead of a pull request. Words: **change**, **version**, never "commit" or "branch" (vision glossary; version label from the pack, CPO C15).
- A **Changes** page (list and one change, with **Widens access** first, then checks, then the files).
- Settings → **Your team's files**: Download, Standing export, Move to GitHub. Tooltips on each (tooltips.md rule).

## 8. Build split and order

| Step | What | Who | Tests |
| --- | --- | --- | --- |
| L9a | `packages/git-store` (objects, trees, commits, pack, bundle, zip, readBundle) | kit-core-dev | 3. Golden hashes and the real-git interop tests |
| L9b | Migration 022, `managed.mjs` backend, CAS, handler backend choice | kit-core-dev (backend-dev reviews the SQL) | Publish/read round trip; two concurrent publishes, exactly one wins; stale base refused; limits; read set enforced |
| L9c | Change requests, checks, capability diff, self-widening refusal, accept with step-up, rollback via change request | kit-core-dev + backend-dev | Accept refused on red checks; non-empty diff without passkey refused; agent-authored self-widening refused; rollback that restores removed access needs passkey; `team.published` id collapses with a repeat |
| L9d | Export, standing export, import | kit-core-dev | Exported bundle clones with real git and matches `main`; export refused without passkey and with a person token; standing export target change waits 24 h |
| L9e | Attach and move back | kit-core-dev, after the GitHub hold lifts (it needs a real host for the end-to-end test; unit tests use a fake host) | Refused with open changes or non-empty repo; SHAs identical after push; backend switch is atomic |
| L9f | Studio screens | web-dev, after the owner signs off a mockup (UX review gate) | qa-web walk-through |

L9a to L9d need no GitHub at all and can be built and merged locally now. Security-reviewer reviews L9c, L9d and L9e.

## 9. Out of scope here

- Where the team's **work** lands (ADR 0012, question 2). Unchanged.
- Code hosts other than GitHub for attach: the same steps through each host's connector, later.
- Delta compression of packs, garbage collection of unreachable objects (closed change requests keep their objects; at team scale this is kilobytes).

## 10. Open questions for review (none block L9a to L9d)

1. Should the export include closed change requests as refs (`refs/changes/<n>`)? I say no for now: it is the published history the promise covers.
2. Object storage provider for hosted: whatever infra-secrets picks for backups (architecture.md area 16); `pgObjects` until then.
