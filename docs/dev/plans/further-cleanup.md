# Further cleanup — refactor opportunities

A survey of simplification opportunities in the current codebase (2026-08-11,
post-v0.2.0 feature work). Nothing here is broken — every item below works and
is tested — but each is a place where the next feature will cost more than it
should. Ordered by leverage: how much future work each one cheapens, against
the risk of touching it. Every sync-adjacent item must keep the harness gate
(isolation diff + 12/12 sabotage) green; that gate is what makes the riskier
items feasible at all.

## 1. Extract the "singleton reconcile" engine (high leverage, medium risk)

Six hand-rolled variants of the same algorithm exist: `reconcileTags`,
`reconcileTopics` (links.ts), `reconcilePlans` (plans.ts), `getNote`'s fold
(notes.ts), `getUserSettings`' collapse (settings.ts), and `reconcileOpenWeeks`
(weeks.ts). All do: group live rows by a logical identity → pick the
smallest-id survivor → carry the freshest content onto it (`putReconciled`,
preserving updated_at) → re-point child/join rows → tombstone strays → queue a
`pendingRepush`. Each was written separately, and each historically had the
same bugs fixed separately (localeCompare vs code-unit ordering, stamp-now vs
preserve, join orphaning — see sync-audit.md).

A single `reconcileByIdentity(store, identityOf, { mergeContent, repointChildren })`
engine would collapse ~400 lines into ~6 declarative configs and make the next
singleton (there will be one) safe by default. The per-store quirks that must
survive as hooks: weeks' per-Monday (not global) identity and closed-row
exemption, topics' ref_number stability, tags' focus-id + hierarchy remapping,
label_usage recency carry-over.

## 2. Finish the patch() migration (medium leverage, low risk)

`repo.patch(store, id, changes)` exists precisely so a stale UI snapshot can't
clobber concurrent edits (audit §7.1), but several writes still spread a whole
captured row:

- `closeWeek` stamps outcomes via `put('week_links', { ...entry, outcome })` —
  entry comes from `weekEntries` moments earlier, so the window is small, but
  it is the same shape the audit killed elsewhere.
- `mergeIntoExisting` (capture.ts) upgrades flags via a whole-row put.
- `addToList` (resourceLists.ts) sets `is_resource` via a whole-row put.
- `reviewLink`/`scheduleLinkForWeek` already re-read; verify the rest of
  links.ts toggles all go through patch.

Sweep them onto `patch`. Mechanical, unit-testable, and the stale-snapshot
Playwright spec pattern (hand the service a deliberately stale row) already
exists to guard each one.

## 3. Split the two giant Svelte components (medium leverage, low risk)

- `WeekApp.svelte` (~950 lines) now carries: the D14 sync-gate/deferral state
  machine, the adder + lazy search corpus, three entry sections with
  drag-reorder, Done-section paging/filtering, suggestions, bulk actions, and
  the close flow. The init/onSync/close-gate logic is the part that hurts —
  it's the most safety-critical code in the app and it lives interleaved with
  UI concerns. Extract a `weekLifecycle.ts` (gate + deferral + retry, pure
  logic, unit-testable without Svelte) and cut the sections into components.
- `SettingsApp.svelte` (~1300 lines): one card = one component. The sync
  card's conflict-resolution flow deserves its own module for the same reason
  as the week lifecycle.

## 4. One source of truth for the capture DSL (small leverage, low risk)

The `!` command set is currently described in four places: `captureDsl.ts`
(COMMANDS + parser), `dslSuggest.ts` (COMMAND_SUGGESTIONS), the CaptureBox
helptext, and two docs (user capturing-links.md, dev link-dsl.md). Adding
`!list` touched all of them. Export one command-metadata table from
captureDsl.ts (name, min prefix, insertion, hint, doc line) and derive the
suggester + helptext from it; docs stay prose but can cite the table.

## 5. Schema triplication guard (small leverage, low risk, high payoff-per-line)

The data model lives in three places that must agree by hand: `sql/schema.sql`
(+ db.go migrations), `sync.go` tableMeta, and `types.ts` STORES (+ the
harness's meta.ts). The field-matrix guard covers store coverage end-to-end,
but a column added to sqlite and forgotten in tableMeta only surfaces as a
silently-unsynced field. A Go test that introspects the sqlite schema
(`PRAGMA table_info`) and diffs it against tableMeta's column lists would turn
that mistake into a red test for ~40 lines.

## 6. sync.ts doSync() decomposition (small leverage, low risk)

`doSync` is ~250 lines covering epoch check, dirty scan, pendingRepush rescue,
archived-links queue, chunked push, conflict adoption, seq write-back, paged
pull, and archive routing. Extract `scanDirty()`, `pushBatches()`,
`applyPull()` with the current tests as the net. Worth doing before the next
sync feature, not after.

## 7. Known-limitation debt (recorded, deliberately not built)

- Per-field merge for `week_links` (concurrent reorder-vs-complete on the same
  entry across offline devices) and for tag renames vs recency-adjacent
  writes — whole-row LWW's residual data-loss cases. Needs a
  `field_updated_at` map like workoutt's settings. Substantial; only worth it
  if the case is ever actually hit.
- The Settings server-migration flows still race an in-flight sync's tail
  writes (audit C7): `syncFresh` fixed "join a stale run", but a genuinely
  in-flight old-server run can still write cursors after `resetLocalSyncState`.
  A `cancelInFlightSync()` (AbortController through doSync's fetches) would
  close it properly.
- suggestLinks has two implementations (pooled filter + indexed merge) with an
  oracle test binding them. That's deliberate — the pooled path is free when
  the corpus is already loaded — but if the corpus ever goes fully lazy
  everywhere, drop the pooled path.

## Non-goals

Rewrites for taste (state libraries, CSS frameworks, TypeScript strictness
crusades) and anything that changes the wire format or IDB schema without a
feature forcing it. The sync surface is the crown jewels; it gets touched with
the harness green or not at all.
