# readerr

Local-first reading list + notes manager. Replaces a weekly-markdown-file
Obsidian workflow: dump links fast, read them, keep notes/excerpts per link
and long-form documents per topic.

Same architecture as `workoutt`: the app lives entirely in the browser
(Astro MPA + Svelte 5 islands over IndexedDB, installable PWA, fully
offline); a small Go + SQLite backend is an optional sync target and
title-resolver, not a source of truth.

## Layout

- `frontend/` — Astro 7 + Svelte 5. IndexedDB (via `idb`) is the primary
  store. Milkdown Crepe editor (markdown in, markdown out) with a
  CodeMirror source-mode bailout.
- `backend/` — Go 1.25, stdlib HTTP + `modernc.org/sqlite` (no cgo).
  Endpoints: `POST /sync/push`, `GET /sync/pull?since=`, `GET /backup`,
  `GET /title?url=` (fetches page titles the browser can't, due to CORS),
  `GET /healthz`, plus static serving of the built frontend via `STATIC_DIR`.

The schema lives in three lockstep places: `backend/sql/schema.sql`
(canonical), the `tables` map in `backend/sync.go`, and
`frontend/src/lib/db/types.ts`. Change one, change all three. Frontend
IndexedDB migrations are append-only in `frontend/src/lib/db/db.ts`.

## Dev

```sh
cd backend && go run .          # :8080, creates readerr.db
cd frontend && npm run dev      # :4321
```

Point the app at the backend in Settings → Sync server URL
(`http://localhost:8080`). In production (Docker) the frontend is served by
the backend on one origin and the sync URL stays blank.

## Deploy

```sh
docker compose up --build       # :8080, data on the readerr-data volume
```
