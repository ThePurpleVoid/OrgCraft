# How this repository's own team builds the Studio

Owner: CTO. Status: draft 1, 2026-11-05.

Agent Team Kit is built by a team defined with Agent Team Kit. Nothing here is special: the team was made with the kit's own `init`, is changed only through `.agent-team/`, and is checked in CI with `sync.sh check`, like any product's team.

## The team

21 roles: the `minimal` preset plus the CPO lane, the AI engineer, infra, the head of quality and test automation, a dormant community lead, and one role of our own, the **kit core dev**, who owns the kit itself. `scripts/agent-team/sync.sh roles` lists each role and where it comes from.

```
owner
└─ chief-of-staff          the one door
   ├─ cto                  engineering lane: delivery plan, ownership, the kit and the Studio
   │  ├─ kit-core-dev      bin/, team/, presets/, scripts/, tools/, templates/, board/, packages/team-model/   (ours)
   │  ├─ architect         architecture, ADRs, specs
   │  ├─ web-dev           apps/studio/ (the editor)
   │  ├─ backend-dev       apps/server/ (API, publish, storage, connectors)
   │  ├─ ai-engineer       apps/runner/, evals/ (sessions, team tools, approvals, budgets)
   │  ├─ infra-secrets-oncall   deploy/, CI, the deployment doc
   │  ├─ security-reviewer, code-reviewer, release-manager, docs-keeper
   │  └─ head-of-quality ─ qa-web, test-automation-engineer
   ├─ cpo                  product and design lane
   │  └─ product-manager (PRD, demo), design-director, design-critic, ux-writer
   └─ community-lead       dormant until the first outside contributors
```

Paths are in [docs/team/ownership.md](../team/ownership.md). Lane priorities are in [docs/team/lanes/cto.md](../team/lanes/cto.md) and [docs/team/lanes/cpo.md](../team/lanes/cpo.md).

## What is ours and what is generated

| Path | What |
| --- | --- |
| `team/` | The kit's source: the role library every team gets. Changing it changes every team on its next sync |
| `.agent-team/` | This repository's project layer: the role choice, our own `kit-core-dev`, extensions that point the builders at `apps/`, our project rules, our gates |
| `docs/team/` | This repository's generated team (do not edit), plus our `ownership.md` and `lanes/` |
| `scripts/agent-team/` | Generated runtime scripts (do not edit). They are not shipped in the kit package (`package.json` `files`) |

## The bootstrap rule: we run on the last release

The team is pinned to a released tag (`"kit": "…#v0.3.0"`), never to `main`, the way a compiler builds itself with the previous release. A change to the kit reaches us the way it reaches every team: the kit core dev merges it, the release manager tags a release, then bumps the pin in `.agent-team/team.json` and runs `scripts/agent-team/sync.sh` in a follow-up PR. That PR is our own upgrade test: if its diff surprises us, it will surprise every other team too.

## How a request becomes work here

1. The owner talks to the chief of staff (this project's coordinator).
2. The chief of staff opens an issue and forwards the owner's words verbatim to the CTO (engineering) or the CPO (product and design).
3. Studio features use the full lane. The product manager writes the story against a demo step, the architect writes the spec (and an ADR when the architect-first list applies), the design director runs style threads for anything visual, and the builders build against the spec.
4. Kit changes go through the kit core dev and always say what existing teams will see on their next sync.
5. Every PR carries `scripts/agent-team/merge-gate.sh kit` output (and `studio` once `apps/` lands), a review from a code reviewer thread, and QA's SIGNOFF with evidence for anything a user can see.

## The first artifacts

The planning docs are the team's first work, each written by the role that owns its path:

| Artifact | Owner |
| --- | --- |
| [PRD](prd.md) (vision, personas, demo, gaps, MVP) | product manager, for the CPO |
| [Architecture](architecture.md), [ADR 0001](../adr/0001-repository-is-the-source-of-truth.md), [ADR 0002](../adr/0002-runtime-agent-sdk-runner.md) | architect |
| [Deployment](deployment.md) | infra, secrets and on-call |
| [Delivery plan](delivery-plan.md), this page, the lane files | CTO |

## Running it

Today the team runs as claude.ai project threads (the kit's option A): the project coordinator is the chief of staff and opens role threads as the plan needs them. The board is the kit dashboard: `node scripts/agent-team/dashboard.mjs` in this repository shows this team. When phase 3 ships, the team moves onto the Studio runner. That makes this repository the Studio's first real user, and the first entry in its evals.
