# syntax=docker/dockerfile:1

# Both images are Debian trixie, so the Node binary runs on the apprise base as-is.
ARG NODE_IMAGE=node:24-trixie-slim
ARG APPRISE_IMAGE=caronc/apprise:2.2.0

# --- build the server and web UI ---
# The output is plain JavaScript, so build once on the native platform even for multi-arch images.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY server ./server
COPY web ./web
RUN npm run build && npm prune --omit=dev

# --- runtime: apprise-api (nginx + gunicorn under supervisord) plus our Node app ---
FROM ${NODE_IMAGE} AS node
FROM ${APPRISE_IMAGE}
ARG VERSION=dev

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=build /app/package.json /app/
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/dist /app/dist

# Run the monitor as one more supervisord program, next to apprise-api's own.
# supervisord drops to the PUID/PGID user (default 1000) for all programs.
RUN cat >> /opt/apprise/webapp/etc/supervisord.conf <<'EOF'

[program:plex-visibility]
command=/usr/local/bin/node /app/dist/server/index.js
directory=/app
autorestart=true
startsecs=3
startretries=100
stopwaitsecs=15
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
EOF

ENV \
    # apprise-api is internal only: listen on loopback, not on the network.
    HTTP_PORT=127.0.0.1:8000 \
    IPV4_ONLY=1 \
    # The web UI and API.
    PORT=8080 \
    DATA_DIR=/config/plex-visibility \
    NODE_ENV=production \
    APP_VERSION=${VERSION}

LABEL org.opencontainers.image.title="plex-visibility" \
      org.opencontainers.image.description="Monitors Plex Media Server remote access and alerts when it is not reachable" \
      org.opencontainers.image.source="https://github.com/lanceheld/plex-visibility"

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD curl -fsS http://127.0.0.1:8080/healthz >/dev/null || exit 1
