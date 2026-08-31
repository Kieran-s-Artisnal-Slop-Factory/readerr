# 0.4.0 (unreleased)

## Features

- **The link adder scrolls and pages.** "Paste a URL to add, or search your
  links…" — on the reading list, topics, and resource lists — was capped at
  eight results with no way to reach the ninth, so on a large library the link
  you wanted was often simply unreachable. It is now one shared component with
  a scrollable list, twenty-five results a page, and a **Show more results**
  button. The corpus scan stops at the end of the page it is drawing, so
  widening stays cheap on a multi-thousand-link library.
- **Bulk operations can add links to resource lists.** The bulk panel gained a
  **Resource lists** group alongside Tags and Topics; adding also marks each
  link a resource, and adding a link that is already a member never creates a
  duplicate. Documented in
  [docs/dev/bulk-and-picking.md](docs/dev/bulk-and-picking.md).

## Bug Fixes

- **The bulk panel opens where you selected.** On the reading list it always
  appeared at the top of "This week", so ticking rows in the **Done** section
  meant scrolling back up past everything to reach the controls. It now
  renders in whichever section holds the selection.

- **Sync only runs when there's a server to sync with.** With no sync URL
  configured the app fell back to same-origin and fired `/healthz`,
  `/sync/stats`, `/sync/push` — plus `/feed` on the Inbox page — at a host
  that answers none of them, filling the console with unfixable errors. The
  app now probes same-origin `/healthz` once per browser session and, if
  nothing readerr-shaped answers, skips every sync, feed, title and database-
  size request. The blank-URL default still works for the Docker deployment,
  where the backend serves the frontend from the same origin. Settings and
  Onboarding also reject a URL that isn't a valid `http(s)` address instead of
  saving a typo as the sync target, and Settings now says outright when sync
  is off for want of a server.

## Other

- Dependency refresh across both halves. Frontend: Astro 7.0.6 → 7.2.9, Svelte
  5.57, Milkdown 7.22, CodeMirror/marked/vitest/Playwright patch-minors, and
  TypeScript 6 → 7 (the major was trialed against the full unit suite and a
  production build — both green, so it stays). Backend: `modernc.org/sqlite`
  1.53.0 → 1.57.0 with transitive updates; `go test ./...` green. Nothing held
  back.

# 0.3.0 August 22nd 2026

## Features

- New **Inbox** tab: subscribe to RSS/Atom feeds and triage what they bring in.
  Each item is one of three things — **→ the reading week**, **→ Backlog**, or
  **Ignore** — and items already in your library never appear at all. Feeds are
  checked once a day per device when you open the page, with manual **Refresh**
  per feed and **Refresh all**; feeds can be renamed, paused, or removed
  (removing one takes its untriaged items, not the links you saved). Adding a
  feed asks how much history to pull in (default 30 days, "nothing" for
  new-posts-only), and that window is remembered so later refreshes never drag
  in the back catalogue. Subscriptions and triage decisions sync across
  devices; the **Added** / **Ignored** views keep a "back to inbox" undo.
  Fetching goes through the backend (browsers can't read another site's feed),
  so the inbox is read-only in offline mode. Documented in
  [docs/user/inbox.md](docs/user/inbox.md).
- The tags page gained a **search box** — it filters by name, and flattens the
  nesting while searching, since a match's parent may not itself match.
- **Series**: multi-part writing (part 1, part 2, …) is now one link that holds
  the others. **Add series** on the Backlog takes a title, description,
  overview URL, tags/topics and the parts — each with its position, URL, title,
  reading week and its own labels — and captures the lot in one pass (a part
  you already had joins the series instead of being saved twice). Because a
  series *is* a link, it can be favourited, tagged, prioritised, annotated and
  scheduled into a reading week as **one row, not five**. In every list it
  shows with a ▸ triangle and a `2/5` progress count; expanding it reveals the
  parts, each with its own ✓, and ticking the last one *offers* to mark the
  series read rather than deciding for you. A part is never listed twice — it
  sits inside its series when both are on screen. The series' own page manages
  membership: add by URL, reorder with ↑/↓, remove a part, or delete the series
  (its parts stay). A series' page is the ordinary link page — Overview
  document, excerpts, tags, topics, reading week and history all work exactly
  as they do for a link, because a series *is* one — and lists gained a
  **Series** filter so they're easy to find, alongside a
  **Collections → Series** index listing every series with its progress and a
  roll-up of parts read. Design and build notes:
  [series.md](docs/dev/experiments%20&%20plans/series.md).
