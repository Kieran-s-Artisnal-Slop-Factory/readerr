# Tagging

Tags are the loose, fast way to organize links — a word or two you can slap on
anything and filter by later. (Topics are the other half: long-form documents
that cite links. Those are covered in
[Organizing & reading](organizing-and-reading.md).)

## The basics

Add tags to a link from:

- the **capture box** — pick tag chips before pasting, or type
  `!tags=[rust, os]` on the line itself ([Capturing links](capturing-links.md));
- the **link row** — on the Backlog and Favourites, the `#` button opens an
  inline tag picker (elsewhere, use the link's detail page — the **›** button
  — or bulk-select);
- **bulk editing** — select several links and tag them all at once.

Typing a tag name that doesn't exist yet **creates it**. Tag names are matched
case-insensitively, so `Rust` and `rust` are the same tag.

**Collections → Tags** lists every tag with its link count, and lets you
create, rename and delete. Deleting a tag never deletes links — they just lose
that one label.

## Nesting tags

A tag can sit **under** one or more parent tags. Nest `astro` under
`javascript`, and every `astro` link shows up when you look at `javascript` —
without you ever tagging those links `javascript` by hand.

To set it up, open a tag's page and use **Edit parents**.

### One tag, several parents

This is the point of the feature. `astro` is both JavaScript *and* web
development, so put it under both:

Now `astro` links appear under `javascript`, under `webdev`, and under
`programming` — because nesting is followed all the way up.

A tag can only be drawn in one place in a list, so the tags index shows each
one under its **first** parent and notes the rest inline:

```
programming        0 links · 4 with child tags
  javascript       1 link  · 3 with child tags
    astro          2 links   also under webdev
  webdev           1 link  · 3 with child tags
```

Untick **Show nesting** for a plain flat list.

### What a tag page shows

A tag with children shows **two** lists:

- **Links** — links tagged with this tag directly.
- **From child tags** — links that only reach it through a nested tag, each
  showing which child it came via. This section only appears when there is
  something in it.

A link tagged with **both** `javascript` and `astro` appears **once**, in
**Links**. It is never listed twice, and never in both sections. The same is
true when a link could arrive by two different routes — you'll see it once.

### Counts

The tags index shows `3 links · 12 with child tags` — the first number is what
carries the tag itself, the second counts everything beneath it too. The second
number counts *distinct* links, so a link tagged both parent and child is
counted once, not twice.

## Where nesting applies

- **Filtering by a tag** anywhere in the app includes its child tags.
- **Focus tags** in Plans include their children — so focusing `webdev` will
  suggest `astro` links from your backlog. (Plans are in
  [Organizing & reading](organizing-and-reading.md#plans-automation).)
- **A link's tag chips are unchanged.** They show only the tags you actually
  applied. A link tagged `astro` shows `astro`, not `astro javascript webdev`
  — otherwise the chips would balloon and it wouldn't be clear which one
  "remove" would remove. Inheritance is about *finding* things, not relabelling
  them.

## Things worth knowing

**Nesting doesn't move or copy anything.** It's a relationship between tags,
not a change to your links. Un-nest a tag and everything is exactly as it was.

**Loops are refused — and repaired.** You can't nest `javascript` under `astro`
when `astro` is already under `javascript`; the app says so and won't save it.
If two of your devices are offline and each makes one half of a loop, they can
still combine into one when they sync. That's harmless: the app notices, drops
one edge, and — importantly — **every device drops the same one**, so they don't
end up disagreeing. You may just find one nesting you set up has quietly gone;
re-add it if you still want it.

**Nesting goes six levels deep.** Deeper than that and the app stops following
the chain. Six is far more than any realistic tag hierarchy.

**Merging duplicate tags keeps the nesting.** If two devices each created
`astro` before syncing, the app merges them into one tag — and the survivor
keeps the nesting, the links, and the notes from both.

**Deleting a parent tag doesn't delete its children.** They just become
top-level tags again. Their links are untouched.

**It all syncs.** Nesting travels between devices like everything else, and is
included in backups ([Sync & backups](sync-and-backups.md)). A tag-template
export carries the hierarchy too, so you can seed a fresh install with your tag
vocabulary and its structure.

**Older versions of the app ignore it.** A device still on an older version
simply won't show any nesting; nothing breaks, and nothing is deleted — the
nesting stays safely on the server and on your up-to-date devices.

One wrinkle when you *do* update that device: nesting created *while it was on
the old version* may not appear, because it marked those updates as "seen"
without understanding them. Anything you nest from then on syncs normally.

If a freshly-updated device is missing some hierarchy, the quickest fix is to
re-add it there — a few clicks, and it syncs back out to everything else. To
force a full re-pull instead, go to **Settings → Sync** and save a *different*
server address — the conflict prompt only appears when the saved URL is
non-empty and different from the one before, so clearing the field and
re-saving does nothing. If your setup normally leaves the URL blank (the app
is served by the sync server), type the server's full address and save.
readerr will offer **Merge both**, which does a full re-push *and* re-pull
against the server.
