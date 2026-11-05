# ADR 0002: run published teams on our own runner, built on the Claude Agent SDK

Status: proposed, 2026-11-05 (the owner is asked, see the PRD's open questions). Owner: architect.

## Context

The demo ends with "talk to the chief of staff and let it run". Today the kit runs as claude.ai project threads that a person opens by hand, or as subagents in one Claude Code session. Claude Code also has built-in agent teams (a lead with teammates). The Studio needs a runtime it can start, watch, pause, budget and gate from its own interface.

## Options

| Option | Control from the Studio | Parallel long-lived roles | Governance enforced | Infrastructure |
| --- | --- | --- | --- | --- |
| A. Drive claude.ai projects and threads | Low: no supported way to open and steer threads from our app | Yes | Prompt only | claude.ai |
| B. Built-in agent teams only | Medium: starts from a terminal | Within one session | Prompt plus hooks | None |
| C. Subagents in one Agent SDK session | High | No (one session) | Runner-enforced | Small |
| D. **Our runner on the Agent SDK: chief of staff plus a session per role, woken by messages** | High | Yes, each in a worktree | Runner-enforced (ownership hook, approvals, budgets) | The runner |

## Decision (proposed)

D is the main run mode, with B and C as zero-infrastructure modes from the same published team, and A kept as an export (the project instructions) for teams that already use claude.ai projects. The MVP builds C first, because it is quick to reach the demo, then D.

## Consequences

- We own a message bus, session supervision, approvals and budgets. That is a real system, but it is the part that makes the kit's governance enforceable and the canvas live.
- The runner, not the agent, is the source of liveness events, which closes the stale-board gap (G1) for runs we start.
- Model access is the customer's own key (or Claude Code login locally); cost is visible per run and per role.
- Other agents can be added later as adapters behind the same runner contract (G3).
