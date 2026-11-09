# ADR 0013: What you see is what you sign; capability changes are computed by the server and never self-granted

Status: **Accepted**, 2026-11-09. Recorded with the owner's decisions of 2026-11-09 at 15:33 UTC (relayed by the chief of staff at 15:37 UTC), which closed review 2. Owner of the document: architect. Source: review 2, security-reviewer Blocks S2-09, S2-12 and S2-23, accepted in vision.md §2.8. The mechanisms are in the vision architecture (project plans, vision/architecture.md) section 8.1. The number is taken when the ADR lands in docs/adr.

## Context

The product's core promise is rule 2: **the owner decides anything that can't be undone**. Review 2 found three ways to keep the ceremony and lose the decision.

1. **The card shows the agent's description, not the call** (S2-12). A teammate that read a hostile email asks to "Refund $20 to Jane" while the queued call pays someone else. Today a generic `request_approval` even ends with the runner telling the agent to "go ahead with exactly that call". That is enforced by an instruction, not bound to the call.
2. **Teammates propose their own access** (S2-09). Self-organising proposals, suggested wiring, lessons, triggers from patterns and model suggestions all let an agent write the change that widens its own reach. The owner then reviews the agent's own prose.
3. **Whoever holds a session can re-route approvals** (S2-23). Delegation, out of office, notification routing and recovery owners decide who approves. Changing them with only a stolen cookie makes the thief the approver without ever touching a card.

## Decision

Three rules sit in the policy package's fixed floor, the part no policy data can relax (CTO R8).

1. **What you see is what you sign.**
   - Every approval holds the canonical pending calls.
   - The card's facts are rendered by the server from those calls through each connector's `facts` map.
   - The passkey challenge is a hash of the tenant, the approval, the card version and the calls.
   - The gateway and the runner run only a call whose hash was signed.
   - The risk class that allows swipe or watch approval is computed by the server.
   - An answer to a question is never an approval.
2. **Capability changes are computed by the server, and never self-granted.**
   - `capabilityDiff` runs on every proposed change, whoever wrote it, and is shown first as `Widens access`.
   - A change authored by a teammate that touches that teammate's own capabilities, reviewer, checks or caps is refused.
   - Accepting any non-empty diff needs a passkey and writes a ledger row in the owner's words.
   - Model and endpoint changes, connector effects and egress, standing rules and rollbacks are all capability changes.
3. **Who approves is protected.**
   - Settings that decide who approves need a step-up bound to the exact change.
   - Widening changes take effect after 24 hours, announced on every channel that existed before the change, with Undo.
   - Delegates accept with their own passkey.
   - Person tokens can never reach these routes, nor approving, credentials, resume or bulk export.

**Stopping stays cheap.** Stop and pause are one tap, are never blocked by a freeze, and need no passkey. Resume does need one.

## Consequences

- There is a code change before any of this ships: the generic `request_approval` path must hold and bind the call, as `accept` and Bash calls held at `preToolUse` already do. Resuming a run a person paused gains step-up.
- connector/1 gains `facts` (pointers to amount, currency and recipient) and `scope: customer` on arguments. Both are additive.
- api-v1 gains `x-interactive-only`, and the permission matrix and the developer platform's "never" list are generated from it.
- Cards get a `calls` hash and server-rendered facts. Old cards keep working as `normal` risk and can't be swiped.
- The 24-hour wait adds friction to legitimate delegation. That is accepted, because narrowing is immediate and the owner can always approve directly.

## Rejected

- **Agent-written facts with a warning label.** The owner still signs words, not the call.
- **Letting a "trusted" teammate widen its own access below a threshold.** A threshold is exactly what an injected instruction would aim at.
- **A passkey only, with no wait, for approver changes.** It doesn't help when the passkey device itself is in the attacker's hands for a short while. The wait plus announcements on every channel gives the real owner time to undo.

## Decision record, 2026-11-09

- **Accepted** on 2026-11-09, recorded with the owner's decisions of 15:33 UTC (A1, B1, C1), relayed by the chief of staff at 15:37 UTC. The three rules above are part of the policy floor from now on.
- **How C1 touches it:** on the shared tiers (free and the first paid tier), OrgCraft's shared code-host App and model key act for many tenants. That makes rule 1 more important, not less: the gateway signs and checks per-call hashes per tenant, and a call signed for one tenant can never run under another tenant's installation or bucket. See architecture.md B16 and "Hosted tiers (decision C1)".
- **Build order:** local PR L6 (approval binds the exact call) and L7 (resume after a person's pause needs step-up) are the first two code changes. The managed store's change requests (ADR 0012, L9) use the same `capabilityDiff` from the start.
