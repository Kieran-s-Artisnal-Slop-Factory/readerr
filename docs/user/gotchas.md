# Common gotchas

A short list of things that surprise people, and what's actually going on.

## Titles aren't filling in

When you paste a bare URL, readerr shows the URL as the title and fills in the
real page title a moment later. That title fetch needs **a sync server and an
internet connection** — the browser itself can't read most other sites'
pages (they block it), so the server does it.

So titles won't resolve when:

- you're in **offline mode** (no server configured), or
- you're **temporarily offline**, or
- the site blocks automated fetches (some do).

Untitled links aren't stuck, though: readerr retries them **every time you
open the Backlog** while online, so they usually sort themselves out. You can
always click a link's title to edit it by hand — a hand-edited title is
authoritative and won't be overwritten.

## My data disappeared / the browser cleared it

readerr stores everything in the browser's local database, which browsers may
**evict** under storage pressure — iOS Safari is the notable offender, wiping
it after about a week of inactivity unless the app is installed.

Protect yourself:

- **Install it as an app (PWA)** — this makes storage durable and lets it load
  offline. Use your browser's "Install" / "Add to Home Screen" option.
- readerr asks for **persistent storage** during onboarding; you can re-request
  it in **Settings → Storage**, which also shows whether it was granted.
- **Sync to a server** or take periodic **JSON/Markdown backups**
  ([Sync & backups](sync-and-backups.md)). A server or an export file is the
  only copy that survives a browser wipe.

## A link I dragged in the Reading List jumped back

In the Reading List, **priority wins over drag order**. Sections are sorted by
priority (1 first), and *within* a priority your drag order is kept — so
dragging a link into a different priority group snaps it back. To move
something to the top for good, raise its **priority** rather than dragging it.

## I set priority "3" but nothing changed

Priority **3 is the default** — it means "no particular priority." Only 1 and 2
change where a link sorts and show a chip. Setting 3 explicitly is the same as
leaving it unset, and (deliberately) re-capturing a duplicate at priority 3
won't overwrite a 1 or 2 you'd set earlier.

## Closing a week "lost" some links

Closing a week doesn't delete anything — it **sorts** the week's links:

- favourited or written-about links stay in your library as **read**,
- read-but-unremarked links go to the **Slush** (Collections → Slush), and
- unfinished links roll back to the **Backlog**.

If a read link vanished, it's almost certainly in the Slush. Favourite it or
file it in a topic before closing if you want it kept as read.

## The ＋ button isn't on every page

The floating **＋** capture button appears on pages that *don't* already have a
capture box. The Reading List and Backlog have their own box at the top, so
they don't show the ＋ — use the box that's already there.

## I chose "Use local data" and another device is now out of date

The **Use local data** conflict option wipes the server and repopulates it from
the device you're on. That device is fine — but any **other** device that had
already synced will keep showing its old data, because it doesn't know the
server was reset. To fix an out-of-date device: re-onboard it with **Sync from
existing server**, or re-enter the server URL in its Settings and choose
**Use server data**. When in doubt, prefer **Merge both**, which never
strands a device.

## Changes on one device aren't showing on another

Background sync is throttled to about every 15 minutes. If you want to see a
change immediately, open **Settings → Sync** and hit **Sync now** on both
devices. Also check the sync status there — a failed sync (wrong URL, server
down) is shown with an explanation.

## The app looks broken after an update (developers)

If you run a dev build and pages come up blank after changing code, a leftover
**service worker** from a production build on the same address may be serving
stale files. Clear site data for the origin, or use a fresh browser profile.
This only affects local development, not the deployed app.
