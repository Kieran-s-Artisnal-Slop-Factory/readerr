# Version 0.4.0 — Phased implementation plan

Status: **ALL PHASES COMPLETE. Checkpoints 1–4 green (2026-08-30).** If you are an agent picking this
up: work top-to-bottom, check off items here AND in `TODO` as you go, and do not skip
checkpoints. VERSION has already been bumped to `0.4.0`; add a `# 0.4.0 (unreleased)`
heading to `CHANGELOG.md` with the first change you land.

## Ground rules (from TODO + repo conventions)

- Usability > accessibility when they collide. Personal app; don't sacrifice
  functionality or performance for a11y.
- Dev docs for new features go in `docs/dev/` with **mermaid diagrams and code
  references** (follow `docs/dev/tagging.md` style); update the `docs/README.md` index.
- Every data-model change follows the full sync-propagation checklist (see Appendix A).
  Gate schema work on **12/12 sabotage + full sync suite green** before calling it done.
- CHANGELOG per change: brief (2–4 sentences), under Features / Bug Fixes / Other.
- **Full test suite** at a checkpoint means, in order:
  1. `cd frontend && npm test` (vitest unit tests)
  2. `cd backend && go test ./...`
  3. `cd frontend && npm run test:sync` (Playwright multi-device sync harness — slow;
     this is why it's checkpoint-only, not per-phase)
- Per-phase, run only the fast targeted tests for what you touched (specific vitest
  files, specific go tests).
- Subagents: at each checkpoint the preceding phases are independent enough to
  parallelize where noted. Don't let two subagents touch the same file
  (`WeekApp.svelte`, `links.ts`, and the export services are the collision hotspots —
  phases that share them are marked **serial**).

---

## Phase 1 — Dependency updates (Maintenance)

- [x] Frontend: all in-range deps updated (Astro 7.2.9, Svelte 5.57.0, Milkdown
      7.22.1, CodeMirror, marked 18.0.11, vitest 4.1.11, Playwright 1.62.1);
      TypeScript 6.0.3 → 7.0.2 major trialed and kept — 373/373 vitest + `astro
      build` green (nothing in the build invokes `tsc` directly).
- [x] Backend: `modernc.org/sqlite` 1.53.0 → 1.57.0 (+ transitive libc/sys/isatty),
      `go mod tidy`; `go test ./...` green. Go toolchain already at installed 1.25.0.
- [x] Nothing held back — noted in CHANGELOG "Other".

## Phase 2 — Only sync when a valid sync URL is set (Bug fix)

Problem: `getSyncUrl()` (`frontend/src/lib/sync.ts` ~39) falls back to same-origin
`BASE_URL`, so an install with no backend hammers `/healthz`, `/sync/push`,
`/sync/stats` and (on the inbox page) `/feed`, filling the console with errors.

- [x] `docker-compose.yml` confirmed: the image serves frontend + sync API on ONE
      origin with no URL configured, so the same-origin fallback had to stay valid.
      Resolved with the second option in the original plan — `isValidSyncUrl()` /
      `hasValidSyncUrl()` (synchronous, config-only) plus `ensureSyncAvailable()`,
      which probes `/healthz` once per tab session and remembers the verdict in
      `sessionStorage` (`readerr-same-origin-sync`). `setSyncUrl()` clears it.
- [x] Guarded the entry points: `requestSync()`, `flushPendingSync()`,
      `maybeAutoSync()` (synchronous check), `doSync()` (async check, returns
      `NO_SERVER_MESSAGE` before `checkServerEpoch` or the push — so
      `checkServerEpoch()` is covered by its only caller), `serverHasData()`.
- [x] Guarded `/feed` in `lib/services/feeds.ts` — falls through to `feedParse.ts`
      with no note. Also guarded two call sites the plan hadn't listed but which have
      the same bug: `/title` (`capture.ts` `fetchTitles`) and `/dbsize`
      (`stats.ts`). `InboxApp.svelte`'s "no sync server" banner now reflects real
      availability instead of only explicit offline mode.
- [x] Settings/Onboarding validate on save (`isValidSyncUrl`); Settings shows a
      "no server to sync with" banner naming the saved target and disables **Sync
      now**; Onboarding refuses to finish or connect with a scheme-less URL.
- [x] Unit tests: `frontend/test/syncGuard.test.ts` (25 cases — URL syntax,
      offline mode, one-probe-per-session both ways, concurrent-probe dedupe,
      re-probe after a URL change, `syncNow()` issuing only `/healthz`).
      `staleSnapshot.test.ts`'s fetch stub needed a healthy `/healthz` added.
      Verified in the browser against the dev server with no backend: reading list,
      inbox and settings issue **zero** sync/feed/title requests after the single
      probe; the inbox banner and the settings banner both appear; a scheme-less URL
      is rejected and not saved; a valid one saves and clears the banner.

## ✅ CHECKPOINT 1 (after phases 1–2) — **GREEN (2026-08-30)**

`npm test` 398/398 · `go test ./...` ok · `npm run test:sync` 151 passed,
self-verification 12/12, coverage 17/17 stores. `astro build` and
`svelte-check` clean (the 24 pre-existing svelte-check errors — node types in
`tests/`, a readonly-tuple assignment in `BacklogApp`/`WeekApp` — are
untouched by this phase). The harness runs the backend serving `dist/` on one
origin with no URL configured, so its green run also proves the same-origin
probe still admits a legitimate server.

Run the full suite (vitest, go test, test:sync). Phase 2 touches sync entry points, so
`test:sync` must be fully green — the harness configures a sync URL, so it also proves
the guard doesn't block legitimate sync. Fix regressions before proceeding.
*Phases 1 and 2 may be done by two parallel subagents (no file overlap), but the
checkpoint runs once, after both merge.*

## Phase 3 — Scrollable / paginated link search picker

The "Paste a URL to add, or search your links…" pattern is duplicated three times with
a hard `.slice(0, 8)` cap.

- [x] `frontend/src/components/LinkSearchPicker.svelte` — input + scrollable results
      + add-by-URL, with the per-page styles (and the sub-40rem stacking rule) moved
      out of all three hosts. Matching goes through `matchesSearch()`; tag names
      participate only via an optional `tagsByLink` map, so no host reads the whole
      `link_tags` table to search.
- [x] 25 results per page, list capped at `22rem` with `overflow-y: auto`, and a
      "Show more results" button that WIDENS the page (rows already on screen keep
      their positions). New pure helper `searchLinkCorpus()` in `lib/services/links.ts`
      stops one row past the page, so cost tracks what's drawn, not what's stored.
      `WeekApp`'s lazy `ensureCorpus()` survives as the picker's `onFocus` prop.
- [x] Adopted in `ResourceListApp.svelte`, `TopicApp.svelte`, `WeekApp.svelte`
      (each keeps its own `exclude` set; the week adder keeps `accept: !slushed_at`).
- [x] `frontend/test/linkSearchPicker.test.ts` — 10 cases including a counted-iteration
      test proving a 25-row page visits 26 rows of a 5,000-link corpus.

## Phase 4 — Bulk operations on links

**Serial with phase 3** (both touch `WeekApp.svelte`).

- [x] "Resource lists" op-group in `BulkActionsPanel.svelte` (Add to / Remove from
      selected, with inline list creation via `ChipSelect`, mirroring Tags/Topics).
      New `addLinksToList()` / `removeLinksFromList()` in `resourceLists.ts` read the
      membership index ONCE per batch instead of once per link, and `addToList()` now
      delegates to the bulk helper so there's a single implementation. Adding sets
      `is_resource` even when the pair already existed. Removing deliberately leaves
      `is_resource` alone, matching `removeFromList()`.
- [x] Panel placement: `WeekApp` renders one `{#snippet bulkPanel()}` at one of two
      sites, chosen by `panelSection` — Done-only selection → inside the Done card,
      week-only → "This week", mixed → follows `lastClickedSection`. Placement uses
      UNFILTERED Done membership so Done's search/filters can't move the panel, and
      the panel always acts on the whole selection.
- [x] Per-section rendering WAS the polish item (the plan's simpler option); no sticky
      positioning added — the reported pain was purely "the controls are far away".
- [x] `frontend/test/bulkLists.test.ts` — 12 cases, including a link already in the
      list, the same link twice in one batch, and a pair already forked across devices
      (the deduping read heals it rather than minting a third row).

## ✅ CHECKPOINT 2 (after phases 3–4) — **GREEN (2026-08-30)**

`npm test` 420/420 · `go test ./...` ok · `npm run test:sync` 151 passed,
self-verification 12/12, coverage 17/17 stores (the `resource_list_links-pair`
invariant included). `astro build` + `svelte-check` clean against the same
22-error/24-warning pre-existing baseline.

Verified in the running app against a 2,396-link seeded library: the picker
shows 25 scrollable results with a working "Show more" (→50), resets depth on
a new query, still lazy-loads the week corpus on first focus, and adds on
click in all three hosts; the bulk panel renders in Done for a Done-only
selection and in "This week" for a mixed one, never both; "Add to selected"
created 3 memberships and re-applying it created 0 (10 rows / 10 unique pairs),
each link flagged `is_resource`; "Remove from selected" took them back out.

Docs: new [bulk-and-picking.md](../bulk-and-picking.md) (two mermaid diagrams
+ code refs), indexed in `docs/README.md` and cross-linked from
`architecture.md`; user docs updated in `organizing-and-reading.md`.

## Phase 5 — Topics data model: status + topic tags (schema change)

The one real schema change of this release. Follow **Appendix A** end-to-end.

- [x] `topics.status TEXT NOT NULL DEFAULT '' CHECK (status IN ('', 'in-progress',
      'done'))`. Empty-string, not NULL — a row pushed by an older client arrives
      without the column and the server default fills it, so there is no NULL-vs-empty
      ambiguity downstream (the `links.is_series` choice). Reads go through
      `topicStatus()`, which normalizes `undefined` AND unknown future values to empty.
      SQLite migration v20 → v21; no IDB migration needed for a new field.
- [x] `topic_tags {topic_id, tag_id}`: `schema.sql` + `db.go` v20 → v21 +
      `migrate_test.go` undo (`undoTargetVersion` unchanged at 18, the undo block
      just grew) + `sync.go` `tableOrder` (after topics; tags land earlier) and
      `tables` + `types.ts` `TopicTag`/`STORES` (own `updated_at` index) + IDB
      `MIGRATIONS` v12.
- [x] Reconcile: `reconcileTopics()` carries `status` onto the survivor with the
      prose rule (a real status beats empty, newest wins between two real ones).
      New `repointTopicTags(axis, ...)` runs on BOTH axes — `topic_id` when duplicate
      topics fold, `tag_id` when duplicate tags do — grouping by the other endpoint
      so pairs that collide after the rewrite collapse to the smallest id.
      `dedupeTopicTags()` guards every display read. Deletion cascades added on both
      sides (`clearTopicTags` / `clearTagFromTopics`).
- [x] Harness: `meta.ts` (TABLE_ORDER, TABLES, FOREIGN_KEYS), `topic_tags-pair` in
      `invariants.ts`, two new `store:` tests in `field-matrix.spec.ts` (topics.status
      across all three value classes incl. the empty default, and a topic_tags edge),
      coverage sets in the spec AND `reporter.ts` (which had its own hardcoded list —
      that is why coverage briefly read 18/17).
- [x] Backup/import: `export.ts` carries `topic_tags` in full / curated / range /
      (tags+topics) template scopes, always via `topicTagsWithin` so an edge never
      travels without BOTH endpoints; `export-markdown.ts` writes status + tags as
      YAML frontmatter. The three files in `frontend/test/fixtures/` are frozen
      historical backups (schemaVersion 5 and 7 — they predate `tag_parents`,
      `series_links` and `feeds` too), so they were left alone; current-format
      round-trips are covered by new tests instead.
- [x] Unit tests: `topicStatusTags.test.ts` (40 cases) + 3 new version-skew cases
      (`makeOldServer` generalized to any table) proving an old backend cannot erase
      `status` and that `topic_tags` simply stays local until it is rebuilt.

## Phase 6 — Topics UI

**After phase 5.** All in `TopicsApp.svelte` / `TopicApp.svelte`.

- [x] Status controls: the two toggles per row on the overview and in the topic
      header. They CYCLE — clicking the active status clears it — so one control
      both sets and unsets without a per-row "clear" button.
- [x] Overview ordering via `orderTopics()` / `statusRank()`: in-progress (0), no
      status (1), done (2), name within the band. Unmarked deliberately sits BETWEEN
      the two, since most topics carry no status and belong above retired ones.
- [x] `TopicBulkPanel.svelte` — the `BulkActionsPanel` shape for topics (set/clear
      status, add/remove tags, delete with the full tombstone cascade). A separate
      component, not a mode: every op on the link panel is link-shaped.
- [x] Tag assignment on topic detail. `TagPicker.svelte` now takes `linkId` **or**
      `topicId` — same junction shape, same interaction, three swapped function
      references — rather than a near-duplicate component.
- [x] `TagApp.svelte` gained a "Topics" section (name + status badge) above Links;
      `topicExport.ts` emits YAML frontmatter (md) and a metadata card (HTML), both
      omitted entirely when a topic has neither status nor tags, so existing exports
      are byte-identical.
- [x] Overview search (`SearchInput`, matching name OR tag name) + `ChipFilter`s for
      status and tag. Statuses are OR (a topic has one status); tags are AND (chips
      narrow). Only tags actually in use are offered.
- [x] Vitest: `filterTopics` / `orderTopics` / `statusRank` / `compareTopicsByStatus`
      in `topicStatusTags.test.ts`, plus export-metadata structure in
      `topicExport.test.ts`.

## ✅ CHECKPOINT 3 (after phases 5–6) — **GREEN (2026-08-30)**

`npm test` 470/470 · `go test ./...` ok · `npm run test:sync` **153 passed,
TRUSTWORTHY, self-verification 12/12, coverage 18/18 stores**. `reconcile-clobber`
+ `field-matrix` also run explicitly (55 passed, 18/18 — that partial run reports
NOT TRUSTWORTHY only because the sabotage suite is not in the subset).
`versionSkew.test.ts` is vitest and ran with the unit suite. `astro build` and
`svelte-check` clean against the same 22-error/24-warning pre-existing baseline.

One flake on the first harness run — `net::ERR_NO_BUFFER_SPACE` fetching a static
CSS asset on device B under parallel load, local resource exhaustion rather than a
schema fault. Green on re-run.

Verified in the running app on a seeded library: ordering (in-progress → unmarked
→ done), each chip filter and search, per-row and header status toggles including
clear-by-reclick, bulk tag-add (re-applying created 0 new rows: 2 live rows /
2 unique pairs) and bulk status, the tag page's Topics section, markdown
frontmatter + HTML metadata card, and the delete cascade taking a topic's
`topic_tags` with it. No console errors on any topics/tag page.

Docs: new [topics.md](../topics.md) (three mermaid diagrams + code refs), indexed
in `docs/README.md`; `data-model.md` updated (ER diagram, IDB table, junction
lists, migration counters); user docs in `organizing-and-reading.md`.

Original gate, for the record: full suite with emphasis on sync — 12/12 sabotage +
full `test:sync` green — plus `reconcile-clobber`, `versionSkew`, `field-matrix`
run explicitly with the new store showing coverage.
*Phase 7 below is independent of 5–6 and may run as a parallel subagent while 5–6 are
in flight (different files), but it must not be merged past this checkpoint until the
checkpoint is green.*

## Phase 7 — Link overview page additions

`LinkApp.svelte` (+ `pages/link.astro`).

- [x] Reschedule: **verified in the running app — the guessed gap does not exist.**
      Changing the week select already MOVES the link in one action (`setLinkWeek`
      removes the other pending assignment first); driven end to end, one `week_links`
      row, re-pointed twice. So no duplicate was built.
      What the verification DID turn up is a real defect in the same control: moving a
      link away from a week it was already ticked off in **tombstoned that finished
      entry**, silently erasing the completion (and its contribution to the stats).
      `setLinkWeek` now displaces only UNFINISHED entries; the link page's select also
      prefers the first unfinished assignment, so it no longer snaps back to a
      done-but-not-yet-closed one. Three new cases in `weeks.test.ts`.
- [x] Resource-list card on `LinkApp.svelte`, between Topics and Excerpts: membership
      chips (TagPicker's vocabulary) plus inline create, through the phase-4
      `addLinksToList` / `removeLinksFromList`. Adding flags the link a resource and
      the header flag updates with it; removing deliberately leaves it.
- [x] Vitest: the reschedule cases above; the list helpers were already covered by
      `bulkLists.test.ts` from phase 4.

## Phase 8 — Export unification groundwork

**Serial before phases 9–10** (they build on it). Read
`lib/services/resourceLists.ts:111-176`, `resourceListExport.ts`, `topicExport.ts`,
`htmlExport.ts` first.

- [x] `collectionExport.ts` (writes) + `collectionSource.ts` (gathers) — the split is
      what lets a third surface be one new `collectionForX()`. `ExportableCollection`
      is {title, aboutMd, stats, sections, topics}; `stats` is written once and read by
      BOTH the md frontmatter and the HTML header card, so they cannot disagree.
      Resource lists ported: their md and HTML (single and mass export) now go through
      it, so a list exports exactly the way a tag does. txt/csv/json stay the plain
      data dumps they always were.
- [x] Shared serializer, one schema for both formats. **One deliberate deviation from
      the spec:** `link` carries the TITLE (rendered as an anchor) with `url` as its
      own column beside it — a table you cannot search by title is not much of a
      table, and the plan's `url` column still exists and still filters. Ordering
      favourites → read → unread, title within the band; `|` escaped and newlines
      flattened in md cells (`mdCell`).
- [x] Vendored the four **dependency-free model libs** — `src/lib/table/{types,
      format,filter,csv}.ts`, unchanged, each headed with its origin — plus their
      upstream tests as `test/table-{filter,format,csv}.test.ts` (113 cases, only the
      import paths changed). `to-sql.ts` skipped as planned.
      **The Svelte components were NOT vendored** — see the next item; vendoring a
      component nothing renders would have been dead code.
      (Cross-repo `cp` is blocked by the sandbox here; the files were copied by
      reading and writing them, which is retoken's copy-paste model anyway.)
- [x] **Took the plan's documented fallback**, and deliberately: bundling a Svelte
      runtime per exported file needs a build step whose output must ALSO exist during
      `astro dev`, and puts tens of kilobytes of framework in every export — for a
      table. `tableRuntime.ts` is instead a plain-JS transcription of the vendored
      `format`/`filter`/`csv` rules, inlined with the rows and schema as JSON.
      A transcription can drift silently, so it is **pinned**:
      `test/tableRuntime.test.ts` evaluates the runtime string and asserts it agrees
      with the vendored modules — every coercion result, the sign of every pairwise
      comparison in every column, contains/isTrue/isFalse filtering vs `filterRows`,
      search vs `searchRows`, and CSV quoting/document/filename vs `csv.ts`.
      The reader gets: search, a filter control per column (Yes/No/Any for booleans),
      click-to-sort headings, a live n-of-m count, and a CSV button that exports what
      is visible, with the UTF-8 BOM.
- [x] **Theming bridge: not needed, and that is the point of the fallback.** With no
      vendored component there are no retoken tokens to map — `TABLE_RUNTIME_CSS` is
      written directly against readerr's own variables, so the exported table follows
      the selected theme through `themeCss()` with nothing in between.
- [x] `test/collectionExport.test.ts` (32 cases) + `test/tagExport.test.ts` (15) —
      structural assertions only, never byte-exact HTML.

## Phase 9 — Exportable tags: Markdown

`TagApp.svelte` gets an Export card (mirror `ResourceListApp.svelte` ~187–200).
Data via `tagCounts()`, `linksTaggedDirectly()`, `linksFromChildTags()`
(`links.ts:343-518`) and `tagTree.ts`.

- [x] Frontmatter: `child_tags`, `links_direct`, `links_from_children`, `favourites`,
      `topics` — the same objects the HTML header card renders.
- [x] About section from `notes_md`, omitted entirely when there are no notes.
- [x] "Links" and "From child tags", the second omitted when nothing reaches the tag
      that way, both through the shared serializer.
- [x] Topic metadata always; `embedTopics` appends the documents as sections;
      `topicsAsFiles` writes a zip instead — the tag's document (keeping the topic
      INDEX, dropping the bodies) plus `topics/<name>.md`, each with its own
      frontmatter, names de-duplicated so two same-named topics cannot collide on one
      zip path. `tagMarkdownFiles()` returns the file set before anything touches the
      DOM, which is what makes it testable.
- [x] Vitest as listed, including the both-ways link appearing exactly once.

## Phase 10 — Exportable tags: HTML

- [x] One file, everything inlined, themed by `themeCss()`. A test asserts there is
      no `<link rel="stylesheet">` and no `src="http` — it has to open from a disk,
      offline.
- [x] Header card from the same `stats` array as the frontmatter.
- [x] About rendered from markdown.
- [x] One table per section, default order favourites → read → unread, filterable and
      sortable per column, with the CSV button enabled (it exports the FILTERED rows).
      Schema as agreed apart from the title/url split noted in phase 8.
- [x] Topic embed → a click-to-read modal per topic, closed by the ✕, the backdrop
      or Escape.
- [x] Vitest on the document structure, including that a link title containing
      `</script>` cannot close the payload element early.

## ✅ CHECKPOINT 4 — release gate — **GREEN (2026-08-30)**

- [x] `npm test` 656/656 · `go test ./...` ok · `npm run test:sync` **153 passed,
      TRUSTWORTHY, 12/12 sabotage, 18/18 stores**. `astro build` and `svelte-check`
      clean against the same 22-error/24-warning pre-existing baseline (node types in
      `tests/`, a readonly-tuple assignment in BacklogApp/WeekApp).
- [x] Docs: `docs/dev/sync.md` (availability guard, mermaid + refs),
      `docs/dev/topics.md` (new), `docs/dev/bulk-and-picking.md` (new),
      `docs/dev/exports.md` (new), `docs/dev/data-model.md` and `docs/dev/seeding.md`
      updated, all indexed in `docs/README.md`; user docs in
      `docs/user/organizing-and-reading.md` for topic statuses/tags, bulk ops, the
      link page's resource lists, and the tag export.
- [x] CHANGELOG 0.4.0 complete. (The section was re-styled by hand mid-release into
      terser `*` bullets; later entries follow that style rather than reverting it.)
- [x] TODO: everything checked off except the "For human" test-series feeds, left
      intact as the human's manual QA.
- [x] Browser sanity pass, on a seeded library and against the running dev server:
      no console errors without a sync URL (one `/healthz` probe, then silence); the
      picker scrolls and pages; the done-section bulk panel; topic statuses ordering
      the overview, its filters and search; the tag Export card; and the exported HTML
      page driven inside an iframe — per-column text filter (4 of 76), boolean filter
      (10 of 76, every row No), sort asc/desc with the arrow, free-text search
      (18 of 76), CSV download carrying the UTF-8 BOM and the filtered rows, and the
      topic modal opening and closing. Resource-list md/HTML and both mass-export zips
      re-checked after the port.

### Left for the human

`TODO` → "For human": the test-series feeds. Nothing else is outstanding.

---

## Appendix A — schema-change propagation checklist (from repo conventions)

1. `backend/sql/schema.sql` **and** a new entry in `backend/db.go` `migrations`.
2. `backend/migrate_test.go`: add undo statements, bump `undoTargetVersion`
   (fresh-vs-upgraded shape equality is enforced).
3. `backend/sync.go`: `tableOrder` (parents before children) + `tables` metadata
   (`columns`, `jsonCols`, `boolCols`, `defaults`).
4. `frontend/src/lib/db/types.ts`: interface + `STORES` (new stores need their own
   `updated_at` index).
5. `frontend/src/lib/db/db.ts`: append to `MIGRATIONS` (never edit shipped ones);
   new *fields* on existing stores need no IDB migration.
6. Reconcilers: singleton folds preserve new fields via `putReconciled`; junctions get
   `dedupePairs()` + repointing; respect `healsAllowed()` test-mode gating.
7. Backup/import (`export.ts`, `export-markdown.ts`) + fixtures.
8. Harness: `tests/sync/helpers/meta.ts`, `invariants.ts`, `field-matrix.spec.ts`.
9. Sabotage self-test still RED-capable (`sabotage.ts` / `sabotage.spec.ts`).
10. Version-skew: confirm `mergeIncoming()` protects the new columns from old servers.
