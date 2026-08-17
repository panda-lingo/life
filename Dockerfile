# syntax=docker/dockerfile:1.7

# Build stage: only used to normalize/static-lint. No build step today, but
# keeping a stage makes it easy to add a bundler or asset hash injection later.
FROM --platform=$BUILDPLATFORM node:24-alpine AS builder

WORKDIR /build
ARG TARGETOS
ARG TARGETARCH

# Static validation only — no bundling. We copy sources so the final nginx
# layer is a clean copy without any node_modules / git noise.
COPY . .

RUN --mount=type=cache,target=/root/.npm \
    node --check src/engine/engine.js && \
    node --check src/game/loop.js && \
    node --check src/ai/director.js && \
    node --check src/ai/provider.js && \
    node --check src/ai/mockProvider.js && \
    node --check src/data/eventlog.js && \
    node --check src/data/learnerModel.js && \
    node --check src/data/analytics.js && \
    node --check src/speech/speech.js && \
    node --check src/ui/hud.js && \
    node --check src/engine/props.js && \
    node --check scenarios/scenarios.js && \
    python3 -m json.tool assets/kits/manifest.json > /dev/null || \
    node -e 'JSON.parse(require("fs").readFileSync("assets/kits/manifest.json","utf8"))'

# Runtime stage
FROM nginx:1.27-alpine

WORKDIR /usr/share/nginx/html

# Clean default nginx content and copy the game
RUN rm -rf /usr/share/nginx/html/*

COPY --from=builder /build/index.html ./
COPY --from=builder /build/src ./src
COPY --from=builder /build/assets ./assets
COPY --from=builder /build/scenarios ./scenarios
COPY --from=builder /build/README.md ./

# Replace default nginx config: SPA-friendly fallback + gzip + correct MIME
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

# Non-root nginx setup
RUN touch /var/run/nginx.pid && \
    chown -R nginx:nginx /var/run/nginx.pid /var/cache/nginx /var/log/nginx

USER nginx

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8080/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
