# Readerr — single image: Go backend serving the built static frontend on
# one origin (no CORS, no separate web server needed).

# --- build the static frontend
FROM node:22-alpine AS frontend
WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# --- build the backend (pure-Go sqlite driver, no cgo)
FROM golang:1.25-alpine AS backend
WORKDIR /app
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 go build -o /readerr .

# --- final image
FROM alpine:3.20
WORKDIR /srv
COPY --from=backend /readerr /usr/local/bin/readerr
COPY --from=frontend /app/dist /srv/public
ENV DB_PATH=/data/readerr.db \
    STATIC_DIR=/srv/public \
    PORT=8080
VOLUME /data
EXPOSE 8080
CMD ["readerr"]
