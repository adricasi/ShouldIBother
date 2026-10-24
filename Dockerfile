# syntax=docker/dockerfile:1
#
# Production image for hosted mode (REQ-032, NFR-013; docs/deploy-digitalocean.md).
#
# The app runs from the compiled output: `node dist/cli.js start` (the `sib` command inside the
# image). Nothing in the image uses tsx. better-sqlite3 and sharp ship prebuilt binaries for
# linux x64/arm64 (glibc) in their packages, so no compiler is installed; the smoke test below
# fails the build if either one cannot load. Build it for the Droplet's architecture:
#
#   docker build --platform linux/amd64 -t sib:<tag> .
#
# Both base images are pinned by the digest of the multi-arch index. To refresh a digest:
#   docker buildx imagetools inspect node:24.22.1-trixie-slim   (the "Digest:" line)
# Looked up on 2026-10-24; re-check it (and the tag's newer patch releases) before you build.
ARG NODE_IMAGE=node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea

# --- build: dev dependencies, compile the server (tsc) and the SPA (vite) into dist/ ---------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json vite.config.ts ./
COPY src ./src
# src/web/styles.css imports the design tokens from docs/design.
COPY docs/design/tokens.css ./docs/design/tokens.css
RUN npm run build

# --- deps: production dependencies only, installed for the runtime's OS and architecture ------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
 && npm cache clean --force

# --- runtime ------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

# git: the data-folder guard (src/backtest/output-guard.ts) runs `git rev-parse` on the data
# folder at every start and refuses to run when git is missing. It finds no repository in /data.
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 sib \
 && useradd --uid 10001 --gid sib --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin sib \
 && install -d -o sib -g sib -m 0700 /data \
 && printf '#!/bin/sh\nexec node /app/dist/cli.js "$@"\n' > /usr/local/bin/sib \
 && chmod 0755 /usr/local/bin/sib

WORKDIR /app
# Code and config are root-owned and read-only for the app user.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY config ./config
COPY prompts ./prompts

# Fail the build now, not at 03:00 on the Droplet, if a native module does not load.
RUN node -e "const D=require('better-sqlite3'); new D(':memory:').close(); require('sharp'); console.log('native modules load')"

ENV NODE_ENV=production \
    SIB_DATA_DIR=/data \
    SIB_PORT=8787 \
    HOME=/tmp

USER 10001:10001
EXPOSE 8787

# No curl in the slim image: node's fetch. `/healthz` answers 204 only to 127.0.0.1 in hosted
# mode (AC-032.7). Exit 0 on any 2xx.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.SIB_PORT||8787)+'/healthz',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# SIGTERM is handled by `sib start` (clean shutdown); compose adds an init for zombie reaping.
CMD ["node", "dist/cli.js", "start"]
