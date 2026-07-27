# Local-first sync: a data-loss bug catalogue

An executive summary of the sync defects found and fixed in a local-first app
(offline-first client store + a "last-write-wins" sync server), written so
**another engineer or AI can audit a different codebase for the same class of
mistakes.** It is deliberately implementation-agnostic: the patterns below recur
in any system that syncs an offline store to a shared backend by timestamp.

If your app has these properties, this applies to you:

- clients hold a full local copy (IndexedDB, SQLite, Core Data, Realm, a JSON
  file…) and work offline;
- rows carry a client-generated id, a client `updated_at`, and a soft-delete
  tombstone;
- the server resolves conflicts by **last-write-wins on `updated_at`** and hands
  out a monotonic per-row cursor (`server_seq`, `version`, `rev`…);
- clients **push** local changes and **pull** rows past a stored cursor.

Sixteen distinct issues were found across conflict resolution, cursors, on-read
reconciliation, server consistency, backup/restore, a local cold-storage
partition, and push resilience. **Most were silent data loss** — no error, no
crash, the user just quietly loses an edit. The single most important lesson is
last (§9): **a sync test harness that fakes "two devices" is worse than none.**

---

## How to use this document

For each item: **the mistake**, **why it loses data**, **grep/read for** (how to
find it in your code), and **the fix**. Treat the "grep/read for" lines as an
audit checklist. None of these are exotic; they are the default, reasonable-
looking implementation that turns out to be wrong under concurrency.

---

## 1. Conflict resolution (last-write-wins) pitfalls

### 1.1 Whole-row LWW clobbers a field the other device just edited
**Mistake:** the whole row is the unit of conflict resolution. Device A edits
field X, device B edits field Y on the same row concurrently; whichever row has
the later `updated_at` wins **wholesale**, silently discarding the other field.
**Why it loses data:** the "losing" field's edit is overwritten and never
re-sent (the row is no longer dirty).
**Grep/read for:** any `put(store, {...row, oneField: newValue})` where the row
carries several independently-edited fields (a settings/profile blob; a list row
with both an ordering field and a status field). Look for a single `updated_at`
covering many fields.
**Fix:** field-level merge — per-field timestamps (`field_updated_at`) merged on
pull, or split hot-toggling fields into their own rows so an edit to one can
never carry another. (We split a per-pin array into one row per pin; we added
per-field timestamps to the settings singleton.)

### 1.2 Timestamp-tie resolves in opposite directions on client vs server
**Mistake:** the server skips on `incoming <= existing` (incumbent wins ties)
while the client applies on `incoming >= local` (incoming wins ties). On an
exact millisecond tie the two sides pick **different** winners → permanent
divergence, no clock skew required.
**Grep/read for:** the comparison operators on both sides. Client apply and
server accept must break ties the **same** way.
**Fix:** make the operators agree, AND (see 1.3) have the loser adopt the
winner.

### 1.3 A rejected (LWW-losing) write is never re-pulled → permanent divergence
**Mistake:** when the server rejects a pushed row (older/tie), it just drops it.
But the pushing device's **pull cursor is already past that row's `server_seq`**,
so it never re-pulls the winning version. The loser keeps its rejected edit
forever while everyone else has the winner.
**Why it loses data:** two devices permanently show different values for the same
row; a device with a slightly slow clock silently loses every conflict.
**Grep/read for:** the push handler's "skip" branch — does it return anything to
the client? The client push code — does it do anything with rejected rows?
**Fix:** the server returns the authoritative row for every rejected push
("conflicts"); the client applies them under the same LWW rule. Now the loser
converges even with its cursor past the row.

### 1.4 LWW rides raw client wall-clocks with no server time authority
**Mistake:** ordering is purely `client.updated_at`. A device with a wrong clock
(fast → always wins and clobbers; slow → always loses and its edits/deletes
vanish, deletions resurrect).
**Grep/read for:** where `updated_at` is set — is it ever the server's clock?
**Fix (hard):** server-authoritative timestamps or a logical clock (HLC). At
minimum, ship 1.3 so a mis-clocked device converges instead of diverging, and
document the limitation.

