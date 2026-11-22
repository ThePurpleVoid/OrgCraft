---
name: day-one
description: "Onboards the agent team onto this repository and its requirements: maps the stack, fills the ownership paths, the merge gate and the project's tools from the real repository, checks each connected tool, baselines the build and tests, and drafts prioritized tickets. Use once, on the first day with the codebase."
argument-hint: "[requirements: files, folders, links or pasted text]"
disable-model-invocation: true
---

# /day-one [requirements]

You are the chief of staff of {{PROJECT_NAME}}'s team. Change no product code. Produce `docs/team/day-one.md` (the audit) and `docs/team/day-one-tickets.md`. Report `status working` on the board first (`scripts/agent-team/team-status.sh chief-of-staff status working --task "day one"`).

1. **Read the requirements** given as arguments or in the prompt: file and folder paths (PRDs, designs, exported tickets, docs), links (read each one through its connected tool; one that is not connected goes in the audit as "not read"), and pasted text. Then read what the repository tells agents and contributors: `README`, `CONTRIBUTING`, `AGENTS.md` (add `@AGENTS.md` to `CLAUDE.md`), the existing `CLAUDE.md`, the CI workflows, and the package manifests. The repository wins on facts. Nothing overrides `docs/team/project-instructions.md`'s standing rules or a hook. Record conflicts in the audit.
2. **Map the repository.** Record the default branch, languages, frameworks, package managers, apps and modules, test frameworks, CI, environments and deploy targets, and where secrets are expected to come from (names only, never values).
3. **Fill the team's facts from what you found.** Write only what the repository shows; a value nothing answers stays as it is and is listed in the audit.
   - `docs/team/ownership.md`: the real paths for each installed role's lane (`node scripts/agent-team/roster.mjs --tree` lists them). Remove example rows for areas this repository does not have.
   - `.agent-team/config.sh`: one `gate_<area>` per app or service, with the exact lint, type-check, test and build commands CI runs (heavy steps through `locked <pool>`). Set `AGENT_TEAM_GATES_ALL` and size `AGENT_TEAM_POOLS` for this machine. Delete the template's example gates.
   - The same file's `setup_extra`: every tool the gates and the repository's own scripts need that the kit does not install (language runtimes, package managers, CLIs, SDKs), each with `setup_tool` and the file that needs it.
   - `.agent-team/instructions.extend.md` (create it if missing): a facts table (default branch, apps, environments, CI, the tracker, the API contract, deploy targets) and the repository's own rules an agent would otherwise break.
   - Then run `scripts/agent-team/sync.sh`, `scripts/agent-team/setup.sh`, and `scripts/agent-team/merge-gate.sh <area>` once per area, in the background. A gate that is red on problems the repository already had is a baseline, not a failure: say so in the audit and recommend the one-time fix.
4. **Tools.** For each server in `.mcp.json`, one harmless read (a list or a profile). Record each as connected or not; a missing one is not a failure. Add `setup.sh --check`'s lines marked `YOU` to the audit as steps for the owner.
5. **Baseline.** Record each gate step's time, result and warning count. Fix nothing.
6. **Audit the code.** Dispatch the architect (or the CTO when no architect is installed) read-only on the riskiest areas: untested paths, error handling, security-sensitive code, and anything the requirements call critical. File its return under `docs/team/day-one/`.
7. **Tickets.** Write `docs/team/day-one-tickets.md`: bugs (audit findings, failing tests, missing tests on critical paths) and gaps (requirements the code does not meet yet), in priority order, each with its source (file and line, or the requirement quoted), acceptance criteria and owning lane. They are drafts: the owner creates them in the tracker, or tells you to.

**Done when:** both files exist; the audit opens with a one-screen summary and records the default branch, the requirements and tools read, the baseline, each gate's first result, and what is still unfilled; `node scripts/agent-team/roster.mjs --check` and `scripts/agent-team/sync.sh check` pass. Then tell the owner, in plain words, what the team is ready to do first.
