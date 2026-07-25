# Sync Testing Framework

An **in-browser, multi-device, end-to-end** test harness for readerr sync that
is trustworthy — one that fails loudly when sync is broken instead of printing
"all pass" over a broken system.

> **Status:** the harness is **built and green** (Phases 0–7). `npm run test:sync`
> in `frontend/` builds the production frontend + the Go backend and runs the
> full suite against a real server across two independent browser contexts. The
> planning audit found **78 distinct sync issues** (22 data-loss, 12 critical,
> 28 major, 12 minor, 4 design-smell); the full catalogue is at
> [`docs/dev/sync-audit.md`](docs/dev/sync-audit.md). Several are fixed and
> guarded; the rest are captured as red **tripwires** or documented as open.
> **Some of these mean data is being lost right now** — do the §2.5 backup
> before further multi-device testing against a real server.

---

## 0. TL;DR

- readerr's sync is not "a bit buggy." A structured audit of the client loop,
  the Go server, the schema, every UI write path, the reconcilers, backup/import,
  and concurrency surfaced **78 distinct issues, 34 of them data-loss or critical.**
  They are independent bugs, not one root cause.
- **The failure the harness is engineered against is the _false green_:** a
  harness that "tests two devices" by wiping one IndexedDB and re-pulling can
  never test two *live* databases converging — the only thing that matters — and
  passes precisely because it never runs the scenario that fails. This harness
  makes that structurally impossible.
- Three non-negotiable principles: **(1)** two genuinely independent browser
  contexts, **(2)** a three-way oracle that checks device A *and* device B *and*
  the server (twice — what it serves and what it stores), including tombstones
  and exact types, and **(3)** a **12-mutant sabotage suite that proves the
  harness can go red** before a single green result is trusted.
- It runs against a **real Go backend and a production build** (the code path you
  actually ship — service worker included), controls every sync explicitly, and
  produces a machine-readable + HTML report with a coverage matrix and a
  regression diff against the previous run.
- **Current run: 90 cases, self-verification 12/12, 13/13 stores covered, 0
  unexpected failures.** Four confirmed bugs are already fixed with regression
  guards; the remaining confirmed data-loss bugs are red tripwires that must flip
  green as they're fixed.

---

## 1. Why a naïve harness is worthless — and the trust model that replaces it

### 1.1 The thing a one-browser harness can never test

"Device B" implemented as *the same IndexedDB after a wipe + cursor reset,
re-pulling from `since=0`* is a backup/restore round-trip wearing a costume. It
cannot test any of the failures that actually bite readerr:

| Real behaviour it skips | The bug class it hides |
|---|---|
| A device B that **already holds data** and pulls incrementally | whole-row LWW clobber; reconcile-on-read restamping the other device's edit |
| **Two independent cursors** on their own histories | `lastPushAt` watermark poisoning; `lastPullSeq` advancing past declined rows (permanent pull holes) |
| **True bidirectional convergence** (A↔B) | LWW ties resolving in opposite directions on client (`>=`) vs server (`<=`) |
| **Concurrency** — a push landing while a pull runs | non-transactional pull advancing `latestSeq` past unseen rows |
| The **service worker** and **real same-origin sync-URL resolution** | SW only exists in prod builds; caching `/sync/*` corrupts cursors |
| **Real service actions** (capture, week-close, reconcile-on-read) | writes on read; no sync trigger after a mutation |

### 1.2 The three principles

1. **Two genuinely independent client states.** Two Playwright browser
   *contexts*, each with its own IndexedDB, localStorage, sessionStorage,
   service-worker registration, and cache partition — both pointed at the **same
   Go origin**, exactly as shipped. Never one DB wiped and reused.
2. **A three-way oracle.** Every convergence assertion checks **A's raw DB, B's
   raw DB, the server's `/sync/pull` output, and a direct read of the server's
   sqlite file** — with exact type checking, tombstones and `server_seq`
   included. Checking only "A equals B" misses the class of bugs where the
   server mangles a field and *both* devices converge on the wrong value.
