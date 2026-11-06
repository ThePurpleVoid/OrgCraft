# M4 spec: signing in to a hosted Studio

Status: accepted with the security conditions in section 4a, 2026-11-06. Owner: architect. Decision record: [ADR 0007](../adr/0007-deployment-is-its-own-identity-provider.md). Builds on the [clients contract](../contracts/clients.md) sections 3 and 4, and replaces the M3 step-up stub ([M3 design](../product/m3-design.md) section 4 and section 12, D3 to D5).

M4 puts the Studio online. Today a person is one admin token in an environment variable, and approving needs a typed step-up secret. M4 replaces both with real sign-in and real step-up, without changing a single `/v1` path a client already calls.

## 1. The shape

```
 browser ──────────── studio.example.com ──────────────┐
   │  static Studio (Vercel)        /v1/*, /oauth/*,    │ rewrite (same origin)
   │                                /.well-known/*  ────┴──▶ control plane container
   │  cookie: __Host-agent-team (HttpOnly, Secure, SameSite=Lax)       │
   │                                                                   │ OAuth (GitHub first)
 phone app / CLI ── bearer token from /oauth/token (PKCE) ─────────────┘──▶ upstream identity provider
```

- **The deployment is its own identity provider** (ADR 0007). The control plane is the OIDC issuer that every client talks to. GitHub, and later Google, Microsoft or SAML, are upstream providers it signs people in with. Clients never talk to GitHub directly (clients.md section 3).
- **One origin.** The Studio page and the API share the deployment's host (section 8 of the M3 design: Vercel rewrites `/v1`, `/oauth` and `/.well-known` to the container). So the web uses a plain first-party cookie, with no third-party cookies, no tokens in page JavaScript, and no CORS for the Studio.
- **Apps and the CLI** use the OAuth authorization code flow with PKCE through the system browser and send a bearer token, as clients.md already says.

## 2. Signing in

Owner: **backend-dev** (the issuer and sessions), **web-dev** (the sign-in page).

1. **Web:** the Studio sends the person to `GET /oauth/authorize?client_id=agent-team-web&return=<path>`. The web client is first-party and never does a code exchange: the page holds no code, verifier or token. **Apps and the CLI** send `GET /oauth/authorize` with `response_type=code`, `client_id`, `redirect_uri`, `code_challenge` (S256), `state` and `nonce`.
2. With no session, the control plane shows a "Continue with GitHub" page and runs the upstream OAuth flow with its own `state` and PKCE. GitHub sign-in uses the deployment's GitHub App (the same app that M4 installs on repositories), with its user authorization flow. The control plane asks only for the person's identity, with no repository scope on the person's token. It keeps the GitHub user id and login, never the person's GitHub token.
3. **Who may sign in.** A person is let in only if they are already a member of a workspace on this deployment, or have an open invitation. A fresh deployment has no members: `AGENT_TEAM_OWNER_GITHUB` (a GitHub user id) names the one person whose first sign-in creates the tenant's owner. Anyone else gets "Ask an owner to invite you", and nothing is created.
4. The upstream provider returns to the issuer's own callback, `GET /oauth/callback/github`. The issuer checks its `state` and PKCE, finds or refuses the person (step 3), and creates a **person session**. Then:
   - **web:** the callback itself sets `__Host-agent-team` and redirects to `return` (a path on the deployment's own host, never a full URL). There is no `/oauth/token` call for the web client.
   - **apps and CLI:** the callback redirects to the app's `redirect_uri` with a code. The app POSTs the code and its `code_verifier` to `/oauth/token` and gets an access token (opaque, 15 minutes), a rotating refresh token bound to the device registration (clients.md section 4) and usable only with **proof of possession**: each refresh is signed by the device key (S3), and an ID token (ES256-signed JWT with `sub`, `auth_time`, `nonce`, 15 minutes, well inside the signing key's 1-day overlap in section 6).
