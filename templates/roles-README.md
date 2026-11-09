# Project roles

This folder is this repository's layer on top of the OrgCraft roles. After any change here, run
`scripts/agent-team/sync.sh` and commit the regenerated `docs/team/roles/` with it.

| File | Effect |
| --- | --- |
| `<role>.extend.md` | Changes a kit role. A `# Title` line renames it. `**Field:** value` lines replace that field (for example `**Model:** deep`). A `## Section` appends to the kit's section of the same name (for example extra `## Rules` bullets or `## Tools`). `## Section (replace)` replaces it. |
| `<role>.md` (same name as a kit role) | Replaces the kit role entirely. Prefer an extension, so kit improvements keep reaching you. |
| `<new-role>.md` | Adds a role the kit does not have. Start from `docs/team/role-template.md`. |

To drop a kit role, add it to `"exclude"` in `.agent-team/team.json`. To add a kit role outside your preset, add it to `"include"`.

Example, `cto.extend.md`:

```markdown
**Model:** deep (high effort)

## Rules
- Never add device or emulator jobs to CI; all device testing happens on the team machine.
```
