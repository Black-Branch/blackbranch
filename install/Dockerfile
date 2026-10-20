# syntax=docker/dockerfile:1
# The bundle's images (context = the release root). Four targets: backup (restic, Postgres 18's
# tools and node — install/backup/run.sh), stream-api and stream-ingest, built on the box from the
# release's source; and web — the site, the same image for every install: a published release
# names it by digest and the box pulls it (tools/release.mjs image + cut); only a checkout builds it
# on the box.
# Base images are pinned by tag here; a release pins them by digest.
ARG NODE_IMAGE=node:26.11.1-trixie-slim

FROM ${NODE_IMAGE} AS base
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /app

# ── backup ──────────────────────────────────────────────────────────────────────────────────
# Kept ahead of the app stages: a builder without BuildKit builds every stage before its target.
# The Postgres image is the database's own, so pg_dump/pg_restore match the server, and its server
# binaries run the scratch database `restore --verify` loads a snapshot into. restic is one static
# binary; node (with libatomic, which the official build needs) judges the restored copy; ssh is
# for an SFTP target. The scripts are not baked in: run.sh is mounted from the release.
FROM restic/restic:0.19.1 AS restic
FROM pgvector/pgvector:pg18 AS backup
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client libatomic1 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=restic /usr/bin/restic /usr/local/bin/restic
COPY --from=base /usr/local/bin/node /usr/local/bin/node
ENTRYPOINT ["bash", "/bb-backup/run.sh"]

# ── stream-api ──────────────────────────────────────────────────────────────────────────────
FROM base AS stream-api
COPY stream-api/package.json stream-api/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --loglevel=error
COPY stream-api/ ./
COPY LICENSE /app/LICENSE
# /data: the media volume (TTS scratch and clips). Created here so a new volume inherits the owner.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3001
CMD ["node", "index.js"]

# ── stream-ingest ───────────────────────────────────────────────────────────────────────────
# Playwright's browser is not downloaded: only the Kick and YouTube readers use it, and a fresh
# install reads no platform until its setup pages switch one on.
FROM base AS stream-ingest
COPY stream-ingest/package.json stream-ingest/package-lock.json ./
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev --no-audit --no-fund --loglevel=error
COPY stream-ingest/ ./
COPY LICENSE /app/LICENSE
USER node
CMD ["node", "index.js"]

# ── web ─────────────────────────────────────────────────────────────────────────────────────
# The site, built ONCE for every install: `next build` runs here with
# no install value at all — the site's name, origins, legal details and the rest are read from the
# container's environment when the server starts (web/app/lib/installValues.ts), and every page is
# rendered at request time. So a published release pulls this one image by digest, and the box
# never builds the site (a ~3 GB build does not fit a 4 GB box). The fonts are in the
# repo: `next build` fetches nothing. An install's own files (its icons, its points icon) are not in
# the image — compose mounts the box's site-files/ at public/site-files.
FROM base AS web-build
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN NODE_ENV=development npm ci --no-audit --no-fund --loglevel=error
COPY web/ ./
# The gates (`npm run build` = check:all + next build) are the release's CI, not the image's.
RUN npx --no-install next build \
 && test -f .next/standalone/server.js \
 && rm -rf .next/standalone/.next/cache

FROM base AS web
WORKDIR /app
COPY --from=web-build /src/web/.next/standalone ./
COPY --from=web-build /src/web/.next/static ./.next/static
COPY --from=web-build /src/web/public ./public
# The licence travels with the code (AGPL-3.0; the release copy puts it at the context's root).
COPY LICENSE /app/LICENSE
# The server's own cache (a volume in compose), and the mount point for the install's own files.
RUN mkdir -p .next/cache public/site-files && chown node:node .next/cache
USER node
EXPOSE 3000
CMD ["node", "server.js"]
