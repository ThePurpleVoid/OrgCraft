# Changelog

## 0.1.0 (unreleased)

First public version, extracted from a production agent team and generalised.

- 48 role briefs across engineering, quality, product and design, go-to-market, customer and corporate lanes.
- Shared protocols: one door, dilution rule, fast and full lanes, HANDOFF, BUG, SIGNOFF and BLOCKED, ownership, memory files, dormant roles.
- `agent-team` CLI (`init`, `sync`, `check`, `roles`), run with npx: projects keep only a `.agent-team/` overlay (role extensions, new roles, include/exclude, gates and pools) and generate the rest from a pinned kit version.
- `minimal`, `engineering` and `company` presets.
- Example overlay for native Android and iOS apps.
- Scripts: `team-status.sh`, `team-board.sh`, `merge-gate.sh` (config-driven gates), `with-lock.sh` (config-driven pools), `janitor.sh`.
- Tools: `roster.mjs` (check and print the org) and `export-subagents.mjs` (briefs to Claude Code subagents).
- Optional hosted board on Supabase.