5. Signing out (`POST /oauth/revoke`, or the Studio's sign-out) ends the session and revokes its tokens. Removing a device or a member does the same (clients.md section 3).

Tokens are opaque to clients and looked up by hash on the server, so revoking one takes effect at once. Refresh tokens rotate on every use. Reusing an old one revokes the whole family and writes an `audit` row.

**The cookie:** `__Host-agent-team`, a random 32-byte session id (only its hash is stored), `HttpOnly; Secure; SameSite=Lax; Path=/`. Idle expiry is 12 hours and absolute expiry 7 days. **CSRF:** every unsafe method sent with the cookie needs an `Origin` that equals the deployment's public URL, and `content-type: application/json` (a cross-site form cannot send either). Requests with a bearer token are not cookie-authenticated, so they need neither.

**Proof** (backend-dev): `a person who is not a member or invitee cannot create an account`, `the first sign-in of AGENT_TEAM_OWNER_GITHUB creates the owner, and a second person cannot`, `a reused refresh token revokes the family`, `a cookie request from another origin is refused`, `a revoked session's cookie is refused at once`, `the person's GitHub token is not stored`, `the web callback sets the cookie and redirects only to a path on the deployment's host`. web-dev: a Playwright sign-in against a stub upstream provider, at desktop and 360 px.

## 3. Step-up, for real

Owner: **backend-dev**, **web-dev**. The security reviewer reviews it.

Step-up has to prove that **a person is present now**, not just that a session exists. Re-running GitHub sign-in proves nothing, because GitHub signs a person in again silently while their GitHub session lasts. So step-up never goes through the upstream provider:

| Client | Step-up | Sets |
| --- | --- | --- |
| Web Studio | A **passkey** (WebAuthn, `userVerification: required`): Touch ID, Face ID, Windows Hello or a security key. Registered at the person's first sign-in, and at least one is required before they can approve anything | a `su_` token (the session records `last_step_up` and `amr` for audit only) |
| iPhone and Android apps | The device key registered with `POST /me/devices`, unlocked by the biometric prompt (clients.md section 4), signing a server challenge | a `su_` token |
| CLI | None. The CLI cannot approve; it prints the approval's URL | |
| Local mode (one built-in owner) | A passkey, which works on `localhost`, or the M3 step-up secret, kept only for local mode | a `su_` token |

The API does not change: `POST /v1/auth/step-up` now takes `{ "webauthn": <assertion> }` or `{ "device": <signed challenge> }`, and still takes `{ "secret": … }` only when the deployment runs in local mode. It answers with the same step-up token (`su_…`, 5 minutes, one use, bound to the principal, D5). **Step-up is only ever a single-use `su_` token minted from a passkey or device-key assertion** (ADR 0007, K2). No session or token timestamp counts on its own: `auth_time` is only the sign-in time, so a fresh upstream sign-in, silent or not, is never a step-up. clients.md section 3's "`auth_time` in the token" is removed when the contract edit lands (section 7). The step-up token is bound to the person **and the tenant** it was minted for (S7). `GET /v1/auth/step-up/challenge` returns the WebAuthn or device challenge (one use, 2 minutes).

Everything D3 to D6 required still holds: lockout after 5 failed attempts in 15 minutes, audit rows with the step-up token's id, nothing replayable, and no step-up from a session token. Passkeys are managed at `GET` and `POST /v1/me/passkeys` and `DELETE /v1/me/passkeys/{id}`. Adding or removing a passkey itself needs step-up, or, for the very first passkey, an `auth_time` no older than 5 minutes (the only place `auth_time` is used as a gate).

**Proof:** `an approval with a passkey assertion passes, and one without step-up gets 401 step-up-required`, `a passkey assertion without user verification is refused`, `the step-up secret is refused on a hosted deployment`, `a fresh GitHub sign-in alone does not count as step-up`, `removing a passkey needs step-up`.

## 4. People, workspaces and roles

Owner: **backend-dev**. Migration 004.

**Who a person is, before any tenant is known.** Sign-in, and every cookie or bearer lookup, happen before the request knows its tenant. So identity lives in three tenant-less tables, read and written only by the owner role (`db.system`, as report-token lookup already is in 001), never by `agent_team_app`:

| Table (no tenant, no RLS, owner role only) | Columns |
| --- | --- |
| `people` | `id` (`per_`), `provider` (`github`), `subject` (the upstream user id), `login`, `name`, `email`, `created_at`. Unique `(provider, subject)` |
| `person_sessions` | `id_hash`, `person`, `client` (`agent-team-web`, `agent-team-ios`, …), `device`, `auth_time` (sign-in), `last_step_up` and `amr` (audit only, never a gate), `created_at`, `last_seen`, `expires_at`, `revoked_at` |
| `oauth_tokens` | `hash`, `kind` (access, refresh), `session`, `family`, `device` (the refresh token's device key, S3), `expires_at`, `used_at`, `revoked_at` |

A lookup returns only the `person` id. Everything a person can do in a workspace is then read **as that tenant**, under RLS:

| Table (tenant-scoped, RLS on `app.tenant`) | Columns (beyond tenant) |
| --- | --- |

| Table | Columns (beyond tenant) |
| --- | --- |
| `members` | `id` (`mem_`), `person`, `role` (owner, admin, editor, viewer, approver), `created_at`, `removed_at`. Unique `(tenant, person)`: one person can be in many workspaces |
| `invitations` | `id`, `provider`, `subject` (the numeric GitHub user id, resolved when the invite is made; logins can be renamed and reused) or `email` (matched only against the upstream's **verified primary** email), `role`, `invited_by`, `expires_at`, `accepted_at` |
| `passkeys` (tenant-less, owner role only, like `people`) | `id`, `person`, `credential_id`, `public_key`, `sign_count`, `name`, `created_at`, `last_used` |

**Which tenant a request runs as.** A route under `/v1/teams/{team}/…` runs as that team's tenant, and only if the person is a member there (otherwise `404`, so it never shows which teams exist). `/v1/me/*` runs once per tenant the person is a member of and merges the results. Finding a person's tenants is a single owner-role query on `members` by `person`. It is the one cross-tenant read, and it returns tenant ids only. A person is let in at sign-in (section 2, step 3) by the same query, plus the open invitations for their upstream user id or verified primary email (S2).

Roles decide what a person may do: viewers read, editors chat and change runs, approvers and owners answer approvals and decision cards, and owners manage members, budgets (including a budget card's `raise`), runners and secrets. Every endpoint states its minimum role, as `x-min-role` in api-v1.yaml. An approval checks the role **and** step-up.

**Proof:** `tenants cannot see each other's members or invitations` (the 001 pattern), `agent_team_app cannot read people, person_sessions, oauth_tokens or passkeys`, `a member of workspace A gets 404 on a team in workspace B`, `one person in two workspaces sees both in /me/summary and no others`, `a fresh GitHub sign-in never passes step-up`, `a step-up token minted in one tenant is refused in another`, `a viewer cannot answer an approval even with step-up`, `removing a member ends their access to that workspace at once, and removing a person's last membership ends their sessions and tokens`.

## 4a. Security conditions (security reviewer, PR #50)

| | Condition | Owner | Proof |
| --- | --- | --- | --- |
| K1 | The issuer is an OpenID-Certified library (for example `oidc-provider`), and WebAuthn uses `@simplewebauthn/server`. We write adapters and policy, not protocol code | backend-dev | the library's conformance suites run in CI for the flows we enable |
| K2 / S1 | Step-up is only a single-use `su_` token from a passkey or device assertion (section 3) | backend-dev | `a fresh GitHub sign-in never passes step-up` |
| S2 | Invitations bind to the numeric upstream user id, or to a verified primary email | backend-dev | `a renamed or reused GitHub login does not accept someone else's invitation`; `an unverified email does not match` |
| S3 | Refresh tokens need proof of possession from the device key | backend-dev, mobile | `a stolen refresh token without the device key is refused and revokes the family` |
| S4 | Exact, pre-registered redirect URIs per client. Apps use Universal Links and App Links on the deployment's host, never custom schemes; the CLI uses a loopback redirect (RFC 8252) | backend-dev | `a redirect_uri that differs by one character is refused` |
| S5 | Adding a passkey, a device or a member notifies the owner and writes an `audit` row | backend-dev | `a new passkey sends a notice and is audited` |
| S6 | WebAuthn: `rpId` is the deployment's host and the origin is checked exactly; challenges are single-use with a 2-minute life; user verification is required; a `sign_count` that does not increase is logged and flagged, not refused | backend-dev | `a replayed challenge is refused`; `an assertion from another origin is refused` |
| S7 | Every cookie or bearer request, and every `su_` token, runs as one tenant, from the path's team after a membership check (section 4) | backend-dev | `a step-up token minted in one tenant is refused in another` |
| S8 | Rate limits on `/oauth/*` and `/v1/auth/step-up`, per IP and per person | backend-dev | `the 21st authorize call in a minute from one IP gets 429` |

## 5. What happens to today's credentials

| Credential | M4 |
| --- | --- |
| `AGENT_TEAM_ADMIN_TOKEN` | Refused on every route once the deployment has an owner member. Kept for local mode and for a recovery command run on the host (`agent-team-server admin reset-owner`), never over the network |
| `AGENT_TEAM_STEP_UP_SECRET_HASH` | Local mode only (section 3) |
| The Studio server's `AGENT_TEAM_SERVER_TOKEN` | Gone in hosted mode: the page is static, and the person's own cookie reaches the API. Local mode keeps the Studio proxy |
| Report tokens (`x-team-token`) | Unchanged (clients.md section 3) |
| Runner keys and session tokens | Unchanged (M3 design section 4) |
| Deploy key and merger app (M3 owner checklist) | Replaced by the deployment's GitHub App installation tokens, held by the runner the same way. The same rules apply: no Actions, Environments, Secrets or Administration permissions |

## 6. Settings the deployment needs

By name only. infra adds them to the deploy docs and the env template:

- `AGENT_TEAM_PUBLIC_URL` (already), which is the issuer and the cookie origin
- `AGENT_TEAM_OWNER_GITHUB`: the first owner's GitHub user id, read only while there are no members
- `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`, from the app's manifest-flow registration (deployment.md, first run)
- The OIDC signing key is created by the control plane on first start, sealed in the vault, and rotated every 90 days, with the old key kept in the JWKS for a day. It is not an environment variable.

## 7. Contract changes (additive)

- **api-v1.yaml:** `GET /me` (the signed-in person: id, login, role per workspace, passkey count); `GET` and `POST /me/passkeys` and `DELETE /me/passkeys/{id}`; `GET /auth/step-up/challenge`; `webauthn` and `device` as alternatives to `secret` on `POST /auth/step-up`; a `cookie` security scheme beside `person`.
- **clients.md:** section 3 names the web's step-up as a passkey, and says that re-running the upstream sign-in is not a step-up. "`auth_time` in the token" is removed as a way to pass step-up, leaving the step-up token (a narrowing, recorded under contracts rule 7 like the M3 tightening). The `/oauth/*` endpoints and `/.well-known/openid-configuration` are listed under discovery. They sit outside `/v1/` because OIDC fixes their shape.

Those contract edits land with the code (backend-dev's M4 PR), not in this spec. The architect reviews them against this section.

## 8. Order of work

| Order | Role | Task |
| --- | --- | --- |
| 1 | backend-dev | Migration 004, the issuer (`/oauth/*`, discovery), GitHub upstream, cookie sessions and CSRF, against a stub upstream in tests |
| 1 | web-dev | The sign-in and "ask to be invited" pages, and passkey registration and step-up dialogs, against a stub `/oauth` |
| 2 | backend-dev | Passkeys and step-up, roles on every route, retiring the admin token |
| 2 | infra-secrets-oncall | The GitHub App manifest flow in setup, the env template, and the Vercel rewrite for `/oauth` and `/.well-known/openid-configuration` |
| 3 | security reviewer | Review of sections 2, 3 and 5 before anything is deployed |
