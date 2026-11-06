# The control plane image (apps/server): the /v1 API, live streams, the runner socket, the sink worker and timers.
# One image for every host: Fly.io, Render, Railway, Compose, Kubernetes. Build from the repository root:
#   docker build -f deploy/server/Dockerfile -t agent-team-server .
# Configuration is the environment only (deploy/env/server.env.example). Nothing secret is baked in.
FROM node:22-bookworm-slim

ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
WORKDIR /app

COPY apps/server/package.json apps/server/package-lock.json apps/server/
RUN npm ci --omit=dev --ignore-scripts --prefix apps/server && npm cache clean --force

# The server imports the event envelope package, the board summariser and, for the deployment's own Studio page
# (apps/server/studio.mjs), the Studio handler, which plans a publish by running sync from the kit. So the image
# carries the kit's published files (package.json "files"): the same set a host gets from npm. Sign-in checks a
# return path with the Studio's own safeReturn (apps/studio/public/auth.js); the root package.json makes it all ES
# modules.
COPY package.json package.json
COPY apps/studio/ apps/studio/
COPY bin/ bin/
COPY packages/events/ packages/events/
COPY packages/model-prices/ packages/model-prices/
COPY packages/team-model/ packages/team-model/
COPY presets/ presets/
COPY scripts/ scripts/
COPY team/ team/
COPY templates/ templates/
COPY tools/ tools/
COPY apps/server/ apps/server/
COPY deploy/server/ deploy/server/
COPY deploy/supabase/prod-ca-2021.crt deploy/supabase/prod-ca-2021.crt

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Migrations run before start (deploy/server/migrate.mjs refuses destructive ones without ALLOW_DESTRUCTIVE=1). Hosts
# with a release step (Fly's release_command) run the same script there, so a failed migration never takes traffic.
CMD ["sh", "-c", "node deploy/server/migrate.mjs && exec node apps/server/bin.mjs"]
