<script lang="ts">
  /**
   * Link detail: edit title/url and flags, assign tags/topics, keep excerpts
   * (notable quotations) and a free-form note. The note row is created
   * lazily on first edit; both prose fields autosave via MarkdownEditor's
   * debounced onChange. Resource-list membership is edited here too, which is
   * the only per-link way in (the list pages add FROM the list's side).
   */
  import { onMount } from 'svelte';
  import Card from '../Card.svelte';
  import MarkdownEditor from '../MarkdownEditor.svelte';
  import TagPicker from '../TagPicker.svelte';
  import TopicPicker from '../TopicPicker.svelte';
  import { byIndex, get, put, softDelete, withSyncFields } from '../../lib/db/repo';
  import { domainOf, toggleFavourite, toggleRead, toggleResource } from '../../lib/services/links';
  import { getNote } from '../../lib/services/notes';
  import {
    entryKindFor,
    pendingWeeksForLink,
    removeFromWeek,
    scheduleLinkForWeek,
    upcomingWeekOptions,
    weekHistoryForLink,
    type HistoryEntry,
    type PendingWeekAssignment,
  } from '../../lib/services/weeks';
  import SeriesParts from '../SeriesParts.svelte';
  import { href } from '../../lib/paths';
  import { isSeries, isSyntheticSeriesUrl, partsOf, seriesForLink } from '../../lib/services/series';
  import {
    addLinksToList,
    listResourceLists,
    removeLinksFromList,
  } from '../../lib/services/resourceLists';
  import type { Excerpt, Link, Note, ResourceList, ResourceListLink } from '../../lib/db/types';

  let link = $state<Link | null>(null);
  let note = $state<Note | null>(null);
  let excerpts = $state<Excerpt[]>([]);
  let history = $state<HistoryEntry[]>([]);
  let pending = $state<PendingWeekAssignment[]>([]);
  let weekChoice = $state('');
  let missing = $state(false);
  /** Every list, and the ids of the ones this link is in. */
  let allLists = $state<ResourceList[]>([]);
  let memberListIds = $state<Set<string>>(new Set());
  let newListName = $state('');
  // The note loads a tick after the link, so the Notes editor must wait for
  // it — otherwise it mounts with '' before the note arrives (the editor
  // only reads `value` at mount), showing an existing note as blank and
  // overwriting it on the next keystroke.
  let loaded = $state(false);
  let creatingNote = $state(false);
  /** The series this link belongs to, if any — usually none. */
  let memberOf = $state<{ series: Link; number: number; total: number }[]>([]);
  // Editing title/url is explicit (form + save) since it's rare.
  let editingMeta = $state(false);
  let editTitle = $state('');
  let editUrl = $state('');

  onMount(async () => {
    const id = new URLSearchParams(location.search).get('id');
    if (!id) {
      missing = true;
      return;
    }
    link = (await get<Link>('links', id)) ?? null;
    if (!link) {
      missing = true;
      return;
    }
    // Collapse any duplicate note rows (two devices editing offline) so the
    // freshest body shows and both devices converge on one row.
    note = await getNote(id);
    excerpts = (await byIndex<Excerpt>('excerpts', 'link_id', id)).sort(
      (a, b) => a.position - b.position
    );
    await refreshWeeks(id);
    await refreshLists(id);
    await refreshSeries(id);
    loaded = true;
  });

  /**
   * Delete the series container. Its edges go with it (a live edge pointing at
   * a tombstoned link is a referential violation), the parts do not.
   */
  async function dropSeries() {
    if (!link) return;
    if (!confirm(`Delete the series “${link.title}”? Its parts stay in your library.`)) return;
    const { deleteSeries } = await import('../../lib/services/series');
    await deleteSeries(link);
    location.href = href('/backlog/');
  }

  /** "Part 3 of Async Rust" — the other half of the series relationship. */
  async function refreshSeries(linkId: string) {
    const owners = await seriesForLink(linkId);
    memberOf = await Promise.all(
      owners.map(async (series) => {
        const parts = await partsOf(series.id);
        return {
          series,
          number: parts.findIndex((p) => p.link.id === linkId) + 1,
          total: parts.length,
        };
      })
    );
  }

  const weekOptions = upcomingWeekOptions();

  /** The scheduled week and the history list move together — reload both. */
  async function refreshWeeks(linkId: string) {
    history = await weekHistoryForLink(linkId);
    pending = await pendingWeeksForLink(linkId);
    // Prefer the first UNFINISHED assignment: a done-but-not-yet-closed entry
    // is a record, not a schedule, so the control shouldn't snap back to it.
    weekChoice = (pending.find((p) => !p.entry.done_at) ?? pending[0])?.week.week_start ?? '';
  }

  /** Resource-list memberships for this link (both directions of the join). */
  async function refreshLists(linkId: string) {
    const [lists, joins] = await Promise.all([
      listResourceLists(),
      byIndex<ResourceListLink>('resource_list_links', 'link_id', linkId),
    ]);
    allLists = lists;
    memberListIds = new Set(joins.map((j) => j.list_id));
  }

  /**
   * Toggle membership. Adding also flags the link a resource — list
   * membership IS the organizational layer over the flat resources view — so
   * the flag in the header above updates with it.
   */
  async function toggleList(list: ResourceList) {
    if (!link) return;
    if (memberListIds.has(list.id)) await removeLinksFromList(list.id, [link]);
    else await addLinksToList(list.id, [link]);
    link = (await get<Link>('links', link.id)) ?? link;
    await refreshLists(link.id);
  }

  async function createListWithLink() {
    const name = newListName.trim();
    if (!name || !link) return;
    const existing = allLists.find((l) => l.name.toLowerCase() === name.toLowerCase());
    const list = existing ?? (await put('resource_lists', withSyncFields({ name, description_md: '' })));
    await addLinksToList(list.id, [link]);
    newListName = '';
    link = (await get<Link>('links', link.id)) ?? link;
    await refreshLists(link.id);
  }

  /** What adding the link to a week would file it as, in plain words. */
  const nextKind = $derived(link && entryKindFor(link) === 'review' ? 'review' : 'first read');

  async function changeWeek() {
    if (!link) return;
    link = await scheduleLinkForWeek(link, weekChoice || null);
    await refreshWeeks(link.id);
  }

  async function unschedule(assignment: PendingWeekAssignment) {
    if (!link) return;
    await removeFromWeek(assignment.entry.id);
    await refreshWeeks(link.id);
  }

  function describeHistory(h: HistoryEntry): string {
    const kind = h.entry.kind === 'review' ? 'review' : 'reading';
    if (h.entry.outcome === 'read') return `${kind} — done`;
    if (h.entry.outcome === 'slushed') return `${kind} — done, slushed`;
    if (h.entry.outcome === 'rolled') return `${kind} — not finished, returned to backlog`;
    return h.entry.done_at ? `${kind} — done` : `${kind} — in progress`;
  }

  function formatWeek(weekStart: string): string {
    return new Date(`${weekStart}T00:00:00`).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  }

  async function saveNote(md: string) {
    if (!link) return;
    if (note) {
      note = await put('notes', { ...note, body_md: md });
    } else if (md.trim() && !creatingNote) {
      // Lock so rapid debounced saves before the first put resolves can't
      // create duplicate note rows.
      creatingNote = true;
      note = await put('notes', withSyncFields({ link_id: link.id, body_md: md }));
      creatingNote = false;
    }
  }

  async function addExcerpt() {
    if (!link) return;
    const position = excerpts.length > 0 ? excerpts[excerpts.length - 1].position + 1 : 0;
    const row = await put(
      'excerpts',
      withSyncFields({ link_id: link.id, content_md: '', position })
    );
    excerpts = [...excerpts, row];
  }

  async function saveExcerpt(excerpt: Excerpt, md: string) {
    const updated = await put('excerpts', { ...excerpt, content_md: md });
    excerpts = excerpts.map((e) => (e.id === updated.id ? updated : e));
  }

  async function deleteExcerpt(excerpt: Excerpt) {
    await softDelete('excerpts', excerpt.id);
    excerpts = excerpts.filter((e) => e.id !== excerpt.id);
  }

  function startEditMeta() {
    if (!link) return;
    editTitle = link.title;
    editUrl = link.url;
    editingMeta = true;
  }

  async function saveMeta() {
    if (!link) return;
    link = await put('links', { ...link, title: editTitle.trim() || link.url, url: editUrl.trim() });
    editingMeta = false;
  }
