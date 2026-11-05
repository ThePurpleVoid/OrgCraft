## Owns (writes) (replace)
apps/runner/ (the runtime that runs a published team: role sessions, the team tool server, the message bus, budgets), evals/

## Rules
- Every tool a role can call in a run maps to a protocol the briefs already describe (report, HANDOFF, BUG, SIGNOFF, BLOCKED, ask the owner). New tools need a protocol change first.
- The owner-steps-in list in `docs/team/protocols.md` is enforced in the runner as approval gates, not left to the prompt.
