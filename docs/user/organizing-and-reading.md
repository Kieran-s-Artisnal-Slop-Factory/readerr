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
   Rows in the **Review** section show a **Reviewed** button instead — it
   completes the review without touching the link's original read date. Every
   row also has a **✕** that removes the link from this week without deleting
   anything; it stays wherever else it lives.
3. **Close the week** with the button at the bottom. Each link gets an
   outcome:
   - **Read** — you favourited it or filed it in a topic. It stays in your
     library as read.
   - **Slushed** — you read it but didn't remark on it. It moves to the
     **Slush** (see below), out of the way but searchable.
   - **Rolled** — you didn't finish it. It simply returns to the Backlog.

Closing asks you to confirm first, and the confirmation says how many
unfinished links will roll back to the Backlog. (The button is disabled while
the week is empty.) With sync on, readerr checks with the server before
closing, waiting up to ~10 seconds: if another device already closed the week
you'll see "This week was already closed on another device." rather than a
second close, and if the server can't confirm either way, the confirmation
gains a warning so you know before proceeding.

Use **← Previous / Next →** to look at other weeks. Only the current week gets
the inline add/search box, the quota suggestions, and the **Close week**
button — but the capture box at the top is always there, and you can still
tick, remove, re-order and bulk-edit rows in an older week.

### Weeks close themselves

A week whose Monday has already passed closes itself when you next open the
**Reading List** page (only that page runs the check). With sync on — and if
this device has reached the server before — readerr syncs *first* and only
closes after a successful sync, so it never repeats a close that already
happened on another device. If the server is offline, failing, or slow (about
10 seconds), the week stays open with a notice that last week "couldn't be
closed yet", and closes automatically after the next successful sync. A device
with sync off, or one that has never synced, closes immediately from local
data. Either way you get a summary: "Last week ended and was closed
automatically: N read, N slushed, N returned to the backlog."

### Past weeks show what you actually read

Open a closed week and any links you never finished drop out of it — they
went back to the Backlog when the week closed, so the week keeps only your
read and slushed history. This trimming is permanent, and it syncs to your
other devices.

### Priorities

Give a link a priority of **1 (top)**, **2 (soon)**, or **3 (default)** — from
the capture box, the `!priority=` shortcut, or bulk-editing. Lists (Backlog,
Favourites, Resources, Slush, and each reading week) show **priority 1 first**,
then newest. Links show a small `P1`/`P2` chip so the order is legible;
priority-3 links show nothing.

> Note: in the Reading List, priority decides order *before* your manual drag
> order, so dragging a link across a priority group snaps it back. To move
> something up for good, raise its priority.

### The Done section

**To read** and **Review** are a queue, so they sort by priority. **Done** is
a record of what happened, so it sorts by *when* you finished — **newest read
first**, with an **Oldest read** toggle when you want to replay the week in
order. It has its own search, filters and pages, since a productive week's
Done list gets long faster than the other two.

## The list toolbar

The **Backlog**, **Favourites** and the Reading List's **Done** card share one
set of controls:

- **Select all / none** — the checkbox on the left. It ticks whenever anything
  is selected, so one click always clears a selection whatever state it's in;
  from empty, one click takes in **everything the filters leave**, across every
  page, not just the rows in front of you.
- **Search** by title, URL or tag name.
- **Sort** — newest or oldest. On Done that means when you *read* it; on the
  Backlog and Favourites, when you *captured* it.
- **Filters** for favourites and resources. Favourites only offers the
  resources chip, since every row there is already a favourite.

> Sorting never overrides priority. Flipping to oldest reverses the order
> *within* each priority band, so a priority-1 link stays at the top either
> way and the backlog's triage order survives.

Everything composes: the count in the card title reads "9 of 55" when a search
or filter is narrowing things, select-all then covers exactly those 9, and
narrowing the list while you're on a later page brings you back rather than
stranding you on an empty one.

## Plans (automation)

