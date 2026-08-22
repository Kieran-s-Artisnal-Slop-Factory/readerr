# Series

Handle multi-part writing — "Part 1, Part 2, Part 3" — as **one thing you can
schedule and read**, without losing the individual parts.

A series behaves like a folder: it contains the links that make it up. It is
also usable **as a link itself** — favourite it, drop it into a reading week,
tag it, write notes on it, and see it in a reading list.

**Status: phases 1–3 are built** (schema v20 / IDB v11, `services/series.ts`,
series rows in every list, the Add-series modal, the Parts editor on a series'
own page, and a Collections → Series index). §9 records what changed on the
way in. The `/series-demo/` prototype this design was drawn against has served
its purpose and been deleted.

Like every design here, it is written to fit the app's grain: local-first,
offline-first, and — the constraint that dominates every decision below —
**synced across devices by whole-row last-write-wins**, which has already cost
this codebase a long list of data-loss bugs
([sync-issues-summary.md](sync-issues-summary.md)).

## 1. Goal

- A series has a title, a description, an optional overview URL, and an
  **ordered** list of member links.
- A series can be **used anywhere a link can**: favourited, tagged, given
  topics, assigned to a reading week, shown in the backlog and reading lists,
  prioritised, annotated.
- In a list, a series is **one row that expands** to its parts. Ticking a part
  marks that part read; the series shows progress (`2/5`).
- Adding a series to a week does **not** flood the week with five rows — but
  the parts are reachable from the one row that was added.
- Tags and topics apply **per series and per link**: the series carries the
  broad ones (`rust`), a part can carry its own (`rust`, `async`).

Explicit non-goals for v1: series of series (nesting), automatic detection of
"Part 2" from titles, and per-part scheduling into *different* weeks from
inside the series row (the Add-series modal asks for a week per part at
creation time instead — see §5.1).

## 2. Data model

### 2.1 The decision: a series **is a link**

Two shapes were considered.

| | A. `series` is its own entity | B. `series` **is a link** (recommended) |
|---|---|---|
| New tables | `series`, `series_links` | `series_links` only |
| Favourite / priority / read state | new columns on `series`, new UI | free — they are `links` columns |
| Tags & topics on a series | `series_tags`, `series_topics` (2 more junctions, 2 more dedupe passes) | free — `link_tags`, `link_topics` |
| Notes / excerpts on a series | `notes.series_id` (nullable FK) or new tables | free — `notes.link_id` |
| Scheduling into a week | `week_links.series_id` nullable + every reader learns two shapes | free — a `week_links` row like any other |
| Backlog / Favourites / search | every list query becomes a union of two sources | unchanged |
| Cost of the choice | ~6 new tables/columns and a second code path through every list | one flag, one junction |

Option B wins outright, and it wins for the reason that matters here: **it adds
no new LWW surface**. Every field a series has is a field the sync engine, the
oracle, and the invariants already cover.

So:

```sql
-- backend/sql/schema.sql
ALTER TABLE links ADD COLUMN is_series INTEGER NOT NULL DEFAULT 0; -- bool

-- One "link N is part of series S, at position P" edge.
CREATE TABLE series_links (
    id         TEXT PRIMARY KEY,
    series_id  TEXT NOT NULL REFERENCES links (id),  -- the link with is_series = 1
    link_id    TEXT NOT NULL REFERENCES links (id),  -- the part
    position   INTEGER NOT NULL DEFAULT 0,           -- 1, 2, 3… within the series
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    server_seq INTEGER
);
CREATE INDEX idx_series_links_series ON series_links (series_id);
CREATE INDEX idx_series_links_link   ON series_links (link_id);
CREATE INDEX idx_series_links_seq    ON series_links (server_seq);
```

`series_links` is **structurally identical to `resource_list_links`** — a
junction with a position — so it inherits machinery that already exists and is
already tested:

| Concern | Reused from |
|---|---|
| Duplicate `(series, link)` rows from two devices | `dedupePairs` in [db/repo.ts](../../../frontend/src/lib/db/repo.ts) — min-id survivor, tombstone the rest |
| Soft delete so removing a part syncs | `softDelete` / tombstone-filtering reads |
| Re-ordering under LWW | the position rewrite in [services/resourceLists.ts](../../../frontend/src/lib/services/resourceLists.ts) and `reorderEntries` in [services/weeks.ts](../../../frontend/src/lib/services/weeks.ts) |
| Membership by capture DSL | `!list=[name]` in [services/captureDsl.ts](../../../frontend/src/lib/services/captureDsl.ts) → add `!series=[name]` |

### 2.2 The overview URL

`links.url` is `NOT NULL` and is the de-duplication key for capture, so a
series with no overview page still needs one. Two options:

1. **Require an overview URL.** Most series have one (a tag page, a landing
   post, the first part). Simple, but it blocks "these three posts belong
   together" with no landing page.
2. **Synthesise `series:<uuid>`** when the field is left blank. `cleanUrl`
   leaves non-http URLs alone, `domainOf` already tolerates unparseable URLs
   (it returns the raw string), and the row is otherwise ordinary.

Recommended: **2, with the field offered and pre-filled where possible.** The
The UI must then never render a `series:` URL as a clickable link: title only,
no external-link affordance.

### 2.3 What is NOT stored

- **No `part_number` on the link.** Position lives on the edge, so the same
  link can (in principle) sit in two series, and renumbering never touches the
  link row — which matters because the link row is what carries read state.
- **No denormalised progress.** `2/5` is computed from the parts' `read_at`;
  a stored counter is one more field for LWW to lose.
- **No `series_id` column on `links`.** That would make membership a property
  of the part, so two devices adding the same part to two series would fight
  over one field instead of writing two independent edges.

## 3. The hard parts under last-write-wins

### 3.1 Position collisions

Two devices reorder the same series while apart, or each append a part: both
end up with a `position = 4`. Whole-row LWW keeps both rows, and the list has
a tie.

**Resolution:** positions are a *hint*, not an identity. Every reader sorts by
`(position, id)` — `id` is the tie-break, so both devices order identically
without coordinating. A reorder writes the whole run of edges (as
`reorderEntries` already does for week entries), so the common case converges
to clean 1..n; a concurrent reorder degrades to "one of the two orders wins",
never to a crash or a duplicated row.

### 3.2 A part is also a series (cycles)

v1 forbids adding a series as a part, but the write is only checked locally:
device A adds series `S2` as a part of `S1` while device B adds `S1` as a part
of `S2`. Neither write is illegal on its own; together they are a loop.

**Resolution:** the same posture as `tag_parents` — readers are
**cycle-tolerant by construction** (a depth cap plus a `seen` set while
expanding), and a `reconcileSeries` pass breaks a detected cycle
deterministically by dropping the highest-id edge in it. The tag hierarchy's
`findTagCycles` in [tests/sync/helpers/invariants.ts](../../../frontend/tests/sync/helpers/invariants.ts)
is directly reusable.

### 3.3 Deleting a series

Tombstoning the series link must tombstone its edges too, or every device is
left with live `series_links` rows pointing at a dead parent — the referential
invariant the harness checks after every convergence. The parts themselves
**stay**: they are ordinary links the user captured.

Symmetrically, deleting a *part* must tombstone the edges naming it. Both are
the pattern `removeFeed` and the tag delete already follow.

### 3.4 Read state

`links.read_at` on the series row and on each part are separate fields on
separate rows, so they can disagree — a device marks the series done while
another marks part 3 done.

**Resolution:** do not derive one from the other in storage. Compute progress
on read, and let the two facts mean different things:

- a part's `read_at` = "I read this part";
- the series' `read_at` = "I'm done with this series", which the UI *offers* to
  set when the last part is ticked (a prompt, not an automatic write — an
  automatic write here is exactly the background-write-clobbers-a-rename shape
  that has bitten this codebase before).

### 3.5 Week entries

