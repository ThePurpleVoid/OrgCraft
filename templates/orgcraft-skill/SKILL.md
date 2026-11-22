---
name: orgcraft
description: "Sets up an OrgCraft agent team (chief of staff, executives, specialists, hooks, merge gate) in the current git repository so /day-one can run. Use when the user asks to set up, install or add OrgCraft or an agent team to a repository."
argument-hint: "[--preset minimal|engineering|company] [--project \"Name\"] [--approve-mcp]"
---

# /orgcraft [options]

Set up the team in the repository this session is in, then hand over to a new session for `/day-one`.

1. Check you are at the root of a git repository (`git rev-parse --show-toplevel` equals the current directory). If not, or if `.agent-team/team.json` already exists, say so in one line and stop: the team is set up already, or the user should clone the repository first.
2. Run, passing the user's arguments through (they win over these defaults):
   ```bash
   npx --yes orgcraft@latest init --preset engineering --subagents --owner "$(git config user.name || echo 'the owner')" $ARGUMENTS
   ```
   The project name defaults to the folder's name and the time zone to this machine's. `init` pins the team to that exact OrgCraft version, merges the team's hooks into `.claude/settings.json` (keeping the repository's own), adds the line that loads the team to `CLAUDE.md`, writes `/day-one`, and turns on the setup hook and the plugins the instructions name. `--approve-mcp` also approves every server in `.mcp.json`: pass it only when the user asked, since a cloned repository's servers are not yours to vouch for.
3. Run `scripts/agent-team/setup.sh` to install what this machine is missing. Report its `MISS` and `YOU` lines, each with its command. Do not run the `YOU` commands.
4. Report in a few lines: the project name, the roles installed (`node scripts/agent-team/roster.mjs --tree`), and what is left for the user.
5. Tell the user the next step plainly: start a new Claude Code session in this folder, accept the trust prompt, and run `/day-one` with the requirements (files, folders, links or pasted text). The team's hooks and instructions load only when a session starts, so do not run `/day-one` or team work in this session.
