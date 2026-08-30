# Professional critique — UI/UX review of readerr v0.3.0

**Stance:** a design review of the shipped interface, written to be useful
rather than kind. It looks at hierarchy, density, affordance, state, motion,
accessibility and responsive behaviour, and it assumes the product goals are
already right: capture fast, read on a weekly rhythm, keep notes, own your data.

Companion piece: [`design-alternatives.html`](design-alternatives.html) renders
each numbered finding with the current implementation and two or three
alternative treatments, using the app's own stylesheet so the comparisons are
real rather than sketched.

The layman's pass ([`laymen-critique.md`](laymen-critique.md)) covers naming
and comprehension; this pass deliberately does not repeat it.

---

## Summary

The app has a coherent visual system already — one card component, one token
set, consistent spacing, a genuinely pleasant light/dark palette built on
`light-dark()`. That is further than most side projects get, and it means the
problems below are refinements rather than a redesign.

The recurring weakness is **flat hierarchy inside a row**: every action on a
link row has the same weight, so nothing reads first, and the eye has to
process 6–8 identical glyphs per row before finding the title. Everything in
§1–§4 is a variation on that theme.

| # | Finding | Severity |
|---|---|---|
| 1 | Row actions are six identical icon buttons | High |
| 2 | Icon-only controls carry meaning only in `title` | High (a11y) |
| 3 | Card titles shout; content whispers | Medium |
| 4 | Density is fixed at one setting | Medium |
| 5 | Modals have no escape, no focus trap, no scroll lock | High (a11y) |
| 6 | State changes have no feedback and no undo | Medium |
| 7 | Empty states describe, but don't act | Medium |
| 8 | Toolbars repeat, and don't remember | Low |
| 9 | Mobile drops to a single column and stops there | Medium |
| 10 | Colour carries meaning that shape should | Medium (a11y) |

---

## 1. Row actions: six identical buttons, no primary

Every link row ends with `✓ ★ ⚒ # ›`, plus `✕` and `⠿` in a week. Same size,
same weight, same colour, same spacing. But their frequencies are wildly
different: `✓` is the daily action, `★` is occasional, `⚒` is rare, `#` is
rarer, `›` is navigation, not an action at all.

Uniformity here reads as "nothing here matters more than anything else", and it
makes the row's *content* — the title — compete with a wall of glyphs.

**Alternatives** (rendered in the HTML page):

- **A. One primary, the rest on hover.** `✓` always visible and weighted; the
  others fade in on hover/focus and stay visible on touch. Highest clarity, and
  the row gets quiet.
- **B. Primary + overflow menu.** `✓` and `★` visible; `⚒ # ›` collapse into a
  `⋯` menu. Best for small screens, one extra click for the rare actions.
- **C. Keep all six, weight them.** `✓` filled, `★` outlined, the rest at 60%
  opacity until hover. Cheapest change; keeps muscle memory intact.

Recommended: **C now, A next** — C is a stylesheet change with no behavioural
risk, and it buys most of the legibility.

## 2. Icon-only controls with meaning only in `title`

`⚒` (resource), `#` (tags & topics), `›` (open), `⠿` (drag), `⧉`/`✎` (edit)
are unlabelled. The tooltip is a `title` attribute, which does not appear on
touch, does not appear on keyboard focus, and is announced inconsistently by
screen readers. Several buttons have no `aria-label` at all, so a screen reader
gets "button" or the glyph read aloud.

This is the one finding I would treat as a defect rather than a preference.

**Alternatives:**

- **A. `aria-label` on every icon button** + a visible text label at ≥`48rem`
  (there is room). Cost: nothing visual on mobile, clearer on desktop.
- **B. Icon + micro-label always** (`✓ Read`, `★ Save`), which doubles row
  height on mobile — only viable with the density control from §4.
- **C. Keep icons, add a legend row** at the top of each list. Weakest option:
  it explains a system rather than fixing it.

Recommended: **A**, unconditionally. It is a one-line-per-button change.

## 3. Card titles shout; the content inside whispers

`.card-title` is uppercase, `font-weight: 800`, letter-spaced, in
`--color-primary-strong`, with an accent bar. The link titles inside are
`font-weight: 600` in body colour at the same size. The chrome is louder than
the content it labels — so a page of five cards reads as five headings first
and content second.

**Alternatives:**

- **A. Demote the chrome.** Sentence case, weight 600, muted colour, keep the
  accent bar. Content becomes the loudest thing on the page.
- **B. Promote the content.** Keep the title as-is, but push link titles to
  `--font-size-lg`/700. Fixes the ratio, costs vertical space.
- **C. Section headings outside the card.** Title above the card in muted small
  caps, card holds only content — a common pattern in dense apps.

Recommended: **A**. It costs four CSS declarations.

## 4. One density, and it doesn't fit both jobs

Row padding is `var(--space-2)` everywhere. Triaging 900 slush items and
reading a 5-item week want different densities, and a library of ~1,900 links
(the live dataset) means the backlog is a scanning surface, not a reading one.

**Alternatives:**

- **A. A density toggle** in the list toolbar (comfortable / compact),
  persisted per device in localStorage like the theme.
- **B. Automatic density**: compact when a list exceeds ~30 rows.
- **C. Compact everywhere**, with the reading week alone staying comfortable —
  no control, one opinion.

Recommended: **C** if you dislike settings, **A** if you don't. Both beat one
density for every surface.

## 5. Modals: no `Esc`, no focus trap, no scroll lock, no labelled close

`SeriesModal` and the series-complete prompt render a `.scrim` + `.modal` with
`role="dialog" aria-modal="true"`, which is right — but:

