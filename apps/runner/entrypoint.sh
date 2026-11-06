#!/bin/sh
# The container's entry point. It starts as root only to set up the volume (mounted volumes come up owned by root),
# then runs the command as the runner user, with no capabilities left. Layout on the volume at /data:
#   /data/runner  the runner's own folder (0700): runner.json, the push credential (deploy-key, gitconfig), the
#                 merger app's key, repository caches
#   /data/work    what sessions may reach (2750, group agentwork): clones, homes, memory files; each session's own
#                 folder in it is 2770, made by the runner
set -eu
DATA="${AGENT_TEAM_RUNNER_DATA:-/data/runner}"
WORK="${AGENT_TEAM_RUNNER_WORK:-/data/work}"
if [ "$(id -u)" = 0 ]; then
  mkdir -p "$DATA" "$WORK"
  chown runner:runner "$DATA" && chmod 0700 "$DATA"
  chown runner:agentwork "$WORK" && chmod 2750 "$WORK"
  # Keys mounted read-only at /run/agent-team (M3 on a Mac: -v ~/.agent-team/runner-secrets:/run/agent-team:ro) are
  # copied into the runner's own folder, owned by it and 0600, so ssh accepts them and sessions cannot read them.
  SECRETS="${AGENT_TEAM_RUNNER_SECRETS:-/run/agent-team}"
  if [ -f "$SECRETS/runner-deploy-key" ]; then
    install -o runner -g runner -m 0600 "$SECRETS/runner-deploy-key" "$DATA/deploy-key"
    # Push over ssh with the deploy key, checking GitHub's published host key (never trust on first use). Written
    # only when no git config of the owner's own is in place.
    if [ -z "${AGENT_TEAM_RUNNER_GITCONFIG:-}" ]; then
      (umask 077; printf '[core]\n\tsshCommand = ssh -i %s/deploy-key -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/app/apps/runner/known_hosts\n[url "git@github.com:"]\n\tinsteadOf = https://github.com/\n' "$DATA" > "$DATA/gitconfig")
      chown runner:runner "$DATA/gitconfig"
    fi
  fi
  if [ -f "$SECRETS/merger-app.pem" ]; then
    install -o runner -g runner -m 0600 "$SECRETS/merger-app.pem" "$DATA/merger-app.pem"
  fi
  exec setpriv --reuid=runner --regid=runner --init-groups --inh-caps=-all -- env HOME=/home/runner "$@"
fi
exec "$@"
