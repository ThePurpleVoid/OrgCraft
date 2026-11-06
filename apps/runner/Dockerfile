# The supported way to run the runner: in a container, the runner as one user and every session as another.
# The runner key and the model key are in the runner's environment only; sessions run as `agent`, which cannot read
# the runner's process environment or its data folder (/data, 0700: the runner key file, the push credential, the
# repository caches). Sessions reach the model through the runner's loopback proxy, with a token of their own.
# Build from the repository root:
#   docker build -f apps/runner/Dockerfile -t agent-team-runner .
#   docker run -e AGENT_TEAM_SERVER=https://… -e AGENT_TEAM_RUNNER_KEY=… -e ANTHROPIC_API_KEY=… \
#     -v runner-data:/data -v runner-work:/work agent-team-runner
# Push credential: mount a git config with a credential helper for a token that can push branches only (never the
# default branch), and point AGENT_TEAM_RUNNER_GITCONFIG at it (inside /data).
# The switch to `agent` uses a copy of setpriv that only the runner's group can run, carrying only the capabilities
# to change uid and gid. Do not run the container with no-new-privileges: that disables those file capabilities,
# and sessions then fail to start (closed, not open).
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates openssh-client util-linux libcap2-bin \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10010 agentwork \
  && useradd --create-home --uid 10001 --user-group --groups agentwork runner \
  && useradd --no-create-home --uid 10002 --gid 10010 --shell /usr/sbin/nologin --home-dir /nonexistent agent \
  && mkdir -p /data /work /usr/local/libexec/agent-team \
  && chown runner:runner /data && chmod 0700 /data \
  && chown runner:agentwork /work && chmod 2750 /work \
  && cp /usr/bin/setpriv /usr/local/libexec/agent-team/setpriv \
  && chown root:runner /usr/local/libexec/agent-team/setpriv && chmod 0750 /usr/local/libexec/agent-team/setpriv \
  && setcap cap_setuid,cap_setgid+ep /usr/local/libexec/agent-team/setpriv \
  && apt-get purge -y libcap2-bin && apt-get autoremove -y
WORKDIR /app
COPY packages/events/ packages/events/
COPY apps/runner/package.json apps/runner/package-lock.json apps/runner/
RUN npm ci --omit=dev --prefix apps/runner
COPY apps/runner/ apps/runner/
USER runner
ENV AGENT_TEAM_RUNNER_DATA=/data AGENT_TEAM_RUNNER_WORK=/work NODE_ENV=production \
    AGENT_TEAM_SANDBOX_UID=10002 AGENT_TEAM_SANDBOX_GID=10010 AGENT_TEAM_SANDBOX_EXEC=/usr/local/libexec/agent-team/setpriv
ENTRYPOINT ["node", "apps/runner/bin.mjs", "start"]
