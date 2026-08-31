# readerr documentation

Two audiences, two folders:

## For using readerr → [`user/`](user/README.md)

Approachable guides to the app's features and the gotchas worth knowing —
capturing links, the weekly reading flow, organizing, syncing across devices,
and **how to run your own sync server**.

- [User guide index](user/README.md)
- [Getting started](user/getting-started.md)
- [Capturing links](user/capturing-links.md)
- [The Inbox](user/inbox.md) — subscribing to RSS/Atom feeds and triaging what arrives
- [Organizing & reading](user/organizing-and-reading.md)
- [Tagging](user/tagging.md) — tags, and nesting them under parent tags
- [Sync & backups](user/sync-and-backups.md) — includes deploying a backend
- [Common gotchas](user/gotchas.md)

## For building / maintaining readerr → [`dev/`](dev/architecture.md)

Technical reference for a maintainer: architecture, the data model, the sync
protocol, the capture DSL internals, offline support, and deployment/CI.

- [Architecture](dev/architecture.md) — start here; has a "where to look when…" table
- [Data model](dev/data-model.md)
- [Tagging](dev/tagging.md) — tag storage, the nesting DAG, and its reconcilers
- [Topics](dev/topics.md) — statuses, topic tags, and how both fold across devices
- [Exports](dev/exports.md) — the shared tag/resource-list core and the table inlined in exported pages
- [Sync protocol](dev/sync.md)
- [Link DSL](dev/link-dsl.md)
- [Bulk operations & the link picker](dev/bulk-and-picking.md) — the shared adder/search component and batch edits
- [Offline support](dev/offline-support.md)
- [Seeding](dev/seeding.md) — demo/stress datasets and what the controls guarantee
- [Performance at scale](dev/performance.md) — measured page costs on a 77k-link library
- [Deployment & CI](dev/deployment.md)
- Design notes & task lists: [`dev/experiments & plans/`](dev/experiments%20%26%20plans/)
