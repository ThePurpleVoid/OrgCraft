#!/bin/sh
# The real-wire test, as one command on the owner's Mac (plans/setup-day/sandbox-repo.md first):
#
#   scripts/real-wire.sh <installation id>            the real run on ThePurpleVoid/orgcraft-sandbox
#   scripts/real-wire.sh --fake                       the same harness here: fake GitHub, stubbed model, no cost
#
# It builds the runner image from this checkout (skip with REAL_WIRE_NO_BUILD=1), starts its own control plane on
# port 4859 (your usual one on 4849 and your runner keep running), a runner container named orgcraft-real-wire with
# the keys in ~/.agent-team/sandbox-secrets, runs two tiny tasks under a $0.50 daily cap, asks for your step-up
# passphrase twice (setup, then the merge), writes a pass/fail table to evidence/real-wire/ and removes everything
# it started. It refuses any repository but ThePurpleVoid/orgcraft-sandbox. Needs ANTHROPIC_API_KEY in this shell.
set -eu
cd "$(dirname "$0")/.."
fail() { echo "real-wire: $*" >&2; exit 2; }
command -v node >/dev/null || fail "node is not installed"
[ -d apps/server/node_modules ] || fail "run: npm ci --prefix apps/server"
if [ "${1:-}" = "--fake" ]; then
  [ -d apps/runner/node_modules ] || fail "run: npm ci --prefix apps/runner"
  exec node tools/real-wire/run.mjs --fake
fi
INSTALLATION="${1:-}"
case "$INSTALLATION" in ''|*[!0-9]*) fail "usage: scripts/real-wire.sh <the merger app's installation id on orgcraft-sandbox>";; esac
SECRETS="${REAL_WIRE_SECRETS:-$HOME/.agent-team/sandbox-secrets}"
for f in runner-deploy-key readonly-deploy-key merger-app.pem; do
  [ -f "$SECRETS/$f" ] || fail "missing $SECRETS/$f (plans/setup-day/sandbox-repo.md)"
done
[ -f "$HOME/.agent-team/step-up.hash" ] || fail "missing ~/.agent-team/step-up.hash (your step-up passphrase's hash)"
[ -n "${ANTHROPIC_API_KEY:-}" ] || fail "ANTHROPIC_API_KEY is not set in this shell"
command -v docker >/dev/null || fail "docker is not installed"
docker info >/dev/null 2>&1 || fail "Docker is not running (open Docker Desktop)"
if [ -z "${REAL_WIRE_NO_BUILD:-}" ]; then
  echo "real-wire: building the runner image from this checkout"
  docker build -q -f apps/runner/Dockerfile -t agent-team-runner . >/dev/null
fi
exec node tools/real-wire/run.mjs --installation "$INSTALLATION" --secrets "$SECRETS" --port "${REAL_WIRE_PORT:-4859}"
