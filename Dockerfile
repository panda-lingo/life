# syntax=docker/dockerfile:1.7

# Build stage: only used to normalize/static-lint. No build step today, but
# keeping a stage makes it easy to add a bundler or asset hash injection later.
FROM --platform=$BUILDPLATFORM node:24-alpine AS builder

WORKDIR /build
ARG TARGETOS
ARG TARGETARCH

# Static validation only — no bundling. We copy sources so the final runtime
# layer is a clean copy without any node_modules / git noise.
COPY . .

RUN --mount=type=cache,target=/root/.npm \
    node --check server/server.js && \
    node --check server/api.js && \
    node --check server/config.js && \
    node --check server/eventStore.js && \
    node --check server/httpLog.js && \
    node --check src/engine/engine.js && \
    node --check src/game/loop.js && \
    node --check src/ai/director.js && \
    node --check src/ai/provider.js && \
    node --check src/ai/openaiProvider.js && \
    node --check src/ai/mockProvider.js && \
    node --check src/data/eventlog.js && \
    node --check src/data/learnerModel.js && \
    node --check src/data/analytics.js && \
    node --check src/net/backend.js && \
    node --check src/speech/speech.js && \
    node --check src/ui/hud.js && \
    node --check src/engine/props.js && \
    node --check src/gmaps/maps.js && \
    node --check scenarios/scenarios.js && \
    python3 -m json.tool assets/kits/manifest.json > /dev/null || \
    node -e 'JSON.parse(require("fs").readFileSync("assets/kits/manifest.json","utf8"))'

# Runtime stage: zero-dependency Node 24 runtime.
# One process serves the game (statics) + /api/* backend. Secrets
# (IMAGE_TEXT_*, GOOGLE_MAPS_*) live ONLY on this process; the browser
# talks to it via same-origin /api/*. See docs/architecture.md
# "Backend boundary".
FROM node:24-alpine

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data

# Copy only what the server needs (statics + backend). The builder stage's
# syntax check has already validated the rest of the tree.
COPY --from=builder /build/index.html ./index.html
COPY --from=builder /build/src ./src
COPY --from=builder /build/assets ./assets
COPY --from=builder /build/scenarios ./scenarios
COPY --from=builder /build/README.md ./README.md
COPY --from=builder /build/server ./server

# Persistent user data lives outside the image; mount a volume here in prod.
RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8080/api/healthz || exit 1

CMD ["node", "server/server.js"]
