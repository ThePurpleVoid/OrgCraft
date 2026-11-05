# shellcheck shell=bash disable=SC2034
# .agent-team/config.sh: the runtime settings for the Agent Team Kit scripts in this repository.
# `agent-team init` writes it once; it is yours to edit and sync never touches it. It is plain bash, sourced by
# every script in scripts/agent-team/. Keep secrets out of it: tokens go in ~/.agent-team/<project>/team.env.

# A short name for the project. Event logs, lock slots and team.env live in ~/.agent-team/<project>/.
# Defaults to the repository folder's name, which is the same in every worktree.
AGENT_TEAM_PROJECT="agent-team-kit"

# Hardware pools for scripts/agent-team/with-lock.sh, as name:slots. Size them for the machine the threads run on:
# a 16 GB laptop might take build:1 emulator:1; a 48 GB workstation build:3 emulator:3 simulator:3.
# Pools are in .agent-team/gates.json.

# Where else reports go (optional). Unset, they go to the local event log only, which the dashboard
# (node scripts/agent-team/dashboard.mjs) and team-board.sh read. Put tokens in ~/.agent-team/<project>/team.env, not here.
# A dashboard on another machine:   TEAM_REPORT_URL="http://<host>:4747/api/report"
# A hosted board (board/supabase):  TEAM_REPORT_URL="https://<project-ref>.supabase.co/functions/v1/team-report"

# ---------------------------------------------------------------------------------------------------------------
# Merge gates. scripts/agent-team/merge-gate.sh <target> calls gate_<target>. Inside a gate:
#   run "<name>" <command...>                 record PASS or FAIL for one step
#   run "<name>" locked <pool> <command...>   the same, holding a hardware slot
# Replace these examples with your real build and test commands.

# The kit gate is in .agent-team/gates.json (sync generates scripts/agent-team/gates.sh from it). Gates that need
# real bash stay here; "studio" joins when apps/ lands (see docs/product/delivery-plan.md).

# gate_studio() {
#   run "studio: install" bash -c "npm ci"
#   run "studio: lint, types and unit tests" bash -c "npm run -ws --if-present lint && npm run -ws --if-present test"
#   run "studio: build" locked build bash -c "npm run -ws --if-present build"
#   run "studio: Playwright flows" locked browser bash -c "cd qa && npx playwright test"
# }

# Extra nightly cleanup for scripts/agent-team/janitor.sh.
# janitor_extra() {
#   ./gradlew --stop >/dev/null 2>&1 || true
#   xcrun simctl shutdown all >/dev/null 2>&1 || true
# }