### 1.5 A "touch" (re-save that only bumps `updated_at`) clobbers real edits
**Mistake:** code re-saves a row to "re-sync" it or bump its cursor, stamping a
fresh `updated_at` over **unchanged content**. That fresh timestamp then beats
another device's genuine edit under LWW.
**Grep/read for:** writes whose only purpose is re-syncing/heal/dedup delivery
(often commented "touch so it re-pushes"). See §3.
**Fix:** never stamp `now` on content you didn't change; preserve the content's
real `updated_at` (see §3.1).

---

## 2. Cursor / watermark pitfalls

### 2.1 Non-transactional server pull skips rows under a concurrent push
**Mistake:** the pull reads each table/collection in a **separate query** (its
own snapshot). A push commits between two of those reads; the later table sees
it, the earlier one didn't. `latestSeq` (max returned) then advances **past** a
row the earlier read missed → that row is below the new cursor and never pulled
again.
**Why it loses data:** a row is silently, permanently skipped on that device.
**Grep/read for:** a pull handler that issues multiple independent reads and
computes a single high-water cursor across them, without a transaction/snapshot.
**Fix:** run the whole pull in **one read transaction** (a consistent snapshot).
A mid-pull commit is then invisible to that pull and delivered by the next one.

### 2.2 Push "watermark" advances past rows that weren't actually sent
**Mistake:** the push watermark (`lastPushAt`) is advanced from timestamps of
rows that were **pulled** (not pushed), or over a non-atomic scan so a write
during the scan lands at/below the watermark. Those rows are never pushed.
**Grep/read for:** how the push high-water mark is computed — is it derived from
pulled rows? Is the "what's dirty" scan atomic w.r.t. concurrent writes? Is the
lower bound exclusive in a way that drops same-timestamp edits?
**Fix:** derive the watermark only from rows you actually pushed; treat rows with
"never accepted by server" (null server cursor) as always-dirty regardless of the
watermark; be careful with `>` vs `>=` at the boundary.

### 2.3 A row rejected under LWW advances the pull cursor and is never re-offered
See 1.3 — the cursor-past-the-row problem is a cursor bug as much as an LWW bug.

---

## 3. Reconcile-on-read / dedup pitfalls

Background: "logical singletons keyed by a random id" (a settings row, a
per-parent note, a per-(a,b) junction, "one open X per key") get duplicated when
two offline devices each mint one. Apps "heal" these by folding duplicates on
read. That healing is a minefield.

### 3.1 The fold stamps `now` on stale content and clobbers a newer edit
**Mistake:** the fold picks a survivor, copies the "best" content from the local
duplicates, and re-saves with `updated_at = now`. A device that still holds
pre-fold duplicates (hasn't pulled the other's tombstones) re-folds later and
writes **old content under a new timestamp**, beating another device's genuinely
newer edit.
**Why it loses data:** the widest silent-loss channel we found — any healed
singleton (settings, notes, tags/topics, plans) can revert a real edit.
**Grep/read for:** any dedup/heal/reconcile function that calls the normal
`put`/save (which stamps `now`) on a survivor row.
**Fix:** the fold must **preserve the real content timestamp** (the max
`updated_at` of the folded rows), never `now`. To still re-deliver a merged
survivor whose preserved timestamp is below the push watermark, record it for an
explicit "re-push this id" pass.

### 3.2 A write that runs *on read* mutates synced data during a pull
**Mistake:** reconcile-on-read fires while a pull is applying rows. It sees a
just-pulled parent **before its children arrive**, folds/tombstones it, and
pushes the tombstone — deleting the other device's data everywhere; the children
then land orphaned.
**Grep/read for:** heal/reconcile functions invoked from read/render paths;
whether they can run concurrently with the sync loop.
**Fix:** don't reconcile while a sync is applying rows (a simple `isSyncing()`
guard); reconcile again after it settles, with complete data.

