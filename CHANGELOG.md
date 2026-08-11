# 0.2.0 (Unreleased)

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
- Added a refactoring survey at docs/dev/experiments & plans/further-cleanup.md.

- Documented the `!list` capture command in the user capture guide and the DSL reference, and marked audit finding D14 (stale-week auto-close clobber) fixed in the sync audit.
- The sync test harness can now exercise REAL page-load behavior (test gates off) via a per-device real-mode switch — used to replay the stale-week incident end-to-end.

# 0.1.0 July 22nd 2026

- initial release