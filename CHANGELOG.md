# 0.4.0 — Unreleased

## Features

* Link pickers now support **scrolling, pagination, and search results beyond the first 8**.
* Topics can be marked **In Progress** or **Done** and can now be tagged.
* Added **topic search, filtering, and bulk operations**.
* Bulk operations can now add links to **resource lists**.
* Added a new **Inbox** for RSS/Atom feed subscriptions and triage.
* Inbox feeds can work **without a sync server**, including offline/static-host deployments.
* Added **Series** for grouping multi-part content into a single link with progress tracking.
* Added **tag distribution statistics**.
* Added migration support for the new topic status and tagging features.
* Updated dependencies, including **TypeScript 7**.

## Bug Fixes

* Sync no longer attempts server requests when **no sync server is configured**.
* Added validation for invalid sync URLs.
* Bulk action controls now appear alongside the **selected items** instead of at the top of the page.
* Fixed older servers potentially **overwriting newer client fields** during sync.
* Fixed series parts appearing **twice in reading weeks**.
* Improved error messages for outdated or incorrectly configured sync servers.
* Fixed the service worker incorrectly caching feed responses.

## Other

* Moved **Backlog** and **Favourites** under the Collections menu.
* Added migration tests for both backend and IndexedDB upgrades.
* Added extensive test coverage for **Series, Inbox, syncing, and migrations**.
* Added a backend `/feed` endpoint supporting **RSS 2.0, Atom, and RSS 1.0/RDF**.
* Removed the temporary Series prototype now that the feature is implemented.

# 0.3.0 — August 22nd, 2026

## Features

* Added **Inbox** with RSS/Atom subscriptions, feed refreshing, and item triage.
* Added **Series** for multi-part content with progress tracking.
* Added tag search.
* Added offline-capable feed fetching.
* Added **Tag Distribution** statistics.

## Bug Fixes

* Fixed newer client data being lost when syncing with an **older server**.
* Fixed series parts appearing twice in reading weeks.
* Improved outdated-server error messages.
* Fixed feed responses being incorrectly cached.

## Other

* Reorganized navigation around **Collections**.
* Added comprehensive migration and multi-device tests.
* Added backend feed parsing and normalization.
* Removed the Series prototype and unused code.

# 0.2.0 — August 13th, 2026

## Features

* Past reading weeks now show only **completed reading activity**.
* Improved week date labels across month boundaries.
* Added bulk **tracking-parameter stripping** for existing links.
* Capture can now add links directly to **resource lists**.
* Added a **sync on/off toggle** for fully local operation.
* Tracking-parameter stripping is now configurable.

## Bug Fixes

* Fixed stale reading weeks potentially **overwriting history from other devices**.
* Fixed competing background sync operations.
* Offline edits now sync automatically when connectivity returns.
* Fixed edits being lost when leaving the page before a background sync completed.
* Fixed page titles being truncated at apostrophes.

## Other

* Improved reading-list performance on large libraries.
* Fixed a CI race condition in the sync test harness.
* Updated documentation and code comments throughout the project.
* Expanded sync testing to cover real page-load behaviour.

# 0.1.0 — July 22nd, 2026

* Initial release
