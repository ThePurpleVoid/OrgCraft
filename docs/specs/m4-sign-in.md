# M4 spec: signing in to a hosted Studio

Status: proposed, 2026-11-06. Owner: architect. Decision record: [ADR 0007](../adr/0007-deployment-is-its-own-identity-provider.md). Builds on the [clients contract](../contracts/clients.md) sections 3 and 4, and replaces the M3 step-up stub ([M3 design](../product/m3-design.md) section 4 and section 12, D3 to D5).

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

1. The Studio, or an app, sends the person to `GET /oauth/authorize` (`response_type=code`, `client_id`, `redirect_uri`, `code_challenge` with S256, `state`, `nonce`). The web Studio is client `agent-team-web`, with its redirect URI on the deployment's own host.
2. With no session, the control plane shows a "Continue with GitHub" page and runs the upstream OAuth flow with its own `state` and PKCE. GitHub sign-in uses the deployment's GitHub App (the same app that M4 installs on repositories), with its user authorization flow. The control plane asks only for the person's identity, with no repository scope on the person's token. It keeps the GitHub user id and login, never the person's GitHub token.
3. **Who may sign in.** A person is let in only if they are already a member of a workspace on this deployment, or have an open invitation. A fresh deployment has no members: `AGENT_TEAM_OWNER_GITHUB` (a GitHub user id) names the one person whose first sign-in creates the tenant's owner. Anyone else gets "Ask an owner to invite you", and nothing is created.
4. The control plane creates a **person session** and redirects back with a code. `POST /oauth/token` exchanges it (PKCE checked) for:
   - **web:** nothing in the body. The token endpoint sets the session cookie on the redirect itself (the web client is first-party), so the page never holds a token.
   - **apps and CLI:** an access token (opaque, 15 minutes), a rotating refresh token bound to the device registration (clients.md section 4), and an ID token (ES256-signed JWT with `sub`, `auth_time`, `amr`, `nonce`).