**Plans → Automation** lets the app suggest what to read:

- **Defaults** — a weekly **quota** (e.g. "5 articles/week") and optional
  **focus tags**. On the Reading List, readerr suggests Backlog links to fill
  the quota, preferring your focus tags (and higher priorities first). With
  more than one focus tag the quota is **split** across them (a quota of 3
  over two tags suggests 2 from one and 1 from the other), and any leftover
  is filled from the general backlog.
- **Scheduled plans** — override the defaults for a specific **week or month**
  (e.g. "next week is compilers, 3 articles"). A weekly plan beats a monthly
  plan beats the defaults, field by field. Each scheduled plan has **Edit**
  and **Delete**; editing can move a plan to a different week or month, and
  readerr asks before replacing a plan that already exists there.

**Plans → Upcoming weeks** shows an 8-week strip of what's scheduled ahead,
with **Earlier / Later** to page through. Click a cell to focus that week: a
card titled like "Week of August 3-9" (plus "(past)" where that applies)
shows its quota, focus tags, plan note, and a line saying where the plan
comes from (a weekly plan, a monthly plan, or the defaults), along with any
links already scheduled into it. **Plan this week / Edit plan** opens an
inline editor right there, and **Clear week plan** removes it.

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

### Topic statuses

A topic can be marked **In progress** or **Done** — or neither, which is the
normal state. Use the ▶ and ✓ buttons on the topics list, or the matching
buttons in a topic's header; clicking the status a topic already has clears it.

The status changes where the topic sits on the list: **in progress first, then
unmarked topics, then done**. In progress is a way to float the thing you are
actively writing to the top; done retires a finished piece without deleting it.

### Tagging topics

Topics take tags, the same way links do — the **Tags** card on a topic page.
A tagged topic shows up in a **Topics** section on that tag's page, next to the
links carrying it, and the tags travel into the topic's Markdown and HTML
exports as metadata.

### Finding and bulk-editing topics

The topics list has a **search box** (it matches the topic name or any of its
tag names) and chip filters for **status** and **tag**. Several status chips
mean "any of these"; several tag chips narrow to topics carrying *all* of them.

Tick the checkbox on any rows for a **bulk operations** panel: set or clear the
status, add or remove tags, or delete the selected topics.

### Citing links as footnotes

Every link on a topic page carries a footnote marker — `[^1]`, `[^2]` — shown
to the left of its title. Type that marker anywhere in the topic document to
cite the link; click the marker to copy it.

**Type `[^` in the document and a menu opens**, the same way `!` completes in
the capture box. Keep typing to search by title, URL, or reference number, then
<kbd>Enter</kbd> or <kbd>Tab</kbd> to insert the marker (<kbd>Esc</kbd>
dismisses, arrows move). It works in both Edit and Source mode.

The topic's own references come first, showing their numbers. Below them, under
**add to this topic**, is the rest of your library — picking one of those files
it under the topic and issues its number in the same keystroke, so you never
have to leave the document to add a link before citing it.

The numbers are permanent. Remove the second of three references and the
remaining two stay `[^1]` and `[^3]`, so citations you already wrote never
start pointing at the wrong article. The next link added takes `[^4]`.

You don't write the `[^1]: <url>` definitions yourself — the reference list is
generated when you export. A citation whose link has since been removed shows
as plain grey text rather than a broken link.

### Exporting a topic

Both the **Export HTML** button and the editor's own **↓ MD** / **↓ HTML**
buttons include the references:

- **HTML** — a self-contained, themed page: your document with every citation
  linked to a numbered **References** section at the bottom, each entry
  showing the title, domain, and full URL. Your theme is carried inline, so it
  looks like readerr with nothing to fetch.
- **Markdown** — your document with a real footnote-definition block appended
  (`[^1]: [Title](url)`), so the citations work as footnotes in Obsidian or
  anything else that speaks GitHub-flavoured markdown.

### Exporting a tag

