# Capture FAB

Adding a floating action button (FAB) that brings capture to the pages that
don't already have it, without losing a single feature the inline capture box
has today. The two pages that already show an inline capture card — Reading
List and Backlog — keep it and are left exactly as-is; the FAB fills in
everywhere else.

## Why

Capture is the app's hottest action — "dump a link fast, from wherever you
are." Right now the capture surface (`CaptureBox.svelte`) is only mounted on
two pages:

- the **Reading List** (home, `WeekApp.svelte:343`)
- the **Backlog** (`BacklogApp.svelte:84`)

Everywhere else — a tag page, a topic document, slush, stats, settings — you
have to navigate home before you can paste a link. That's friction on the one
thing the app is meant to make frictionless. A FAB pinned to the corner of
*those* pages makes capture a one-tap action there too, the way "compose"
works in mail apps — while the two pages that already put a full capture card
front-and-center are left untouched, so nothing about the current home/backlog
experience changes.

## What "same features" means

The FAB is **not** a reduced quick-add. It must carry everything
`CaptureBox` does today, because the whole point is to not regress:

- Multi-line paste — one URL per line, plain URLs, `- bullet` lists, or
  `[Title](url)` markdown links; dedupe + invalid reporting.
- Tag chips and Topic chips (`ChipSelect`), including inline create of a new
  tag/topic on the fly.
- Reading-week select, preselected from the Settings default
  (`default_week` / `default_week_offset`).
- The four toggles: **Clean URLs**, **Auto-title**, **Resource**,
  **Mark as done**.
- `Enter` to add, `Shift+Enter` for a newline.
- The post-add report line ("3 added · 2 labels applied · 1 already saved").

The good news: **all of that already lives in one self-contained component.**
`CaptureBox` takes a single prop, `onAdded: (links: Link[]) => void`, and owns
its own state, settings load, and option loading. So the FAB does **not**
reimplement capture — it *hosts the existing `CaptureBox` inside a floating
panel*. This is the central design decision and it keeps the change small.

## Design

### Shape: FAB button + popover panel, both in one new component

A new `CaptureFab.svelte`:

- Renders a fixed-position round button (the FAB) in the bottom-right corner.
- On click/tap, opens a floating panel (popover on desktop, bottom sheet on
  mobile) that contains `<CaptureBox onAdded={...} />` verbatim.
- Handles open/close, backdrop, Escape, click-outside, and focus management.

Because `CaptureBox` is unchanged, every feature above comes for free. The FAB
component is essentially a styled disclosure wrapper.

```
CaptureFab.svelte
├── <button class="fab">  (＋ icon, aria-expanded, aria-controls)
└── {#if open}
    ├── <div class="fab-backdrop" onclick={close}>
    └── <div class="fab-panel" role="dialog" aria-modal="true" aria-label="Capture links">
        └── <CaptureBox onAdded={onCaptured} />
```

### Where it mounts: Layout, suppressed on pages that already capture

Mount it in `Layout.astro` next to the existing `ArchiveSuggestModal`, behind
the same `!noNav` guard so it never appears on onboarding — **plus** a new
guard so it never appears on the two pages that already have an inline
capture card.

The cleanest way to express "this page already has capture" is an explicit
prop on `Layout`, mirroring the existing `noNav` pattern, rather than
hardcoding a path list inside the FAB (which would have to stay in sync with
routing and be base-path aware):

```astro
interface Props {
  title: string;
  noNav?: boolean;
  hasCapture?: boolean;   // page already shows an inline CaptureBox
}
---
{!noNav && !hasCapture && <CaptureFab client:load />}
```

Then the three pages that render an inline capture card declare it:

- `pages/index.astro` (Reading List) → `<Layout title="Reading List" hasCapture>`
- `pages/week.astro` (the `/week` alias) → `<Layout title="Reading List" hasCapture>`
- `pages/backlog.astro` (Backlog) → `<Layout title="Backlog" hasCapture>`

Every other page gets the FAB automatically, with no per-page work. One island
per page load, exactly like the Navbar and the archive modal already are. If a
future page adds its own inline `CaptureBox`, it opts out with the same
one-word `hasCapture` flag.

### The cross-island refresh problem (the one real wrinkle)

Today `onAdded` is wired to a page-specific refresh: the Backlog re-reads its
list, the Reading List reloads the week. That works because `CaptureBox` is a
child of those page apps and shares nothing across islands.

