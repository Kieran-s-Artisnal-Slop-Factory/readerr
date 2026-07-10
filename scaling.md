# Scaling plan

How readerr handles sustained real usage — ~150 links/week, notes on 5–10 of
them, ~3 topics/week — over a 10-year horizon, without giving up the
local-first architecture (IndexedDB as source of truth, Go+SQLite as a
sync/backup target).

## 1. Projected data volume

| Store | Growth | 1 year | 5 years | 10 years | Row size | 10-yr bytes |
|---|---|---|---|---|---|---|
| links | 150/wk | 7.8k | 39k | 78k | ~300 B | ~25 MB |
| link_tags | ~1/link | 7.8k | 39k | 78k | ~150 B | ~12 MB |
| week_links | ~1/link | 7.8k | 39k | 78k | ~200 B | ~16 MB |
| notes | 7/wk | 360 | 1.8k | 3.6k | 1–5 KB | ~15 MB |
| topics | 3/wk | 156 | 780 | 1.6k | 10–50 KB | ~40 MB |
| excerpts, link_topics, etc. | small | — | — | ~20k | ~200 B | ~5 MB |
| weeks / plans / lists | ~52/yr | — | — | ~600 | tiny | — |
| **Total** | | **~25k rows** | **~125k** | **~260k rows** | | **~110 MB** |

Conclusions up front:

- **Capacity is not the problem.** 110 MB is far below IndexedDB quotas
  (Chromium allows up to ~60% of free disk per origin; `persist()` is already
  requested) and is trivial for SQLite (comfortable into the hundreds of
  millions of rows). Neither store needs replacing — ever, at this usage.
- **Access patterns are the problem.** Today most pages call
  `getAll(store)` and filter in memory, and sync scans every store on every
  push. Fine at 1k rows, painful at 78k: a backlog page load would
  deserialize ~25 MB and build a 78k-entry tag map before painting.

The plan is therefore about *query discipline*, not new infrastructure.

## 2. What breaks, and roughly when

