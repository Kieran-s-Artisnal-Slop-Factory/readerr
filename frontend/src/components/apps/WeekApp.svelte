<script lang="ts">
  /**
   * This week's reading list, in three sections: To read (unfinished
   * 'reading' entries), Review (unfinished slush re-reads), and Done.
   * Marking a link read completes its entry; a week whose Monday has
   * passed closes itself on page load — done links get their outcome
   * (read/slushed) and everything unfinished returns to the backlog.
   */
  import { onMount } from 'svelte';
  import Card from '../Card.svelte';
  import LinkRow from '../LinkRow.svelte';
  import { all, byIndex, get } from '../../lib/db/repo';
  import { captureLinks, fetchTitles } from '../../lib/services/capture';
  import { domainOf, tagsForLink } from '../../lib/services/links';
  import { effectiveTriage, type EffectiveTriage } from '../../lib/services/plans';
  import {
    addLinkToWeek,
    autoCloseStaleWeeks,
    closeWeek,
    ensureOpenWeek,
    removeFromWeek,
    reorderEntries,
    setEntryDone,
    suggestLinks,
    weekEntries,
    type CloseResult,
    type WeekEntry,
  } from '../../lib/services/weeks';
  import type { Excerpt, Link, Note, Tag, Week, WeekLink } from '../../lib/db/types';

  let week = $state<Week | null>(null);
  let entries = $state<WeekEntry[]>([]);
  let tagsByLink = $state<Map<string, Tag[]>>(new Map());
  let allLinks = $state<Link[]>([]);
  let query = $state('');
  let adding = $state(false);
  let closing = $state(false);
  let message = $state('');
  let triage = $state<EffectiveTriage | null>(null);
  let suggestions = $state<Link[]>([]);
  let focusTagName = $state('');
  /** Notes taken across this week's links (#6). */
  let stats = $state({ linksWithNotes: 0, excerpts: 0 });

  // Drag-and-drop reordering, section-local (#13).
  type SectionKey = 'toRead' | 'review';
  let drag = $state<{ section: SectionKey; index: number } | null>(null);
  let dragOver = $state<number | null>(null);

  const toRead = $derived(entries.filter((e) => e.entry.kind === 'reading' && !e.entry.done_at));
  const review = $derived(entries.filter((e) => e.entry.kind === 'review' && !e.entry.done_at));
  const done = $derived(entries.filter((e) => !!e.entry.done_at));

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

  onMount(async () => {
    // A week whose Monday has passed closes itself (#14).
    const autoClosed = await autoCloseStaleWeeks();
    if (autoClosed) {
      message = `Last week ended and was closed automatically: ${describeClose(autoClosed)}.`;
    }
    week = await ensureOpenWeek();
    triage = await effectiveTriage(week.week_start);
    if (triage.focusTagId) {
      const tag = await get<Tag>('tags', triage.focusTagId);
      focusTagName = tag?.name ?? '';
    }
    await refresh();
  });

  async function refresh() {
    if (!week) return;
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
    await refreshSuggestions();
  }

  async function refreshSuggestions() {
    if (quota === null || underQuota === 0) {
      suggestions = [];
      return;
    }
    suggestions = await suggestLinks(
      new Set(entries.map((e) => e.link.id)),
      triage?.focusTagId ?? null,
      underQuota
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

  function onDragStart(section: SectionKey, index: number, e: DragEvent) {
    drag = { section, index };
    dragOver = index;
    if (e.dataTransfer) {
      e.dataTransfer.setData('text/plain', ''); // Firefox requires data
      e.dataTransfer.effectAllowed = 'move';
    }
  }

  function onDragOver(section: SectionKey, index: number, e: DragEvent) {
    if (drag?.section !== section) return;
    e.preventDefault();
    dragOver = index;
  }

  async function onDrop(section: SectionKey, index: number, e: DragEvent) {
    e.preventDefault();
    if (drag?.section !== section) return;
    const from = drag.index;
    drag = null;
    dragOver = null;
    await reorderEntries(
      sectionOf(section).map((x) => x.entry),
      from,
      index
    );
    await refresh();
  }

  function onDragEnd() {
    drag = null;
    dragOver = null;
  }

  async function remove(entryId: string) {
    await removeFromWeek(entryId);
    await refresh();
  }

  async function completeReview(entry: WeekLink) {
    await setEntryDone(entry, true);
    await refresh();
  }

  async function reopenEntry(entry: WeekLink) {
    await setEntryDone(entry, false);
    await refresh();
  }

  async function onCloseWeek() {
    if (!week || closing) return;
    const open = toRead.length + review.length;
    const detail =
      `Close this week? ` +
      (open > 0 ? `${open} unfinished link${open === 1 ? '' : 's'} return to the backlog. ` : '') +
      `Done links without a topic or favourite go to the slush archive.`;
    if (!confirm(detail)) return;
    closing = true;
    try {
      const result = await closeWeek(week);
      message = `Week closed: ${describeClose(result)}.`;
      week = await ensureOpenWeek();
      await refresh();
    } finally {
      closing = false;
    }
  }

  /** Marking read completes the entry too, so reload everything. */
  async function onRowChange() {
    await refresh();
  }

  function formatWeek(weekStart: string): string {
    const d = new Date(`${weekStart}T00:00:00`);
    return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
  }
</script>

{#snippet draggableList(sectionKey: 'toRead' | 'review', withReviewed: boolean)}
  <div class="entries">
    {#each sectionOf(sectionKey) as { entry, link }, i (entry.id)}
      <div
        class="entry"
        class:dragging={drag?.section === sectionKey && drag.index === i}
        class:drag-over={drag?.section === sectionKey && dragOver === i && drag.index !== i}
        role="listitem"
        ondragover={(e) => onDragOver(sectionKey, i, e)}
        ondrop={(e) => onDrop(sectionKey, i, e)}
      >
        <span
          class="handle"
          title="Drag to reorder"
          draggable="true"
          role="button"
          tabindex="-1"
          ondragstart={(e) => onDragStart(sectionKey, i, e)}
          ondragend={onDragEnd}
        >
          ⠿
        </span>
        <div class="entry-row">
          <LinkRow {link} tags={tagsByLink.get(link.id) ?? []} onChange={onRowChange} />
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

{#if week}
  <div class="stack">
    {#if message}
      <p class="notice">{message}</p>
    {/if}

    <Card title={`Week of ${formatWeek(week.week_start)} — ${done.length}/${entries.length} done`}>
      {#if entries.length > 0}
        <p class="stats">
          Notes on {stats.linksWithNotes} of {entries.length} link{entries.length === 1 ? '' : 's'}
          · {stats.excerpts} excerpt{stats.excerpts === 1 ? '' : 's'}
        </p>
      {/if}
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

      {#if quota !== null && underQuota > 0 && suggestions.length > 0}
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

    {#if done.length > 0}
      <Card title={`Done (${done.length})`}>
        <div class="entries">
          {#each done as { entry, link } (entry.id)}
            <div class="entry done-entry">
              <button class="ctrl" title="Not done after all" onclick={() => reopenEntry(entry)}>↩</button>
              <div class="entry-row">
                <LinkRow {link} tags={tagsByLink.get(link.id) ?? []} onChange={onRowChange} />
              </div>
              <button class="corner-remove" title="Remove from this week" onclick={() => remove(entry.id)}>
                ✕
              </button>
            </div>
          {/each}
        </div>
      </Card>
    {/if}

    <div class="close-row">
      <button class="btn btn-danger" onclick={onCloseWeek} disabled={closing || entries.length === 0}>
        {closing ? 'Closing…' : 'Close week'}
      </button>
    </div>
  </div>
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
  }

  .handle:active {
    cursor: grabbing;
  }

  .handle:hover {
    color: var(--color-primary-strong);
  }

  .corner-remove {
    position: absolute;
    top: 2px;
    right: 2px;
    width: 1.3rem;
    height: 1.3rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: var(--radius-full);
    background: none;
    color: var(--text-muted-color);
    cursor: pointer;
    font-size: var(--font-size-sm);
    opacity: 0.6;
  }

  .corner-remove:hover {
    opacity: 1;
    background: var(--color-primary-soft);
    color: var(--color-danger);
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
</style>
