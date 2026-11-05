#!/usr/bin/env bash
# shellcheck disable=SC2016,SC2034,SC1010  # assertions are eval-ed strings
# End-to-end tests for the agent-team CLI and the scripts it generates. Run from anywhere: tests/scripts.test.sh
set -uo pipefail
KIT="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
export HOME="$tmp/home"; mkdir -p "$HOME"
fails=0; passes=0
ok() { passes=$((passes + 1)); echo "ok   $1"; }
no() { fails=$((fails + 1)); echo "FAIL $1"; [ -n "${2:-}" ] && echo "     $2"; }
expect() { if eval "$2"; then ok "$1"; else no "$1" "$2"; fi; }

repo="$tmp/demo"; mkdir -p "$repo"; git -C "$repo" init -q; git -C "$repo" commit -q --allow-empty -m init \
  -c user.name=t -c user.email=t@t 2>/dev/null || git -C "$repo" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init

# init and sync (the kit runs from this checkout, as npx would run it from the pinned version)
AT="node $KIT/bin/agent-team.mjs"
out="$(cd "$repo" && $AT init --preset minimal --project "Demo App" --owner "Sam" --timezone "UTC" --subagents 2>&1)"
expect "init succeeds" '[ $? -eq 0 ]'
expect "minimal preset generates 11 briefs" '[ "$(ls "$repo/docs/team/roles" | grep -vc "^_")" -eq 11 ]'
expect "placeholders are filled" '! grep -rq "{{" "$repo/docs/team" && grep -q "Sam is the owner" "$repo/docs/team/project-instructions.md"'
expect "config written with project slug" 'grep -q "AGENT_TEAM_PROJECT=\"demo-app\"" "$repo/.agent-team/config.sh"'
expect "kit pinned in team.json" 'jq -e ".kit | test(\"Agent-Team-Kit#v\")" "$repo/.agent-team/team.json" >/dev/null'
expect ".merge-gate ignored" 'grep -qx ".merge-gate/" "$repo/.gitignore"'
expect "minimal team has no roster warnings" '! grep -q "warning" <<<"$out"'
expect "subagents exported for every active role" '[ "$(ls "$repo/.claude/agents" | wc -l)" -eq 11 ] && grep -q "^model: opus" "$repo/.claude/agents/cto.md"'
expect "role template sits outside roles/" '[ -f "$repo/docs/team/role-template.md" ] && [ ! -e "$repo/docs/team/roles/_template.md" ]'
expect "org tree is generated from the installed roles" 'grep -q "─ cto (deep)" "$repo/docs/team/project-instructions.md" && ! grep -q "mobile-dev" "$repo/docs/team/project-instructions.md"'
expect "generated node tools run (hashbang stays first)" '(cd "$repo" && node scripts/agent-team/roster.mjs --check >/dev/null && node scripts/agent-team/dashboard.mjs --help >/dev/null)'
expect "dashboard page is generated" '[ -f "$repo/scripts/agent-team/dashboard/index.html" ] && [ -f "$repo/scripts/agent-team/dashboard/app.js" ]'
expect "dashboard export writes a static site" '(cd "$repo" && node scripts/agent-team/dashboard.mjs export --out "$tmp/site" --board https://b.example/team-report >/dev/null) && jq -e ".roles | length == 11" "$tmp/site/roster.json" >/dev/null && grep -q "b.example" "$tmp/site/config.js"'
expect "check passes right after init" '(cd "$repo" && $AT check >/dev/null)'
(cd "$repo" && $AT init >/dev/null 2>&1)
expect "second init refuses" '[ $? -eq 64 ]'

# overlays: extension, new role, exclude, then check catches hand edits and sync removes dropped roles
cat >"$repo/.agent-team/roles/cto.extend.md" <<'MD'
## Rules
- Ship on Fridays only with the owner's yes.
MD
cat >"$repo/.agent-team/roles/data-engineer.md" <<'MD'
# Data engineer

**Model:** standard
**Group:** engineering
**Reports to:** cto

## Identity
Own the pipelines.

## Owns (writes)
pipelines/
MD
jq '.exclude = ["docs-keeper"]' "$repo/.agent-team/team.json" >"$tmp/t.json" && mv "$tmp/t.json" "$repo/.agent-team/team.json"
expect "check sees the overlay changes" '! (cd "$repo" && $AT check >/dev/null)'
(cd "$repo" && $AT sync >/dev/null)
expect "extension rule lands in the generated brief" 'grep -q "Ship on Fridays" "$repo/docs/team/roles/cto.md"'
expect "new role is generated" '[ -f "$repo/docs/team/roles/data-engineer.md" ]'
expect "excluded role and its subagent are removed" '[ ! -f "$repo/docs/team/roles/docs-keeper.md" ] && [ ! -f "$repo/.claude/agents/docs-keeper.md" ]'
echo "tampered" >>"$repo/docs/team/protocols.md"
expect "check catches a hand edit" '(cd "$repo" && { $AT check || true; } | grep -q "edited by hand")'
expect "sync.sh runs the local kit" '(cd "$repo" && AGENT_TEAM_KIT_DIR="$KIT" scripts/agent-team/sync.sh >/dev/null && AGENT_TEAM_KIT_DIR="$KIT" scripts/agent-team/sync.sh check >/dev/null)'
expect "ownership.md survives sync" 'grep -q "one writer per path" "$repo/docs/team/ownership.md"'

