# The control plane image (apps/server): the /v1 API, live streams, the runner socket, the sink worker and timers.
# One image for every host: Fly.io, Render, Railway, Compose, Kubernetes. Build from the repository root:
#   docker build -f deploy/server/Dockerfile -t agent-team-server .
# Configuration is the environment only (deploy/env/server.env.example). Nothing secret is baked in.
FROM node:22-bookworm-slim

ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
WORKDIR /app

COPY apps/server/package.json apps/server/package-lock.json apps/server/
RUN npm ci --omit=dev --prefix apps/server && npm cache clean --force

# The server imports the event envelope package and the board summariser by relative path.
COPY packages/events/ packages/events/
COPY tools/board.mjs tools/board.mjs
COPY apps/server/ apps/server/
COPY deploy/server/ deploy/server/

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Migrations run before start (deploy/server/migrate.mjs refuses destructive ones without ALLOW_DESTRUCTIVE=1). Hosts
# with a release step (Fly's release_command) run the same script there, so a failed migration never takes traffic.
CMD ["sh", "-c", "node deploy/server/migrate.mjs && exec node apps/server/bin.mjs"]