5. Signing out (`POST /oauth/revoke`, or the Studio's sign-out) ends the session and revokes its tokens. Removing a device or a member does the same (clients.md section 3).

Tokens are opaque to clients and looked up by hash on the server, so revoking one takes effect at once. Refresh tokens rotate on every use. Reusing an old one revokes the whole family and writes an `audit` row.

**The cookie:** `__Host-agent-team`, a random 32-byte session id (only its hash is stored), `HttpOnly; Secure; SameSite=Lax; Path=/`. Idle expiry is 12 hours and absolute expiry 7 days. **CSRF:** every unsafe method sent with the cookie needs an `Origin` that equals the deployment's public URL, and `content-type: application/json` (a cross-site form cannot send either). Requests with a bearer token are not cookie-authenticated, so they need neither.

**Proof** (backend-dev): `a person who is not a member or invitee cannot create an account`, `the first sign-in of AGENT_TEAM_OWNER_GITHUB creates the owner, and a second person cannot`, `a reused refresh token revokes the family`, `a cookie request from another origin is refused`, `a revoked session's cookie is refused at once`, `the person's GitHub token is not stored`. web-dev: a Playwright sign-in against a stub upstream provider, at desktop and 360 px.

## 3. Step-up, for real

Owner: **backend-dev**, **web-dev**. The security reviewer reviews it.

Step-up has to prove that **a person is present now**, not just that a session exists. Re-running GitHub sign-in proves nothing, because GitHub signs a person in again silently while their GitHub session lasts. So step-up never goes through the upstream provider:

| Client | Step-up | Sets |
| --- | --- | --- |
| Web Studio | A **passkey** (WebAuthn, `userVerification: required`): Touch ID, Face ID, Windows Hello or a security key. Registered at the person's first sign-in, and at least one is required before they can approve anything | the session's `auth_time` and `amr: ["hwk", "user"]` |
| iPhone and Android apps | The device key registered with `POST /me/devices`, unlocked by the biometric prompt (clients.md section 4), signing a server challenge | the token's `auth_time` |
| CLI | None. The CLI cannot approve; it prints the approval's URL | |
| Local mode (one built-in owner) | A passkey, which works on `localhost`, or the M3 step-up secret, kept only for local mode | the session's `auth_time` |

The API does not change: `POST /v1/auth/step-up` now takes `{ "webauthn": <assertion> }` or `{ "device": <signed challenge> }`, and still takes `{ "secret": … }` only when the deployment runs in local mode. It answers with the same step-up token (`su_…`, 5 minutes, one use, bound to the principal, D5). A request whose session or token has `auth_time` within 5 minutes also passes, which clients.md already allows. `GET /v1/auth/step-up/challenge` returns the WebAuthn or device challenge (one use, 2 minutes).

Everything D3 to D6 required still holds: lockout after 5 failed attempts in 15 minutes, audit rows with the step-up token's id, nothing replayable, and no step-up from a session token. Passkeys are managed at `GET` and `POST /v1/me/passkeys` and `DELETE /v1/me/passkeys/{id}`. Adding or removing a passkey itself needs step-up, or, for the very first passkey, a sign-in no older than 5 minutes.

**Proof:** `an approval with a passkey assertion passes, and one without step-up gets 401 step-up-required`, `a passkey assertion without user verification is refused`, `the step-up secret is refused on a hosted deployment`, `a fresh GitHub sign-in alone does not count as step-up`, `removing a passkey needs step-up`.

## 4. People, workspaces and roles

Owner: **backend-dev**. Migration 004, with RLS on `app.tenant` like 001 and 003:

| Table | Columns (beyond tenant) |
| --- | --- |
| `members` | `id` (`mem_`), `provider` (`github`), `subject` (the upstream user id), `login`, `name`, `email`, `role` (owner, admin, editor, viewer, approver), `created_at`, `removed_at`. Unique `(provider, subject)` |
| `invitations` | `id`, `provider`, `login` or `email`, `role`, `invited_by`, `expires_at`, `accepted_at` |
| `person_sessions` | `id_hash`, `member`, `client` (`agent-team-web`, `agent-team-ios`, …), `device`, `auth_time`, `amr`, `created_at`, `last_seen`, `expires_at`, `revoked_at` |
| `oauth_tokens` | `hash`, `kind` (access, refresh), `session`, `family`, `expires_at`, `used_at`, `revoked_at` |
| `passkeys` | `id`, `member`, `credential_id`, `public_key`, `sign_count`, `name`, `created_at`, `last_used` |

Roles decide what a person may do: viewers read, editors chat and change runs, approvers and owners answer approvals, and owners manage members, budgets, runners and secrets. Every endpoint states its minimum role, as `x-min-role` in api-v1.yaml. An approval checks the role **and** step-up.

**Proof:** `tenants cannot see each other's members, sessions, tokens or passkeys` (the 001 pattern), `a viewer cannot answer an approval even with step-up`, `removing a member ends their sessions and tokens at once`.

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
- **clients.md:** section 3 names the web's step-up as a passkey, and says that re-running the upstream sign-in is not a step-up. The `/oauth/*` endpoints and `/.well-known/openid-configuration` are listed under discovery. They sit outside `/v1/` because OIDC fixes their shape.

Those contract edits land with the code (backend-dev's M4 PR), not in this spec. The architect reviews them against this section.

## 8. Order of work

| Order | Role | Task |
| --- | --- | --- |
| 1 | backend-dev | Migration 004, the issuer (`/oauth/*`, discovery), GitHub upstream, cookie sessions and CSRF, against a stub upstream in tests |
| 1 | web-dev | The sign-in and "ask to be invited" pages, and passkey registration and step-up dialogs, against a stub `/oauth` |
| 2 | backend-dev | Passkeys and step-up, roles on every route, retiring the admin token |
| 2 | infra-secrets-oncall | The GitHub App manifest flow in setup, the env template, and the Vercel rewrite for `/oauth` and `/.well-known/openid-configuration` |
| 3 | security reviewer | Review of sections 2, 3 and 5 before anything is deployed |