- **The inbox no longer needs a backend.** With a sync server, feeds are
  fetched server-side as before; without one — offline mode, a static host, or
  a server too old to have `/feed` — the browser fetches and parses the feed
  itself (RSS 2.0, Atom and RSS 1.0/RDF, matching the backend's parser case
  for case). Sites that refuse cross-origin reads say so in plain terms
  ("your browser wasn't allowed to read example.com directly — the site
  doesn't send the CORS header that would permit it"), naming a sync server as
  the fix rather than leaving a bare status code. The daily check runs in
  offline mode too: that setting means "no server", not "no internet".
- Stats gained a **Tag distribution** card: every tag's slice of the library,
  as a share of all tag assignments (adds up to 100%) *and* as a percentage of
  all links (adds up to more, since links carry several tags), plus how much of
  the library is tagged at all.

## Bug Fixes

- **A server older than the app no longer erases the app's newest fields.**
  Pushing a row to a backend that predates one of its columns stored the row
  without that column and handed it straight back, and the client applied the
  short copy over its own — so a series created against a not-yet-rebuilt
  v0.2.0 backend lost `is_series` on the device that made it and silently
  became an ordinary link. Incoming rows are now merged over the local row
  rather than replacing it: every field the server sends still wins (explicit
  nulls included), and only fields it never sent survive. Found while
  rehearsing the v0.3.0 upgrade against a real database and a real
  pre-v0.3.0 binary; see [docs/dev/sync.md](docs/dev/sync.md#version-skew-an-incoming-row-is-merged-not-swapped-in).
- A part of a series no longer shows up twice in the reading week. Ticking a
  part inside its series row adds that part to the week like any other read
  link, so the week listed it again under Done; parts of a series that is
  itself in the week are now folded into that one row (and the week's counts
  follow what's on screen).
- The inbox's "sync server returned 404" now explains itself. A 404 on `/feed`
  is almost never about the feed: the endpoint ships with v0.3.0, so a server
  that answers `/healthz` but 404s `/feed` is simply older than the app and
  needs rebuilding — which the message now says, naming the URL it tried. A
  404 with no `/healthz` at all reports the sync URL as wrong instead.
- The service worker no longer caches `/feed` responses, which would have let
  a manual refresh replay the items it had already imported and call it a
  success.

## Other

- **Backlog** and **Favourites** moved into the nav's **Collections** menu —
  they are collections of links like Tags, Topics and Resources, and the top
  row now holds Reading List, Inbox and Stats.
- Two adversarial design reviews of the shipped UI live in
  [docs/dev/experiments & plans/design-critique/](docs/dev/experiments%20&%20plans/design-critique/):
  a first-time user's read of what the interface fails to explain
  (`laymen-critique.md`), a UI/UX review of hierarchy, affordance, feedback and
  accessibility (`professional-critique.md`), and `design-alternatives.html`,
  which renders each finding as the shipped implementation plus two or three
  alternatives using the app's own stylesheet.
- The migration path is now tested rather than assumed: `backend/migrate_test.go`
  proves an upgraded database ends up with the same columns, defaults and
  indexes as a freshly created one (and that existing rows keep their values
  while gaining `is_series = 0`), and `frontend/test/migration.test.ts` upgrades
  a populated v9 IndexedDB to the current version and checks every store,
  index and row survives.
- The `/series-demo/` prototype has been deleted now that the real feature
  exists — the plan it came from carries a "what actually happened" section
  instead. Trimmed with it: a handful of exports in the series and feed
  services that nothing outside their own module called.
- Series are excluded from the Stats **origins** table and the variability
  score — a series is a container, not something captured from a domain, and
  its parts are already counted.
- Series coverage across all three legs: unit tests for ordering, membership,
  deletion and creation; a multi-device Playwright spec (two devices appending
  at the same position still agreeing on the order, the same part added twice
  collapsing to one edge, a reorder propagating, a created series arriving as
  one week entry with its parts intact, and deletion leaving no dangling
  edges); plus `series_links` in the field matrix, the invariants
  (pair-uniqueness and no self-edges) and the store-coverage list.
- New backend endpoint `GET /feed?url=` parses RSS 2.0, Atom, and RSS 1.0/RDF
  into normalized JSON (with tolerant parsing, Latin-1 handling, and dates
  normalized to UTC), alongside the existing `GET /title`.
- Test coverage for the inbox on all three legs: Go tests for the feed parser
  and endpoint, vitest for import/triage/convergence rules, and a
  multi-device Playwright spec (duplicate subscriptions folding onto one feed,
  the same entry imported on two devices keeping its triaged state, triage
  propagating with its link and week entry, and unsubscribing leaving no
  orphaned items). The harness's field matrix, invariants, and store-coverage
  list now cover `feeds` and `feed_items`.


# 0.2.0 August 13th 2026

## Features

- Past weeks now show only what was actually read: opening a closed week removes any entries that were never finished (they had already returned to the backlog when the week closed), so old weeks stop accumulating unread leftovers.
- "Week of" labels show the whole span — "Week of August 3-9", or "Week of July 27-August 2" across a month boundary — on the reading list's week navigation and in Plans > Automation and Plans > Upcoming weeks.
- Settings > Link handling gained **Run stripping on existing links**: applies the configured tracking-param stripping to every link already saved (new pastes were already cleaned). Links whose cleaned URL would collide with another saved link are skipped and reported.
- The capture box can add links straight into **resource lists**: pick (or create) lists with chips like tags/topics, or per line with `!list=[name]` / `!l=[name]` in the capture DSL (a new name creates the list). List membership implies the resource flag — the ⚒ button lights up and stays locked while a list is selected.
- Settings > Sync gained an on/off toggle: turning sync off makes the device fully local-only (no background sync, and the weekly close runs from local data alone) until a server is configured again.
- The tracking-param stripping list is now configurable: Settings > Link handling accepts additional query params to strip on top of the built-in list (case-insensitive; a trailing `*` matches a prefix, like `sess*`). Applies to new captures, the bulk "Run stripping on existing links" pass, and whitelisted domains under full stripping.

## Bug Fixes

- Fixed a data-loss bug: a device opened after days away would auto-close its stale copy of the reading week before its first sync, overwriting the real history (done marks and read/slushed outcomes recorded on another device) on the server and every device. The reading list now syncs first and only closes a stale week after a successful sync; if the sync server can't be reached, the week stays open with a notice and closes automatically after the next successful sync. The manual "Close week" button gets the same protection (it adopts a close made elsewhere instead of overwriting it, and warns when the server can't confirm). Devices that have never synced to a server — and offline mode — keep closing locally as before.
- Background syncs no longer race each other: simultaneous sync triggers share one run, edits made during a long sync still push promptly afterwards, and switching sync servers in Settings/Onboarding always syncs against the newly configured server rather than a run that was already in flight.
- Edits no longer strand locally when the connection or the page goes away: writes made offline push automatically when connectivity returns, and a write made moments before closing or leaving the page is flushed immediately instead of dying with its debounce timer.
- Auto-title no longer truncates page titles at an apostrophe ("it doesn" for "it doesn't matter your rank"): the backend now matches quoted og:title values per quote style, and long titles truncate without splitting multi-byte characters.

## Other

- The reading list's last whole-library reads at scale are gone (~900ms at 77k links): the search box's corpus loads on first use instead of on every page load, backlog suggestions read through a new priority index with early termination, and capture-box chip ordering keeps a small local recency cache instead of scanning every tag/topic assignment. Existing chip ordering carries over via a one-time backfill.
- Fixed a CI flake in the sync test harness: backends now bind an OS-assigned port (PORT=0) and report the resolved address, instead of the probe-then-spawn allocation whose close-to-bind window let parallel workers collide ("bind: address already in use").
- Full documentation overhaul: every developer and user doc audited against the code and corrected — stale sync/week-close/DSL/migration claims fixed and the newer features (sync toggle, extra strip params, closed-week pruning, resource-list capture) documented. Code comments across frontend and backend brought back in line with current behavior, a handful of unused files and dead exports removed, and a refactoring survey added at docs/dev/experiments & plans/further-cleanup.md.

- Documented the `!list` capture command in the user capture guide and the DSL reference, and marked audit finding D14 (stale-week auto-close clobber) fixed in the sync audit.
- The sync test harness can now exercise REAL page-load behavior (test gates off) via a per-device real-mode switch — used to replay the stale-week incident end-to-end.

# 0.1.0 July 22nd 2026

- initial release