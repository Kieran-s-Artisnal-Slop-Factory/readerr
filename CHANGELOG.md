# 0.3.0 (Unreleased)

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
- Stats gained a **Tag distribution** card: every tag's slice of the library,
  as a share of all tag assignments (adds up to 100%) *and* as a percentage of
  all links (adds up to more, since links carry several tags), plus how much of
  the library is tagged at all.

## Bug Fixes

## Other

- **Backlog** and **Favourites** moved into the nav's **Collections** menu —
  they are collections of links like Tags, Topics and Resources, and the top
  row now holds Reading List, Inbox and Stats.
- A design plan for handling multi-part **series** (part 1, part 2, …) is in
  [docs/dev/experiments & plans/series.md](docs/dev/experiments%20&%20plans/series.md),
  with an interactive prototype of its UI at `/series-demo/` — an unlisted page
  that stores its state in localStorage and never touches the database.
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