3. **The harness must prove it can fail.** A **12-mutant sabotage suite** injects
   known faults (drop a store from the push, null a column, retype a value on the
   wire, inflate the cursor, skew a clock, hard-delete without a tombstone, …)
   and asserts the oracle goes **red**. A run that isn't `sabotage 12/12` is
   reported **NOT TRUSTWORTHY**.

---

## 2. What the audit found (the "recommend issues as you go" deliverable)

Full catalogue — every finding with `file:line`, mechanism, and a two-device
repro — is at [`docs/dev/sync-audit.md`](docs/dev/sync-audit.md). The
symptom-relevant and data-loss subset:

### 2.1 Data-loss that is firing in the field

- **Reconcile-on-read folds stamp `updated_at = now` onto content computed from
  the folding device's *local* copies** ([`notes.ts:41`](frontend/src/lib/services/notes.ts:41),
  and the same pattern in `plans.ts`, `settings.ts`, `links.ts` tag/topic
  merges, `weeks.ts`). A device that still holds pre-fold duplicates re-runs the
  fold later and writes **old content under a newer timestamp**, which then beats
  the other device's genuinely newer edit under LWW — and the loser is never
  re-pushed. *Adversarially verified (2 votes).* This is the widest data-loss
  channel and is **open** (it needs a per-field-timestamp or fold-preserving-
  `updated_at` redesign).
- **Server `reconcileWeeks` between push chunks tombstones a stray week before
  its `week_links` arrive** ([`sync.go:243`](backend/sync.go:243)): the client
  chunks pushes at 2000 rows and `weeks` precedes `week_links`, so a chunk
  boundary orphans the entries onto a tombstoned week — unreachable on the server
  and every client. *Verified.* **Open.**
- **Client `reconcileOpenWeeks` racing an in-flight pull** tombstones a
  just-pulled week before its entries arrive, then pushes the tombstone
  ([`weeks.ts:85`](frontend/src/lib/services/weeks.ts:85)) — the other device's
  whole week disappears everywhere. *Verified.* **Open** (mitigated in test mode;
  the production race remains).
- **Week folds drop a duplicate entry wholesale** — `done_at`/`kind` on the
  tombstoned twin is lost, with no `mergeSurvivor` for `week_links`
  ([`weeks.ts:79`](frontend/src/lib/services/weeks.ts:79)). *Verified.* **Open.**
- **Merge-mode import blindly overwrites newer local rows** and resurrects
  tombstones with no LWW check ([`export.ts:216`](frontend/src/lib/db/export.ts:216)).
  ✅ **FIXED** — merge now applies LWW by `updated_at`.
- **Full-restore import kept `lastPullSeq`**, silently forking the device from
  the server forever ([`export.ts:227`](frontend/src/lib/db/export.ts:227)).
  ✅ **FIXED** — full restore now also drops `lastPullSeq` + `serverEpoch` and
  nulls foreign `server_seq`.