### 3.3 Folding drops a duplicate wholesale, losing its unique state
**Mistake:** when two duplicates are collapsed, the "loser" is tombstoned
**without merging its state** onto the survivor. If the loser was the only copy
carrying a completion flag / timestamp / status, that's gone.
**Grep/read for:** dedup code that tombstones duplicates — does it merge their
meaningful fields first, or just delete?
**Fix:** merge the loser's state (e.g. keep the earliest completion, the stickier
status) onto the survivor before tombstoning.

### 3.4 Survivor selection is non-deterministic across devices → fold ping-pong
**Mistake:** the "which duplicate wins" rule uses locale-sensitive string
comparison (`localeCompare` with no locale) or anything not byte-identical across
devices/the server. Two devices pick **different** survivors, each tombstones the
other's, and every reconcile flips it back — forever.
**Grep/read for:** `localeCompare` / locale-aware sorting used to choose a
canonical row or break ties; ensure it matches the server's ordering.
**Fix:** pick the survivor by a device-independent rule (raw code-unit/byte order
on the id), identical on client and server.

### 3.5 A fold/dedup re-save resurrects a row another device just deleted
**Mistake:** the fold re-saves a row (fresh `now`) computed from local live rows;
it can't see that another device already soft-deleted that row. The fresh save
beats the tombstone under LWW → the deleted item comes back.
**Grep/read for:** the same re-save-with-now folds as 3.1; they resurrect as well
as clobber.
**Fix:** preserving the real timestamp (3.1) also fixes this — the stale re-save
loses to the newer tombstone.

---

## 4. Server-side write / consistency pitfalls

### 4.1 One bad row aborts the whole push batch → permanent sync halt (poison)
**Mistake:** the push applies rows in a transaction; a single unstorable row (a
`CHECK`/`NOT NULL` violation, a missing required field, a corrupt value) fails the
statement and the handler **500s the whole batch**. The client retries the same
payload forever → **all** sync stops, push and pull.
**Why it's severe:** one malformed row (from an old schema, a bad import, a bug)
bricks sync entirely and silently.
**Grep/read for:** the push loop — does a per-row error `return`/throw out of the
whole request?
**Fix:** **skip** the offending row (report it), let the rest of the batch land.
(SQLite keeps a transaction usable after a constraint error; check your DB's
semantics.) Also validate rows before writing so corruption can't enter locally.

