<script lang="ts">
  /**
   * The Reading List: a week's links in three sections — To read (unfinished
   * 'reading' entries), Review (unfinished slush re-reads), and Done. Prev/
   * Next scroll through weeks; the capture box and the week's own controls
   * (suggestions, close) apply to the current open week. Marking a link read
   * completes its entry; a week whose Monday has passed closes itself on
   * load — done links get their outcome and everything unfinished returns to
   * the backlog.
   */
  import { onMount } from 'svelte';
  import BulkActionsPanel from '../BulkActionsPanel.svelte';
  import Card from '../Card.svelte';
  import CaptureBox from '../CaptureBox.svelte';
  import LinkRow from '../LinkRow.svelte';
  import ListToolbar from '../ListToolbar.svelte';
  import Pagination from '../Pagination.svelte';
  import { FLAG_FILTERS } from '../../lib/services/links';
  import { all, byIndex, get } from '../../lib/db/repo';
  import { captureLinks, fetchTitles } from '../../lib/services/capture';
  import {
    domainOf,
    effectivePriority,
    matchesFlagFilters,
    matchesSearch,
    tagsForLink,
  } from '../../lib/services/links';
  import { effectiveTriage, type EffectiveTriage } from '../../lib/services/plans';
  import {
    liveChecked,
    NO_ANCHOR,
    selectOnClick,
    type SelectionAnchor,
  } from '../../lib/services/rangeSelect';
  import { href } from '../../lib/paths';
  import {
    addLinkToWeek,
    autoCloseStaleWeeks,
    closeWeek,
    currentWeekStart,
    ensureOpenWeek,
    findWeek,
    formatWeekRange,
    hasStaleOpenWeeks,
    pruneUnfinishedEntries,
    removeFromWeek,
    reorderEntries,
    setEntryDone,
    suggestLinks,
    weekEntries,
    weekStartPlus,
    type CloseResult,
    type WeekEntry,
  } from '../../lib/services/weeks';
  import {
    getSyncMode,
    hasEverReachedServer,
    syncFresh,
    syncNow,
    SYNC_EVENT,
    type SyncResult,
  } from '../../lib/sync';
  import { isTestMode } from '../../lib/testMode';
  import type { Excerpt, Link, Note, Tag, Week, WeekLink } from '../../lib/db/types';

  let loaded = $state(false);
  let week = $state<Week | null>(null);
  // The actual current open week vs. the week currently being viewed.
  let openWeekStart = $state(currentWeekStart());
  let focusStart = $state(currentWeekStart());
  let entries = $state<WeekEntry[]>([]);
  let tagsByLink = $state<Map<string, Tag[]>>(new Map());
  // $state.raw, not $state: this is the whole library (tens of thousands of
  // rows at scale) and it is only ever replaced wholesale, never mutated in
  // place. Deep-proxying every row so the search box can filter them costs far
  // more than the read itself.
  let allLinks = $state.raw<Link[]>([]);
  let query = $state('');
  let adding = $state(false);
  let closing = $state(false);
  let message = $state('');
  let triage = $state<EffectiveTriage | null>(null);
  let suggestions = $state<Link[]>([]);
  let focusTagName = $state('');

  const isOpenWeek = $derived(focusStart === openWeekStart);

  // Bulk operations over this week's entries (checkboxes on each row).
  let selectedIds = $state<string[]>([]);
  const selectedLinks = $derived(
    entries.filter((e) => selectedIds.includes(e.link.id)).map((e) => e.link)
  );

  /** Notes taken across this week's links (#6). */
  let stats = $state({ linksWithNotes: 0, excerpts: 0 });

  // Drag-and-drop reordering, section-local (#13).
  type SectionKey = 'toRead' | 'review';
  let drag = $state<{ section: SectionKey; index: number } | null>(null);
  let dragOver = $state<number | null>(null);

  // Sections order by priority first (1 → 3), then the dragged position —
  // the sort is stable, so drag order still decides within a priority.
  const byPriority = (a: WeekEntry, b: WeekEntry) =>
    effectivePriority(a.link) - effectivePriority(b.link);
  const toRead = $derived(
    entries.filter((e) => e.entry.kind === 'reading' && !e.entry.done_at).sort(byPriority)
  );
  const review = $derived(
    entries.filter((e) => e.entry.kind === 'review' && !e.entry.done_at).sort(byPriority)
  );
  /**
   * Done is a record of what happened, so it reads by *when* rather than by
   * priority — newest first, since the thing you just finished is the thing
   * you're most likely looking for. It gets its own search, filters and
   * paging because a busy week's Done list outgrows the eye long before the
   * other two sections do.
   */
  const DONE_PAGE_SIZE = 50;
  let doneOrder = $state<'newest' | 'oldest'>('newest');
  let doneSearch = $state('');
  let doneFilters = $state<string[]>([]);
  let donePage = $state(0);

  const done = $derived(
    entries
      .filter((e) => !!e.entry.done_at)
      .filter((e) => matchesFlagFilters(e.link, doneFilters))
      .filter((e) => matchesSearch(e.link, tagsByLink.get(e.link.id) ?? [], doneSearch))
      .sort((a, b) => {
        const at = a.entry.done_at ?? '';
        const bt = b.entry.done_at ?? '';
        return doneOrder === 'newest' ? bt.localeCompare(at) : at.localeCompare(bt);
      })
  );

  const doneVisible = $derived(
    done.slice(donePage * DONE_PAGE_SIZE, (donePage + 1) * DONE_PAGE_SIZE)
  );

  /** Unfiltered, for the "n of m" count when a search is narrowing it. */
  const doneTotal = $derived(entries.filter((e) => !!e.entry.done_at).length);
  const doneNarrowed = $derived(doneSearch.trim() !== '' || doneFilters.length > 0);


  /** Select-all covers everything the filters leave, not just this page. */
  const doneSelectedCount = $derived(
    done.filter((e) => selectedIds.includes(e.link.id)).length
  );

  function toggleAllDone(selectAll: boolean) {
    const ids = done.map((e) => e.link.id);
    if (selectAll) {
      selectedIds = [...new Set([...selectedIds, ...ids])];
    } else {
      const drop = new Set(ids);
      selectedIds = selectedIds.filter((id) => !drop.has(id));
    }
    anchor = NO_ANCHOR;
  }

  const quota = $derived(triage?.quota ?? null);
  const underQuota = $derived(quota !== null ? Math.max(0, quota - entries.length) : 0);
  const quotaSourceLabel = $derived(
    triage?.quotaSource === 'week'
      ? "this week's plan"
      : triage?.quotaSource === 'month'
        ? "this month's plan"
        : null
  );

  const entryLinkIds = $derived(new Set(entries.map((e) => e.link.id)));

  // Shift+click extends from the last plainly-clicked row (rangeSelect.ts).
  // The order is every visible row top to bottom, so a range can span the
  // section boundaries the same way the eye does — and it follows Done's
  // sort and search, since a range must mean what's on screen.
  let anchor = $state<SelectionAnchor>(NO_ANCHOR);
  const selectableIds = $derived(
    [...toRead, ...review, ...doneVisible].map((e) => e.link.id)
  );

  /** Returns whether the clicked row ended up selected. */
  function toggleSelect(id: string, shiftKey = false): boolean {
    const result = selectOnClick(selectedIds, selectableIds, id, shiftKey, anchor);
    selectedIds = result.selected;
    anchor = result.anchor;
    return result.selected.includes(id);
  }

  const queryIsUrl = $derived.by(() => {
    try {
      const u = new URL(query.trim());
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  });

  const matches = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q || queryIsUrl) return [];
    return allLinks
      .filter((l) => l.title.toLowerCase().includes(q) || l.url.toLowerCase().includes(q))
      .filter((l) => !entryLinkIds.has(l.id) && !l.slushed_at)
      .slice(0, 8);
  });

  function describeClose(r: CloseResult): string {
    return `${r.read} read, ${r.slushed} slushed, ${r.returned} returned to the backlog`;
  }

  onMount(() => {
    void init();
    // A background pull can land this week's real row after we first render;
    // heal the view when a sync actually brings data down.
    window.addEventListener(SYNC_EVENT, onSync);
    return () => window.removeEventListener(SYNC_EVENT, onSync);
  });

  /**
   * Set when a stale week could not be safely closed on load because the
   * sync server hadn't confirmed the week wasn't already closed elsewhere;
   * onSync retries the close after the next successful sync.
   */
  let closeDeferred = false;
  const DEFER_NOTICE =
    "Last week couldn't be closed yet — the sync server hasn't confirmed " +
    'whether it was already closed on another device. It will close ' +
    'automatically after the next successful sync.';
  /** Don't block first render forever on an unresponsive server. */
  const CLOSE_SYNC_TIMEOUT_MS = 10_000;

  async function init() {
    // Harness: mounting the week page must not write (auto-close stamps
    // outcomes, ensureOpenWeek mints a week row). Tests drive both explicitly
    // via window.__readerr; here we just render whatever exists.
    if (isTestMode()) {
      await loadWeek();
      loaded = true;
      return;
    }
    // A week whose Monday has passed closes itself (#14) — but NEVER from
    // stale local state when a sync server exists (audit D14). Another device
    // may already have closed this week; its done/outcome stamps live only on
    // the server, and a close from the local copy would overwrite them under
    // LWW with fresh 'rolled' stamps, erasing the week's reading history
    // everywhere. So: sync first (sharing Navbar's auto-sync run), and close
    // only once a sync has succeeded. If the server can't confirm in time,
    // leave the week open and let onSync finish the job after the next
    // successful sync.
    if (await hasStaleOpenWeeks()) {
      // Only wait on the network when a server has ever actually answered:
      // static/serverless deployments run in the default 'sync' mode too, and
      // holding their weeks hostage to a sync that can never succeed would
      // defer the close forever. A device that has never reached a server
      // holds the only copy of its data — closing locally is safe.
      if (getSyncMode() !== 'offline' && (await hasEverReachedServer())) {
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
          closeDeferred = true; // a fetch now is doomed — skip straight to deferral
        } else {
          const gate = syncNow();
          const synced = await Promise.race([
            gate,
            new Promise<null>((r) => setTimeout(() => r(null), CLOSE_SYNC_TIMEOUT_MS)),
          ]);
          closeDeferred = !synced?.ok;
          if (synced === null) {
            // Timed out but still running. Its SYNC_EVENT may fire before
            // `loaded` flips, which onSync ignores — so finish the deferred
            // close from the promise itself when it eventually succeeds.
            void gate.then(async (r) => {
              if (r.ok && closeDeferred && (await retryDeferredClose())) {
                await refreshOpenWeekView();
              }
            });
          }
        }
      }
      if (!closeDeferred) {
        // Re-reads after the pull, so a week closed elsewhere is a no-op here.
        const autoClosed = await autoCloseStaleWeeks();
        if (autoClosed) {
          message = `Last week ended and was closed automatically: ${describeClose(autoClosed)}.`;
        }
      } else {
        message = DEFER_NOTICE;
      }
    }
    const ow = await ensureOpenWeek();
    openWeekStart = ow.week_start;
    focusStart = ow.week_start;
    await loadWeek();
    loaded = true;
  }

  /**
   * The ensureOpenWeek/first-sync race can leave an empty local open week on
   * screen while the pull is still bringing this week's real row and entries
   * down. Re-run ensureOpenWeek (which folds away any duplicate open week for
   * the Monday via reconcileOpenWeeks) and reload whenever a sync actually
   * pulled something, so the current week heals itself with no manual refresh —
   * and stay put if the user has navigated away to a past week.
   */
  /**
   * Run a close that was deferred because no successful sync had confirmed
   * the server's view yet. Callers guarantee a sync JUST succeeded, so the
   * local state is fresh ground truth — a close that already happened
   * elsewhere was pulled in and makes this a no-op. Returns what was closed.
   */
  async function retryDeferredClose(): Promise<CloseResult | null> {
    if (!closeDeferred) return null;
    closeDeferred = false;
    const closed = (await hasStaleOpenWeeks()) ? await autoCloseStaleWeeks() : null;
    if (closed) {
      message = `Last week ended and was closed automatically: ${describeClose(closed)}.`;
    } else if (message === DEFER_NOTICE) {
      // The remote close arrived (or nothing was stale) — the notice is moot.
      message = '';
    }
    return closed;
  }

  /** Re-resolve the open week and reload, keeping a past-week view in place. */
  async function refreshOpenWeekView() {
    const viewingOpen = focusStart === openWeekStart;
    const ow = await ensureOpenWeek();
    openWeekStart = ow.week_start;
    if (viewingOpen) focusStart = ow.week_start;
    await loadWeek();
  }

  async function onSync(e: Event) {
    const detail = (e as CustomEvent<SyncResult>).detail;
    if (!loaded || !detail?.ok) return;
    // Harness: refresh the view but never write from an event handler.
    if (isTestMode()) {
      if (detail.pulled > 0) await loadWeek();
      return;
    }
    const closed = closeDeferred ? await retryDeferredClose() : null;
    if (!closed && detail.pulled === 0) return;
    await refreshOpenWeekView();
  }

  /** Load whichever week `focusStart` points at (may not have a row yet). */
  async function loadWeek() {
    week = await findWeek(focusStart);
    // Past weeks read as "what I actually read": opening a closed week drops
    // its never-finished ('rolled') entries — their links went back to the
    // backlog at close, so only the reading history is being tidied.
    if (week?.closed_at) await pruneUnfinishedEntries(week);
    triage = await effectiveTriage(focusStart);
    const names: string[] = [];
    for (const id of triage.focusTagIds) {
      const tag = await get<Tag>('tags', id);
      if (tag) names.push(tag.name);
    }
    focusTagName = names.join(' + ');
    await refresh();
  }

  async function navWeek(dir: -1 | 1) {
    focusStart = weekStartPlus(focusStart, dir);
    await loadWeek();
  }

  async function refresh() {
    if (!week) {
      entries = [];
      tagsByLink = new Map();
      stats = { linksWithNotes: 0, excerpts: 0 };
      suggestions = [];
      allLinks = await all<Link>('links');
      return;
    }
    const [rows, everything] = await Promise.all([weekEntries(week.id), all<Link>('links')]);
    entries = rows;
    allLinks = everything;
    const byLink = new Map<string, Tag[]>();
    let linksWithNotes = 0;
    let excerptCount = 0;
    for (const { link } of rows) {
      byLink.set(link.id, await tagsForLink(link.id));
      const notes = await byIndex<Note>('notes', 'link_id', link.id);
      if (notes.some((n) => n.body_md.trim())) linksWithNotes++;
      excerptCount += (await byIndex<Excerpt>('excerpts', 'link_id', link.id)).length;
    }
    tagsByLink = byLink;
    stats = { linksWithNotes, excerpts: excerptCount };
    // Selections whose entries left this week drop off.
    selectedIds = selectedIds.filter((id) => rows.some((r) => r.link.id === id));
    await refreshSuggestions();
  }

  async function refreshSuggestions() {
    if (quota === null || underQuota === 0) {
      suggestions = [];
      return;
    }
    // Reuse the links refresh() just loaded — suggestLinks would otherwise
    // scan the whole table a second time, moments after the first.
    suggestions = await suggestLinks(
      new Set(entries.map((e) => e.link.id)),
      triage?.focusTagIds ?? [],
      underQuota,
      allLinks.length > 0 ? allLinks : undefined
    );
  }

  async function addSuggestion(link: Link) {
    if (!week) return;
    await addLinkToWeek(week.id, link.id);
    await refresh();
  }

  async function addAllSuggestions() {
    if (!week) return;
    for (const link of suggestions) {
      await addLinkToWeek(week.id, link.id);
    }
    await refresh();
  }

  async function addByUrl() {
    if (!week || !queryIsUrl || adding) return;
    adding = true;
    try {
      const url = new URL(query.trim()).toString();
      const { added } = await captureLinks(url);
      const link = added[0] ?? allLinks.find((l) => l.url === url);
      if (link) await addLinkToWeek(week.id, link.id);
      query = '';
      await refresh();
      if (added.length > 0) {
        await fetchTitles(added);
        await refresh();
      }
    } finally {
      adding = false;
    }
  }

  async function addExisting(link: Link) {
    if (!week) return;
    await addLinkToWeek(week.id, link.id);
    query = '';
    await refresh();
  }

  function sectionOf(key: SectionKey): WeekEntry[] {
    return key === 'toRead' ? toRead : review;
  }

  /**
   * Pointer-based dragging (mouse AND touch — HTML5 drag & drop is
   * mouse-only). pointerdown on a handle arms the drag; the target index
   * tracks whichever entry the pointer is over; pointerup drops.
   */
  function onHandleDown(section: SectionKey, index: number, e: PointerEvent) {
    e.preventDefault();
    const container = (e.currentTarget as HTMLElement).closest('.entries');
    if (!container) return;
    drag = { section, index };
    dragOver = index;

    const indexAt = (y: number): number => {
      const rows = [...container.querySelectorAll(':scope > .entry')];
      const hit = rows.findIndex((r) => {
        const b = r.getBoundingClientRect();
        return y >= b.top && y <= b.bottom;
      });
      if (hit !== -1) return hit;
      return y < rows[0].getBoundingClientRect().top ? 0 : rows.length - 1;
    };

    const onMove = (ev: PointerEvent) => {
      ev.preventDefault(); // keep touch from scrolling mid-drag
      dragOver = indexAt(ev.clientY);
    };
    const onUp = async () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      const from = drag?.index ?? null;
      const to = dragOver;
      const sec = drag?.section ?? null;
      drag = null;
      dragOver = null;
      if (sec !== null && from !== null && to !== null && from !== to) {
        await reorderEntries(
          sectionOf(sec).map((x) => x.entry),
          from,
          to
        );
        await refresh();
      }
    };
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  async function remove(entryId: string) {
    await removeFromWeek(entryId);
    await refresh();
  }

  async function completeReview(entry: WeekLink) {
    await setEntryDone(entry, true);
    await refresh();
  }

  async function onCloseWeek() {
    if (!week || closing) return;
    closing = true;
    try {
      // The manual close is the same stamp-everything write as the automatic
      // one, so it gets the same D14 guard: sync first, so a close recorded
      // on another device is adopted instead of overwritten. Only when the
      // server can't answer does the user decide — with the risk spelled out.
      let syncWarning = '';
      if (!isTestMode() && getSyncMode() !== 'offline' && (await hasEverReachedServer())) {
        const online = typeof navigator === 'undefined' || navigator.onLine;
        const synced = online
          ? await Promise.race([
              syncFresh(),
              new Promise<null>((r) => setTimeout(() => r(null), CLOSE_SYNC_TIMEOUT_MS)),
            ])
          : null;
        if (synced?.ok) {
          const fresh = await get<Week>('weeks', week.id);
          if (!fresh || fresh.closed_at) {
            message = 'This week was already closed on another device.';
            await refreshOpenWeekView();
            return;
          }
          week = fresh;
          await refresh();
        } else {
          syncWarning =
            "The sync server couldn't confirm whether this week was already closed on " +
            'another device — closing now may overwrite reading history recorded there. ';
        }
      }
      const open = toRead.length + review.length;
      const detail =
        syncWarning +
        `Close this week? ` +
        (open > 0 ? `${open} unfinished link${open === 1 ? '' : 's'} return to the backlog. ` : '') +
        `Done links without a topic or favourite go to the slush archive.`;
      if (!confirm(detail)) return;
      const result = await closeWeek(week);
      message = `Week closed: ${describeClose(result)}.`;
      const ow = await ensureOpenWeek();
      openWeekStart = ow.week_start;
      focusStart = ow.week_start;
      await loadWeek();
    } finally {
      closing = false;
    }
  }

  /** Marking read completes the entry too, so reload everything. */
  async function onRowChange() {
    await refresh();
  }

  /** "August 3-9" — the week's whole span, not just its Monday. */
  function formatWeek(weekStart: string): string {
    return formatWeekRange(weekStart);
  }
