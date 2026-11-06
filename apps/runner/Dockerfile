# The supported way to run the runner: in a container, as its own user, with nothing else of the host's in reach.
# Sessions run inside it; the runner key and the model key are in the runner's environment only (sessions reach the
# model through the runner's loopback proxy). Build from the repository root:
#   docker build -f apps/runner/Dockerfile -t agent-team-runner .
#   docker run -e AGENT_TEAM_SERVER=https://… -e AGENT_TEAM_RUNNER_KEY=… -e ANTHROPIC_API_KEY=… \
#     -v runner-data:/data agent-team-runner
# Push credential: mount a git config with a credential helper for a token that can push branches only (never the
# default branch), and point AGENT_TEAM_RUNNER_GITCONFIG at it.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates openssh-client && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 10001 runner && mkdir -p /data && chown runner /data
WORKDIR /app
COPY packages/events/ packages/events/
COPY apps/runner/package.json apps/runner/package-lock.json apps/runner/
RUN npm ci --omit=dev --prefix apps/runner
COPY apps/runner/ apps/runner/
USER runner
ENV AGENT_TEAM_RUNNER_DATA=/data NODE_ENV=production
ENTRYPOINT ["node", "apps/runner/bin.mjs", "start"]