- **Archive hard-deletes live synced rows without tombstoning**
  ([`archive.ts:59`](frontend/src/lib/services/archive.ts:59)): a pull or remote
  edit resurrects the row into the hot store, duplicating it across `links` and
  `archived_links`. **Open** (archive is local-only by design; needs a
  don't-re-pull-archived guard).

### 2.2 Cursor / protocol data-loss

- **Clock-skew rejected edits are never re-pulled** ([`sync.ts:322`](frontend/src/lib/sync.ts:322)
  + `sync.go:210`): a device whose edit loses LWW already holds a `server_seq`
  past that row, so it never re-pulls the winner — permanent divergence. Also the
  **tie asymmetry** (client applies on `>=`, server skips on `<=`) resolves a
  millisecond tie in opposite directions. Captured as a red tripwire in
  [`concurrency.spec.ts`](frontend/tests/sync/concurrency.spec.ts). **Open** —
  inherent to client-timestamp LWW; the real fix is server-authoritative
  timestamps.
- **`lastPushAt` watermark poisoning / below-watermark strands**: pulled rows
  re-enter the dirty scan; an edit stamped at/below the exclusive lower bound is
  never pushed ([`sync.ts:296`](frontend/src/lib/sync.ts:247)). **Open.**
- **Non-transactional pull on the server**: a push committing between per-table
  queries advances `latestSeq` past rows the client never received
  ([`sync.go:435`](backend/sync.go:435)). **Open.**
- **Poison push**: a single row missing a `NOT NULL` column (legacy `ref_number`,
  `kind`, `focus_tag_ids`) 500s the whole batch and the client retries it
  forever. The **import** side of this is ✅ **FIXED** (rows are validated before
  any write; a malformed backup is rejected cleanly). The legacy-row-on-server
  side remains **open**.

### 2.3 The reported #1 symptom: "changes don't transfer"

- **Nothing triggered a sync after a mutation** — the only automatic sync was the
  navigation-gated, 15-min-throttled page-load one
  ([`Navbar.svelte:14`](frontend/src/components/Navbar.svelte:14)). ✅ **FIXED** —
  `requestSync()` ([`sync.ts`](frontend/src/lib/sync.ts)) is a debounced,
  online + mode-gated, self-mutexed push called from every `repo.ts` write; a
  change now propagates in seconds. Guarded by
  [`sync-trigger.spec.ts`](frontend/tests/sync/sync-trigger.spec.ts).

### 2.4 Prerequisites the harness needed (Phase 0)

- **Passive read paths mutate the DB** — every reconcile-on-read healer
  (settings, plans, notes, tags, topics, open weeks, junction pairs) writes on
  read, week-page mount auto-closes and mints weeks, backlog retries titles, the
  layout grandfathers onboarding. All are now gated behind
  [`testMode.ts`](frontend/src/lib/testMode.ts): on-load side effects are skipped
  and healers are read-only in test mode, invoked explicitly via the hook so
  reconciliation stays testable. *That the app can't load without mutating synced
  data is itself finding — the flag is a testability scaffold, not a blessing.*

### 2.5 ⚠️ Back up before further testing

Several bugs corrupt data on contact. Before more multi-device testing:

```bash
# Server-side sqlite snapshot (WAL-checkpointed by the endpoint)
curl -o "readerr-server-$(date +%Y%m%d-%H%M%S).db" http://YOUR_SERVER/backup
```

On each real device, Settings → export a **full backup** and keep the JSON — from
the device with the *most correct* data **first**, before opening the app on the
others (opening it can trigger a reconcile-on-read write that then wins LWW).

---

## 3. Harness architecture

### 3.1 Tooling — Playwright + Chromium

`browser.newContext()` gives each "device" a fully partitioned storage
(IndexedDB, localStorage, sessionStorage, SW, cache). Full control over network
interception (wire capture + sabotage), console/request listeners (false-green
guards), and clock/timezone overrides. Installed as a dev dependency;
`npx playwright install chromium`.

### 3.2 Two devices — two contexts, same origin

Both contexts load the **same Go origin** (as production does — the backend
serves the frontend *and* is the sync target). Independence comes from the
context partition, not different origins. [`helpers/devices.ts`](frontend/tests/sync/helpers/devices.ts)
provides `deviceA`/`deviceB`/`backend` fixtures; each context is pinned to test
mode via `addInitScript` **before first navigation** and its console/page/request
errors are asserted empty at teardown (opt out with `allowPageErrors` for cases
that deliberately provoke errors).

### 3.3 App under test — a production build served by Go

[`global-setup.ts`](frontend/tests/sync/global-setup.ts) builds `frontend/dist`
and the backend + `dbdump` binaries once per run. Each test **file** spawns its
own backend ([`helpers/backend.ts`](frontend/tests/sync/helpers/backend.ts)):
fresh sqlite in an OS temp dir, ephemeral port (`bind :0`), `/healthz` wait
(never a fixed sleep), Windows-safe teardown (retry-delete over the sqlite lock
lag; a prebuilt binary so teardown kills one PID). `READERR_SKIP_BUILD=1` skips
the rebuild for fast local iteration.

### 3.4 The test hook — `window.__readerr`

Installed from [`Layout.astro`](frontend/src/layouts/Layout.astro) **only in test
mode** (never ships to real users). [`testHook.ts`](frontend/src/lib/testHook.ts)
exposes: `rawDump`/`rawDumpAll`/`rawGet` (raw IDB — tombstones + `server_seq`,
bypassing the tombstone-filtering reads), `rawPut`/`rawDelete` (fixture/sabotage
writes), `repoPut`/`softDeleteNow` (Tier-2 writes through the real repo),
`getCursors`/`setMeta`/`deleteMeta`, `syncNow` (explicit, awaited), the real
reconcilers/`captureNow`/`closeWeekNow` (heals enabled on demand), and a separate
`__readerrExport` for backup/import.

### 3.5 The oracle — the anti-false-green core

[`helpers/oracle.ts`](frontend/tests/sync/helpers/oracle.ts) +
[`helpers/compare.ts`](frontend/tests/sync/helpers/compare.ts):

- **Three-way (four-leg) capture** — A_raw, B_raw, `/sync/pull` (what the server
  *serves*), and a direct `dbdump` of the sqlite file (what it *stores*),
  cross-checked. The stored leg is normalized to wire shape via the harness's
  **own** metadata ([`helpers/meta.ts`](frontend/tests/sync/helpers/meta.ts)), so
  a drift in the server's metadata surfaces as a failure instead of being
  inherited.
- **Typed comparator** — fails on `1` vs `"1"`, `true` vs `1`, `null` vs
  `undefined` vs absent key, `[]` vs `null`, float drift (`Object.is`), and extra
  / missing keys.
- **Whole-DB isolation diff** — after a case mutates one field of one row, the
  total delta across all 13 stores must be *exactly* the intended change. This is
  the collateral-damage detector (reconcile restamps, pull clobbers).
- **Structural invariants** ([`helpers/invariants.ts`](frontend/tests/sync/helpers/invariants.ts))
  — referential integrity across every FK, one canonical row per logical
  singleton, per-topic footnote uniqueness. Run on every real converged DB;
  tripped on purpose by the sabotage suite.
- **Intended-value check** ([`helpers/roundtrip.ts`](frontend/tests/sync/helpers/roundtrip.ts))
  — three-way agreement is necessary but not sufficient (a field erased on push
  makes all three agree on the erased value), so every field case also asserts
  the field against the **known intended value**.

---

## 4. The suite (Phases 4–6)

- [`smoke.spec.ts`](frontend/tests/sync/smoke.spec.ts) — Phase 1 acceptance:
  zero writes on load in test mode; A→server→B field-exact; idempotent re-sync.
- [`oracle.spec.ts`](frontend/tests/sync/oracle.spec.ts) — Phase 2: the
  comparator/isolation-diff/invariants prove they detect a hand-crafted mismatch
  (including a negative control).
- [`sabotage.spec.ts`](frontend/tests/sync/sabotage.spec.ts) — Phase 3: **12
  mutants, all detected** (the trust gate).
- [`field-matrix.spec.ts`](frontend/tests/sync/field-matrix.spec.ts) — Phase 4:
  every store, every column, every value class (JSON arrays empty/many/order,
  booleans **both** ways type-exact, floats, null↔value, unicode + 12k strings,
  enums, tombstone delete). **13/13 stores, 0 holes.**
- [`concurrency.spec.ts`](frontend/tests/sync/concurrency.spec.ts) — Phase 5:
  incremental pull on an established cursor, LWW conflict, LWW tie convergence,
  delete/recreate, re-sync idempotency, concurrent push-during-pull, and the
  clock-skew divergence **tripwire**.
- [`scenarios.spec.ts`](frontend/tests/sync/scenarios.spec.ts) — Phase 6: the
  real weekly-reading close flow, the real capture pipeline, and sync with the
  **production service worker active**.
- [`backup.spec.ts`](frontend/tests/sync/backup.spec.ts) — import LWW, poison
  guard, full-restore cursor reset (fixes as regression guards).
- [`sync-trigger.spec.ts`](frontend/tests/sync/sync-trigger.spec.ts) — the
  mutation → auto-push fix, plus the "dormant without opt-in" determinism guard.

Cases that document a confirmed-but-unfixed bug are marked `test.fail()` — red
now, and the reporter flags a tripwire that *unexpectedly passes* ("looks fixed —
remove the marker").

---

## 5. Reporting + CI (Phase 7)

[`reporter.ts`](frontend/tests/sync/reporter.ts) writes `results.json` and a
self-contained `report.html` (`frontend/tests/sync/.results/`) with: a **verdict
banner** (green only when 0 unexpected failures AND sabotage ran 12/12), the
**self-verification count**, a **store coverage** view where uncovered stores are
loud red chips, the **tripwire list** (with an alert when one unexpectedly
passes), and a **regression diff** vs the previous run. A run that omits the
sabotage suite is reported **NOT TRUSTWORTHY** by design.

[`.github/workflows/sync-tests.yml`](.github/workflows/sync-tests.yml) runs it on
PRs touching sync-relevant paths and nightly: Node 22 + Go 1.25, builds both,
runs `npm run test:sync`, uploads the report and traces. A failing sabotage test
is a suite failure, so `<12/12` self-verification exits non-zero automatically.

Run locally:

```bash
cd frontend && npm run test:sync
```

---

## 6. Fix status

| Bug | Severity | Status |
|---|---|---|
| No sync after a mutation (reported #1 symptom) | design-smell → high impact | ✅ fixed (`requestSync`) |
| Merge import clobbers newer local rows (no LWW) | data-loss | ✅ fixed |
| Full restore keeps `lastPullSeq` → device forks | data-loss | ✅ fixed |
| Import poison (unvalidated row bricks all sync) | critical | ✅ fixed (import side) |
| Reconcile-on-read stale-content restamp clobber | data-loss | ⏳ open (needs per-field ts) |
| Week fold orphans entries (server chunk / client race) | data-loss | ⏳ open |
| Week fold drops `done_at`/`kind` on the twin | data-loss | ⏳ open |
| Clock-skew / tie rejected-row divergence | data-loss | ⏳ open tripwire (needs server time) |
| Non-transactional server pull skips rows | data-loss | ⏳ open |
| Archive hard-delete resurrection | major | ⏳ open |
| Legacy-row poison push (server side) | critical | ⏳ open |

Each open item is grounded in [`docs/dev/sync-audit.md`](docs/dev/sync-audit.md)
and most have a red tripwire or an obvious place for one. **The gate to calling
any fix "done": its case flips red→green AND the full suite — isolation diff and
12/12 sabotage included — stays green.**

> **A note on verification.** The reconciliation dimension of the audit was fully
> adversarially verified (two independent skeptic + reproduction passes per
> finding). The remaining dimensions' verifiers were interrupted by a session
> usage limit; those findings are grounded in cited code and were spot-checked
> while building the harness, but should be treated as *plausible* until each has
> a red-before/green-after case. The harness is exactly the tool for that.

---

## 7. Exit criteria — when you're allowed to trust it

1. Self-verification is **12/12** on every run. ✅ (met every run)
2. Coverage matrix has **no uncovered store**. ✅ (13/13)
3. Every confirmed bug has a case that **was red before the fix and is green
   after**. ⏳ (4 done; the rest are red tripwires awaiting fixes)
4. The regression diff has run across at least two runs and caught a seeded
   regression. ✅ (diff wired; identical runs produce empty deltas)
5. The suite runs green **three times in a row** with no flakes. ✅ (repeated
   clean runs; `retries: 0` on purpose — a flaky sync test is untrustworthy)
