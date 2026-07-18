# Readerr — single image: Go backend serving the built static frontend on
# one origin (no CORS, no separate web server needed).
#
# Multi-arch friendly: the frontend build and Go compile both run on the
# BUILD platform and cross-compile to the TARGET, so `buildx` can emit
# linux/amd64 + linux/arm64 without QEMU-emulating node or go (the
# modernc.org/sqlite driver is pure Go, so CGO stays off).

# --- build the static frontend (arch-independent output)
FROM --platform=$BUILDPLATFORM node:22-alpine AS frontend
WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# --- build the backend (pure-Go sqlite driver, no cgo)
FROM --platform=$BUILDPLATFORM golang:1.25-alpine AS backend
ARG TARGETOS TARGETARCH
WORKDIR /app
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} \
    go build -trimpath -ldflags="-s -w" -o /readerr .

# --- final image
FROM alpine:3.20
WORKDIR /srv
# curl is only for the compose healthcheck; drop it if you don't use one.
RUN apk add --no-cache curl
COPY --from=backend /readerr /usr/local/bin/readerr
COPY --from=frontend /app/dist /srv/public
ENV DB_PATH=/data/readerr.db \
    STATIC_DIR=/srv/public \
    PORT=8080
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -fsS "http://localhost:${PORT}/healthz" || exit 1
CMD ["readerr"]
