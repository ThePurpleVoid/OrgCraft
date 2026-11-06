# The runner image (data plane): Agent SDK sessions in git worktrees, connecting outbound to the control plane.
# DRAFT until apps/runner lands (M3, ai-engineer): the entry point and environment are confirmed then.
#   docker build -f deploy/runner/Dockerfile -t agent-team-runner .
# Worktrees and checkouts live on the volume at /data, so a restart resumes instead of re-cloning.
FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates jq \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production AGENT_TEAM_DATA=/data
WORKDIR /app

COPY apps/runner/package.json apps/runner/package-lock.json apps/runner/
RUN npm ci --omit=dev --prefix apps/runner && npm cache clean --force
COPY packages/ packages/
COPY tools/ tools/
COPY apps/runner/ apps/runner/

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
CMD ["node", "apps/runner/bin.mjs"]