- `Esc` does not close them;
- focus is not moved into the dialog, not trapped, and not restored on close;
- the page behind still scrolls;
- clicking the scrim does nothing (neither closes nor signals that it won't);
- the only way out is a "Cancel" button that is last in tab order.

**Alternatives:**

- **A. Native `<dialog>`** with `showModal()`: gets `Esc`, the focus trap,
  inertness and the top layer for free, and removes the hand-rolled scrim.
- **B. Keep the div, add the behaviours**: `Esc` handler, focus-in/restore,
  `overflow: hidden` on body, scrim click closes.
- **C. Not a modal at all.** "Add series" is a form with 6+ fields and a
  repeating group — it wants a page (`/series/new/`), not a dialog.

Recommended: **A** for the small prompt, **C** for Add series. A form that
scrolls inside a dialog on a laptop is a form that wants a page.

## 6. State changes are silent, and nothing is undoable

Ticking `✓`, ignoring an inbox item, removing a part, unsubscribing from a feed
— all happen instantly with no confirmation of what happened and no way back
except doing the inverse by hand. `confirm()` is used for the destructive ones,
which is the bluntest possible tool and cannot be styled or undone either.

**Alternatives:**

- **A. A toast with Undo** ("Ignored 12 items · Undo"), 6-second timeout. The
  data model already supports it: everything is a soft delete or a status flip.
- **B. Inline row state** — the row stays in place, greyed, with "Undone?" for
  a few seconds before it leaves the list.
- **C. Keep `confirm()`, but only where it is genuinely irreversible** (nothing
  currently is) and drop it elsewhere.

Recommended: **A**, replacing every `confirm()` except "Delete series".

## 7. Empty states describe the void instead of filling it

"No tags yet." / "No feeds yet." / "Nothing waiting — the inbox is clear." Each
is accurate; none is a next step, and several appear on pages where the action
that would fill them is elsewhere in the app.

**Alternatives:**

- **A. Empty state = the primary action.** "No tags yet — tags appear when you
  add one to a link. [Open the backlog]".
- **B. Seeded examples**: offer to create two or three starter tags/feeds.
- **C. Illustration + one line.** Prettier, no more useful.

Recommended: **A** everywhere; **B** only for the inbox, where a couple of
suggested feeds genuinely lower the bar.

## 8. The toolbar repeats itself, and forgets

Search + sort + filters appear on the backlog, favourites, resources, slush,
series, the week's Done card and both label pages. Each instance resets on
navigation, so "sort by oldest" has to be re-chosen every time. The chips also
sit in a second row on desktop, where there is space for one.

**Alternatives:**

- **A. Persist per-list preferences** in localStorage (sort + density + filters
  are per-device preferences, not synced state).
- **B. One row on desktop**: search grows, sort and chips sit beside it,
  wrapping only under `48rem`.
- **C. Both.**

Recommended: **C**. Neither half is expensive.

## 9. Responsive stops at "one column"

Below `48rem` the nav collapses correctly and the cards stack — good. But rows
keep the same 6-icon action cluster next to a title that now has ~40% of the
width, and the series parts indent twice (series indent + row padding), so a
part title on a phone gets very little room. Tables on Stats scroll
horizontally inside their container, which is right, but the origins table has
six numeric columns that could collapse to a two-line summary.

**Alternatives:**

- **A. Row reflow under `40rem`:** title on line one, meta + actions on line
  two, full width each.
- **B. Swipe actions** for the two common ones (read / save), with the rest in
  the overflow menu from §1B.
- **C. Reduce, don't reflow:** hide `⚒` and `#` under `40rem` and rely on the
  detail page.

Recommended: **A**, which is a flex-direction change at one breakpoint.

## 10. Colour is doing work that shape should

The primary green (or brown, in dark) marks: the active nav item, the active
sort button, active filter chips, the series badge, the progress bar, the
active flag buttons, and the primary CTA. Seven different meanings in one hue,
which makes "active" and "important" indistinguishable, and leaves nothing for
genuine semantic states.

Meanwhile `--color-success` and `--color-warning` are defined and almost
unused, and the danger red appears both on "Delete" (destructive) and on the
week's `✕` "Remove from this week" (not destructive).

**Alternatives:**

- **A. Split the roles:** accent = selection/active only; a second neutral
  weight for "primary action"; danger reserved for irreversible actions.
- **B. Add shape:** selected chips get a check mark, active sort gets an
  underline, so state survives being read in greyscale.
- **C. Both**, plus demote the week's `✕` to a neutral button with a danger
  hover.

Recommended: **A + C**. `✕` on a row you are looking at, in red, reads as
"delete this link" — it isn't.

---

## What I would not change

- **The token system.** One `theme.css`, `light-dark()` throughout, custom
  themes compiled to CSS at save time. This is better than most production apps.
- **The card as the only container.** No nested panels, no competing surfaces.
- **The week's drag handle.** `⠿` with `touch-action: none` and pointer events
  — correct, and rare to see done properly.
- **The capture box's position.** Top of the page it serves, with a FAB
  everywhere else. The right call.
- **Series folding into one row.** The strongest interaction in the app: it
  compresses five things into one without hiding their state.

## Suggested order of work

1. §2 (`aria-label`s) and §5 (dialog behaviour) — accessibility defects, both
   small.
2. §1C + §3A + §10C — one stylesheet pass, biggest visible gain per line
   changed.
3. §6A (toast + undo) — removes every `confirm()` worth removing.
4. §8, §4, §9 — comfort work, in whatever order irritates you most.
