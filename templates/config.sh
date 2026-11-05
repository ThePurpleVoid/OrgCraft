# shellcheck shell=bash disable=SC2034
# .agent-team/config.sh: the runtime settings for the Agent Team Kit scripts in this repository.
# `agent-team init` writes it once; it is yours to edit and sync never touches it. It is plain bash, sourced by
# every script in scripts/agent-team/. Keep secrets out of it: tokens go in ~/.agent-team/<project>/team.env.

# A short name for the project. Event logs, lock slots and team.env live in ~/.agent-team/<project>/.
# Defaults to the repository folder's name, which is the same in every worktree.
AGENT_TEAM_PROJECT="my-project"

# Hardware pools for scripts/agent-team/with-lock.sh, as name:slots. Size them for the machine the threads run on:
# a 16 GB laptop might take build:1 emulator:1; a 48 GB workstation build:3 emulator:3 simulator:3.
AGENT_TEAM_POOLS="build:2 browser:3 emulator:2 simulator:2 backend:1"

# Where else reports go (optional). Unset, they go to the local event log only, which the dashboard
# (node scripts/agent-team/dashboard.mjs) and team-board.sh read. Put tokens in ~/.agent-team/<project>/team.env, not here.
# A dashboard on another machine:   TEAM_REPORT_URL="http://<host>:4747/api/report"
# A hosted board (board/supabase):  TEAM_REPORT_URL="https://<project-ref>.supabase.co/functions/v1/team-report"

# ---------------------------------------------------------------------------------------------------------------
# Merge gates. scripts/agent-team/merge-gate.sh <target> calls gate_<target>. Inside a gate:
#   run "<name>" <command...>                 record PASS or FAIL for one step
#   run "<name>" locked <pool> <command...>   the same, holding a hardware slot
# Replace these examples with your real build and test commands.

# The targets "merge-gate.sh all" runs, in order.
AGENT_TEAM_GATES_ALL="web backend"

gate_web() {
  run "web: install" bash -c "cd apps/web && npm ci"
  run "web: lint and type check" bash -c "cd apps/web && npm run lint && npm run typecheck"
  run "web: unit tests" bash -c "cd apps/web && npm test"
  run "web: build" locked build bash -c "cd apps/web && npm run build"
  if [ -f qa/playwright.config.ts ]; then
    run "web: Playwright flows" locked browser bash -c "cd qa && npx playwright test"
  fi
}

gate_backend() {
  run "backend: tests on the local stack" locked backend bash -c "cd backend && npm test"
}

# gate_mobile() {
#   run "mobile: build and unit tests" locked build bash -c "cd apps/mobile && ./gradlew assembleDebug testDebugUnitTest"
#   if command -v maestro >/dev/null && ls qa/flows/mobile/*.yaml >/dev/null 2>&1; then
#     run "mobile: Maestro flows" locked emulator maestro test qa/flows/mobile/
#   fi
# }

# Extra nightly cleanup for scripts/agent-team/janitor.sh.
# janitor_extra() {
#   ./gradlew --stop >/dev/null 2>&1 || true
#   xcrun simctl shutdown all >/dev/null 2>&1 || true
# }
