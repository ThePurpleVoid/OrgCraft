# ADR 0008: one Studio with swappable repository backends; it mounts in a host app and publishes through the GitHub API

Status: proposed, 2026-11-06. Owner: architect. Issue: #123. Spec: [studio-embed.md](../specs/studio-embed.md).

## Context

A company's admin site is where its people already manage everything. The owner wants the team editor there too: open the admin page, change the team, press Publish. Today the Studio runs only on a machine with a checkout, `git` and `gh`, behind a launch token (ADR 0003). The dashboard already mounts in a host page (`AgentTeamDashboard.mount`); the Studio cannot.

The repository stays the source of truth (ADR 0001). The design has to be hosted-first (ADR 0005) and run in the host's own serverless functions, with a writable `/tmp` and about 10 seconds per request. It has to work for any product, and it must not contain anything specific to one of them.

## Options

| Option | Who holds the GitHub credential | Needs the control plane | Where it runs |
| --- | --- | --- | --- |
| A. **A kit handler the host mounts in its own server.** It reads `.agent-team/` and the files the kit generates through the GitHub API, runs the kit's pure `sync` in a temp dir, and opens a branch and pull request with the Git Data API | The host's server mints a GitHub App installation token per request; the browser never sees it | No (step 1) | The host's function, behind the host's admin auth |
| B. The browser calls GitHub directly with the person's own GitHub sign-in | The browser | No | The browser. But `sync` would run in the browser on a token with the person's full repository scopes, and the person needs GitHub access to the repository |
| C. Wait for M4 and embed the control plane's Studio in an iframe | The deployment | Yes | The deployment. The host's admin auth does not apply, and it blocks today's ask on M4 |
| D. Run `agent-team studio` on a server with a checkout | The server's git credential | No | An always-on box with a clone, not a serverless function |

## Decision

**One Studio, with interchangeable repository backends behind one interface** (owner, 2026-11-06: customers can run the Studio locally or deployed somewhere). The interface is `RepoBackend`: read the team, sync, publish a branch and a pull request, and report the pull request's status (spec section 2).

- **`local`** uses today's `git` and `gh` on the machine.
- **`github`** uses the GitHub App handler. It runs in two places: mounted in a customer's own app, or as the standalone hosted Studio of a deployment.

Every mode has the same UI and the same publish result: byte-identical files and a pull request. No feature works in only one mode (ADR 0005), and one shared test suite proves both backends.

For the `github` backend, **A, in two steps:**

- **Step 1** is edit and Publish with no control plane. The host mounts `createStudioHandler({ repo, getInstallationToken, authorize, allowedOrigins })` and `AgentTeamStudio.mount(el, { api })`.
- **Step 2** adds chat, runs and the live board through the control plane once M4 is online. The same handler becomes a backend-for-frontend for `/v1`, and publishing can move to the deployment's GitHub App, so the host can drop its own.

Option A is the only one that keeps the host's own admin auth as the gate. It keeps every credential server-side, runs in a serverless function, and ships today. It reuses the code that already works: the team model is pure, and the Studio already previews in temp dirs. B puts a broad credential and the kit's code generation in the browser. C makes the owner wait and splits sign-in. D brings back the always-on box that hosted mode exists to remove.

**The M4 GitHub App is not the step 1 app.** The deployment's app key can mint tokens for every installation of that app, so on a hosted deployment it would reach every customer. A host must never hold it. In step 1, each host registers its own small GitHub App, installed on its own repository only. In step 2 the host can delegate publishing to the deployment (`POST /v1/teams/{team}/publish`), which uses the M4 app as it does for runs, and then delete its own app. The spec has the details (section 7).

## Consequences

- The kit gains a server-side module and a Git-over-HTTP backend for `build`/`sync`. `sync` must stay free of child processes and network calls. A test enforces that, because it now runs inside other people's servers.
- The host pins the kit version, and the handler refuses a repository that was synced by a different kit version. A host upgrade is a dependency bump plus a re-sync PR.
- The Studio front end loses its hard-coded `/v1/team` paths and the launch-token flow when embedded. Local mode keeps both.
- Every published change is a pull request opened by the host's app. The host's branch protection and review decide what merges, as for any other PR.
