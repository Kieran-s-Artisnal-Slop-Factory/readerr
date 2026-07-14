# Yearly archival

How readerr keeps hot paths snappy once the link count grows into the tens
of thousands, by relocating old, cold links out of the working set.

## The problem

The canonical store is IndexedDB. Backlog, slush, favourites, resources,
stats, and search all read `all('links')` — a full `getAll` over the `links`
object store — then filter/paginate in memory. That deserialization is the
cost: at a few thousand rows it's imperceptible; at 50k+ it can take
seconds, and it happens on nearly every page load. SQLite (the sync backend)
handles this volume trivially; the browser's IndexedDB does not.

Pagination (scaling.md phase A) limits *rendering*, but the whole `links`
store is still deserialized to build each page. The only way to make loads
fast at scale is to **read fewer rows**. Archival does that by moving links
that are cold — read long ago and never written about — into a separate
store the hot paths never touch.

## What counts as archivable

The safe, high-volume target is **slushed links** (read, but not favourited
or referenced in a topic — see the reading lifecycle) **older than a
threshold**, default 24 months, configurable in whole months. These are the
links you triaged and moved on from; they have no notes, no topic, no
favourite — nothing you're likely to open again, but worth keeping for
search/history. On the 150-links/week projection (~78k/decade) the large
majority end up slushed, so this reclaims most of the working set.

Favourited links, links in topics, links with notes/excerpts, and unread
backlog links are **never** archived — they're the working set by
definition.

## Design: a local, separate object store

Archived links move to a dedicated `archived_links` IndexedDB store that is
**local-only** (not synced, not in the `STORES` sync loop), created directly
in an append-only IDB migration.

Why local-only rather than a synced table:

- **Real perf win.** Archiving *hard-deletes* the row from `links` (not a
  soft tombstone), so `getAll('links')` genuinely returns fewer rows. A
  synced approach would need tombstones, which stay in `links` and don't
  shrink the load — defeating the purpose.
- **The server is still the full backup.** Every link was already pushed to
  the sync backend before it aged out, so hard-deleting locally loses
  nothing: the sync cursor (`server_seq > since`) never re-pulls an old row,
  so it won't reappear. Archived content is preserved in `archived_links`
  locally *and* on the server's `links` table.
- **Deterministic, so devices converge.** Archival is a pure function of
  `slushed_at` age vs the threshold. Each device runs it independently and
  arrives at the same partition, so there's no cross-device state to
  reconcile and no duplication bugs. A fresh device pulls the full history
  (server has everything), then archives locally on first run.

Related rows (notes, excerpts, `link_tags`, `link_topics`, `week_links`)
stay put — they're keyed by `link_id` and are looked up on demand when an
archived link is viewed, and those stores are comparatively tiny. The
archive view resolves an archived link's tags the same way every list page
does.

Backups: the JSON full-export includes `archived_links` explicitly (it's not
in `STORES`), so a restore brings archived links back; `clearAllData` wipes
it too.

## Automatic mode

Archival is a **mode** the user enables (off by default), configurable at
any time in Settings → Archival:

- **Enable archival** toggle. Off is the current behavior (nothing moves).
- **Archive slushed links older than** N months (default 24).
- **Archive now** button (runs immediately) and a live count of how many
  links are currently archivable and how many are archived.

When enabled, archival runs automatically on app start (throttled to at most
once/day via a local timestamp) so the working set stays trimmed without the
user thinking about it. It also runs right after a week closes (that's when
new links get slushed).

The **Archive** collection appears in the Collections nav dropdown **only
while the mode is enabled**; it lists archived links, paginated and
searchable, with an "unarchive" action per link (moves it back into `links`)
in case something was archived that you want active again.

## The suggestion trigger

The mode should surface itself to users who need it without nagging those
who don't:

- On app start, if archival is **disabled** and the active `links` count
  exceeds **50,000**, a one-time modal suggests enabling archival, explains
  what it does, and offers **Enable** or **Not now**.
- **Not now** sets a local `archive-suggest-dismissed` flag so the modal
  never appears again (the count keeps climbing; nagging repeatedly is
  worse than letting the user find the setting).
- The 50k number is *only* the suggestion trigger. The setting itself is
  always available in Settings regardless of count, so a user can enable it
  at 5k or ignore it at 500k.

## Configuration & settings summary

| Setting | Default | Where | Synced |
|---|---|---|---|
| `archive_enabled` | off | Settings → Archival | yes (a preference) |
| `archive_after_months` | 24 | Settings → Archival | yes |
| suggestion dismissed | — | localStorage | no (per-device UX) |
| last auto-run time | — | localStorage | no |

`archive_enabled` and `archive_after_months` live on `user_settings` so the
preference carries across devices; the archived *rows* do not sync (each
device archives locally, deterministically).

## Rollout / relationship to scaling.md

This is the first concrete step of scaling.md's phase C ("~50k+ links"). It
is independently shippable and touches no sync wire-format. The deeper
phase-B work — cursor-paged reads over indexes so even the *active* store is
never fully deserialized — remains the endgame for truly enormous active
sets; archival reduces how much data ever reaches those hot paths in the
first place, buying years of headroom before phase B is needed.

## Explicit non-goals

- Archival is not deletion — nothing is lost; archived links are searchable
  in the Archive tab and recoverable via unarchive or a JSON restore.
- It does not move the server off SQLite or change the sync protocol.
- It does not archive anything with notes, excerpts, a topic, or a favourite
  — only cold slushed links past the age threshold.
