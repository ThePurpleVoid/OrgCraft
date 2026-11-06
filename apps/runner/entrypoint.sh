#!/bin/sh
# The container's entry point. It starts as root only to set up the volume (mounted volumes come up owned by root),
# then runs the command as the runner user, with no capabilities left. Layout on the volume at /data:
#   /data/runner  the runner's own folder (0700): runner.json, the push credential's git config, repository caches
#   /data/work    what sessions may reach (2750, group agentwork): clones, homes, memory files; each session's own
#                 folder in it is 2770, made by the runner
set -eu
DATA="${AGENT_TEAM_RUNNER_DATA:-/data/runner}"
WORK="${AGENT_TEAM_RUNNER_WORK:-/data/work}"
if [ "$(id -u)" = 0 ]; then
  mkdir -p "$DATA" "$WORK"
  chown runner:runner "$DATA" && chmod 0700 "$DATA"
  chown runner:agentwork "$WORK" && chmod 2750 "$WORK"
  exec setpriv --reuid=runner --regid=runner --init-groups --inh-caps=-all -- "$@"
fi
exec "$@"
