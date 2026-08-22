# Getting started

## Opening readerr for the first time

The first time you open readerr you'll see a short **onboarding** flow. You
have three ways in:

- **Show me around** — a quick guided walkthrough of the main features.
- **Start from scratch** — skip straight to an empty app.
- **Sync from existing server** — if you already run readerr on another device
  or a server, paste its address and pull everything down (see
  [Sync & backups](sync-and-backups.md)).

You can also **import a backup file** from the welcome screen, or revisit
onboarding any time at `/onboarding` (jump to a specific step with
`/onboarding?page=2`).

Everything you do is saved **in this browser**. There's no account and no
server required. If you want the same data on your phone and laptop, that's
what syncing is for — but it's entirely optional.

## The two homes: Reading List and Backlog

- **Reading List** (the home page) — the links you've lined up to read *this
  week*.
- **Backlog** — everything you've saved that isn't scheduled yet. This is
  where new links land.

Both pages have a **capture box** at the top, and every other page has a
floating **＋ button** in the bottom-right corner that opens the same box —
so you can save a link from anywhere.

## Capturing your first links

Paste one or more URLs into the capture box (one per line) and hit **Add**.
readerr accepts a few formats, and mixes them freely:

```
https://example.com
- https://example.com
[A nice title](https://example.com)
* [A nice title](https://example.com)
```

- Duplicates are detected automatically — pasting a link you already saved
  won't create a second copy (it just updates the existing one).
- Page **titles fill themselves in** a moment after you add a bare URL (this
  needs a sync server, a connection, and **Automatically title bare links**
  left on in Settings → Link handling — it's on by default; see
  [gotchas](gotchas.md#titles-arent-filling-in)).
- The links you just added appear in a **Just Added** list right under the
  box, so they're easy to find and open — handy when you've scheduled them
  for a future week.

Want to tag, prioritize, or schedule links as you capture them? That's all in
[Capturing links](capturing-links.md).

## Reading and finishing

1. Add links to a reading week (they default to the Backlog; pick a week in
   the capture box, or the app can suggest a weekly quota for you).
2. On the **Reading List**, open a link, read it, and click the **✓** to mark
   it read.
3. At the end of the week, hit **Close week**. Links you favourited or wrote
   about are kept as *read*; links you read but didn't remark on are set aside
   in the **Slush**; anything you didn't get to rolls back to the Backlog.
   (If sync is on, readerr checks with the sync server first — see
   [Organizing & reading](organizing-and-reading.md).)

The whole rhythm is covered in [Organizing & reading](organizing-and-reading.md).

## Where everything else lives

The **Settings** page (the gear icon) has: appearance and custom themes;
link handling (URL cleaning, auto-titles, the default capture week, tag-chip
ordering); sync configuration, including a per-device on/off switch; backups
and exports; storage; archival; and demo data to try things out, with options
to shape what gets generated. The nav's **Plans** and **Collections** menus
hold automation, upcoming weeks, the backlog, favourites, tags, topics,
resources, and the slush. **Inbox** sits in the top row: subscribe to a site's
RSS feed and triage what it brings in — see [The Inbox](inbox.md).
