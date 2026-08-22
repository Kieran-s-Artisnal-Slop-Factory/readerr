<script lang="ts">
  /**
   * One backlog row: title (links out), domain, tag chips, flag toggles.
   * When onAssignmentsChange is provided, a # button expands inline
   * tag/topic pickers so links can be organized without leaving the list.
   *
   * A link flagged `is_series` renders as ONE row with a disclosure triangle
   * and a progress count; expanding it lists its parts as ordinary rows
   * (this component, rendering itself), each with its own ✓. Because every
   * list in the app builds on this component, series behave the same in the
   * reading week, the backlog, favourites, a tag page — everywhere.
   */
  import Self from './LinkRow.svelte';
  import TagPicker from './TagPicker.svelte';
  import TopicPicker from './TopicPicker.svelte';
  import { href } from '../lib/paths';
  import {
    domainOf,
    renameLink,
    toggleFavourite,
    toggleRead,
    toggleResource,
  } from '../lib/services/links';
  import { currentWeekStart, pendingWeeksForLink, setLinkWeek, upcomingWeekOptions } from '../lib/services/weeks';
  import {
    isSeries,
    isSyntheticSeriesUrl,
    markSeriesRead,
    partsOf,
    progressOf,
    type SeriesPart,
  } from '../lib/services/series';
  import type { Link, Tag, Topic } from '../lib/db/types';

  let {
    link,
    tags = [],
    topics = [],
    onChange,
    onAssignmentsChange,
    showWeek = true,
    refNumber,
    readOnly = false,
    nested = false,
  }: {
    link: Link;
    tags?: Tag[];
    topics?: Topic[];
    onChange: (updated: Link) => void;
    /** Hide every write control (flag toggles, title edit, label panel). The
     *  archive view uses this: an archived link lives only in the cold store,
     *  so any write here would resurrect it into the hot `links` store as a
     *  duplicate. Unarchive it first to edit. */
    readOnly?: boolean;
    /** The link's footnote number on a topic page — click the chip to copy
     *  the `[^n]` citation for pasting into the document. */
    refNumber?: number;
    /** Enables the inline label editor; fired after assignments change. */
    onAssignmentsChange?: () => void;
    /** Badge the week(s) the link is scheduled for — the Reading List turns
     *  this off since the week is the page's own context. */
    showWeek?: boolean;
    /** This row IS a part, drawn inside its series. Parts don't expand (a
     *  series can't contain a series in v1) and sit indented. */
    nested?: boolean;
  } = $props();

  // --- series ---------------------------------------------------------------
  // A series row loads its parts up front: the count and the progress are what
  // make the collapsed row worth reading. That's one indexed read plus a get
  // per part, and only for rows that are actually series — never a table scan.
  const series = $derived(isSeries(link) && !nested);
  let parts = $state<SeriesPart[]>([]);
  let expanded = $state(false);
  /** Shown once the last part is ticked — an offer, never an automatic write. */
  let offerComplete = $state(false);

  $effect(() => {
    if (!series) return;
    const id = link.id;
    void link.updated_at; // reload after an edit to the series row itself
    void partsOf(id).then((rows) => (parts = rows));
  });

  const progress = $derived(progressOf(parts));

  /**
   * A part changed: update it in place (re-reading every part would throw away
   * what we already know) and, if that completed the series, offer to close it.
   * The series' own read state stays the user's decision — series.md §3.4.
   *
   * The change is also passed UP to the host list. A part is one of the host's
   * own rows — merely hidden while its series is on screen — so a host that
   * never heard about it would keep a stale copy and re-show the part as
   * unread the moment the series left the list (marking the series read does
   * exactly that on the backlog).
   */
  function onPartChange(updated: Link) {
    parts = parts.map((p) => (p.link.id === updated.id ? { ...p, link: updated } : p));
    if (!link.read_at && progressOf(parts).complete) offerComplete = true;
    onChange(updated);
  }

  async function completeSeries() {
    offerComplete = false;
    const updated = await markSeriesRead(link);
    if (updated) onChange(updated);
  }

  // The link's pending week assignments, shown as 📅 chips in the meta row.
  let scheduledWeeks = $state<string[]>([]);

  $effect(() => {
    if (!showWeek) return;
    const id = link.id;
    void link.updated_at; // re-check after any row change (done, week move…)
    void pendingWeeksForLink(id).then((pending) => {
      scheduledWeeks = pending.map(({ week }) => week.week_start);
    });
  });

  function weekLabel(weekStart: string): string {
    if (weekStart === currentWeekStart()) return 'This week';
    const d = new Date(`${weekStart}T00:00:00`);
    return `Week of ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  }

  let labelsOpen = $state(false);

  // Inline title edit (the pencil next to the title).
  let editingTitle = $state(false);
  let titleDraft = $state('');
  let titleInput = $state<HTMLInputElement | null>(null);

  function startTitleEdit() {
    titleDraft = link.title;
    editingTitle = true;
    setTimeout(() => titleInput?.select(), 0);
  }

  async function saveTitle() {
    if (!editingTitle) return;
    editingTitle = false;
    const title = titleDraft.trim();
    if (!title || title === link.title) return;
    // A hand-edited title is authoritative — stop the fetch retrying over it.
    onChange(await renameLink(link, title));
  }

  // Week assignment (inside the # panel). Loaded lazily when opened.
  let pendingWeek = $state('');
  async function loadPendingWeek() {
    const pending = await pendingWeeksForLink(link.id);
    pendingWeek = pending[0]?.week.week_start ?? '';
  }

  async function changeWeek() {
    await setLinkWeek(link.id, pendingWeek || null);
    // Refresh the 📅 badge (the effect only re-runs when the row changes).
    if (showWeek) {
      const pending = await pendingWeeksForLink(link.id);
      scheduledWeeks = pending.map(({ week }) => week.week_start);
    }
    onAssignmentsChange?.();
  }

  const weekOptions = upcomingWeekOptions();

  function toggleLabels() {
    labelsOpen = !labelsOpen;
    if (labelsOpen) void loadPendingWeek();
  }

  // Click-to-copy for the footnote chip: writing `[^3]` by hand means
  // scrolling back down the page to check the number.
  let copied = $state(false);
  async function copyCitation() {
    try {
      await navigator.clipboard.writeText(`[^${refNumber}]`);
      copied = true;
      setTimeout(() => (copied = false), 1200);
    } catch {
      // Clipboard denied (insecure context, permissions) — the chip still
      // shows the number to type.
    }
  }
</script>

<div class="link-item">
<article class="row" class:read={!!link.read_at}>
  <div class="row-main">
    <span class="title-line">
      {#if refNumber}
        <button
          class="ref-chip"
          class:copied
          title={`Reference ${refNumber} — cite it in the document as [^${refNumber}]`}
          onclick={copyCitation}
        >
          {copied ? '✓' : `[^${refNumber}]`}
        </button>
      {/if}
      {#if series}
        <button
          class="disclosure"
          aria-expanded={expanded}
          title={expanded ? 'Collapse the series' : `Show the ${parts.length} parts`}
          onclick={() => (expanded = !expanded)}
        >
          {expanded ? '▾' : '▸'}
        </button>
      {/if}
      {#if editingTitle}
        <input
          class="title-input"
          bind:this={titleInput}
          bind:value={titleDraft}
          onblur={saveTitle}
          onkeydown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void saveTitle();
            } else if (e.key === 'Escape') {
              editingTitle = false;
            }
          }}
        />
      {:else if series && isSyntheticSeriesUrl(link.url)}
        <!-- No overview page: the synthesised series: URL is not a destination. -->
        <span class="title">{link.title}</span>
        {#if !readOnly}
          <button class="title-edit" title="Edit title" onclick={startTitleEdit}>✎</button>
        {/if}
      {:else}
        <a class="title" href={link.url} target="_blank" rel="noopener noreferrer">
          {link.title}
        </a>
        {#if !readOnly}
          <button class="title-edit" title="Edit title" onclick={startTitleEdit}>✎</button>
        {/if}
      {/if}
      {#if series}
        <span class="series-badge" title="A series: one row holding its parts">series</span>
        {#if parts.length > 0}
          <span class="series-progress" title="Parts read">
            {progress.read}/{progress.total}
          </span>
        {/if}
      {/if}
    </span>
    <div class="meta">
      <span class="domain">{domainOf(link.url)}</span>
      {#if (link.priority ?? 3) < 3}
        <span class="prio-chip" class:top={link.priority === 1} title="Priority {link.priority} (1 = highest; lists sort by priority)">
          P{link.priority}
        </span>
      {/if}
      {#each scheduledWeeks as ws (ws)}
        <span class="week-chip" title="Scheduled reading week">📅 {weekLabel(ws)}</span>
      {/each}
      {#each tags as tag (tag.id)}
        <a class="tag-chip" href={href(`/tag/?id=${tag.id}`)}>{tag.name}</a>
      {/each}
      {#each topics as topic (topic.id)}
        <a class="tag-chip topic-chip" href={href(`/topic/?id=${topic.id}`)}>§ {topic.name}</a>
      {/each}
    </div>
  </div>
  <div class="row-actions">
    {#if !readOnly}
    <button
      class="icon-btn"
      class:active={!!link.read_at}
      title={link.read_at ? 'Mark unread' : 'Mark read'}
      onclick={async () => onChange(await toggleRead(link))}
    >
      ✓
    </button>
    <button
      class="icon-btn"
      class:active={link.favourite}
      title={link.favourite ? 'Unfavourite' : 'Favourite'}
      onclick={async () => onChange(await toggleFavourite(link))}
    >
      ★
    </button>
    <button
      class="icon-btn"
      class:active={link.is_resource}
      title={link.is_resource ? 'Not a resource' : 'Mark as resource'}
      onclick={async () => onChange(await toggleResource(link))}
    >
      ⚒
    </button>
    {#if onAssignmentsChange}
      <button
        class="icon-btn"
        class:active={labelsOpen}
        title="Tags & topics"
        aria-expanded={labelsOpen}
        onclick={toggleLabels}
      >
        #
      </button>
    {/if}
    {/if}
    <a class="icon-btn open" title="Notes & details" href={href(`/link/?id=${link.id}`)}>›</a>
  </div>
</article>
{#if series && offerComplete}
  <div class="series-offer">
    <span>That was the last part of “{link.title}”. Mark the whole series read?</span>
    <span class="series-offer-actions">
      <button class="btn" onclick={() => (offerComplete = false)}>Not yet</button>
      <button class="btn btn-primary" onclick={completeSeries}>Mark read</button>
    </span>
  </div>
{/if}
{#if series && expanded}
  {#if parts.length === 0}
    <p class="series-empty">No parts yet — add them from the series' own page (the › button).</p>
  {:else}
    <div class="series-parts">
      {#each parts as part (part.link.id)}
        <div class="series-part">
          <span class="series-part-number">{part.number}</span>
          <div class="series-part-row">
            <Self link={part.link} onChange={onPartChange} {showWeek} {readOnly} nested />
          </div>
        </div>
      {/each}
    </div>
  {/if}
{/if}
{#if labelsOpen && onAssignmentsChange}
  <div class="labels">
    <div class="labels-group">
      <span class="labels-label">Tags</span>
      <TagPicker linkId={link.id} onChange={onAssignmentsChange} />
    </div>
    <div class="labels-group">
      <span class="labels-label">Topics</span>
      <TopicPicker linkId={link.id} onChange={onAssignmentsChange} />
    </div>
    <div class="labels-group">
      <span class="labels-label">Reading week</span>
      <select class="week-select" bind:value={pendingWeek} onchange={changeWeek}>
        <option value="">None (backlog only)</option>
        {#if pendingWeek && !weekOptions.some((o) => o.value === pendingWeek)}
          <option value={pendingWeek}>Week of {pendingWeek}</option>
        {/if}
        {#each weekOptions as opt (opt.value)}
          <option value={opt.value}>{opt.label}</option>
        {/each}
      </select>
    </div>
  </div>
{/if}
</div>

<style>
  .link-item {
    border-bottom: 1px solid var(--border-color);
  }

  /* --- series --------------------------------------------------------- */

  .disclosure {
    border: none;
    background: none;
    color: var(--text-muted-color);
    cursor: pointer;
    padding: 0 var(--space-1) 0 0;
    font-size: var(--font-size-base);
    line-height: 1;
  }

  .disclosure:hover {
    color: var(--color-primary-strong);
  }

  .series-badge {
    font-size: var(--font-size-sm);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 700;
    background: var(--color-primary-soft);
    color: var(--color-primary-strong);
    border-radius: var(--radius-full);
    padding: 0 var(--space-2);
  }

  .series-progress {
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
    font-variant-numeric: tabular-nums;
  }

  .series-parts {
    margin: 0 0 var(--space-2) var(--space-4);
    border-left: 2px solid var(--border-color);
    padding-left: var(--space-2);
  }

  .series-part {
    display: flex;
    align-items: flex-start;
    gap: var(--space-1);
  }

  .series-part-number {
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
    font-variant-numeric: tabular-nums;
    padding-top: var(--space-2);
    min-width: 1.1rem;
    text-align: right;
  }

  .series-part-row {
    flex: 1;
    min-width: 0;
  }

  /* The parts list owns its own separators; the nested rows shouldn't
     double them up against the series row's border. */
  .series-part:last-child .series-part-row :global(.link-item) {
    border-bottom: none;
  }

  .series-empty {
    margin: 0 0 var(--space-2) var(--space-5);
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
  }

  .series-offer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    margin: 0 0 var(--space-2);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--color-primary);
    border-radius: var(--radius-md);
    background: var(--color-primary-soft);
    font-size: var(--font-size-sm);
  }

  .series-offer-actions {
    display: flex;
    gap: var(--space-2);
  }

  .link-item:last-child {
    border-bottom: none;
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-3);
  }

  .labels {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: 0 var(--space-3) var(--space-3);
  }

  .labels-group {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .labels-label {
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
    font-weight: 600;
  }

  .row.read .title {
    color: var(--text-muted-color);
  }

  /* The footnote number, set before the title like the citation it stands for. */
  .ref-chip {
    flex-shrink: 0;
    align-self: baseline;
    border: 1px dashed var(--border-color);
    border-radius: var(--radius-md);
    background: var(--surface-color);
    color: var(--text-muted-color);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: var(--font-size-sm);
    padding: 0 var(--space-2);
    cursor: pointer;
    min-width: 3.5rem;
  }

  .ref-chip:hover {
    border-color: var(--color-primary);
    color: var(--color-primary-strong);
  }

  .ref-chip.copied {
    border-style: solid;
    border-color: var(--color-primary);
    background: var(--color-primary-soft);
    color: var(--color-primary-strong);
  }

  .row-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .title-line {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    min-width: 0;
  }

  .title {
    color: var(--text-color);
    font-weight: 600;
    text-decoration: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .title-edit {
    border: none;
    background: none;
    color: var(--text-muted-color);
    cursor: pointer;
    padding: 0 var(--space-1);
    font-size: var(--font-size-sm);
    flex-shrink: 0;
    opacity: 0.6;
  }

  .title-edit:hover {
    color: var(--color-primary-strong);
    opacity: 1;
  }

  .title-input {
    width: 100%;
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--color-primary);
    border-radius: var(--radius-md);
    background: var(--surface-color);
    color: var(--text-color);
    font-weight: 600;
    font-size: var(--font-size-base);
  }

  .week-select {
    max-width: 16rem;
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    background: var(--surface-color);
    color: var(--text-color);
    font-size: var(--font-size-sm);
  }

  .title:hover {
    color: var(--color-primary-strong);
    text-decoration: underline;
  }

  .meta {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
  }

  .tag-chip {
    border: 1px solid var(--border-color);
    border-radius: var(--radius-full);
    padding: 0 var(--space-2);
    text-decoration: none;
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
  }

  .tag-chip:hover {
    border-color: var(--color-primary);
    color: var(--color-primary-strong);
  }

  .topic-chip {
    border-style: dashed;
  }

  .week-chip {
    border: 1px solid var(--color-primary);
    border-radius: var(--radius-full);
    padding: 0 var(--space-2);
    color: var(--color-primary-strong);
    background: var(--color-primary-soft);
    font-size: var(--font-size-sm);
    white-space: nowrap;
  }

  .prio-chip {
    border: 1px solid var(--color-warning);
    border-radius: var(--radius-full);
    padding: 0 var(--space-2);
    color: var(--color-warning);
    font-size: var(--font-size-sm);
    font-weight: 700;
    white-space: nowrap;
  }

  .prio-chip.top {
    border-color: var(--color-danger);
    color: var(--color-danger);
  }

  .row-actions {
    display: flex;
    gap: var(--space-1);
    flex-shrink: 0;
  }

  .icon-btn {
    width: 2rem;
    height: 2rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    background: var(--surface-color);
    color: var(--text-muted-color);
    cursor: pointer;
    text-decoration: none;
    font-size: var(--font-size-base);
  }

  .icon-btn:hover {
    border-color: var(--color-primary);
    color: var(--color-primary-strong);
  }

  .icon-btn.active {
    background: var(--color-primary-soft);
    border-color: var(--color-primary);
    color: var(--color-primary-strong);
  }

  /*
   * On a phone the action buttons are ~176px of a ~280px row, which left
   * the title 42px — a fifth of a typical headline. Below 40rem the row
   * stacks instead: the title gets the full width and wraps (capped at
   * three lines so one runaway title can't own the screen), and the
   * buttons drop underneath at a comfortable tap size.
   */
  @media (max-width: 40rem) {
    .row {
      flex-direction: column;
      align-items: stretch;
      gap: var(--space-2);
    }

    .title-line {
      align-items: baseline;
    }

    .title {
      white-space: normal;
      overflow-wrap: anywhere;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      line-clamp: 3;
      -webkit-box-orient: vertical;
    }

    .row-actions {
      gap: var(--space-2);
    }

    .icon-btn {
      width: 2.25rem;
      height: 2.25rem;
    }

    .week-select {
      max-width: none;
    }
  }
</style>
