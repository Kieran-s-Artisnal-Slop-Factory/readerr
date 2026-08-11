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

## The second round: the last two whole-library reads (fixed)

The ~900ms that remained after the first round was two genuine whole-library
reads. Both are now gone (IDB migration v9, `db.ts`):

- **`all('links')` — was 474ms on every load.** The read served two purposes:
  the adder's search corpus and the suggestions pool. They were split apart.
  The search corpus now loads lazily on first focus of the adder (most visits
  never type in it), and `suggestLinks` without a pool reads the backlog
  through indexes with early termination: rows with an explicit priority come
  from a compound `[priority, added_at]` index, and null-priority rows (the
  common case — IndexedDB won't index null, so they are absent from the
  compound index by construction) come from the plain `added_at` index; the
  two streams merge in (priority, added_at) order and stop at the quota. Both
  cursors share one transaction — an idle IDB transaction auto-commits, so
  two transactions would kill each other's cursor. Focus-tag pools resolve
  through the `link_tags` index, bounded by the tag's own assignments.
- **`tagsByRecentUse()` — was 399ms per capture-box mount.** Recency now lives
  in `label_usage`, a LOCAL-ONLY store with one row per tag/topic id, stamped
  by `assignTag`/`assignTopic` and rebuilt from the joins by a one-time
  backfill (so existing ordering carried over). Local-only deliberately: a
  synced `last_used_at` column on the tag row was the obvious design, but
  every assignment would then rewrite the tag row itself, and under whole-row
  LWW a stale device stamping recency could clobber a concurrent rename —
  the same stale-snapshot class the sync audit spent weeks killing. Per-device
  recency is also arguably the better UX (your recent tags, not the
  household's). Name-merges carry the stray's recency onto the survivor.

Guards: `test/perfPaths.test.ts` — ordering equivalence against the old
whole-table implementations as oracle, plus tests that FAIL if a whole-table
`getAll` ever returns to either path.

Rule of thumb this leaves behind: **on a hot page, a whole-table read should be
something you chose deliberately, not something a helper does on your behalf.**
Every fixed item above was a helper quietly reading everything.

## Seeding

Writing the 77k-link dataset above took ~245s through the normal stores. That
is bulk `put` throughput, not a page-load path, and it reports progress as it
goes.