The FAB has no such parent. It's a separate island from the page's list app
(`TagApp`, `TopicApp`, `ResourcesApp`, `SlushApp`, …), so it can't call their
`refresh()` directly. This is an Astro MPA reality: islands are independent,
they don't share a component tree or a store.

Note this only matters on the pages the FAB actually appears on. **Backlog and
Reading List are not among them** — they keep their own inline `CaptureBox`
with its existing `onAdded` refresh, and need no changes at all. So the pages
that might want live refresh from a FAB capture are the *other* list views.

Two ways to close the loop after a capture; we should do **both**:

1. **Broadcast a DOM event.** On add, the FAB dispatches
   `window.dispatchEvent(new CustomEvent('readerr-captured', { detail: added }))`.
   Any list app that wants live refresh adds a listener in `onMount` and calls
   its existing `refresh()`. There's already precedent for this pattern in the
   codebase: `sync.ts` dispatches a `readerr-sync` CustomEvent the same way
   (`sync.ts:213`). We'd define a `CAPTURE_EVENT` constant beside it and give
   it real consumers:

   - `ResourcesApp` → `refresh()` (only meaningful when Resource was ticked)
   - `TagApp` / `TopicApp` → refresh if a just-captured link carries that
     tag/topic (they can filter on `detail`).
   - `SlushApp` / `FavouritesApp` → rarely relevant to a fresh capture, but
     cheap to wire.

2. **Self-contained feedback regardless of page.** The `CaptureBox` report
   line already renders inside the panel, so the user gets confirmation
   ("3 added") even on a page that has no list to refresh (settings, stats).
   No page is left with silent-looking capture.

