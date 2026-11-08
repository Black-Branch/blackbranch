# The Discord bridge: Out Of Your Element (OOYE), a Discord <-> Matrix application service.
# Upstream publishes no image, so the bundle builds this one on the box (compose service `ooye`,
# profile `discord`). OOYE is AGPL-3.0-or-later: its source is the tag below, unchanged, and its
# licence (COPYING) stays in the image (docs/public/licences.md).
#
# OOYE keeps everything it owns in its WORKING DIRECTORY: registration.yaml and ooye.db (SQLite).
# So the code lives in /opt/ooye and the working directory is /data, the bridge-data volume, owned
# by `node` (uid 1000), the user the container runs as. The registration is the renderer's
# (/config, read-only): entrypoint.js links it into /data and never writes it, and keeps OOYE
# started through an outage outside the box instead of letting the container crash-loop.
#
# Both base images are pinned by digest here, not at the release cut: the release's pin check reads
# compose.yaml and install/Dockerfile only, and `node:22-alpine` moves.
FROM node:22.23.4-alpine3.24@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS build
ARG OOYE_REPO=https://gitdab.com/cadence/out-of-your-element.git
# Upstream tags are vX.Y (package.json says 3.7.0; the tag is v3.7).
ARG OOYE_REF=v3.7
# The tag's commit: a tag moved upstream fails the build instead of changing what is built.
ARG OOYE_COMMIT=2430d60809f6fb914258a64ba07c735831c729b0
# git for the clone; the compiler only for a native module with no prebuilt binary for musl.
RUN apk add --no-cache git python3 make g++
RUN git clone --depth 1 --branch "$OOYE_REF" "$OOYE_REPO" /opt/ooye \
 && actual="$(git -C /opt/ooye rev-parse HEAD)" \
 && if [ "$actual" != "$OOYE_COMMIT" ]; then echo "OOYE $OOYE_REF is commit $actual, not $OOYE_COMMIT: refusing to build" >&2; exit 1; fi \
 && rm -rf /opt/ooye/.git
WORKDIR /opt/ooye
# Production dependencies only. test/ stays: src/stdin.js requires test/data at start.
RUN npm ci --omit=dev --no-audit --no-fund --loglevel=error && npm cache clean --force

FROM node:22.23.4-alpine3.24@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
LABEL org.opencontainers.image.title="Out Of Your Element (Black Branch build)" \
      org.opencontainers.image.source="https://gitdab.com/cadence/out-of-your-element" \
      org.opencontainers.image.version="3.7.0" \
      org.opencontainers.image.revision="2430d60809f6fb914258a64ba07c735831c729b0" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"
COPY --from=build /opt/ooye /opt/ooye
# The bundle's files beside OOYE (never inside its tree): the first process, setup's non-Discord
# half, the host's reader of what the bridge has linked (links.js), the panel's link calls (link.js),
# and its reads of Discord itself (discord-read.js: the bot, and one server for the import).
COPY entrypoint.js init.js links.js link.js discord-read.js /opt/blackbranch-ooye/
# A new bridge-data volume takes this directory's owner on its first mount.
RUN mkdir -p /data && chown node:node /data
USER node
WORKDIR /data
VOLUME /data
# One port: the application service Synapse pushes to, and the bridge's web page (caddy, /bridge/).
EXPOSE 6693
CMD ["node", "/opt/blackbranch-ooye/entrypoint.js"]
