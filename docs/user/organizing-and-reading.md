# Organizing & reading

readerr is built around a weekly rhythm, with lots of optional structure on
top. This guide walks the whole loop and every organizing tool.

## The weekly reading flow

```
Backlog  →  Reading week  →  read it ✓  →  close the week  →  kept / slushed / rolled
```

1. **Pick links into a week.** Schedule them when you capture, drag them in
   from the Backlog, or let a **Plan** suggest a weekly batch (below).
2. **Read and mark done.** On the Reading List, the **✓** marks a link read.
3. **Close the week** with the button at the bottom. Each link gets an
   outcome:
   - **Read** — you favourited it or filed it in a topic. It stays in your
     library as read.
   - **Slushed** — you read it but didn't remark on it. It moves to the
     **Slush** (see below), out of the way but searchable.
   - **Rolled** — you didn't finish it. It simply returns to the Backlog.

Use **← Previous / Next →** on the Reading List to look at other weeks. Past
and future weeks are read-only; only the current week has the capture box,
suggestions, and Close button. A week whose Monday has already passed closes
itself automatically when you next open the app.

### Priorities

Give a link a priority of **1 (top)**, **2 (soon)**, or **3 (default)** — from
the capture box, the `!priority=` shortcut, or bulk-editing. Lists (Backlog,
Favourites, Resources, Slush, and each reading week) show **priority 1 first**,
then newest. Links show a small `P1`/`P2` chip so the order is legible;
priority-3 links show nothing.

> Note: in the Reading List, priority decides order *before* your manual drag
> order, so dragging a link across a priority group snaps it back. To move
> something up for good, raise its priority.

## Plans (automation)

**Plans → Automation** lets the app suggest what to read:

- **Defaults** — a weekly **quota** (e.g. "5 articles/week") and optional
  **focus tags**. On the Reading List, readerr suggests Backlog links to fill
  the quota, preferring your focus tags (and higher priorities first).
- **Scheduled plans** — override the defaults for a specific **week or month**
  (e.g. "next week is compilers, 3 articles"). A weekly plan beats a monthly
  plan beats the defaults, field by field.

**Plans → Upcoming weeks** shows a calendar strip of what's scheduled ahead.

## The Slush

Read-but-unremarked links land in the **Slush** (Collections → Slush). It's
your "read it, nothing to say" pile — kept for history and search, not
cluttering the main views. From any slush row you can pick **Review in…** a
week to give a link another look; it rejoins that week as a *review* entry and
leaves the slush.

## Tags and topics

- **Tags** (Collections → Tags) group links loosely. Each tag has its own
  notes page and lists every link carrying it.
- **Topics** (Collections → Topics) are **long-form documents** that reference
  links — the place for real writing. A topic page is a full Markdown editor
  with the linked articles listed below it.

Both are edited in an Obsidian-style live Markdown editor, with a **source
mode** toggle for exact text. Markdown is the storage format, so exporting to
plain `.md` files is lossless.

## Favourites and resources

- **★ Favourite** marks the good stuff (Favourites in the nav). Favouriting a
  link also rescues it from the Slush.
- **⚒ Resource** marks tools, apps, and references that aren't really
  "articles to read." They live under Collections → Resources.

### Resource lists and exports

Group resources into named **lists** (e.g. "CLI tools") on the Resources page.
Each list has an overview document and **exports**:

- **Markdown / plain text / CSV / JSON** — for one list or all lists at once.
- **HTML** — a self-contained, themed page with a searchable link table where
  each row expands to show its notes, excerpts, and full URL. Export a single
  list, or a whole zip of pages (an index plus one page per list) for the
  entire Resources section.

## Per-link notes and excerpts

Open any link (the **›** button) for its detail page: edit its title, toggle
flags, manage tags/topics and its reading week, write **notes**, and save
notable **excerpts** (quotes) — each in its own small editor. The page also
shows the link's full week history.

## Bulk editing

On the **Backlog** and **Reading List**, tick the checkbox on any rows to
open a **bulk operations** panel. Select a range and, in one action:

- add or remove tags/topics,
- set/clear favourite, resource, or done,
- set or clear the reading week.

It's the fastest way to triage a big paste or reorganize after the fact.

## Archiving old links (keeping things fast)

Over years, read-and-set-aside links pile up. **Settings → Archival** can move
old **slushed** links (read, not favourited, not in a topic) older than a
threshold (default 24 months) into a searchable **Archive** tab that the main
views never load — so the app stays snappy at scale. It's off by default,
reversible (you can un-archive), and readerr suggests turning it on once you
pass ~50,000 links.

## Stats

**Stats** shows where your links come from (per-domain), your **storage** use,
and **history**: when you set up, your longest daily capture streak, biggest
bulk paste, and weekly/monthly/yearly/lifetime averages for links read,
favourites, resources, and topics.

## Themes

**Settings → Appearance** has three built-in themes (Forest, Gruvbox,
Dracula), light/dark following your OS, and a full **variable editor** to
customize any colour or token. Themes export/import as JSON so you can share
them.