</script>

{#snippet draggableList(sectionKey: 'toRead' | 'review', withReviewed: boolean)}
  <div class="entries">
    {#each sectionOf(sectionKey) as { entry, link }, i (entry.id)}
      <div
        class="entry"
        class:dragging={drag?.section === sectionKey && drag.index === i}
        class:drag-over={drag?.section === sectionKey && dragOver === i && drag.index !== i}
        class:bulk-selected={selectedIds.includes(link.id)}
        role="listitem"
      >
        <input
          type="checkbox"
          class="entry-check"
          use:liveChecked={{ checked: selectedIds.includes(link.id) }}
          onmousedown={(e) => e.shiftKey && e.preventDefault()}
                onclick={(e) => {
                  e.currentTarget.checked = toggleSelect(link.id, e.shiftKey);
                }}
          aria-label={`Select ${link.title}`}
        />
        <span
          class="handle"
          title="Drag to reorder"
          role="button"
          tabindex="-1"
          onpointerdown={(e) => onHandleDown(sectionKey, i, e)}
        >
          ⠿
        </span>
        <div class="entry-row">
          <LinkRow {link} tags={tagsByLink.get(link.id) ?? []} onChange={onRowChange} showWeek={false} />
        </div>
        {#if withReviewed}
          <button class="btn review-done" onclick={() => completeReview(entry)}>Reviewed</button>
        {/if}
        <button class="corner-remove" title="Remove from this week" onclick={() => remove(entry.id)}>
          ✕
        </button>
      </div>
    {/each}
  </div>
{/snippet}

{#if loaded}
  <div class="stack">
    {#if message}
      <p class="notice">{message}</p>
    {/if}

    {#if allLinks.length === 0}
      <p class="notice onboard-hint">
        Not sure what to do, <a href={href('/onboarding/')}>try the onboarding process</a>
      </p>
    {/if}

    <Card title="Capture">
      <CaptureBox onAdded={() => loadWeek()} />
    </Card>

    <Card title={`${focusStart === currentWeekStart() ? 'This week' : `Week of ${formatWeek(focusStart)}`} — ${done.length}/${entries.length} done`}>
      <div class="week-nav">
        <button class="btn" onclick={() => navWeek(-1)}>← Previous</button>
        <span class="muted">
          {isOpenWeek ? 'Current reading week' : `Week of ${formatWeek(focusStart)}`}
        </span>
        <button class="btn" onclick={() => navWeek(1)}>Next →</button>
      </div>
      {#if entries.length > 0}
        <p class="stats">
          Notes on {stats.linksWithNotes} of {entries.length} link{entries.length === 1 ? '' : 's'}
          · {stats.excerpts} excerpt{stats.excerpts === 1 ? '' : 's'}
        </p>
      {/if}

      {#if selectedLinks.length > 0}
        <BulkActionsPanel
          links={selectedLinks}
          onApplied={() => void loadWeek()}
          onClearSelection={() => (selectedIds = [])}
        />
      {/if}
      {#if isOpenWeek}
        <form
          class="adder"
          onsubmit={(e) => {
            e.preventDefault();
            void addByUrl();
          }}
        >
          <input
            type="text"
            placeholder="Paste a URL to add, or search your links…"
            bind:value={query}
          />
          {#if queryIsUrl}
            <button type="submit" class="btn btn-primary" disabled={adding}>
              {adding ? 'Adding…' : 'Add link'}
            </button>
          {/if}
        </form>
        {#if matches.length > 0}
          <ul class="matches">
            {#each matches as match (match.id)}
              <li>
                <button type="button" class="match" onclick={() => addExisting(match)}>
                  <span class="match-title">{match.title}</span>
                  <span class="match-domain">{domainOf(match.url)}</span>
                </button>
              </li>
            {/each}
          </ul>
        {:else if query.trim() && !queryIsUrl}
          <p class="no-match">No links match — paste a full URL to add a new one.</p>
        {/if}
      {/if}

      {#if isOpenWeek && quota !== null && underQuota > 0 && suggestions.length > 0}
        <div class="suggestions">
          <div class="suggestions-head">
            <span>
              {underQuota} under your quota of {quota}{#if quotaSourceLabel}&nbsp;({quotaSourceLabel}){/if}
              {#if focusTagName}
                — prioritizing <strong>{focusTagName}</strong>
              {/if}
            </span>
            <button type="button" class="btn" onclick={addAllSuggestions}>Add all</button>
          </div>
          <ul class="matches suggestion-list">
            {#each suggestions as suggestion (suggestion.id)}
              <li>
                <button type="button" class="match" onclick={() => addSuggestion(suggestion)}>
                  <span class="match-title">{suggestion.title}</span>
                  <span class="match-domain">{domainOf(suggestion.url)}</span>
                </button>
              </li>
            {/each}
          </ul>
        </div>
      {:else if quota !== null && underQuota > 0}
        <p class="no-match">
          {underQuota} under your quota of {quota}, and the backlog has no unread links to suggest.
        </p>
      {/if}

      {#if toRead.length === 0}
        <p class="empty">Nothing left to read this week.</p>
      {:else}
        {@render draggableList('toRead', false)}
      {/if}
    </Card>

    {#if review.length > 0}
      <Card title={`Review (${review.length})`}>
        <p class="hint">Slushed links you re-scheduled for another look.</p>
        {@render draggableList('review', true)}
      </Card>
    {/if}

    {#if doneTotal > 0}
      <Card title={`Done (${doneNarrowed ? `${done.length} of ${doneTotal}` : doneTotal})`}>
        <ListToolbar
          bind:search={doneSearch}
          bind:order={doneOrder}
          bind:filters={doneFilters}
          filterOptions={FLAG_FILTERS}
          sortLabels={{ newest: 'Newest read', oldest: 'Oldest read' }}
          searchPlaceholder="Search what you've read…"
          selectedCount={doneSelectedCount}
          selectableCount={done.length}
          onToggleAll={toggleAllDone}
        />
        {#if done.length === 0}
          <p class="empty">Nothing you've read this week matches that.</p>
        {/if}
        <div class="entries">
          {#each doneVisible as { entry, link } (entry.id)}
            <div class="entry done-entry" class:bulk-selected={selectedIds.includes(link.id)}>
              <input
                type="checkbox"
                class="entry-check"
                use:liveChecked={{ checked: selectedIds.includes(link.id) }}
                onmousedown={(e) => e.shiftKey && e.preventDefault()}
                onclick={(e) => {
                  e.currentTarget.checked = toggleSelect(link.id, e.shiftKey);
                }}
                aria-label={`Select ${link.title}`}
              />
              <div class="entry-row">
                <LinkRow {link} tags={tagsByLink.get(link.id) ?? []} onChange={onRowChange} showWeek={false} />
              </div>
              <button class="corner-remove" title="Remove from this week" onclick={() => remove(entry.id)}>
                ✕
              </button>
            </div>
          {/each}
        </div>
        <Pagination total={done.length} pageSize={DONE_PAGE_SIZE} bind:page={donePage} label="read links" />
      </Card>
    {/if}

    {#if isOpenWeek}
      <div class="close-row">
        <button class="btn btn-danger" onclick={onCloseWeek} disabled={closing || entries.length === 0}>
          {closing ? 'Closing…' : 'Close week'}
        </button>
      </div>
    {/if}
  </div>
{:else}
  <p class="empty">Loading…</p>
{/if}

<style>
  .stack {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .notice {
    background: var(--color-primary-soft);
    border: 1px solid var(--color-primary);
    border-radius: var(--radius-md);
    padding: var(--space-2) var(--space-3);
    margin: 0;
  }

  .week-nav {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
  }

  .entry-check {
    flex-shrink: 0;
    width: auto;
    margin: 0;
    align-self: center;
  }

  .entry.bulk-selected {
    background: var(--color-primary-soft);
  }

  .week-nav .muted {
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
    text-align: center;
  }

  .adder {
    display: flex;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
  }

  .adder input {
    flex: 1;
    min-width: 0;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    background: var(--surface-color);
    color: var(--text-color);
  }

  .matches {
    list-style: none;
    margin: 0 0 var(--space-3);
    padding: 0;
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  .match {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    width: 100%;
    padding: var(--space-2) var(--space-3);
    border: none;
    border-bottom: 1px solid var(--border-color);
    background: var(--surface-color);
    color: var(--text-color);
    cursor: pointer;
    text-align: left;
  }

  .matches li:last-child .match {
    border-bottom: none;
  }

  .match:hover {
    background: var(--color-primary-soft);
  }

  .match-title {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .match-domain {
    flex-shrink: 0;
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
  }

  .no-match {
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
    margin: 0 0 var(--space-3);
  }

  .hint {
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
    margin: 0 0 var(--space-2);
  }

  .suggestions {
    margin-bottom: var(--space-3);
  }

  .suggestions-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
    margin-bottom: var(--space-2);
  }

  .suggestion-list {
    margin-bottom: 0;
  }

  .empty {
    color: var(--text-muted-color);
    text-align: center;
    padding: var(--space-5) 0;
  }

  .entries {
    display: flex;
    flex-direction: column;
  }

  .entry {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    border-bottom: 1px solid var(--border-color);
  }

  .entry:last-child {
    border-bottom: none;
  }

  .entry.dragging {
    opacity: 0.4;
  }

  .entry.drag-over {
    box-shadow: inset 0 2px 0 var(--color-primary);
  }

  .handle {
    flex-shrink: 0;
    cursor: grab;
    color: var(--text-muted-color);
    font-size: var(--font-size-lg);
    padding: var(--space-1);
    user-select: none;
    /* Pointer-event dragging: the handle must not pan the page on touch. */
    touch-action: none;
  }

  .handle:active {
    cursor: grabbing;
  }

  .handle:hover {
    color: var(--color-primary-strong);
  }

  /* A flow sibling at the end of the entry row (not absolute) so it never
   * overlaps the link's own action buttons. */
  .corner-remove {
    flex-shrink: 0;
    align-self: center;
    width: 1.9rem;
    height: 1.9rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border-color);
    border-radius: var(--radius-full);
    background: var(--surface-raised-color);
    color: var(--color-danger);
    cursor: pointer;
    font-size: var(--font-size-base);
    font-weight: 700;
    line-height: 1;
  }

  .corner-remove:hover {
    background: var(--color-danger);
    color: var(--color-on-primary);
    border-color: var(--color-danger);
  }

  .stats {
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
    margin: 0 0 var(--space-3);
  }

  .entry-row {
    flex: 1;
    min-width: 0;
  }

  /* LinkRow draws its own bottom border; the entry wrapper owns it here. */
  .entry-row :global(.link-item) {
    border-bottom: none;
  }

  .done-entry {
    opacity: 0.75;
  }

  .review-done {
    flex-shrink: 0;
    margin-right: var(--space-4);
  }

  .ctrl {
    width: 1.6rem;
    height: 1.6rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    background: var(--surface-color);
    color: var(--text-muted-color);
    cursor: pointer;
    font-size: var(--font-size-sm);
  }

  .ctrl:hover:not(:disabled) {
    border-color: var(--color-primary);
    color: var(--color-primary-strong);
  }

  .ctrl:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .ctrl.remove:hover {
    border-color: var(--color-danger);
    color: var(--color-danger);
  }

  .close-row {
    display: flex;
    justify-content: flex-end;
  }

  /* Title beside domain leaves too little of either to recognise a result. */
  @media (max-width: 40rem) {
    .match {
      flex-direction: column;
      align-items: stretch;
      gap: 2px;
    }

    .match-title {
      white-space: normal;
      overflow-wrap: anywhere;
    }
  }
</style>