</script>

{#if missing}
  <p class="empty">Link not found. <a href="./..">Back to the backlog.</a></p>
{:else if link}
  <div class="stack">
    <Card>
      {#if editingMeta}
        <form
          class="meta-form"
          onsubmit={(e) => {
            e.preventDefault();
            void saveMeta();
          }}
        >
          <input type="text" bind:value={editTitle} placeholder="Title" />
          <input type="url" bind:value={editUrl} placeholder="URL" required />
          <div class="meta-actions">
            <button type="button" class="btn" onclick={() => (editingMeta = false)}>Cancel</button>
            <button type="submit" class="btn btn-primary">Save</button>
          </div>
        </form>
      {:else}
        <div class="header">
          <div class="header-main">
            <span class="title-line">
              {#if isSeries(link) && isSyntheticSeriesUrl(link.url)}
                <!-- A series with no overview page: the synthesised URL is not
                     somewhere to go, so it isn't rendered as a link. -->
                <span class="title">{link.title}</span>
              {:else}
                <a class="title" href={link.url} target="_blank" rel="noopener noreferrer">
                  {link.title}
                </a>
              {/if}
              {#if isSeries(link)}
                <span class="series-badge">series</span>
              {/if}
            </span>
            <span class="domain">
              {#if isSeries(link)}
                {isSyntheticSeriesUrl(link.url)
                  ? 'no overview page — this page is the overview'
                  : domainOf(link.url)}
              {:else}
                {domainOf(link.url)}
              {/if}
            </span>
            {#each memberOf as owner (owner.series.id)}
              <span class="part-of">
                Part {owner.number} of {owner.total} —
                <a href={href(`/link/?id=${owner.series.id}`)}>{owner.series.title}</a>
              </span>
            {/each}
          </div>
          <button class="btn" onclick={startEditMeta}>Edit</button>
        </div>
      {/if}
      <div class="flags">
        <button
          class="flag"
          class:active={!!link.read_at}
          onclick={async () => (link = await toggleRead(link!))}
        >
          ✓ {link.read_at ? 'Read' : 'Unread'}
        </button>
        <button
          class="flag"
          class:active={link.favourite}
          onclick={async () => (link = await toggleFavourite(link!))}
        >
          ★ Favourite
        </button>
        <button
          class="flag"
          class:active={link.is_resource}
          onclick={async () => (link = await toggleResource(link!))}
        >
          ⚒ Resource
        </button>
      </div>
    </Card>

    {#if isSeries(link)}
      <Card title="Parts">
        <SeriesParts series={link} />
        <div class="series-danger">
          <!-- The only "delete a link" path in the app, and deliberately so:
               a series is a container the user made, and deleting it must not
               take the parts (they are real captures) with it. -->
          <button class="btn btn-danger" onclick={dropSeries}>Delete series</button>
          <span class="hint">The parts stay in your library.</span>
        </div>
      </Card>
    {/if}

    <Card title="Reading week">
      {#if pending.length === 0}
        <p class="hint">
          Not scheduled for a week. Adding it now files it as a <strong>{nextKind}</strong>.
        </p>
      {:else}
        <ul class="weeks">
          {#each pending as assignment (assignment.entry.id)}
            <li>
              <span class="week-name">Week of {formatWeek(assignment.week.week_start)}</span>
              <span class="week-kind">{describeHistory(assignment)}</span>
              <button class="btn btn-danger" onclick={() => unschedule(assignment)}>Remove</button>
            </li>
          {/each}
        </ul>
      {/if}
      <label class="week-label" for="week-select">Scheduled for</label>
      <select id="week-select" class="week-select" bind:value={weekChoice} onchange={changeWeek}>
        <option value="">Not scheduled (backlog only)</option>
        {#if weekChoice && !weekOptions.some((o) => o.value === weekChoice)}
          <option value={weekChoice}>Week of {weekChoice}</option>
        {/if}
        {#each weekOptions as opt (opt.value)}
          <option value={opt.value}>{opt.label}</option>
        {/each}
      </select>
    </Card>

    <Card title="Tags">
      <TagPicker linkId={link.id} />
    </Card>

    <Card title="Topics">
      <TopicPicker linkId={link.id} />
    </Card>

    <Card title={`Resource lists (${memberListIds.size})`}>
      <p class="hint">
        Adding this link to a list also marks it a <strong>resource</strong>.
        Removing it from one leaves the flag alone — it is still reference
        material, just not in that list.
      </p>
      {#if allLists.length > 0}
        <div class="chips">
          {#each allLists as list (list.id)}
            <button
              type="button"
              class="chip"
              class:selected={memberListIds.has(list.id)}
              aria-pressed={memberListIds.has(list.id)}
              onclick={() => toggleList(list)}
            >
              {list.name}
            </button>
          {/each}
        </div>
      {/if}
      <form
        class="create"
        onsubmit={(e) => {
          e.preventDefault();
          void createListWithLink();
        }}
      >
        <input type="text" placeholder="New list…" bind:value={newListName} />
        <button type="submit" class="btn" disabled={!newListName.trim()}>Add</button>
      </form>
    </Card>

    <Card title="Excerpts">
      <div class="excerpts">
        {#each excerpts as excerpt (excerpt.id)}
          <div class="excerpt">
            <MarkdownEditor
              value={excerpt.content_md}
              placeholder="Notable quotation…"
              exportName={`${link.title} excerpt`}
              onChange={(md) => saveExcerpt(excerpt, md)}
            />
            <button class="btn btn-danger" onclick={() => deleteExcerpt(excerpt)}>Delete</button>
          </div>
        {/each}
        <button class="btn" onclick={addExcerpt}>+ Add excerpt</button>
      </div>
    </Card>

    <!-- A series' note IS its overview document: the description typed when
         the series was created lands here, and everything a link's notes can
         do (markdown, MD/HTML export) applies unchanged. -->
    <Card title={isSeries(link) ? 'Overview' : 'Notes'}>
      {#if loaded}
        <MarkdownEditor
          value={note?.body_md ?? ''}
          placeholder={isSeries(link)
            ? 'What this series covers, why it is worth reading…'
            : 'Notes about this link…'}
          exportName={link.title}
          onChange={saveNote}
        />
      {:else}
        <p class="empty">Loading…</p>
      {/if}
    </Card>

    <Card title="History">
      {#if history.length === 0}
        <p class="empty">Never scheduled into a week yet.</p>
      {:else}
        <ul class="history">
          {#each history as h (h.entry.id)}
            <li>
              <span class="history-week">Week of {formatWeek(h.week.week_start)}</span>
              <span class="history-detail">{describeHistory(h)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </Card>
  </div>
{:else}
  <p class="empty">Loading…</p>
{/if}

<style>
  /* Resource-list chips: the TagPicker vocabulary, so the two cards read alike. */
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    margin-bottom: var(--space-2);
  }

  .chip {
    border: 1px solid var(--border-color);
    border-radius: var(--radius-full);
    background: var(--surface-color);
    padding: 0 var(--space-3);
    font-size: var(--font-size-sm);
    line-height: 1.9;
    cursor: pointer;
    color: var(--text-color);
  }

  .chip:hover {
    border-color: var(--color-primary);
  }

  .chip.selected {
    background: var(--color-primary-soft);
    border-color: var(--color-primary);
    color: var(--color-primary-strong);
    font-weight: 600;
  }

  .create {
    display: flex;
    gap: var(--space-2);
  }

  .create input {
    flex: 1;
    min-width: 0;
    padding: var(--space-1) var(--space-3);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    background: var(--surface-color);
    color: var(--text-color);
  }

  .stack {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .title-line {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: var(--space-2);
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

  .part-of {
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
  }

  .series-danger {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-top: var(--space-3);
    padding-top: var(--space-3);
    border-top: 1px solid var(--border-color);
  }

  .empty {
    color: var(--text-muted-color);
    text-align: center;
    padding: var(--space-5) 0;
  }

  .header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .header-main {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .title {
    font-size: var(--font-size-lg);
    font-weight: 700;
    color: var(--text-color);
    text-decoration: none;
    overflow-wrap: anywhere;
  }

  .title:hover {
    color: var(--color-primary-strong);
    text-decoration: underline;
  }

  .domain {
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
  }

  .meta-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .meta-form input {
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    background: var(--surface-color);
    color: var(--text-color);
  }

  .meta-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
  }

  .flags {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-top: var(--space-3);
  }

  .flag {
    border: 1px solid var(--border-color);
    border-radius: var(--radius-full);
    background: var(--surface-color);
    padding: var(--space-1) var(--space-3);
    font-size: var(--font-size-sm);
    font-weight: 600;
    cursor: pointer;
    color: var(--text-muted-color);
  }

  .flag:hover {
    border-color: var(--color-primary);
  }

  .flag.active {
    background: var(--color-primary-soft);
    border-color: var(--color-primary);
    color: var(--color-primary-strong);
  }

  .excerpts {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .excerpt {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    align-items: flex-end;
  }

  .excerpt :global(.editor) {
    width: 100%;
  }

  .hint {
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
    margin: 0 0 var(--space-3);
  }

  .weeks {
    list-style: none;
    margin: 0 0 var(--space-3);
    padding: 0;
  }

  .weeks li {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    padding: var(--space-1) 0;
  }

  .week-name {
    font-weight: 600;
  }

  .week-kind {
    flex: 1;
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
  }

  .week-select {
    max-width: 20rem;
  }

  .week-label {
    margin-bottom: var(--space-1);
  }

  .history {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .history li {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
    padding: var(--space-1) 0;
    border-bottom: 1px solid var(--border-color);
  }

  .history li:last-child {
    border-bottom: none;
  }

  .history-week {
    font-weight: 600;
  }

  .history-detail {
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
  }
</style>