A series in a week is one `week_links` row pointing at the series link. Week
close ([services/weeks.ts](../../../frontend/src/lib/services/weeks.ts)) treats
it like any other entry — done or not — and the parts are untouched unless the
user ticked them. This is deliberate: a half-read series rolls over as one
entry, not five.

## 4. Query semantics

| Read | Behaviour |
|---|---|
| Backlog / Favourites / week lists | Series rows appear as normal links. **Parts are hidden** when their series is present in the same list, and shown as ordinary links when it is not. |
| `partsOf(seriesId)` | `byIndex('series_links', 'series_id')` → deduped → sorted by `(position, id)` → resolve links. One indexed read, no table scan. |
| `seriesFor(linkId)` | `byIndex('series_links', 'link_id')` — for the part's own page ("Part 3 of *Rust async*"). |
| Tag filtering | Unchanged. A series carries its own tags; a part carries its own. A tag page may therefore show a series **and** one of its parts — correct, since both were tagged. |
| Search | Unchanged; both are links. |
| Stats | A series counts as a link. Worth a note in the origins table (`series:` URLs group into one pseudo-origin) — or exclude `is_series` rows from origin stats, which is the cleaner answer. |

The hiding rule in row 1 is the only genuinely new query behaviour, and it is
cheap: build the set of part ids for the series present in the page's rows
(one indexed read per series on the visible page, the same shape as
`tagsForLinks`), then filter.

## 5. UI

### 5.1 The "Add series" modal

Fields, in order:

- **Title**, **Description** (markdown), **Overview URL** (optional, §2.2);
- **Tags & topics** for the series itself;
- a repeating **part** row: position, URL, title, assigned week, and its own
  tags/topics.

Positions default to 1, 2, 3… in the order the rows were added and can be
edited; blank titles fall back to the URL and the ordinary auto-title fetch
fills them in afterwards.

Creating a series is one capture pass: the series link, then each part through
the normal `captureLinks` path (so URL cleaning, duplicate merging, and week
assignment all behave exactly as they do everywhere else), then one
`series_links` edge per part.

### 5.2 In a reading list

A series row is a normal row plus a **disclosure triangle** and a progress
count. Expanded, the parts render as indented rows with their own ✓, ★, and
tag chips.

Rules this pins down:

- collapsed by default, expansion state is per-view UI state (**not** stored —
  it is not worth a synced field, and a synced one would fight between devices);
- ticking the last part offers "mark the whole series read" rather than doing
  it (§3.4);
- a part shown inside its series never *also* appears as a top-level row in the
  same list (§4).

### 5.3 Writes must not resurrect the stale-snapshot bug

Every mutation goes through `patch()` with a re-read, never
`put(store, {...uiRow, field})` — a series row is exactly the kind of row that
sits on screen while another device edits it (audit §7.1).

## 6. Wiring checklist

Each of these is a place this codebase has been bitten before when a table was
added and one step was missed:

- `STORES` + a new migration in [db/db.ts](../../../frontend/src/lib/db/db.ts)
  (never edit an existing migration — append one);
- the `Link` interface (`is_series`) and a `SeriesLink` interface in
  [db/types.ts](../../../frontend/src/lib/db/types.ts);
- `tableOrder` **and** the `tables` metadata in
  [backend/sync.go](../../../backend/sync.go) — `series_links` sorts after
  `links`, and `is_series` joins `boolCols`;
- a backend migration in [backend/db.go](../../../backend/db.go) stepping
  `PRAGMA user_version`;
- the harness's `TABLES` / `TABLE_ORDER` / `FOREIGN_KEYS` in
  [tests/sync/helpers/meta.ts](../../../frontend/tests/sync/helpers/meta.ts),
  a `series_links-pair` check in `invariants.ts`, and `ALL_STORES` in
  [tests/sync/reporter.ts](../../../frontend/tests/sync/reporter.ts) —
  otherwise the new store is a **silent coverage hole**;
- the seeder ([db/seed.ts](../../../frontend/src/lib/db/seed.ts)), so stress
  datasets contain series;
