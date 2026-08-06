# Performance at scale

Measured on a seeded library of **77,328 links / 75,042 week_links / 61,854
link_tags / 520 weeks** (Edge, Astro dev server), which is roughly the
"multi-year heavy user" shape the seeder exists to produce — see
[seeding.md](seeding.md).

## The reading-list page

The `/week/` page was taking ~3s of blocked main thread at that size. A DevTools
profile put ~3s of self time in one place: the `idb` request-success handler,
i.e. V8 materialising IndexedDB result arrays. That is the tell for whole-table
reads, and there were four of them per page load — three of which did nothing.

Load-path cost, measured per call:

| Call | Before | After |
|---|---:|---:|
| `autoCloseStaleWeeks()` | 488ms | 9ms |
| `ensureOpenWeek()` | 490ms | 24ms |
| `findWeek()` → `reconcileOpenWeeks()` | 490ms | 8ms |
| `all('links')` (search corpus + suggestions) | 500ms | 474ms |
| `suggestLinks()` | 506ms | 13ms |
| `tagsByRecentUse()` (capture box chips) | 385ms | 399ms |
| **total** | **~2,860ms** | **~930ms** |

Three fixes, none of which change what the page shows:

1. **`healOrphanedEntries` stopped scanning `week_links`.** It ran on every
   `reconcileOpenWeeks()` — three times per page load — and read the entire
   entries table to look for entries whose week is missing. But an entry
   pointing at a week this device has never received can't be re-homed anyway
   (its Monday is unknowable), so the only rescuable orphans hang off a
   *tombstoned* week, and the `week_id` index reaches those directly. Nothing
   tombstones weeks in normal use, so the common path is now an early return.
   This was ~1.3s of the 2.9s, spent finding nothing.

2. **`suggestLinks()` accepts the caller's already-loaded links.** The week page
   read every link, then `suggestLinks` read every link again moments later.

3. **`allLinks` is `$state.raw`, not `$state`.** It is replaced wholesale and
   never mutated, so deep-proxying tens of thousands of rows so a search box can
   filter them was pure overhead.

## What is left, and why

The remaining ~900ms is two genuine whole-library reads. Both are expected given
the current design; neither is free to remove:

- **`all('links')` — 474ms.** Suggestions need the backlog: unread, un-slushed,
  non-resource links, priority-ordered. None of those are indexable (IndexedDB
  won't index booleans or nulls), so finding candidates means reading the
  library. Iterating the `added_at` index with early termination would fix it
  for the common case, but priority ordering breaks a naive early stop — a
  priority-1 link captured yesterday must beat a priority-3 from two years ago.
  A compound `[priority, added_at]` index would do it properly.
- **`tagsByRecentUse()` — 399ms.** Ordering ~120 tags by most recent use means
  reading all 61k join rows for their `updated_at`. A `last_used_at` column on
  the tag row would make it a 120-row read — but that is a schema change, so it
  needs the migration + `sync.go` + sync-test work every data-model change here
  requires.

Rule of thumb this leaves behind: **on a hot page, a whole-table read should be
something you chose deliberately, not something a helper does on your behalf.**
The three fixed items were all helpers quietly reading everything.

## Seeding

Writing the 77k-link dataset above took ~245s through the normal stores. That
is bulk `put` throughput, not a page-load path, and it reports progress as it
goes.
