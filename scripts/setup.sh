#!/usr/bin/env bash
# Installs and checks what this team needs on one machine: the command-line tools the kit's scripts and hooks call,
# the project's own tools (setup_extra in .agent-team/config.sh), the Claude Code plugins .claude/settings.json turns
# on, and which connectors in .mcp.json still need a variable or a sign-in. Safe to run again: it installs only what
# is missing.
#
#   scripts/agent-team/setup.sh           install what is missing (Homebrew), then report
#   scripts/agent-team/setup.sh --check   report only, change nothing; exit 1 when something is missing
#   scripts/agent-team/setup.sh --auto    what the SessionStart hook runs ("setup": true in .agent-team/team.json): the
#                                         first time on a machine it starts the install in the background; after that
#                                         it checks and prints only what is missing. Always exits 0.
#
# It never asks for a password, never accepts a licence and never writes a secret: those steps are printed as the
# exact command, marked YOU, for the owner to run.
#
# Project tools go in .agent-team/config.sh, in a setup_extra function that calls these helpers:
#   setup_tool <command> <what needs it> <brew arguments…>   present, else installed with brew, else reported missing
#   setup_missing <what> <how to get it>                      report something missing that brew cannot install
#   setup_yours <what> <the exact command>                    a step only the owner can do (password, licence, sign-in)
#   setup_ok <what>                                           report something present
#   setup_path <dir>                                          a tool is installed outside PATH: Claude sessions get it
# and these variables: SETUP_MODE (install, check or auto) and SETUP_INSTALL (1 when this run may install).
SETUP_MODE=install
case "${1:-}" in
  --check) SETUP_MODE=check ;;
  --auto) SETUP_MODE=auto ;;
  ""|--install) ;;
  *) sed -n '7,12p' "$0" | sed 's/^# \{0,1\}//'; exit 64 ;;
esac
SETUP_INSTALL=""; [ "$SETUP_MODE" = install ] && SETUP_INSTALL=1

# shellcheck source=lib.sh
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"
at_init
SELF="scripts/agent-team/setup.sh"
STAMP="$AT_HOME/setup.done"
LOG="$AT_HOME/setup.log"

# The first run on a machine installs in the background, so the session that triggered it starts at once.
if [ "$SETUP_MODE" = auto ] && [ ! -e "$STAMP" ]; then
  mkdir -p "$AT_HOME"
  # A lock left by an install that died (reboot, kill) is cleared: its pid is no longer running.
  kill -0 "$(cat "$AT_HOME/setup.running/pid" 2>/dev/null)" 2>/dev/null || rm -rf "$AT_HOME/setup.running"
  if mkdir "$AT_HOME/setup.running" 2>/dev/null; then
    ( trap 'rm -rf "$AT_HOME/setup.running"' EXIT; "$0" --install ) >"$LOG" 2>&1 </dev/null &
    echo $! >"$AT_HOME/setup.running/pid"
    echo "Setup: first run on this machine. Installing the team's tools and plugins in the background (log: $LOG). Tell the owner; when it finishes, \`$SELF --check\` shows what is left."
  else
    echo "Setup: the first-run install is still going (log: $LOG)."
  fi
  exit 0
fi

MISSING=0; YOURS=0; PATH_ADD=""
have() { command -v "$1" >/dev/null 2>&1; }
setup_ok()      { [ "$SETUP_MODE" = auto ] || echo "ok    $1"; }
setup_missing() { MISSING=$((MISSING + 1)); echo "MISS  $1${2:+: $2}"; }
setup_yours()   { YOURS=$((YOURS + 1)); echo "YOU   $1"; echo "        $2"; }
setup_note()    { [ "$SETUP_MODE" = auto ] || echo "      $1"; }
setup_path()    { case ":$PATH:$PATH_ADD:" in *":$1:"*) ;; *) PATH_ADD="${PATH_ADD:+$PATH_ADD:}$1"; PATH="$1:$PATH" ;; esac; }