| Symptom | Cause | Rough threshold |
|---|---|---|
| Backlog/slush/favourites pages slow to load | `getAll('links')` + full tag-map build | ~10–25k links (year 1–3) |
| Search keystrokes lag | in-memory filter over all links on each keystroke | ~25k links |
| Sync push takes seconds, runs every 15 min | full-store dirty scan | ~50k rows total |
| First sync of a new device stalls / OOMs | pull returns entire history in one JSON body | ~100k rows |
| Full JSON / markdown export janks the tab | building one 100 MB string in memory | ~50 MB data |
| Stats page slow | full scan + per-link map | ~50k links (tolerable — it's one page) |
| DB file bloat | tombstones are never physically deleted | cosmetic until far out |

## 3. Frontend plan

### 3.1 Paged reads replace `getAll` (the core change)

Add a paged query API to `repo.ts` built on IndexedDB cursors:

```ts
page<T>(store, index, { after?: IDBValidKey, limit = 100, dir = 'prev' }): Promise<{ rows: T[]; nextAfter?: IDBValidKey }>
```

and use the existing `Pagination.svelte` (copied from workoutt, currently
unused) on every unbounded list. Target limits:

| Page | Query | Page size |
|---|---|---|
| Backlog — not done | `links` by `added_at` desc, filtered | 100 |
| Backlog — done | same (already capped at most-recent 100) | 100 |
| Slush | `links` by `slushed_at` desc (new index) | 100 |
| Favourites / Resources | `links` by `added_at` desc, filtered | 100 |
| Tag / topic / list member lists | join index + `get` per member | 100 |
| Week page | bounded by design (~150 entries max) | no change |
| Search results | capped | 50 |

Two supporting schema-shaped changes (IndexedDB-only, no SQL/sync impact —
both are derivable fields/indexes):

- **Status key for one-index filtering.** Booleans aren't indexable in IDB,
  and "unread backlog page 3" can't be served by the `added_at` index alone
  without scanning read rows. Maintain a derived string field on links —
  `status_added = "<unread|read|slushed>|<added_at>"` — written by the same
  service functions that already own those transitions (`markLinkDone`,
  `toggleRead`, `reviewLink`, capture), with an IDB index on it. One
  `IDBKeyRange.bound('unread|', 'unread|￿')` cursor then serves each
  backlog section in order, paged. Backfill in the IDB migration that adds
  the index. (Not synced; recomputable, excluded from exports.)
- **`slushed_at` index** on links for the slush page.

Tag chips per row: build the tag map only for the 100 visible links
(one `byIndex('link_tags','link_id')` per row is ~100 indexed lookups —
fast) instead of `tagsByLinkMap()` over all joins.

Counts shown in headings come from `IDBObjectStore.count(range)` rather than
loaded arrays.

### 3.2 Search

Replace filter-as-you-type over full arrays with either (in order of
preference):

1. **MiniSearch index in a web worker.** Index title+url+tag names of all
   links: ~78k short documents ≈ 15–25 MB, builds in ~1–2 s off-thread.
   Persist the serialized index in a non-synced IDB store keyed by a
   data-version stamp; update incrementally on writes. Instant fuzzy search
   at any scale, prefix and typo tolerant.
2. Fallback: cursor scan capped at 50 matches with a 300 ms debounce —
   simpler, still fine at 78k because the scan short-circuits.

### 3.3 Heavy documents (topics)

1.6k topic documents at 10–50 KB each are only loaded one-at-a-time (topic
page), so no change needed. The topics *index* page should stop loading
`body_md` — add a `page`d listing that projects name only (IDB returns whole
rows; acceptable, or keep a derived `name`-only mirror if it ever matters).

### 3.4 Exports

- Stream instead of accumulate: build the JSON export as an array of Blob
  parts per store (`new Blob(parts)` never materializes one giant string);
  same for the markdown zip (JSZip already streams per-file).
- Nudge users toward **curated/time-range exports** (already built) for
  routine sharing; full backup stays for disaster recovery.

### 3.5 Stats

Compute `originStats` from a single cursor pass (no array materialization)
and cache the result in `sync_meta` with a row-count+latest-`updated_at`
stamp; recompute only when stale. At 78k links a pass is ~100–300 ms — cache
makes repeat visits free.

## 4. Sync plan

Current engine is LWW on `updated_at` with a global `server_seq` cursor.
That design survives 10 years unchanged; only the transport needs bounds.

- **Dirty tracking for push.** Today push does `getAll` on every store and
  filters by `updated_at > lastPushAt`. Add an IDB index on `updated_at` per
  store and query `IDBKeyRange.lowerBound(lastPushAt, true)` — push cost
  becomes proportional to changes, not history. (Rows with
  `server_seq == null` are found the same way since their `updated_at` is
  recent by construction.)
- **Chunked push:** send batches of ≤2,000 rows per request (the server
  already transacts per request; multiple requests are fine because LWW is
  idempotent and `lastPushAt` only advances after all batches succeed).
- **Chunked pull:** add `limit` to `GET /sync/pull?since=&limit=5000`; the
  client loops until a short page arrives, advancing its cursor each page.
  This bounds first-device-sync memory on both ends. Backwards compatible
  (no `limit` = current behavior).
- **Auto-sync stays at 15 min** — with dirty tracking each tick is O(changes
  since last push) ≈ tens of rows.

## 5. Backend plan (small)

SQLite with WAL handles this scale trivially; the changes are hygiene:

1. **Index `server_seq` on every synced table** (migration). Pull filters
   `WHERE server_seq > ?` — today that's a full table scan per table per
   pull; at 260k rows every 15 min it's the first thing to fix server-side.
2. **`limit` support in `/sync/pull`** (see §4).
3. **gzip responses** for pull/backup (stdlib middleware) — sync bodies are
   highly compressible JSON (~8:1).
4. **Tombstone compaction (manual, opt-in).** Deletions must persist as
   tombstones until every device has pulled them. Single-user reality: a
   Settings "Compact" action that (a) confirms all devices have synced,
   (b) asks the server to hard-delete tombstones with `deleted_at` older
   than 90 days and `VACUUM`, (c) does the same locally. Cosmetic until
   deletions number in the tens of thousands, so this is the lowest
   priority.
5. Nothing else. No Postgres, no server-side pagination of app reads (the
   server never serves app reads), no auth changes.

## 6. Rollout

| Phase | Trigger | Work |
|---|---|---|
| **A — now / preemptive** | before real multi-year data accumulates | `page()` repo API + Pagination on backlog/slush/favourites/resources; per-row tag lookups; `server_seq` indexes server-side (one migration, cheap now) |
| **B — ~10–25k links (year 1–2)** | list pages > ~200 ms or search lags | `status_added` + `slushed_at` + `updated_at` IDB indexes (one migration + backfill); dirty-tracked chunked push; pull `limit`; MiniSearch worker |
| **C — ~50k+ links (year 4+)** | export jank / stats slow / DB bloat | streamed exports; cached stats; gzip; tombstone compaction |

Each phase is independently shippable, touches no wire-format or conflict
semantics, and every migration follows the existing patterns (append-only
IDB migrations; `user_version` steps server-side).

## 7. Explicit non-changes

- **IndexedDB stays the source of truth** — no move to WASM SQLite (OPFS)
  unless IDB cursor pagination proves insufficient, which at 78k rows it
  will not. Revisit only if usage grows 10× beyond the estimate.
- **The sync protocol stays LWW + global cursor** — correct and debuggable;
  scale pressure is bandwidth-shaped, solved by chunking/gzip above.
- **SQLite stays** — a single reader/writer on a LAN at 260k rows is far
  inside its comfort zone.