Phase 1 can ship with just the event dispatch and leave every list app to
refresh on its next navigation — the report line covers the gap in the
meantime — then wire the listeners into individual list apps as a follow-up.
Because a fresh capture usually lands in the *backlog* (not the tag/topic/
resource view you're currently on), the live-refresh listeners are a nicety,
not a correctness requirement.

### The two inline capture cards stay

Backlog and Reading List keep their inline `CaptureBox` cards unchanged — no
edits, no removed `onAdded` plumbing. The FAB simply doesn't render on those
two pages (via the `hasCapture` flag above), so there's never a page with two
capture surfaces. Each page has exactly one: an inline card on the two capture-
centric pages, a FAB everywhere else.

### Positioning, layering, responsiveness

- **Desktop:** fixed bottom-right, `~1.5rem` inset. Round ~3.5rem button using
  `--color-primary`, `--radius-full`, `--shadow-2`. Panel opens anchored above
  the button, `min(24rem, calc(100vw - 3rem))` wide, capped height with
  internal scroll so long tag/topic chip lists never push it off-screen.
- **Mobile (`max-width: 48rem`):** the panel becomes a full-width bottom sheet.
  The FAB stays bottom-right; it does **not** collide with the nav hamburger,
  which is top-right — good, opposite corner. Respect
  `env(safe-area-inset-bottom)` for iOS home-indicator clearance.
- **z-index budget:** Navbar is `10`, the archive modal backdrop is `100`. Put
  the FAB button at `~40` (above content, below any modal) and the open
  panel/backdrop at `~90` (below the archive suggestion modal, which is a
  higher-priority interrupt). Document these alongside the existing values so
  the stack stays legible.
- Hide or dim the FAB while its own panel is open (the panel's ＋ becomes a ✕,
  or the button animates to a close affordance).

### Accessibility & interaction

- `aria-expanded` on the button, `aria-controls` pointing at the panel,
  `role="dialog"` + `aria-modal="true"` + `aria-label` on the panel.
- Focus moves into the textarea on open (autofocus-on-open), returns to the
  FAB on close.
- `Escape` closes; click on backdrop closes; click-outside closes. Reuse the
  same `closeMenus`-style outside-click check the Navbar uses.
- The existing `Enter`-to-add inside `CaptureBox` keeps working unchanged.
- Keep the panel open after a successful add (so you can paste several batches
  with different labels) — it already resets its fields and shows the report.
  Closing is an explicit user action.

### Settings / option loading timing

`CaptureBox` loads user settings + tag/topic options in its own `onMount`.
Inside a `{#if open}` panel, that runs the first time the panel opens rather
than on every page load — a small efficiency win over the current always-
mounted inline cards. No change needed; just note it. (If we ever want the FAB
badge to reflect a running count we'd load lazily anyway.)

## Files touched

New:

- `frontend/src/components/CaptureFab.svelte` — the button + panel wrapper.

Edited:

- `frontend/src/layouts/Layout.astro` — add a `hasCapture?: boolean` prop;
  mount `CaptureFab` behind `!noNav && !hasCapture`.
- `frontend/src/pages/index.astro`, `pages/week.astro`, `pages/backlog.astro`
  — pass `hasCapture` so the FAB is suppressed where an inline box already
  exists.
- `frontend/src/lib/sync.ts` *(or a small new `lib/events.ts`)* — export a
  `CAPTURE_EVENT` constant to keep event names centralized next to
  `SYNC_EVENT`.
- *(optional, phase 2)* `ResourcesApp`, `TagApp`, `TopicApp`,
  `FavouritesApp`, `SlushApp` — add a `readerr-captured` listener for live
  refresh.

Unchanged (this is the point):

- `frontend/src/components/CaptureBox.svelte` — hosted as-is.
- `frontend/src/components/apps/BacklogApp.svelte` and
  `apps/WeekApp.svelte` — their inline capture cards stay exactly as they are.
- `frontend/src/components/ChipSelect.svelte`, `capture.ts`, everything in the
  capture pipeline.

## Work order

1. Build `CaptureFab.svelte`: button, panel, backdrop, open/close, Escape,
   click-outside, focus management, responsive/bottom-sheet CSS. Host
   `<CaptureBox onAdded={...}>`; on add, dispatch `CAPTURE_EVENT`.
2. Add the `hasCapture` prop to `Layout.astro`; mount `CaptureFab` behind
   `!noNav && !hasCapture`. Set `hasCapture` on `index.astro`, `week.astro`,
   and `backlog.astro`.
3. Verify: FAB shows on tags/topics/slush/resources/stats/settings, is absent
   from Reading List, Backlog, and onboarding.
4. Add the `CAPTURE_EVENT` constant.
5. *(optional)* Wire the non-capture list apps to the event for live refresh.
6. Polish: z-index doc comment, safe-area insets, reduced-motion for the
   open/close transition, dark-mode check.

## Verification

- FAB appears bottom-right on Tags, a topic page, Slush, Resources, Stats,
  Settings; **absent** on Reading List, Backlog (they keep their inline card),
  and `/onboarding`.
- Reading List and Backlog are visually unchanged — inline capture card still
  there, no FAB overlapping it.
- Open the FAB → paste a mix (one dup, one bogus, two good) → report reads
  correctly; links land in the backlog. If a listener is wired for the current
  page, its list updates without a manual reload; otherwise it appears on next
  navigation.
- Tags/topics inline-create still works from inside the panel; reading-week
  preselect still honors the Settings default; all four toggles still behave.
- `Enter` adds; `Shift+Enter` newlines; `Escape` / backdrop / outside-click
  close; focus returns to the FAB.
- Mobile viewport: panel is a bottom sheet, clears the home indicator, doesn't
  overlap the hamburger; desktop: panel doesn't overflow the viewport with a
  long tag list (internal scroll).
- Dark mode and each custom theme render the button/panel correctly.
- `npm run build` clean.

## Risks & notes

- **Cross-island refresh is the only non-trivial part**, and it's now optional:
  the FAB never appears on the two capture-centric pages, so their inline
  refresh is untouched. Other list pages just refresh on next navigation until
  their (optional) listener is wired. The in-panel report keeps that from
  feeling broken.
- **No page ever shows two capture surfaces** — the `hasCapture` flag suppresses
  the FAB wherever an inline box lives. The one thing to keep honest: if a new
  page adds an inline `CaptureBox`, remember to set `hasCapture` on it.
- **MPA navigation loses an in-progress draft.** A FAB doesn't fix this (islands
  are torn down on navigation). If it ever matters, persist the textarea to
  `sessionStorage` on input and restore on open — small, optional follow-up.
- Purely additive to data/schema — **no backend, schema, sync, or migration
  changes.** This is entirely a frontend UI addition around an unchanged
  capture pipeline.

## Effort

Small-to-medium, frontend-only. The heavy lifting (the actual capture logic,
options, settings, reporting) is already built and reused wholesale. The work
is one new presentational component, one mount line, one event constant, and
refresh listeners on two apps — plus the CSS to make the button and
sheet/popover feel right across desktop, mobile, and themes.