A tag's page has an **Export** card. Both formats carry the same thing:
the child tags and link counts as metadata, your tag notes as an **About**
section, then a table of the links tagged directly and — when there are any —
a second table of the links that reach the tag through a nested child tag.
A link that is both only appears once, under the direct heading.

Rows come out **favourites first, then read, then unread**.
Each row shows the link, its URL, whether it's read / a favourite / a resource,
the reading week it's queued for, and its tags.

- **HTML** — one self-contained themed page. Every table has a search box, a
  filter per column, sortable headings, and a **Download CSV** button that
  exports exactly what you've filtered down to. It all works from a saved file
  with no internet.
- **Markdown** — the same content as YAML frontmatter plus GitHub-flavoured
  tables, ready to drop into a vault.

If the tag has tagged **topics**, they're listed either way. Two checkboxes
decide how much of them travels: *include each topic's full document* (an
extra section in the markdown, a click-to-read modal in the HTML), and, for
markdown only, *one file per topic, bundled as a zip* — the tag's document
plus a `topics/` folder, one note per topic.

**Resource lists export the same way**, from the Export card on a list's page:
Markdown and HTML now produce the same document shape a tag does. (Plain
**txt**, **csv** and **JSON** are still there for a bare list of URLs.)

## Series (part 1, part 2, part 3…)

Some writing comes in parts. A **series** keeps them together: it is one link
that holds the others.

Add one from the **Backlog** with the **Add series** button under the capture
box. You give it a title, an optional description and overview URL, tags and
topics — then the parts, each with its position, URL, title, reading week, and
its own tags if you want them. Parts you'd already saved join the series
instead of being captured a second time.

Afterwards it behaves like any other link, because it **is** one:

- favourite it, tag it, give it a priority, write notes on it;
- schedule it into a reading week — as **one row**, not five;
- find it in search and in your lists.

In any list it shows as a single row with a **▸** triangle and a progress
count like `2/5`. Expand it to see the parts, each with its own **✓** so you
can tick them off as you read. When the last one is ticked, readerr *asks*
whether to mark the whole series read rather than deciding for you — the
series' own ✓ means "I'm done with this", which isn't always the same thing.

A part is never shown twice: while its series is on the page, it lives inside
it rather than as a row of its own (the list says so underneath).

### The series' overview page

The **›** button opens it. It is the ordinary link page, so everything a link
has, a series has:

- an **Overview** document (the description you typed lands here) with the
  same markdown editor and MD/HTML exports as any link's notes;
- **excerpts**, for quotations that belong to the series as a whole;
- **tags**, **topics** and **resource lists** (adding it to a list marks it a
  resource), its **reading week**, and its **history**;
- and a **Parts** card on top: add a part by URL, reorder with **↑ ↓**, remove
  one, or delete the series.

**Deleting a series keeps its parts** — they're links you captured, and only
the container goes.

**Collections → Series** lists every series you have, each with its progress,
and totals across all of them. Any list's toolbar also has a **Series** filter
if you'd rather find them in place.

## Favourites and resources

- **★ Favourite** marks the good stuff (Collections → Favourites). Favouriting
  a link also rescues it from the Slush.
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

## What's on a link row

Link rows carry a few controls beyond the flag toggles:

- A **📅 chip** appears when the link is scheduled into a reading week,
  naming the week.
- The **✎** button edits the title inline. A hand-edited title is
  authoritative — auto-titling never overwrites it.
- On the Backlog and Favourites, the **#** button opens an inline panel with
  the tag picker *and* a reading-week selector, so you can tag and schedule
  without leaving the list.
- Links with notes or excerpts show a small line under the title, so you can
  see at a glance that there's writing attached.

## Per-link notes and excerpts

Open any link (the **›** button) for its detail page: edit its title, toggle
flags, manage tags/topics and its reading week, write **notes**, and save
notable **excerpts** (quotes) — each in its own small editor. The page also
shows the link's full week history.