### 4.2 Absent wire keys become SQL NULL / defaults (silent erasure or 500)
**Mistake:** the server builds an INSERT listing every column and binds NULL for
any key missing from the wire row. For a `NOT NULL` column with no default →
500; for a nullable column → the value is silently **erased**; for `NOT NULL
DEFAULT` it depends on the conflict clause (INSERT-OR-REPLACE may substitute the
default; a plain INSERT won't).
**Grep/read for:** optional/omittable fields on the client that map to columns
the server always writes; upsert SQL that binds explicit NULL for missing keys.
**Fix:** fill known defaults server-side; for updates, prefer partial updates
that preserve columns the client omitted rather than overwriting with NULL.

### 4.3 Response ordering doesn't guarantee parents-before-children
**Mistake:** the pull serializes collections in map/hash order, so children can
arrive before parents. Harmless only if the client has no referential
enforcement; a hazard if it does.
**Grep/read for:** pull response assembled from an unordered map; a client that
enforces foreign keys on apply.
**Fix:** emit in explicit parent→child order; make the client tolerant of
out-of-order arrival (apply, reconcile later).

---

## 5. Backup / restore / device-lifecycle pitfalls

### 5.1 Merge-import overwrites newer local rows (no LWW on import)
**Mistake:** importing a partial/curated backup writes rows by id **without an
LWW check**, regressing a newer local row to the backup's older copy and
resurrecting tombstones.
**Grep/read for:** import/restore code that does a blind `put(row)` per id.
**Fix:** apply the same LWW rule on import — only overwrite if the imported row
is newer; never resurrect a newer local tombstone.

### 5.2 A full restore keeps the old sync cursor → silent permanent fork
**Mistake:** restoring a backup replaces the data but leaves the pull cursor
(and/or the server's row cursors) untouched. The device now sits **above** the
server's sequence and never pulls the rows below its stale cursor → it silently
diverges from the server forever.
**Grep/read for:** restore/import code — does it reset the pull cursor? Does it
clear foreign server cursors carried in the backup?
**Fix:** a full restore is a new baseline: reset the pull cursor, drop the push
watermark, clear any server-assigned cursors on restored rows, forget the server
"epoch"/identity so a fresh full sync happens.

### 5.3 Unvalidated import lets a poison row in (then §4.1 halts sync)
**Mistake:** import writes rows with no shape validation; a row missing an id or
required field lands locally and then poisons every push.
**Fix:** validate every row before writing anything; reject the file cleanly with
no partial write.

### 5.4 Switching servers without resetting sync bookkeeping
**Mistake:** pointing the app at a new server without clearing cursors/row-
sequences means stale cursors run against a different sequence space → skipped or
mis-applied rows.
**Grep/read for:** the "change server URL" path — does it reset all sync state?
**Fix:** treat a server change like a full reset (see 5.2); use a server "epoch"
id so clients detect a counter restart and resync from zero.

### 5.5 Onboarding writes a singleton before the first pull
**Mistake:** first-run creates the settings/profile singleton locally and pushes
it **before** pulling existing server data, clobbering the real profile.
**Fix:** pull before writing first-run singletons; or create them at a fixed id
and LWW-merge.

---

## 6. Local derived/partition stores (caches, archives)

### 6.1 A local-only partition resurrects on pull
**Mistake:** for performance, "cold" rows are **hard-deleted** from the synced
store and moved to a local-only store — but they still exist on the server. Any
full re-pull or remote edit **re-inserts** them into the hot store → duplicated
across both stores; editing the now-stale cold copy later clobbers newer server
edits.
**Grep/read for:** any place that hard-deletes a synced row locally while it
lives on the server (archival, caching, "trim the hot set"); the pull-apply code
— does it know about the partition?
**Fix:** make the pull **route** an incoming row to whichever partition holds its
id (update the cold copy in place; never re-insert into hot); on a server
switch/full-resync, move the partition's rows back so they re-push.

### 6.2 UI actions on a cold/derived row write to the hot store
**Mistake:** the archive/cold view reuses the normal row component whose actions
write to the hot store, resurrecting the row on any interaction.
**Fix:** render derived-store rows read-only, or route their writes to the
correct partition.

---

## 7. UI-snapshot staleness

### 7.1 A write built from a stale UI snapshot reverts a just-pulled edit
**Mistake:** an action (reorder, bulk edit) writes rows built from a **UI state
snapshot** captured earlier. A background pull updated those rows in between; the
action writes the stale snapshot back, reverting the pulled edit and propagating
the reversion under LWW.
**Grep/read for:** writes that spread a component/state snapshot back into the
store (`put({...snapshotRow, oneField})`), especially bulk/reorder operations.
**Fix:** re-read each row **fresh from the store** immediately before writing, and
change only the field you mean to change.

### 7.2 Reorder/positioning rewrites siblings wholesale
**Mistake:** reordering a list rewrites every sibling's position as a whole-row
save, clobbering concurrent edits to those siblings (see 1.1, 7.1).
**Fix:** re-read fresh + change only `position`; minimize how many rows a single
reorder rewrites (gap/fractional positions rewrite one row instead of N).

---

## 8. Nothing triggers a sync after a change

**Mistake:** the only automatic sync is on app launch / a long timer. A change on
one device is invisible to others for minutes (or until an app relaunch), which
also **widens every LWW race window** above.
**Grep/read for:** who calls `sync()` — only app start / a 15-min timer?
**Fix:** a debounced, coalesced, self-mutexed "sync soon" triggered after every
mutation (online + not-offline-mode gated).

---

## 9. The meta-bug: a sync test harness that can't fail

**This is the most important item.** The reason all of the above shipped is that
the previous test harness gave false confidence.

### 9.1 The false-green harness
**Mistake:** "two-device" tests that use **one** client store, wiped and
re-pulled from scratch to simulate "device B". That can never test **two live
stores converging** — the only thing that matters — and it passes precisely
because it never runs the scenario that fails. A backup/restore round-trip
wearing a two-device costume.
**Grep/read for:** sync tests that clear local state + reset cursors to fake a
second device; tests that assert "A equals B" without ever checking the server;
tests with no concurrency.
**Fix — three non-negotiables:**
1. **Two genuinely independent client contexts** (real separate stores), both
   against a **real** server, exercising the **production** code path (service
   worker / real sync-URL resolution included).
2. **A multi-way oracle:** assert device A **and** device B **and** the server —
   the server **twice** (what it *serves* via pull and what it *stores* on disk,
   cross-checked) — with **exact type checking** (`1`≠`"1"`, `true`≠`1`,
   `null`≠`undefined`≠absent, `[]`≠`null`, float-exact), tombstones and cursors
   included. Also assert against the **intended value**, not just "all three
   agree" — a field erased on push makes all three agree on the *erased* value.
3. **A sabotage suite that proves the harness can go red:** inject known faults
   (drop a row from the push/pull, null a field on the wire, retype a value,
   inflate the cursor, skew a clock, hard-delete without a tombstone, duplicate a
   tuple, HTTP 500) and assert the oracle **detects every one**. A run that
   isn't "N/N faults detected" is reported **untrustworthy**, not green.

### 9.2 Supporting techniques that made bugs reproducible
- **A whole-DB isolation diff:** after a case changes one field of one row, the
  total delta across *every* store on both devices must be **exactly** that
  change. This is what catches collateral damage (a reconcile restamping
  unrelated rows, a pull clobbering a local field). Most real data loss shows up
  here, not in the targeted assertion.
- **Structural invariants** run on every converged state: referential integrity
  across every FK, one canonical row per logical singleton, uniqueness tuples.
- **Deterministic reproduction of races** via a tiny **test-only seam** in the
  server (a hook fired between per-table pull queries) to inject a mid-pull
  commit — turning a timing-dependent race into a red-before/green-after test.
- **Red-before/green-after discipline:** every fix has a test that failed before
  it and passes after; verified *both* directions (revert the fix, watch it go
  red). Findings that can't be reproduced this way are marked *plausible*, not
  *fixed* — one audit finding ("legacy row missing a NOT-NULL-with-default column
  500s the batch") turned out to be a **false positive** (the DB's upsert already
  substitutes the default) and was only caught by writing the failing test first.
- **On-load determinism:** the app mutated its own DB on page load (auto-sync,
  auto-archive, reconcile-on-read, first-run writes), so no snapshot was stable.
  A test-mode flag gates every on-load side effect; that the app *can't be
  observed without mutating synced data* is itself a finding.

---

## 10. A 30-minute audit checklist for your codebase

1. **Search conflict resolution:** find where `updated_at` (or version) is
   compared on push (server) and apply (pull, client). Do the tie operators
   agree (1.2)? Does the loser adopt the winner (1.3)? Is the row the unit,
   clobbering sibling fields (1.1)?
2. **Search for `now`/`Date.now()` in dedup/reconcile/heal code (3.1, 3.5).**
   Any fold that re-saves a survivor with a fresh timestamp is a data-loss bug.
3. **Search for `localeCompare`/locale-aware sorts choosing a canonical row
   (3.4).**
4. **Read the pull handler:** is it one snapshot/transaction, or many queries
   with a shared high-water cursor (2.1)?
5. **Read the push handler:** does one bad row abort the batch (4.1)? Do missing
   keys become NULL/erasure (4.2)?
6. **Read import/restore:** LWW on merge (5.1)? Cursor reset on full restore
   (5.2)? Row validation (5.3)?
7. **Find any hard-delete of a synced row** that keeps it on the server (6.1).
8. **Find writes built from UI/state snapshots**, especially reorder/bulk (7.1).
9. **Find who triggers sync** — only launch/timer (8)?
10. **Look at the sync tests:** do they run two *live* stores, check the server,
    type-exactly, under concurrency, with a sabotage suite that proves they can
    fail (9)? If not, **do not trust any green result** — build that first, then
    re-audit 1–9 with it.

The order that matters: **build the trustworthy harness first (9), then fix
1–8 with red-before/green-after tests.** Fixing sync bugs without a harness that
can prove it caught them just moves the data loss somewhere you can't see.
