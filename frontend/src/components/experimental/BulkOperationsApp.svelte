<script lang="ts">
  /**
   * EXPERIMENT (see experiments.md #2, mounted only on /bulk-operations-test):
   * a backlog-style listing of EXISTING links with WordPress/Drupal-style
   * bulk operations — check off rows, then batch add/remove tags/topics,
   * set/clear favourite/resource/done, and assign or clear the reading week.
   *
   * Isolated app component: it composes shared building blocks (LinkRow,
   * ChipSelect, Pagination, services) without modifying any of them. Delete
   * this file + its page to remove the experiment.
   */
  import { onMount } from 'svelte';
  import Card from '../Card.svelte';
  import ChipFilter from '../ChipFilter.svelte';
  import ChipSelect from '../ChipSelect.svelte';
  import LinkRow from '../LinkRow.svelte';
  import Pagination from '../Pagination.svelte';
  import SearchInput from '../SearchInput.svelte';
  import { all, put, withSyncFields } from '../../lib/db/repo';
  import {
    assignTag,
    assignTopic,
    markLinkDone,
    matchesSearch,
    tagsForLinks,
    toggleRead,
    unassignTag,
    unassignTopic,
  } from '../../lib/services/links';
  import { setLinkWeek, upcomingWeekOptions } from '../../lib/services/weeks';
  import type { Link, Tag, Topic } from '../../lib/db/types';

  const PAGE_SIZE = 100;

  let links = $state<Link[]>([]);
  let pageTags = $state<Map<string, Tag[]>>(new Map());
  let allTags = $state<Tag[]>([]);
  let allTopics = $state<Topic[]>([]);
  let search = $state('');
  let filters = $state<string[]>([]);
  let page = $state(0);
  let loading = $state(true);
  let busy = $state(false);
  let message = $state('');

  // Selection + the operation panel's inputs.
  let selectedIds = $state<string[]>([]);
  let tagIdsToApply = $state<string[]>([]);
  let topicIdsToApply = $state<string[]>([]);
  let weekChoice = $state('');

  const weekOptions = upcomingWeekOptions();

  const FILTER_OPTIONS = [
    { value: 'unread', label: 'Unread' },
    { value: 'read', label: 'Read' },
    { value: 'favourite', label: 'Favourites' },
    { value: 'resource', label: 'Resources' },
    { value: 'slushed', label: 'Slushed' },
  ];

  // Unlike the backlog, EVERY live link is listed — bulk ops target existing
  // items wherever they are in the lifecycle. Filters narrow, not exclude.
  const filtered = $derived(
    links.filter((l) => {
      if (filters.includes('unread') && l.read_at) return false;
      if (filters.includes('read') && !l.read_at) return false;
      if (filters.includes('favourite') && !l.favourite) return false;
      if (filters.includes('resource') && !l.is_resource) return false;
      if (filters.includes('slushed') && !l.slushed_at) return false;
      return matchesSearch(l, pageTags.get(l.id) ?? [], search);
    })
  );
  const visible = $derived(filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE));
  const selectedSet = $derived(new Set(selectedIds));
  const selectedLinks = $derived(links.filter((l) => selectedSet.has(l.id)));
  const allVisibleSelected = $derived(
    visible.length > 0 && visible.every((l) => selectedSet.has(l.id))
  );

  $effect(() => {
    const slice = visible;
    void tagsForLinks(slice).then((m) => (pageTags = m));
  });

  onMount(refresh);

  async function refresh() {
    const [rows, tags, topics] = await Promise.all([
      all<Link>('links'),
      all<Tag>('tags'),
      all<Topic>('topics'),
    ]);
    links = rows.sort((a, b) => (a.added_at < b.added_at ? 1 : -1));
    allTags = tags.sort((a, b) => a.name.localeCompare(b.name));
    allTopics = topics.sort((a, b) => a.name.localeCompare(b.name));
    // Drop selections whose links no longer exist.
    const ids = new Set(rows.map((l) => l.id));
    selectedIds = selectedIds.filter((id) => ids.has(id));
    loading = false;
  }

  function toggleSelect(id: string) {
    selectedIds = selectedSet.has(id)
      ? selectedIds.filter((s) => s !== id)
      : [...selectedIds, id];
  }

  function togglePageSelection() {
    if (allVisibleSelected) {
      const pageIds = new Set(visible.map((l) => l.id));
      selectedIds = selectedIds.filter((id) => !pageIds.has(id));
    } else {
      selectedIds = [...new Set([...selectedIds, ...visible.map((l) => l.id)])];
    }
  }

  async function createTag(name: string): Promise<string> {
    const tag = await put('tags', withSyncFields({ name, notes_md: '' }));
    allTags = [...allTags, tag].sort((a, b) => a.name.localeCompare(b.name));
    return tag.id;
  }

  async function createTopic(name: string): Promise<string> {
    const topic = await put('topics', withSyncFields({ name, body_md: '' }));
    allTopics = [...allTopics, topic].sort((a, b) => a.name.localeCompare(b.name));
    return topic.id;
  }

  /** Run an operation over every selected link, then refresh + report. */
  async function forSelected(label: string, op: (link: Link) => Promise<unknown>) {
    if (busy || selectedLinks.length === 0) return;
    busy = true;
    try {
      for (const link of selectedLinks) await op(link);
      await refresh();
      message = `${label} applied to ${selectedLinks.length} link${selectedLinks.length === 1 ? '' : 's'}.`;
    } finally {
      busy = false;
    }
  }

  const addTags = () =>
    forSelected('Tags added', async (l) => {
      for (const id of tagIdsToApply) await assignTag(l.id, id);
    });
  const removeTags = () =>
    forSelected('Tags removed', async (l) => {
      for (const id of tagIdsToApply) await unassignTag(l.id, id);
    });
  const addTopics = () =>
    forSelected('Topics added', async (l) => {
      for (const id of topicIdsToApply) await assignTopic(l.id, id);
    });
  const removeTopics = () =>
    forSelected('Topics removed', async (l) => {
      for (const id of topicIdsToApply) await unassignTopic(l.id, id);
    });
  // Favouriting rescues from the slush (matches toggleFavourite); clearing
  // leaves slushed_at alone.
  const setFavourite = (v: boolean) =>
    forSelected(v ? 'Favourited' : 'Unfavourited', (l) =>
      l.favourite === v ? Promise.resolve() : put('links', { ...l, favourite: v, slushed_at: v ? null : l.slushed_at })
    );
  const setResource = (v: boolean) =>
    forSelected(v ? 'Marked as resources' : 'Unmarked as resources', (l) =>
      l.is_resource === v ? Promise.resolve() : put('links', { ...l, is_resource: v })
    );
  const setDone = (v: boolean) =>
    forSelected(v ? 'Marked done' : 'Marked unread', (l) => {
      if (v) return l.read_at ? Promise.resolve() : markLinkDone(l, false);
      return l.read_at ? toggleRead(l) : Promise.resolve();
    });
  const setWeek = () => forSelected('Week set', (l) => setLinkWeek(l.id, weekChoice || null));
  const clearWeek = () => forSelected('Week cleared', (l) => setLinkWeek(l.id, null));