The **Reading week** card schedules the link straight from here, or removes it
from the week it's queued for. It files the entry the right way round on its
own: a link you haven't read yet joins as a *first read*, while one you've
already read (or that's sitting in the Slush) joins as a *review*, which
completes without disturbing the original read date — and leaves the Slush.

## Bulk editing

On the **Backlog**, **Favourites** and **Reading List**, tick the checkbox on
any rows to open a **bulk operations** panel. Select a range and, in one action:

- add or remove tags/topics,
- add to or remove from **resource lists** (anything you add to a list is
  marked a resource, since lists are the layer above the flat ⚒ view),
- set/clear favourite, resource, or done,
- set or clear the reading week.

It's the fastest way to triage a big paste or reorganize after the fact.

On the Reading List the panel appears **next to whatever you selected**: tick
rows in **Done** and the controls open in the Done section rather than at the
top of the page. A selection spanning both follows wherever you last ticked.

**Shift+click selects a range.** Tick one row, then shift+click another, and
everything between them is ticked too — in either direction. (For "all of
them", use the select-all box in the toolbar above.)

It follows whichever way the first click went, which is what makes it useful
for *un*-picking as well: with rows 4–8 ticked, clicking 5 to untick it and
then shift+clicking 7 clears 5, 6 and 7, leaving 4 and 8. Rows outside the
range are never touched, and the first row stays the anchor, so you can
shift+click again to adjust how far the range reaches.

On the Reading List a range can span the **To read**, **Review** and **Done**
sections — it covers what's between the two rows on screen.

## Adding a link you already have

The **"Paste a URL to add, or search your links…"** box on the reading list,
on a topic, and on a resource list does two jobs from one field. Paste a full
URL and an **Add link** button appears — it captures the link (or reuses the
one you already had) and attaches it. Type anything else and it searches your
library by title, URL, and tag name.

Results are a scrollable list, twenty-five at a time, with **Show more
results** underneath when there are further matches. Links already attached
don't appear, so the list is only ever things you could actually add.

## Archiving old links (keeping things fast)

Over years, read-and-set-aside links pile up. **Settings → Archival** can move
old **slushed** links (read, not favourited, not in a topic) older than a
threshold (default 24 months) into a searchable **Archive** tab that the main
views never load — so the app stays snappy at scale. It's off by default,
reversible (you can un-archive), and readerr suggests turning it on once you
pass ~50,000 links. The **Collections → Archive** entry only appears in the
nav once archival mode is enabled.

## Stats

**Stats** shows where your links come from (per-domain), your **storage** use,
and **history**: when you set up, your longest daily capture streak, biggest
bulk paste, and weekly/monthly/yearly/lifetime averages for links read,
favourites, resources, and topics.

Series are left out of the origins table and the variability score: a series
is a container, not something you captured from a domain, and its parts are
already counted.

**Tag distribution** is the same question asked of your tags: how the library
divides across them. Two percentages, because with multi-tagging there are two
honest answers — **share** counts each (link, tag) pairing once and therefore
adds up to 100%, while **of library** is the fraction of *all* your links
carrying that tag and adds up to more than 100% when links carry several tags.
The card also says how much of the library is tagged at all. Nested tags are
not rolled up here: each link counts for exactly the tags it carries.

**Variability** is the one-number version of the origins table: the share of
your links captured from anywhere *other* than your biggest domains. If you
have 1,200 links and your top three domains account for 980 of them, that's
18.3% — most of your reading comes from a handful of places. Widen the window
(top 1 through top 10) to see how quickly the concentration falls off.

The origins table hides domains you've only saved one link from — usually most
of the list, and never the interesting part. Untick **Hide domains with only
one link** to see them. Hidden or not, they're still counted in the Total row
and in the variability score.

## Themes

**Settings → Appearance** has three built-in themes (Forest, Gruvbox,
Dracula), light/dark following your OS, and a full **variable editor** to
customize any colour or token. Themes export/import as JSON so you can share
them.
