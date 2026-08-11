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
- **Automatically title bare links** (Settings → Link handling) is switched
  off, or
- the site blocks automated fetches (some do).

Untitled links aren't stuck, though: readerr retries them **every time you
open the Backlog page** (only there) while online, so they usually sort
themselves out. You can always click a link's title to edit it by hand — a
hand-edited title is authoritative and won't be overwritten.

One historical quirk: titles containing an apostrophe used to arrive
truncated ("it doesn"). That's fixed on the server side — if you still see
it, your sync server needs updating.

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
won't overwrite a 1 or 2 you'd set earlier. The one exception: an explicit
`!priority=3` on the line *does* mean "reset this" — it knocks an existing 1
or 2 back to the default.

## Closing a week "lost" some links

Closing a week doesn't delete anything — it **sorts** the week's links:

- favourited or written-about links stay in your library as **read**,
- read-but-unremarked links go to the **Slush** (Collections → Slush), and
- unfinished links roll back to the **Backlog**.

If a read link vanished, it's almost certainly in the Slush. Favourite it or
file it in a topic before closing if you want it kept as read.

Reopening a closed week shows only what you actually read — the rolled
entries are removed from the week itself (the links are safe in the Backlog).

## A link disappeared when I ticked it read

The **✓** on a Backlog or Favourites row doesn't just mark the link read — it
files it into the current week as done, and the entry completes on the spot,
so the link is **slushed immediately** unless it's favourited or in a topic.
It moved to the **Slush** (Collections → Slush); it isn't gone. Unticking
pulls it back, and favouriting it or filing it in a topic first keeps it as
*read* instead.

## "Last week couldn't be closed yet"

With sync on, a device won't close a stale week until it hears from the sync
server — another device might have closed that week already. The week stays
open, and closes automatically after the next successful sync. Nothing is
lost in the meantime. If the server is gone for good, turn sync off in
**Settings → Sync** and the week closes locally.

## The ＋ button isn't on every page

The floating **＋** capture button appears on pages that *don't* already have a
capture box. The Reading List and Backlog have their own box at the top, so
they don't show the ＋ — use the box that's already there.

## I chose "Use local data" and rows I wiped reappeared

The **Use local data** conflict option wipes the server and repopulates it
from the device you're on. Other devices notice the reset on their next sync
and re-sync from scratch — they won't be left on stale data. But they'll also
push their own copy back up, so rows you wiped can reappear. If you want one
dataset to win everywhere, use **Use local data** here and then **Use server
data** on each other device (or prefer **Merge both** and delete what you
don't want).

## Changes on one device aren't showing on another

Edits push to the server within about a second (and flush when you close the
tab or come back online) — it's *pulling* that's throttled, to roughly every
15 minutes. So open **Settings → Sync** and hit **Sync now** on the device
that's *missing* the change. Also check the sync status there — a failed sync
(wrong URL, server down) is shown with an explanation.

## The app looks broken after an update (developers)

If you run a dev build and pages come up blank after changing code, a leftover
**service worker** from a production build on the same address may be serving
stale files. Clear site data for the origin, or use a fresh browser profile.
This only affects local development, not the deployed app.