</script>

<div class="stack">
  {#if message}
    <p class="notice">{message}</p>
  {/if}

  {#if selectedIds.length > 0}
    <Card title={`Bulk operations — ${selectedIds.length} selected`}>
      <div class="op-group">
        <span class="op-label">Tags</span>
        <ChipSelect items={allTags} bind:selected={tagIdsToApply} createPlaceholder="New tag…" pageLabel="tags" onCreate={createTag} />
        <div class="op-actions">
          <button class="btn" disabled={busy || tagIdsToApply.length === 0} onclick={addTags}>Add to selected</button>
          <button class="btn btn-danger" disabled={busy || tagIdsToApply.length === 0} onclick={removeTags}>Remove from selected</button>
        </div>
      </div>

      <div class="op-group">
        <span class="op-label">Topics</span>
        <ChipSelect items={allTopics} bind:selected={topicIdsToApply} createPlaceholder="New topic…" pageLabel="topics" onCreate={createTopic} />
        <div class="op-actions">
          <button class="btn" disabled={busy || topicIdsToApply.length === 0} onclick={addTopics}>Add to selected</button>
          <button class="btn btn-danger" disabled={busy || topicIdsToApply.length === 0} onclick={removeTopics}>Remove from selected</button>
        </div>
      </div>

      <div class="op-group">
        <span class="op-label">Flags</span>
        <div class="op-actions">
          <button class="btn" disabled={busy} onclick={() => setFavourite(true)}>★ Favourite</button>
          <button class="btn" disabled={busy} onclick={() => setFavourite(false)}>Unfavourite</button>
          <button class="btn" disabled={busy} onclick={() => setResource(true)}>⚒ Resource</button>
          <button class="btn" disabled={busy} onclick={() => setResource(false)}>Not a resource</button>
          <button class="btn" disabled={busy} onclick={() => setDone(true)}>✓ Mark done</button>
          <button class="btn" disabled={busy} onclick={() => setDone(false)}>Mark unread</button>
        </div>
      </div>

      <div class="op-group">
        <span class="op-label">Reading week</span>
        <div class="op-actions">
          <select bind:value={weekChoice}>
            <option value="">None (backlog only)</option>
            {#each weekOptions as opt (opt.value)}
              <option value={opt.value}>{opt.label}</option>
            {/each}
          </select>
          <button class="btn" disabled={busy} onclick={setWeek}>Set week</button>
          <button class="btn" disabled={busy} onclick={clearWeek}>Clear week</button>
        </div>
      </div>

      <div class="op-actions">
        <button class="btn" disabled={busy} onclick={() => (selectedIds = [])}>Clear selection</button>
      </div>
    </Card>
  {/if}

  <Card title={`All links (${filtered.length.toLocaleString()})`}>
    <div class="controls">
      <SearchInput bind:value={search} />
      <ChipFilter options={FILTER_OPTIONS} bind:selected={filters} />
    </div>
    {#if loading}
      <p class="empty">Loading…</p>
    {:else if visible.length === 0}
      <p class="empty">{search || filters.length ? 'Nothing matches.' : 'No links yet.'}</p>
    {:else}
      <label class="select-all">
        <input type="checkbox" checked={allVisibleSelected} onchange={togglePageSelection} />
        Select all on this page ({visible.length})
      </label>
      <div class="rows">
        {#each visible as link (link.id)}
          <div class="row" class:selected={selectedSet.has(link.id)}>
            <input
              type="checkbox"
              class="row-check"
              checked={selectedSet.has(link.id)}
              onchange={() => toggleSelect(link.id)}
              aria-label={`Select ${link.title}`}
            />
            <div class="row-link">
              <LinkRow {link} tags={pageTags.get(link.id) ?? []} onChange={() => void refresh()} />
            </div>
          </div>
        {/each}
      </div>
      <Pagination total={filtered.length} pageSize={PAGE_SIZE} bind:page label="links" />
    {/if}
  </Card>
</div>

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

  .controls {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-bottom: var(--space-2);
  }

  .empty {
    color: var(--text-muted-color);
    text-align: center;
    padding: var(--space-5) 0;
  }

  .op-group {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding-bottom: var(--space-3);
    margin-bottom: var(--space-3);
    border-bottom: 1px solid var(--border-color);
  }

  .op-label {
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-muted-color);
  }

  .op-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .op-actions select {
    width: auto;
  }

  .select-all {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0 0 var(--space-2);
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
    cursor: pointer;
  }

  .select-all input,
  .row-check {
    width: auto;
    margin: 0;
  }

  .rows {
    display: flex;
    flex-direction: column;
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    border-bottom: 1px solid var(--border-color);
  }

  .row:last-child {
    border-bottom: none;
  }

  .row.selected {
    background: var(--color-primary-soft);
  }

  .row-check {
    flex-shrink: 0;
    margin-left: var(--space-2);
  }

  .row-link {
    flex: 1;
    min-width: 0;
  }

  .row-link :global(.link-item) {
    border-bottom: none;
  }
</style>
