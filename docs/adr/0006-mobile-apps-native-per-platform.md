# ADR 0006: mobile apps, native, one repository per platform

Status: accepted, 2026-11-06. Owner: architect. Builds on [ADR 0005](0005-online-first-built-to-last.md) (online first, built to last). Reads with [PRD 6.10](../product/prd.md#610-mobile-apps) and [architecture section 14](../product/architecture.md#14-mobile-clients).

## Context

The owner (2026-11-06): "What if I'm on mobile and need to check up on my systems? We will need to eventually have an Android and iPhone app to go along with this in their own repos."

The Studio is a web app. The founder-builder persona already wants "a whole company of agents working while they sleep, steered from a phone" (PRD section 2), and a team that holds meetings at 9 a.m. and asks for approvals at 3 a.m. needs a way to reach its owner that is better than an email. Phones are where people answer things quickly, so the phone is where approvals, decisions and "is everything all right?" checks will mostly happen.

Two questions need an answer now, even though the apps come later:

1. **How are the apps built, and where does their code live?** The owner asked for their own repositories.
2. **What must the server guarantee today** so that the MVP's API, events and notifications do not have to be redone when the apps arrive? This is the expensive part to get wrong, because the MVP contracts are being built now.

What the apps are for is small and stable: see what the team is doing, get told when something needs you, answer it (approve, decide, choose what happens to ongoing work), talk to the chief of staff, and follow meetings. Building the team on a canvas stays a large-screen job (PRD 6.10).

## Decision

### 1. Two native apps, each in its own repository

| | iPhone (and iPad) | Android |
| --- | --- | --- |
| Repository | `agent-team-ios` (working name), created when phase 4 starts | `agent-team-android` (working name), same |
| Language and UI | Swift, SwiftUI | Kotlin, Jetpack Compose |
| Networking | `URLSession`, a client generated from `api-v1.yaml` | OkHttp or Ktor, a client generated from `api-v1.yaml` |
| Sign-in | `ASWebAuthenticationSession` (system browser, OIDC with PKCE) | Custom Tabs through AppAuth (same) |
| Push | APNs | FCM |
| Secure storage | Keychain, Face ID or Touch ID for step-up | Keystore, BiometricPrompt for step-up |
| Releases | TestFlight, then the App Store | Internal track, then Google Play |
| License | MIT, like the kit | MIT |

The kit repository stays the home of the **contracts** the apps depend on (`docs/contracts/`, including the new [clients contract](../contracts/clients.md)). The apps never depend on the Studio's source code, only on the public API.

### 2. What is shared, and how

The apps share contracts, not code:

- **The API**, as the OpenAPI file. Each app generates its client from a pinned version of `api-v1.yaml` (by kit tag), and CI fails if the generated client is out of date with the pinned contract.
- **Conformance fixtures** in the kit repository (`docs/contracts/fixtures/`, added with the first app): sample event streams, board and inbox responses, cards, an unknown event type and an unknown enum value. Both apps run the same fixtures in their tests, so they render the same team the same way, and both prove they survive things they do not know yet.
- **Design tokens** from the Studio (colours for groups and statuses, the status vocabulary), exported as JSON from the kit, so a role's colour and a "blocked" badge mean the same thing on every screen.
- **Copy and vocabulary** from the pack (ADR 0005 §8). The server sends the pack's words ("pull request" or "draft for approval"); the apps never hard-code engineering terms.

No shared runtime library. If client-side logic grows (offline sync, a local event store), a Kotlin Multiplatform module for that logic only is the first thing to try, in a third repository, consumed by both apps as a versioned package. It is not needed for the scope above.

### 3. The mobile web as the interim, and the fallback forever

Until the apps ship, and for anyone who never installs them, the Studio's control-room screens (home, inbox, board as a list, role detail, chat, approvals, meeting minutes) work on a phone browser. This is in the MVP (delivery plan phase 3). The editor itself is not reflowed for phones; on a small screen it opens read-only with a note to use a larger screen to edit.

### 4. Mobile is a client of the public API, nothing more

The apps use only `/v1/`, the event stream, and the deep-link URLs. There is no private mobile API and no backend-for-frontend. Everything a phone needs that the web did not already need (an inbox across teams, device registration, push, step-up for approvals, a discovery document for self-hosted deployments) is added to the public API for every client. The full list is in [architecture section 14](../product/architecture.md#14-mobile-clients) and the [clients contract](../contracts/clients.md).

### 5. Push goes through a relay we run, with no content in it

Only the holder of an app's signing keys can send pushes to it. A customer's self-hosted Studio does not have the keys for our published apps, so every deployment sends pushes through a small **push relay** that we operate. The deployment sends the relay a device token and an opaque payload (the event id and a count); the relay forwards it to APNs or FCM. Nothing readable about the team goes through the relay: the app wakes, signs in to its own deployment and fetches the details. A customer who builds their own copy of the apps under their own keys can run the relay themselves (it is open source in the same repository as the server). The relay is a connector with the `notify` capability, like email (architecture section 7).

## Why native, and why two repositories

The owner asked for their own repositories. The reasons it is also the better choice for a decade:

- **The apps' value is in platform features.** Lock-screen notification actions, time-sensitive notifications that break through Focus for approvals, biometric step-up, widgets, Live Activities for a running meeting or rollout, Siri and App Intents, Android's notification channels and Quick Settings. These arrive first, and work best, in the platforms' own SDKs. A cross-platform layer gets them late or through plugins we would maintain.
- **Platform SDKs are the most durable dependency available.** SwiftUI and Jetpack Compose are the platform owners' own direction and will be supported as long as the platforms are. Cross-platform frameworks have come and gone in the last decade; ten years is longer than most of them have existed.
- **The scope is small and the contracts carry the logic.** The apps show projections the server computes (board, inbox, cards) and send a few writes (chat, decide, approve, pause). There is little logic to duplicate. Duplication in thin, contract-driven clients is cheap, and agents on our own team write both.
- **Separate release trains.** App Store review, Play rollout, platform OS deadlines and signing are different for each store. One repository per platform keeps each store's CI, secrets, release role and versioning independent, so an iOS review delay never blocks an Android fix.
- **It matches our own team.** The kit's engineering pack already has iOS and Android builder and QA roles, with separate owned areas and gates. One repository per platform maps onto them with no shared paths, so one writer per path holds trivially. The owner's own products already ship native SwiftUI and Compose apps, so the skills and the toolchains are known.

## Rejected

- **One cross-platform repository (React Native with Expo, or Flutter).** Cheapest to start, and React Native would reuse the Studio's TypeScript. Rejected because it goes against the owner's ask, puts the features that matter most (notification actions, Focus breakthrough, widgets, biometrics) behind third-party plugins, ties both stores to one release train, and bets the next ten years on a framework's roadmap rather than the platforms'. Worth revisiting only if the apps' scope grows to the full editor, which it should not.
- **Kotlin Multiplatform with a shared UI (Compose Multiplatform).** Keeps two native-feeling apps from one codebase. Rejected for now: shared UI on iOS is newer and less native than SwiftUI, and it would need a shared repository. A KMP module for *logic only* stays the fallback named in decision 2.
- **A wrapped web app (Capacitor, or a WebView shell) published to the stores.** Fast, but a store app that is a website gets the weakest platform integration and store reviewers reject thin wrappers. The mobile web Studio (decision 3) already covers "a website on my phone" without a store.
- **A mobile-only API or backend-for-frontend.** It would drift from the public API and break the rule that every client uses `/v1/` (architecture section 13). What a phone needs is useful to every client, so it goes in `/v1/`.
- **Sending pushes directly from each deployment to APNs and FCM.** Impossible for our published apps without handing our signing keys to every customer. The relay with contentless payloads is how self-hosted chat products solve the same problem.

## Consequences

- The MVP contracts gain what mobile needs now (discovery document, PKCE for public clients, an inbox projection, device registration, step-up approvals, structured cards, stable deep links), so the apps add screens later, not server changes. The phase 3 build checks itself against [architecture section 14](../product/architecture.md#14-mobile-clients).
- The mobile web control room ships in phase 3. The native apps v1 land in phase 4, with push through the relay. Widgets, Live Activities, joining a meeting by voice, and enterprise device management land in phase 5.
- The two app repositories are created when phase 4 starts, not before. Each gets its own `.agent-team/` team (or joins the kit's team as a lane), its own gates and its own release role.
- Each app release states the API contract version (kit tag) it was generated from. The server's discovery document states the oldest app version it still supports, so a security fix can require an update without breaking everyone else.
