# readerr

A **local-first reading list + notes manager**. Dump links in fast, read
them on your own schedule, and keep what you learned — notes and quotes per
link, long-form documents per topic.

Everything lives in your browser (IndexedDB), works fully offline, and
installs as a PWA. A small Go + SQLite backend is an *optional* sync target
and backup — never a requirement: delete the server and you lose nothing but
sync.

**Docs:** [user guide](docs/user/README.md) · [developer/maintainer docs](docs/dev/architecture.md).

## What it does

- **Capture at paste speed** — one URL per line, bullet lists, or
  `[title](url)` markdown; duplicates are detected and merged, page titles
  resolve themselves, tracking params can be stripped automatically.
- **A per-line mini-DSL** for batch pastes:
  `https://… !tags=[rust, os] !week=1 !favourite` tags, schedules, and flags
  each line individually — with autocomplete as you type
  ([capturing links](docs/user/capturing-links.md)).
- **Weekly reading flow** — pick links into a reading week, mark them read,
  and close the week: what you wrote about stays *read*, the rest slushes or
  rolls back to the backlog. Plans can automate quotas and focus tags.
- **Notes that are yours** — an Obsidian-style live markdown editor
  (with a source-mode bailout); markdown is the storage format, so exporting
  everything to plain `.md` files is one click.
- **Organization** — tags, long-form topics, favourites, resources and
  resource lists (exportable to md/txt/csv/JSON/themed HTML), bulk
  operations, per-link priorities.
- **Longevity** — multi-device sync with conflict options, JSON backups,
  yearly archival to keep a decade of links fast, custom themes, stats.

## Quick start (users)

### Option A — full setup with sync (recommended)

One Docker container serves the app and the sync backend on one origin. Using
the prebuilt image from GHCR:

```sh
docker compose up -d             # app at http://localhost:8080
```

The database is stored as a real file at **`./data/readerr.db` on the host**
(a bind mount you can back up or copy out). Open the app, walk through
onboarding (or hit *Start from scratch*), and you're in — the sync URL stays
blank because app and backend share an origin.

To build from source instead of pulling:
`docker compose -f docker-compose.build.yml up --build`. Full deployment
guide (ports, volumes, backups, CI images, HTTPS): **[docs/dev/deployment.md](docs/dev/deployment.md)**.

**Adding a second device:** open the same URL, choose
**Sync from existing server** on the onboarding screen, and everything pulls
down. See [Sync & backups](docs/user/sync-and-backups.md) for multi-device
setup, running your own server, conflict options, and backups.

### Option B — no server at all

readerr is fully functional offline-only: host `frontend/dist/` on any
static host (or just run the container and never configure sync elsewhere),
choose offline mode in onboarding, and use JSON/markdown exports as your
backup strategy. Install it as a PWA for offline loading and durable
storage. How it degrades offline is in
[docs/dev/offline-support.md](docs/dev/offline-support.md).

### First-run tips

- The **Reading List** (home) is your current week; the **Backlog** is where
  new links wait. The ＋ button in the corner captures from any page.
- Onboarding can be revisited anytime at `/onboarding` (steps deep-link via
  `?page=N`), and it can also restore from a backup file.
- Settings has everything else: themes, backups, sync, archival, demo data.

Full **[user guide](docs/user/README.md)** — capturing, the reading flow,
organizing, syncing, and common gotchas.

## Quick start (developers)

```sh
# backend — :8080, creates readerr.db on first run
cd backend && go run .

# frontend dev server — :4321 (or --port of your choice)
cd frontend && npm install && npm run dev

# tests (vitest + fake-indexeddb)
cd frontend && npm test

# production build (static site the Go server can serve via STATIC_DIR)
cd frontend && npm run build
```

Point the dev app at the backend in **Settings → Sync server URL**
(`http://localhost:8080`). In production the backend serves the built
frontend, so the URL stays blank.

### Documentation

Maintainer docs live in **[`docs/dev/`](docs/dev/architecture.md)**; start
with the architecture overview — it has a "where to look when…" table.

| Doc | What's in it |
|---|---|
| [docs/dev/architecture.md](docs/dev/architecture.md) | the map: layers, repo layout, patterns, dev workflow |
| [docs/dev/data-model.md](docs/dev/data-model.md) | every entity, IndexedDB ↔ SQLite mapping, migrations |
| [docs/dev/sync.md](docs/dev/sync.md) | the sync model + the wire protocol |
| [docs/dev/link-dsl.md](docs/dev/link-dsl.md) | the capture DSL grammar, semantics, and autocomplete internals |
| [docs/dev/offline-support.md](docs/dev/offline-support.md) | service worker, PWA, storage durability, degradation |
| [docs/dev/deployment.md](docs/dev/deployment.md) | Docker image, compose, volumes/backups, CI, HTTPS |

Design notes and working task lists live in
[`docs/dev/experiments & plans/`](docs/dev/experiments%20%26%20plans/).
End-user guides are in [`docs/user/`](docs/user/README.md).

### Layout

- `frontend/` — Astro 7 MPA + Svelte 5 islands over IndexedDB (via `idb`).
  Milkdown Crepe editor (markdown in, markdown out) with a CodeMirror
  source-mode bailout. Tests in `frontend/test/`.
- `backend/` — Go 1.25, stdlib HTTP + `modernc.org/sqlite` (no cgo).
  Sync (`/sync/push`, `/sync/pull`), backups (`/backup`), page-title
  resolution (`/title`), health/stats endpoints, and static serving of the
  built frontend via `STATIC_DIR`.

One rule to know before changing the schema: it lives in **three lockstep
places** — `backend/sql/schema.sql` (canonical), the `tables` map in
`backend/sync.go`, and `frontend/src/lib/db/types.ts` — plus append-only
migrations on both sides. Change one, change all. The full checklist is in
[docs/dev/data-model.md](docs/dev/data-model.md).

## Deploy

```sh
docker compose up -d             # published image, :8080, DB in ./data on the host
```

CI ([.github/workflows/docker.yaml](.github/workflows/docker.yaml)) builds a
multi-arch image (amd64 + arm64) and publishes it to
`ghcr.io/descent098/readerr` on every push to `main` and every `v*` tag.

Environment: `DB_PATH` (default `/data/readerr.db`), `PORT` (default `8080`),
`STATIC_DIR` (built frontend inside the image). No auth — run it on a LAN, a
VPN, or behind a reverse proxy you trust. Full guide, including ports,
backups, and building from source: **[docs/dev/deployment.md](docs/dev/deployment.md)**.
Non-technical walkthrough: **[Sync & backups](docs/user/sync-and-backups.md)**.
