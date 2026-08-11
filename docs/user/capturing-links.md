# Capturing links

Capture is the thing readerr tries hardest to make fast. The capture box sits
at the top of the Reading List and Backlog, and the floating **＋** button
opens the same box from any other page.

## Paste formats

One link per line. These all work, and you can mix them in a single paste:

| You paste | You get |
|---|---|
| `https://example.com` | the link; its title fills in shortly |
| `- https://example.com` | same (bullet-list lines are fine) |
| `* https://example.com` | same (asterisk bullets too) |
| `[My title](https://example.com)` | the link with *My title* set already |
| `- [My title](https://example.com)` | same, bulleted |

Press **Enter** to add, **Shift+Enter** for a new line when you're pasting
several at once. Anything that isn't a URL is reported ("2 not a link") and
skipped rather than saved as junk.

**Duplicates merge.** Pasting a link you already have doesn't make a second
copy — instead your new options (tags, a week, flags) are applied to the
existing link. Tags and topics are added; favourite/resource only ever turn
*on*; a new week is added for another look.

## Organizing as you capture

Under the box is an **organize** area where you can set, for everything in
this paste:

- **Tags** and **Topics** — pick existing ones or type a new name to create
  it on the spot.
- **Resource lists** — add everything in the paste to one or more resource
  lists (type a new name to create one). Picking a list turns the ⚒ resource
  flag on and locks it — lists only hold resources — until the selection is
  cleared.
- **Reading week** — schedule the links into this week or a future one (or
  leave them in the Backlog).
- **Priority** — 1 (top), 2 (soon), or 3 (the default). Lists show priority 1
  first. Leaving it at 3 means "no particular priority".
- **⚒ Resource** — mark these as tools/apps/references rather than articles.
- **✓ Mark as done** — you've already read these; they join the week as done.
- **Clean** — strip tracking junk (`utm_*`, `ref`, …) from the URLs. The
  default comes from Settings → Link handling.

These selections reset after each add, so a stale choice can't mislabel your
next paste.

## Per-line options (the `!` shortcuts)

Sometimes a batch paste needs *different* settings per link. Add `!options`
after any link and they apply to **just that line**:

```
[The Untold Story of SSH](https://youtu.be/1UX_iTdrtbc) !tags=[security, history] !week=0
https://github.com/rust-lang/rust !tags=[rust, os] !resource !priority=1
https://example.com/later !week=false !clean=false
```

The available options (any prefix works — `!ta`, `!fav`, `!p`):

| Option | Example | Meaning |
|---|---|---|
| `!tags` | `!tags=[a, b]` | add these tags; `!tags=false` skips the ones picked above |
| `!topics` | `!topics=[x]` | add these topics; `!topics=false` skips them |
| `!list` | `!list=[CLI tools]` | add to these resource lists (created if new) — implies `!resource`; `!list=false` skips the lists picked above |
| `!week` | `!week=2` | schedule N weeks ahead (`0` = this week, `false` = none) |
| `!priority` | `!priority=1` | set priority 1–3 |
| `!favourite` | `!favourite` | mark as a favourite |
| `!done` | `!done` | mark as read |
| `!resource` | `!resource` | flag as a resource |
| `!clean` | `!clean=false` | keep the URL exactly as pasted |

A few conveniences:

- **Autocomplete.** Type `!` after a link and a menu suggests the options;
  inside `!tags=[…]` it suggests your existing tag names. Use ↑/↓ then Tab or
  Enter to accept, Esc to dismiss. (The menu only appears *after* a link, so a
  line that starts with `!` is treated as plain text.)
- **New tags are created** if the name doesn't exist yet.
- **Commas in a name** are escaped with a backslash: `!tags=[really\, rusty]`.
- Anything it can't parse is reported ("1 option not understood") and the
  link is still captured.

New tag/topic names created via `!options` behave exactly like ones you pick
from the chips.

## After you add

- The **Just Added** list shows your most recent captures as normal rows —
  open them, toggle flags, or jump to their detail page. This is especially
  useful when the links went to a *future* week or straight to the Backlog,
  so they're not otherwise on screen.
- Titles for bare URLs resolve a couple of seconds later and the rows update
  in place. If they don't, see
  [gotchas](gotchas.md#titles-arent-filling-in).
