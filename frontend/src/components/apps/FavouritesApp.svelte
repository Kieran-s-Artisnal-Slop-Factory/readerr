<script lang="ts">
  /**
   * Everything flagged favourite, with tag and topic chips as context.
   * Carries the same toolbar as the Backlog and the Reading List's Done
   * card — search, newest/oldest captured, bulk selection — minus the
   * favourites filter, which every row here would pass anyway.
   * Paginated at 100; labels resolved for the visible page only.
   * Tag-name search lazily loads the full map.
   */
  import { onMount } from 'svelte';
  import BulkActionsPanel from '../BulkActionsPanel.svelte';
  import Card from '../Card.svelte';
  import LinkList from '../LinkList.svelte';
  import ListToolbar from '../ListToolbar.svelte';
  import Pagination from '../Pagination.svelte';
  import { all } from '../../lib/db/repo';
  import {
    compareByOrder,
    FLAG_FILTERS,
    matchesFlagFilters,
    matchesSearch,
    tagsByLinkMap,
    tagsForLinks,
    topicsForLinks,
  } from '../../lib/services/links';
  import type { Link, Tag, Topic } from '../../lib/db/types';

  const PAGE_SIZE = 100;
  // Every row here is already a favourite — offering that filter would be a
  // no-op chip, so only 'resource' is worth showing.
  const FILTER_OPTIONS = FLAG_FILTERS.filter((f) => f.value !== 'favourite');

  let links = $state<Link[]>([]);
  let pageTags = $state<Map<string, Tag[]>>(new Map());
  let pageTopics = $state<Map<string, Topic[]>>(new Map());
  let searchTags = $state<Map<string, Tag[]> | null>(null);
  let search = $state('');
  let order = $state<'newest' | 'oldest'>('newest');
  let filters = $state<string[]>([]);
  let page = $state(0);
  let loading = $state(true);
  let selectedIds = $state<string[]>([]);

  const filtered = $derived(
    links
      .filter((l) => matchesFlagFilters(l, filters))
      .filter((l) => matchesSearch(l, searchTags?.get(l.id) ?? [], search))
      .sort(compareByOrder(order))
  );
  const visible = $derived(filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE));


  /** Select-all covers everything the filters leave, not just this page. */
  const selectedHere = $derived(filtered.filter((l) => selectedIds.includes(l.id)).length);

  function toggleAll(selectAll: boolean) {
    const ids = filtered.map((l) => l.id);
    if (selectAll) {
      selectedIds = [...new Set([...selectedIds, ...ids])];
    } else {
      const drop = new Set(ids);
      selectedIds = selectedIds.filter((id) => !drop.has(id));
    }
  }

  $effect(() => {
    const slice = visible;
    void tagsForLinks(slice).then((m) => (pageTags = m));
    void topicsForLinks(slice).then((m) => (pageTopics = m));
  });

  $effect(() => {
    if (search.trim() && !searchTags) {
      void tagsByLinkMap().then((m) => (searchTags = m));
    }
  });

  onMount(async () => {
    await refresh();
    loading = false;
  });

  async function refresh() {
    const rows = await all<Link>('links');
    links = rows.filter((l) => l.favourite);
    searchTags = null; // stale after any data change
    // Selections whose links are no longer favourites drop off.
    const ids = new Set(links.map((l) => l.id));
    selectedIds = selectedIds.filter((id) => ids.has(id));
  }

  function onRowChange(updated: Link) {
    // Unfavouriting removes the row from this view.
    links = links.map((l) => (l.id === updated.id ? updated : l)).filter((l) => l.favourite);
  }
</script>

<Card title={`Favourites (${filtered.length.toLocaleString()})`}>
  <ListToolbar
    bind:search
    bind:order
    bind:filters
    filterOptions={FILTER_OPTIONS}
    sortLabels={{ newest: 'Newest captured', oldest: 'Oldest captured' }}
    selectedCount={selectedHere}
    selectableCount={filtered.length}
    onToggleAll={toggleAll}
  />
  {#if loading}
    <p class="empty">Loading…</p>
  {:else}
    {#if selectedIds.length > 0}
      <BulkActionsPanel
        links={links.filter((l) => selectedIds.includes(l.id))}
        onApplied={() => void refresh()}
        onClearSelection={() => (selectedIds = [])}
      />
    {/if}
    <LinkList
      links={visible}
      tagsByLink={pageTags}
      topicsByLink={pageTopics}
      onChange={onRowChange}
      onAssignmentsChange={() => void refresh()}
      selectable
      bind:selectedIds
      empty={search || filters.length > 0
        ? 'No favourites match that.'
        : 'Nothing favourited yet — hit ★ on any link.'}
    />
    <Pagination total={filtered.length} pageSize={PAGE_SIZE} bind:page label="favourites" />
  {/if}
</Card>

<style>
  .empty {
    color: var(--text-muted-color);
    text-align: center;
    padding: var(--space-5) 0;
  }
</style>
