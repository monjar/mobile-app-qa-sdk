# syntax=docker/dockerfile:1
#
# Snitch server image: the bundled server, the built dashboard, and the one
# native dependency (better-sqlite3). Build from the repository root:
#
#   docker build -f server/Dockerfile -t snitch-server .
#
# Runs as the unprivileged `node` user with all state under /data (mount a volume).

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-alpine AS base
WORKDIR /app

# ── deps: full workspace install ─────────────────────────────────────────────
# better-sqlite3 ships prebuilt musl binaries for x64 and arm64, so no compiler
# toolchain is needed; a platform without one fails here, loudly.
FROM base AS deps
COPY package.json package-lock.json ./
COPY contract/package.json contract/
COPY server/package.json server/
COPY dashboard/package.json dashboard/
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# ── build: dashboard (Vite) and server (esbuild single file) ─────────────────
FROM deps AS build
COPY tsconfig.base.json ./
COPY contract contract
COPY server server
COPY dashboard dashboard
RUN npm run build -w dashboard && npm run build -w server

# ── runtime deps: only better-sqlite3, at the exact locked version ──────────
FROM base AS prod-deps
COPY package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    VERSION=$(node -p "require('./package-lock.json').packages['node_modules/better-sqlite3'].version") \
 && echo '{"name":"snitch-runtime","private":true,"type":"module"}' > package.json \
 && npm install --omit=dev --no-audit --no-fund --no-package-lock "better-sqlite3@${VERSION}"

# ── runner ───────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS runner
ENV NODE_ENV=production \
    PORT=8080 \
    SNITCH_DATA_DIR=/data \
    SNITCH_PUBLIC_DIR=/app/public
WORKDIR /app
# libstdc++ (needed by better-sqlite3) already ships with the Node image.
RUN mkdir -p /data && chown node:node /data \
 && printf '#!/bin/sh\nexec node /app/dist/cli.js "$@"\n' > /usr/local/bin/snitch \
 && chmod +x /usr/local/bin/snitch
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/server/dist ./dist
COPY --chown=node:node --from=build /app/dashboard/dist ./public
COPY --chown=node:node server/package.json ./package.json
USER node
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# The server handles SIGTERM/SIGINT itself (graceful drain), so it can be PID 1.
CMD ["node", "dist/index.js"]