BREW="$(command -v brew || true)"
for b in /opt/homebrew/bin/brew /usr/local/bin/brew /home/linuxbrew/.linuxbrew/bin/brew; do
  if [ -z "$BREW" ] && [ -x "$b" ]; then BREW="$b"; fi
done
[ -n "$BREW" ] && eval "$("$BREW" shellenv 2>/dev/null)"
export HOMEBREW_NO_ENV_HINTS=1 NONINTERACTIVE=1

# brew_get <what> <brew arguments…>: installs when this run may and brew is here.
brew_get() {
  [ -n "$SETUP_INSTALL" ] && [ -n "$BREW" ] || return 1
  echo "…     installing $1 (brew install ${*:2})"
  "$BREW" install -q "${@:2}" </dev/null >/dev/null 2>&1 || "$BREW" install "${@:2}" </dev/null 2>&1 | tail -5
  hash -r
}
setup_tool() {
  if have "$1"; then setup_ok "$1"; return 0; fi
  if brew_get "$1" "${@:3}" && have "$1"; then setup_ok "$1 (installed)"; return 0; fi
  setup_missing "$1" "$2 needs it. brew install ${*:3}"; return 1
}

# ------------------------------------------------------------------------------------------------ the kit's own tools
if [ -z "$BREW" ]; then
  setup_yours "Homebrew is not installed (it asks for your password); the installs below go through it" \
    '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
else setup_ok "brew"; fi
if [ "$(uname -s)" = Darwin ] && ! xcode-select -p >/dev/null 2>&1; then
  setup_yours "the Xcode Command Line Tools are not installed (a system dialog you accept)" "xcode-select --install"
fi
setup_tool git  "everything"                                 git
setup_tool bash "merge-gate.sh, with-lock.sh, team-board.sh" bash
setup_tool jq   "team-board.sh and merge-gate.sh"            jq
setup_tool curl "team-status.sh"                             curl
setup_tool gh   "pull requests and the task log"             gh
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$(node_major)" -ge 18 ]; then setup_ok "node $(node -v)"
elif brew_get node node && [ "$(node_major)" -ge 18 ]; then setup_ok "node $(node -v) (installed)"
else setup_missing "node 18 or later" "the hooks, the board and sync need it; found $(node -v 2>/dev/null || echo none). brew install node"; fi
setup_tool claude "the hooks and headless runs" --cask claude-code

# ------------------------------------------------------------------------------------------------ the project's tools
if declare -F setup_extra >/dev/null; then setup_extra; fi

# Tools that are installed but not on PATH: Claude sessions get them from the hook; the owner's own shell needs a line.
if [ -n "$PATH_ADD" ]; then
  line="export PATH=\"$PATH_ADD:\$PATH\""
  if [ -n "${CLAUDE_ENV_FILE:-}" ] && ! grep -qsF "$PATH_ADD" "$CLAUDE_ENV_FILE"; then echo "$line" >>"$CLAUDE_ENV_FILE"; fi
  setup_note "some tools are installed but not on PATH. Claude sessions here get them from the hook; for your own terminal add to your shell profile:"
  setup_note "  $line"
fi

# ------------------------------------------------------------------------------------------------ plugins
# A plugin that settings turn on is not downloaded by that alone, so each machine installs it once.
SETTINGS="$AT_ROOT/.claude/settings.json"
if [ -f "$SETTINGS" ] && have jq && have claude; then
  wanted="$(jq -r '(.enabledPlugins // {}) | to_entries[] | select(.value == true) | .key' "$SETTINGS" 2>/dev/null)"
  if [ -n "$wanted" ]; then
    got="$(claude plugin list --json 2>/dev/null | jq -r '.[]?.id' 2>/dev/null)"
    for id in $wanted; do
      name="${id%@*}"; mkt="${id#*@}"
      if printf '%s\n' "$got" | grep -q "^$name@"; then setup_ok "plugin $name"; continue; fi
      if [ -n "$SETUP_INSTALL" ]; then
        echo "…     installing plugin $id"
        src="$(jq -r --arg m "$mkt" '.extraKnownMarketplaces[$m].source // {} | .repo // .url // empty' "$SETTINGS")"
        if [ -n "$src" ] && ! claude plugin marketplace list --json 2>/dev/null | jq -e --arg m "$mkt" 'any(.[]?; .name == $m)' >/dev/null 2>&1; then
          (cd "$AT_ROOT" && claude plugin marketplace add "$src" </dev/null >/dev/null 2>&1)
        fi
        (cd "$AT_ROOT" && claude plugin install "$id" --scope project </dev/null >/dev/null 2>&1)
        if claude plugin list --json 2>/dev/null | jq -r '.[]?.id' | grep -q "^$name@"; then setup_ok "plugin $name (installed)"; continue; fi
      fi
      setup_missing "plugin $name" "claude plugin install $id --scope project"
    done
  fi
