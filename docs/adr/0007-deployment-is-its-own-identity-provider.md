# ADR 0007: each deployment is its own identity provider, with passkeys for step-up

Status: accepted, 2026-11-06, with conditions K1 and K2. Owner: architect. Spec: [m4-sign-in.md](../specs/m4-sign-in.md).

## Context

M4 puts the Studio online for real people: the owner first, then their team, on phones and on the web. The clients contract already says every client talks to the deployment's own OIDC issuer, and that approvals need a sign-in no older than 5 minutes. The M3 stubs (one admin token, and a typed step-up secret) cannot go online. This is hard to undo, because every client, and every app in a store, will depend on the identity model.

## Options

| Option | Clients talk to | Step-up on the web | Works self-hosted and offline from any vendor | Cost |
| --- | --- | --- | --- | --- |
| A. **The control plane is the OIDC issuer**, with GitHub and others upstream | The deployment | A passkey | Yes | We run an issuer: tokens, rotation, revocation |
| B. Clients sign in to GitHub directly, and the API accepts GitHub tokens | GitHub | Re-running the GitHub sign-in | No: GitHub only, and its tokens carry repository scopes | Least code |
| C. A hosted identity vendor (Auth0, Clerk, Cognito) | The vendor | The vendor's MFA | No: every self-hosted customer needs that vendor account | A dependency per deployment |
| D. Keycloak or another bundled identity server | The bundled server | Its WebAuthn | Yes | One more service to run, upgrade and secure everywhere |

## Decision

**A.** It is the only option that keeps clients unchanged across hosted, self-hosted and local deployments (ADR 0005: no vendor in a contract, decade-proof). It keeps the person's GitHub token out of our system, and it lets step-up mean what it must: a person present now. Step-up on the web is a **passkey with user verification**, because re-running a GitHub sign-in is silent while GitHub's own session lasts, so it proves nothing. On phones it is the device key that the biometric prompt unlocks (already in clients.md). We use an OpenID-Certified issuer library and a maintained WebAuthn library, and write no protocol or cryptography code of our own (K1). Step-up is only ever a single-use token minted from a passkey or device-key assertion; a recent sign-in never counts (K2).

## Consequences

- We own token issuance, rotation, revocation and key rotation. Through a certified library (K1), that is configuration, storage adapters and policy, tested with the library's conformance suites in CI.
- Option D stays open. If enterprise customers need features we don't want to build (SCIM, complex federation), an issuer like Keycloak can sit upstream like any other provider, without a client change.
- A person must register a passkey before their first approval. On a device without one, they approve from their phone.

## Second opinion

The security reviewer argued for B and D on the pull request (#50) and does not dissent from A, on two conditions, now part of this decision:

- **K1:** use an OpenID-Certified issuer library (such as `oidc-provider`) and `@simplewebauthn/server`, not a hand-written issuer.
- **K2:** step-up only ever comes from a single-use step-up token minted from a passkey or device-key assertion. A recent `auth_time` alone never counts.

Their spec findings S1 to S8 are in the spec, section 4a.