- the markdown/HTML exports, which should render a series as a nested list.

## 7. Testing plan

**Unit ([frontend/test/series.test.ts](../../../frontend/test)):** ordering by
`(position, id)`; reorder rewrites the run; a part removed from a series keeps
the link; deleting a series tombstones its edges; the hiding rule in §4;
progress counting; cycle tolerance with a hand-built loop.

**Sync ([frontend/tests/sync/series.spec.ts](../../../frontend/tests/sync)):**
both devices adding the same part → one edge; concurrent reorder → identical
order on both; series deleted on A → no orphan edges on B; a series scheduled
into a week on A → one entry on B, parts untouched; a part read on B → progress
on A.

**Field matrix:** `store:series_links` (position round-trip, `is_series` as a
real bool, not `1`).

## 8. Phasing

1. **Model + service** — column, table, migrations, `series.ts`
   (`createSeries`, `partsOf`, `addPart`, `removePart`, `reorderParts`,
   `progressOf`), unit tests. No UI.
2. **Reading-list rendering** — the expandable row and the hiding rule.
3. **Creation** — the modal, plus `!series=[name]` in the capture DSL.
4. **Everywhere else** — the part's own page ("Part 3 of…"), exports, seeder,
   stats treatment.

Each phase is shippable on its own; phase 1 with no UI is invisible, and phase
2 degrades to "series look like ordinary links" if the rest never lands.

## 9. Build notes — what actually happened

Phases 1–3 shipped together. The plan survived contact mostly intact; these
are the places it didn't, and why.

- **The overview URL went with option 2** (§2.2): blank synthesises
  `series:<uuid>`. `isSyntheticSeriesUrl()` is what the UI checks before
  rendering a title as a hyperlink, and `originStats` skips series rows
  outright rather than grouping them into a bogus `series:` origin.
- **The expansion lives in `LinkRow`, which renders itself for the parts.**
  That was not obvious up front: putting it in `LinkList` would have missed
  the reading week, which builds its rows from `LinkRow` directly for
  drag-and-drop. One component means series behave identically in the week,
  the backlog, favourites, a tag page and a resource list.
- **The hiding rule (§4) is applied in `LinkList` only.** In a reading *week*,
  a part with its own `week_links` entry is a deliberate scheduling decision
  carrying its own done state, and hiding that row would hide the state with
  it. So the week shows what you scheduled; every other list nests parts under
  their series and says how many it folded away.
- **A part's edge merge keeps the LOWEST position** and carries the group's
  freshest `updated_at`. The timestamp detail is not cosmetic: `putReconciled`
  deliberately doesn't restamp, so a fold that kept the survivor's own older
  timestamp loses to the server's copy of that same row under LWW and undoes
  itself on the next pull. (The inbox hit exactly this, and the harness caught
  it as a 1-in-2 flake — see the `feed_items` merge.)
- **Deleting a series is the app's only link-delete path**, deliberately: the
  container is something the user assembled, while the parts are real
  captures. It tombstones the edges first, because a live edge naming a
  tombstoned link is precisely the referential violation the harness fails on.
- **The week hides nested parts after all.** The first cut left the reading
  week alone (a part with its own entry was assumed deliberate). In practice
  ticking a part *inside* its series creates that entry as a side effect —
  `toggleRead` files every read link into the current week — so the week
  listed the same reading twice. Parts of a series that is itself in the week
  are now folded into its row, and the week's counts follow the rows on
  screen.
- **The overview page is the link page.** A series needed notes, excerpts,
  tags and a week; it had all of them the moment `is_series` became a column
  on `links`. The only additions were presentation: a `series` badge, the
  Notes card retitled **Overview**, the Parts card above the fold, and a
  **Series** filter in the list toolbars so a series can be found again.
- **Not built yet (phase 4):** `!series=[name]` in the capture DSL, series in
  the markdown/HTML exports and in the seeder, and drag-to-reorder (the Parts
  editor uses ↑/↓ buttons, which reuse the same whole-run rewrite).