fi

# ------------------------------------------------------------------------------------------------ connectors
MCP="$AT_ROOT/.mcp.json"
if [ -f "$MCP" ] && have jq; then
  # A variable .mcp.json reads that is not set: reported when it has no default, or when it looks like a credential
  # (a default there is a placeholder such as "unset", and the connector fails without the real value).
  vars="$(jq -r '.mcpServers // {} | to_entries[] | .key as $s | .value | .. | strings
          | scan("\\$\\{([A-Za-z_][A-Za-z0-9_]*)(:-[^}]*)?\\}") | "\($s) \(.[0]) \(.[1] // "")"' "$MCP" 2>/dev/null | sort -u -k2,2)"
  while read -r server var default; do
    [ -n "$var" ] || continue
    if [ -n "${!var:-}" ]; then setup_ok "$var is set"; continue; fi
    case "$var" in *TOKEN|*PAT|*KEY|*SECRET|*PASSWORD) ;; *) [ -n "$default" ] && continue ;; esac
    setup_yours "$var is not set, so the $server connector cannot connect" "add it to your shell profile, then restart Claude Code:  export $var=<value>"
  done <<EOF
$vars
EOF
  # Sign-ins come from Claude Code's own health check. It starts every server, so the hook leaves it out.
  if [ "$SETUP_MODE" != auto ] && have claude; then
    state="$(cd "$AT_ROOT" && claude mcp list 2>/dev/null </dev/null)"
    pending=""
    for s in $(jq -r '.mcpServers // {} | keys[]' "$MCP"); do
      l="$(printf '%s\n' "$state" | grep -m1 "^$s: " || true)"
      case "$l" in
        *"Needs authentication"*) setup_yours "connector $s needs a sign-in (a browser step)" "in Claude Code: /mcp, then $s, then Authenticate" ;;
        *"Pending approval"*)     pending="$pending $s" ;;
        *Connected*)              setup_ok "connector $s" ;;
        "")                       setup_note "connector $s: no status from \`claude mcp list\`" ;;
        *)                        setup_note "connector $s: ${l#*- }" ;;
      esac
    done
    [ -z "$pending" ] || setup_yours "connectors waiting for approval:$pending" \
      "open the folder in Claude Code and accept the trust prompt (with \"approveMcpServers\": true in .agent-team/team.json the folder approves them all)"
  fi
fi

# ------------------------------------------------------------------------------------------------ summary
if [ "$SETUP_MODE" = install ]; then mkdir -p "$AT_HOME" && date -u +%Y-%m-%dT%H:%M:%SZ >"$STAMP"; fi
if [ $((MISSING + YOURS)) -eq 0 ]; then
  [ "$SETUP_MODE" = auto ] || echo "Setup: everything this team needs is here."
else
  echo "Setup: $MISSING missing, $YOURS for the owner to do (lines marked YOU carry the exact command)."
  if [ "$MISSING" -gt 0 ] && [ "$SETUP_MODE" != install ]; then echo "Install what is missing with: $SELF"; fi
  [ "$SETUP_MODE" = auto ] && echo "Tell the owner once, in plain words; do not run the YOU commands yourself."
fi
[ "$SETUP_MODE" = check ] && [ "$MISSING" -gt 0 ] && exit 1
exit 0
