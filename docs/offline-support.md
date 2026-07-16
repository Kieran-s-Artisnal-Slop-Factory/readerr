# Offline support

readerr is offline-*first*, not offline-tolerant: the network is an
enhancement, never a dependency. That property falls out of three layers
that are worth understanding separately, because they fail (and recover)
independently:

1. **Data** — IndexedDB is the source of truth; every read and write is
   local. Nothing in the app awaits the network to complete a user action.
2. **Shell** — a service worker caches the static pages/assets so the app
   *loads* without a network.
3. **Enhancements** — sync and title-fetching use the network when it's
   there and degrade quietly when it isn't.

## Layer 1: the data never leaves

All application state lives in IndexedDB ([data-model.md](data-model.md)).
Capturing links, editing notes, closing weeks, theming, exporting — all of
it is local I/O. There is no "saving…" spinner waiting on a server anywhere
in the app; the Go backend is only a sync target
([sync.md](sync.md)) and can be absent forever in **offline mode**.

Two distinct notions of "offline":

| | How it's chosen | What it means |
|---|---|---|
| **Offline mode** | onboarding, or by clearing the sync URL | *policy*: `readerr-sync-mode = 'offline'` in localStorage — no network calls, ever (no sync, no title fetch) |
| **Temporarily offline** | `navigator.onLine` / failed fetches | *circumstance*: network features skip or fail quietly and retry later |

### Durability

Browsers treat IndexedDB as evictable cache (iOS Safari famously wipes it
after ~7 days of inactivity unless installed as a PWA), and on a
no-sync-server setup the browser holds the only copy. So
[persistence.ts](../frontend/src/lib/db/persistence.ts) requests the
**persistent storage bucket** (`navigator.storage.persist()`) during
onboarding, and the Settings → Storage card surfaces the verdict with a
"request" button and a warning when denied. The Stats page shows
`storage.estimate()` usage. JSON/markdown exports (and a sync server) are
the real safety nets — see the Backup card.

## Layer 2: the app shell loads offline

[public/sw.js](../frontend/public/sw.js) is a small hand-written service
worker (registered by
[Layout.astro](../frontend/src/layouts/Layout.astro) **in production
builds only**) plus
[manifest.webmanifest](../frontend/public/manifest.webmanifest) to make the
app installable as a PWA. It caches only the static shell — it never touches
IndexedDB or sync traffic.

```mermaid
flowchart TD
    F["fetch event"] --> G{"GET, same-origin,<br/>not /src/ /@ /node_modules/?"}
    G -->|no| Pass["pass through untouched<br/>(includes all /sync/* calls)"]
    G -->|yes| M{"navigation?"}
    M -->|yes| NF["network-first:<br/>fetch → cache copy → serve"]
    NF -->|offline| NC["cached page,<br/>else cached base '/'"]
    M -->|no: asset| SWR["stale-while-revalidate:<br/>serve cache immediately,<br/>refresh cache in background"]
    SWR -->|no cache yet| Net["fetch (cache if ok)"]
```

- **Navigations are network-first** so deploys show up on the next load
  when online, with the cached page (then the cached root) as the offline
  fallback.
- **Assets are stale-while-revalidate** — instant loads, background
  freshness.
- `CACHE_VERSION` (`readerr-v1`) names the cache; bump it to invalidate
  everything after a breaking asset change. `activate` deletes old caches
  and claims clients; `install` calls `skipWaiting()`.
- Cross-origin requests and non-GETs (every `/sync/*` POST) bypass the
  worker entirely — offline caching must never make sync state lie.

**Dev mode is the opposite:** Layout.astro *unregisters* any service worker
and clears its caches, because a worker caching Vite's module URLs serves
stale code after edits (blank pages). If the dev server ever behaves
impossibly, a leftover production worker on the same origin is the first
suspect.

The app also works hosted under a sub-path: the worker derives its base from
its own URL, and all app links go through `href()` in
[paths.ts](../frontend/src/lib/paths.ts).

## Layer 3: network features degrade quietly

### Sync

`maybeAutoSync()` ([sync.ts](../frontend/src/lib/sync.ts)) returns
immediately when `navigator.onLine` is false or the mode is offline; a
failed `syncNow()` records the error (Settings shows it, the
[sync log](sync.md#sync-history--status)'s *explicit errors* mode ignores
offline-caused ones) and simply waits for the next trigger — session start,
the 15-minute throttle, or a manual **Sync now**. Nothing queues: push is
cursor-based ("everything changed since `lastPushAt`"), so however long the
device was offline, the next successful sync carries it all, in bounded
chunks. The Navbar shows an `offline` badge driven by the
`online`/`offline` window events.

### Title fetching

Capture is instant and offline-safe by design: links are stored immediately
with `title = url` and `title_fetched = false`
([capture.ts](../frontend/src/lib/services/capture.ts)). Resolving real
titles needs the backend (browsers can't read cross-origin pages), so
`fetchTitles`:

- skips entirely when `navigator.onLine` is false,
- skips entirely in offline mode (no backend exists; a client-side fetch
  would be CORS-blocked for nearly every site),
- otherwise fires-and-forgets against `GET /title`, retrying 3× per link and
  logging a console warning when it gives up.

`title_fetched = false` **is** the retry queue: `retryMissingTitles()` runs
on every Backlog mount and re-attempts every bare link, so titles captured
offline resolve themselves the next time the app is online with a backend.

```mermaid
sequenceDiagram
    participant U as User (offline)
    participant App as App island
    participant DB as IndexedDB
    participant BE as Backend

    U->>App: paste links (capture works fully)
    App->>DB: links stored, title_fetched = false
    Note over App,BE: later, back online
    App->>App: backlog mount → retryMissingTitles()
    App->>BE: GET /title?url=… (per bare link)
    BE-->>App: {ok, title}
    App->>DB: title updated, title_fetched = true
    Note over App,BE: next auto-sync tick
    App->>BE: push everything since lastPushAt
```

## What to test when touching any of this

- Capture, edit, and navigate with DevTools → Network set to *Offline*:
  everything except title resolution and sync must behave identically.
- Production build + `astro preview`, then go offline and reload: pages
  serve from the worker cache.
- Come back online: titles resolve on the next Backlog visit; the next sync
  tick pushes the backlog of changes (watch the sync log).
- After changing `sw.js`, bump `CACHE_VERSION` and verify old caches are
  dropped on activate.