# the example overlay syncs cleanly
ex="$tmp/example"; mkdir -p "$ex"; git -C "$ex" init -q; cp -r "$KIT/examples/native-mobile/.agent-team" "$ex/"
exout="$(cd "$ex" && $AT sync 2>&1)"
expect "example overlay syncs with no warnings" '[ $? -eq 0 ] && ! grep -q "warning\|error" <<<"$exout"'

cd "$repo" || exit 1
S=scripts/agent-team

# team-status and team-board
$S/team-status.sh backend-dev status working --task "Invoices API" --issue 42 >/dev/null 2>&1
$S/team-status.sh backend-dev handoff waiting --to backend-tester --task "Invoices API" --pr 57 >/dev/null 2>&1
$S/team-status.sh qa-web bug - --to web-dev --severity 2 --evidence a.png,b.txt --detail "Save does nothing" >/dev/null 2>&1
$S/team-status.sh code-reviewer#57 status done >/dev/null 2>&1
log="$HOME/.agent-team/demo-app/events.jsonl"
expect "events are logged per project" '[ "$(wc -l <"$log")" -eq 4 ]'
expect "evidence is an array" '[ "$(sed -n 3p "$log" | jq -r ".evidence | length")" -eq 2 ]'
expect "branch is filled from git" '[ -n "$(head -1 "$log" | jq -r ".branch // empty")" ]'
msg="$($S/team-status.sh qa-web bug - --detail x 2>&1)"
expect "bug without --to is refused, exit 0" '[ $? -eq 0 ] && grep -q "needs --to" <<<"$msg" && [ "$(wc -l <"$log")" -eq 4 ]'
$S/team-status.sh qa-web status nonsense >/dev/null 2>&1
expect "bad status is refused" '[ "$(wc -l <"$log")" -eq 4 ]'
board="$($S/team-board.sh)"
expect "board shows backend-dev waiting on backend-tester" 'grep -E "^backend-dev +waiting .*backend-tester" <<<"$board" >/dev/null'
expect "board shows pool instance" 'grep -q "code-reviewer#57" <<<"$board"'
expect "board json has 3 roles" '[ "$($S/team-board.sh --json | jq length)" -eq 3 ]'
feed="$($S/team-board.sh --feed 2)"
expect "feed lists newest first" 'head -1 <<<"$feed" | grep -q "code-reviewer#57"'

# with-lock
expect "with-lock runs the command" '[ "$($S/with-lock.sh backend -- echo hi 2>/dev/null)" = hi ]'
$S/with-lock.sh nope -- true 2>/dev/null
expect "unknown pool exits 64" '[ $? -eq 64 ]'
( AGENT_TEAM_POOLS="one:1" $S/with-lock.sh one -- sleep 3 ) 2>/dev/null &
sleep 1
AGENT_TEAM_POOLS="one:1" WITH_LOCK_TIMEOUT=1 WITH_LOCK_POLL=1 $S/with-lock.sh one -- true 2>/dev/null
expect "a full pool times out with 75" '[ $? -eq 75 ]'
wait

# merge-gate
cat >>.agent-team/config.sh <<'CFG'
AGENT_TEAM_GATES_ALL="good"
gate_good() { run "good: true" true; run "good: locked" locked backend true; }
gate_bad() { run "bad: false" false; }
CFG
expect "gate passes" '$S/merge-gate.sh good >/dev/null 2>&1'
expect "gate fails on a failing step" '! $S/merge-gate.sh good bad >/dev/null 2>&1'
gate_out="$($S/merge-gate.sh bad 2>&1)"
expect "gate summary names the failure" 'grep -q "FAIL bad: false" <<<"$gate_out"'
gate_out="$($S/merge-gate.sh all 2>&1)"
expect "all runs AGENT_TEAM_GATES_ALL" 'grep -q "PASS good: locked" <<<"$gate_out"'
$S/merge-gate.sh missing >/dev/null 2>&1
expect "unknown target exits 64" '[ $? -eq 64 ]'

# janitor
expect "janitor runs" '$S/janitor.sh >/dev/null 2>&1'

echo; echo "$passes passed, $fails failed"
[ "$fails" -eq 0 ]
