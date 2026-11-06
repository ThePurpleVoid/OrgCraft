# Clients contract, version 1

What every client of the product can rely on: the Studio in a desktop browser, the Studio on a phone browser, the iPhone and Android apps ([ADR 0006](../adr/0006-mobile-apps-native-per-platform.md)), the CLI, and integrations. It exists so a client built years after a server release, or a server upgraded years after a client shipped, still works. Phone apps make this sharper than the web: an app in a store can stay installed and unupdated for years, and it may talk to a self-hosted deployment we have never seen.

The rules here are part of `/v1/`. They change only as the [contract rules](README.md#rules-for-changing-them) allow.

## 1. Every client uses only the public API

The Studio, the apps and the CLI use `/v1/`, the event stream and the deep-link URLs below, and nothing else. There is no private endpoint for the Studio and no backend-for-frontend for mobile. If one client needs something, it is added to `/v1/` for all of them.

## 2. Discovery: one URL is enough to connect

A person connects a client to a deployment by typing its address (`studio.example.com`) or scanning a QR code from the Studio's "Connect your phone" page. Everything else comes from a discovery document, served without sign-in:

`GET https://{host}/.well-known/agent-team`

```json
{
  "api": "https://studio.example.com/v1",
  "contract": "1",
  "kit": "v0.8.0",
  "name": "Acme Studio",
  "oidc": { "issuer": "https://studio.example.com", "clientIds": { "ios": "agent-team-ios", "android": "agent-team-android", "cli": "agent-team-cli" } },
  "push": { "relay": "https://push.agent-team.dev", "providers": ["apns", "fcm"] },
  "clients": { "ios": { "min": "1.0.0" }, "android": { "min": "1.0.0" } },
  "features": ["inbox", "chat", "approvals", "meetings", "push"]
}
```

- `clients.<platform>.min` is the oldest app version the deployment still serves. It is raised only for security fixes. An older app shows "Update the app to keep using this Studio" and nothing else.
- `features` lets a newer app hide what an older server cannot do. Clients ignore names they do not know.
- One app can hold accounts on several deployments (the hosted service, a company's own, a laptop on the same network) and shows them together on its home screen.

## 3. Sign-in

- **OIDC authorization code flow with PKCE** for every public client (phones, the CLI, desktop apps), through the system browser ([RFC 8252](https://www.rfc-editor.org/rfc/rfc8252)). No passwords typed into an app, no embedded web views.
- The deployment's identity layer is the OIDC issuer the clients talk to, whatever upstream provider the workspace uses (GitHub, Google, Microsoft, SAML). The apps never talk to GitHub directly.
- Tokens: a short-lived access token (15 minutes or less) and a rotating refresh token bound to the device registration. Signing out on the phone, removing the device in the Studio, or an admin removing the member revokes them.
- **Step-up for approvals.** `POST /v1/approvals/{id}` requires a sign-in proof no older than 5 minutes (`auth_time` in the token, or a fresh step-up token). Apps get it with Face ID, Touch ID or the Android biometric prompt unlocking a device key registered at sign-in; the web gets it by re-authenticating. A stale token gets `401` with `"type": "step-up-required"`, never a silent approval.

## 4. Devices and push

- `POST /v1/me/devices` registers a client install: platform, app version, push token (APNs or FCM), the device's public key for step-up, and a name the person sees ("Dana's iPhone"). `GET` lists them, `DELETE /v1/me/devices/{id}` removes one and revokes its tokens.
- Push is a notification channel like email (architecture section 12.3). A person's rules decide which events reach which device. Quiet hours and breakthrough work the same way; on iPhone a breakthrough approval is sent as time-sensitive.
- **A push carries no team content.** The payload is `{ "deployment": "<host hash>", "event": "<event id>", "kind": "approval.requested", "badge": 3 }` plus a generic localized title chosen by the app ("Approval needed"). The app fetches the details from its own deployment before showing anything more. This keeps team data out of the push relay, out of Apple's and Google's servers, and off a locked screen unless the person allows previews.
- Actions on a notification: a reversible decision card may be answered from the notification (the app signs the answer with its device key). An approval always opens the app and asks for biometric step-up.

## 5. Reading state: projections, the stream, and catching up

Clients render projections the server computes. They do not rebuild state from raw events.

| Need | Endpoint | Notes |
| --- | --- | --- |
| Everything waiting for me, across teams | `GET /v1/me/inbox` | Approvals, decision cards, ongoing-work choices (ADR 0004), and failed channels, each as a **card** (section 6). Sorted by urgency, then time |
| How each team is doing, at a glance | `GET /v1/me/summary` | Per team: live version, run state, roles working, waiting and blocked, today's cost against the cap, and the inbox count |
| Where every role stands | `GET /v1/teams/{team}/board` | As today |
| One role's recent work | `GET /v1/teams/{team}/roles/{role}` | Current task, branch, PR, last reports, evidence links, meetings |
| The chat | `GET /v1/teams/{team}/chat` | Pages backwards from newest with `before` |
| Live updates | `GET /v1/teams/{team}/events/stream` and `GET /v1/me/stream` | Server-sent events, resumable with `Last-Event-ID` |
| Catching up after being away | `GET /v1/teams/{team}/events?after={eventId}` | Cursor is an event id, so "since I last looked" is exact |

- Every projection response carries an `ETag` and the id of the last event it includes (`"asOf": "<event id>"`). A client can fetch a projection, then open the stream from `asOf`, and miss nothing.
- `If-None-Match` returns `304`. Lists page with `cursor` and `limit`. Responses are compressed.
- A phone does not hold a stream open in the background. It catches up on open, and push wakes it in between.

## 6. Cards: structured, never HTML

Anything a person answers (approval, decision, ongoing-work choice, meeting invitation) is a **card** with the same shape on every client and in every notification channel:

```json
{
  "id": "card_…", "kind": "approval", "team": "my-app", "subject": "approval/apr_91",
  "title": "Add a column to profiles",
  "body": "Backend dev wants to run migration 0042. It adds `theme text null`.",
  "recommendation": { "option": "approve", "why": "Additive and reversible." },
  "options": [ { "id": "approve", "label": "Approve", "style": "primary", "stepUp": true },
               { "id": "deny", "label": "Deny", "style": "danger", "stepUp": false } ],
  "risk": "medium", "expires": "2026-11-06T09:00:00Z", "version": 3,
  "links": [ { "rel": "pr", "url": "https://github.com/…/pull/142" } ],
  "url": "https://studio.example.com/t/my-app/approvals/apr_91"
}
```

- `body` is a small Markdown subset (paragraphs, emphasis, code, links, lists). No HTML, no scripts, no remote images. Text from outside the team is marked untrusted and shortened, as in notifications.
- Answers send the `version` they saw. If the card changed (expired, already answered by someone else, superseded), the server returns `409` with the current card, and the client shows it. Nobody approves something they did not see.
- `kind` and option `style` values a client does not know are rendered as a generic card with plain buttons, never hidden.

## 7. Writing: safe on a bad connection

- Every write accepts `Idempotency-Key`. Chat messages also carry a client-made id, so a message sent twice from a train tunnel appears once.
- Offline, an app may queue **chat messages only**, and shows them as "waiting to send". Approvals and decisions are never queued: they need a live, current card and, for approvals, a fresh step-up.
- Pause and stop for a run are writes like any other, available on every client, and need no step-up (stopping is always safe).

## 8. Deep links: one URL per thing, everywhere

Each thing a person might be sent to has one HTTPS URL on the deployment's host. Emails, Slack messages, push notifications and the Studio all use it. On a phone with the app installed, the URL opens the app (iOS universal links, Android app links); otherwise it opens the mobile web Studio.

| Thing | URL |
| --- | --- |
| Team | `/t/{team}` |
| Role | `/t/{team}/roles/{role}` |
| Approval | `/t/{team}/approvals/{id}` |
| Decision or other card | `/t/{team}/cards/{id}` |
| Chat message | `/t/{team}/chat/{eventId}` |
| Meeting | `/t/{team}/meetings/{id}` |
| Run | `/t/{team}/runs/{id}` |
| Inbox | `/inbox` |

The deployment serves `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` for the published apps by default, and for a customer's own app identifiers if configured. These paths are part of the contract and are never renamed within `/v1/`.

## 9. Forward compatibility

- Clients ignore unknown fields, event types and enum values, and render unknown event types as a plain timeline line (`actor`, `type`, `time`). The conformance fixtures include unknown values on purpose.
- Times are ISO 8601 in UTC; the client shows them in the person's time zone. Money is in minor units with a currency code. Counts and costs are numbers, never preformatted strings.
- Words that depend on the pack (pull request or draft for approval, repository or workspace) come from the team's `vocabulary` in `GET /v1/teams/{team}`. Clients do not hard-code engineering terms.
- Evidence images are signed URLs with size variants (`thumb`, `screen`, `original`), so a phone on mobile data never downloads a full-size screenshot to show a thumbnail.
