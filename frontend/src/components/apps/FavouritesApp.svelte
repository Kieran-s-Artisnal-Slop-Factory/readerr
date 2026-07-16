<script lang="ts">
  /**
   * Everything flagged favourite, with tag and topic chips as context.
   * Paginated at 100; labels resolved for the visible page only
   * (scaling.md phase A). Tag-name search lazily loads the full map.
   */
  import { onMount } from 'svelte';
  import Card from '../Card.svelte';
  import LinkList from '../LinkList.svelte';
  import Pagination from '../Pagination.svelte';
  import SearchInput from '../SearchInput.svelte';
  import { all } from '../../lib/db/repo';
  import {
    comparePriority,
    matchesSearch,
    tagsByLinkMap,
    tagsForLinks,
    topicsForLinks,
  } from '../../lib/services/links';
  import type { Link, Tag, Topic } from '../../lib/db/types';

  const PAGE_SIZE = 100;

  let links = $state<Link[]>([]);
  let pageTags = $state<Map<string, Tag[]>>(new Map());
  let pageTopics = $state<Map<string, Topic[]>>(new Map());
  let searchTags = $state<Map<string, Tag[]> | null>(null);
  let search = $state('');
  let page = $state(0);
  let loading = $state(true);

  const filtered = $derived(
    links.filter((l) => matchesSearch(l, searchTags?.get(l.id) ?? [], search))
  );
  const visible = $derived(filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE));

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
    const rows = await all<Link>('links');
    links = rows
      .filter((l) => l.favourite)
      .sort((a, b) => comparePriority(a, b));
    loading = false;
  });

  function onRowChange(updated: Link) {
    // Unfavouriting removes the row from this view.
    links = links.map((l) => (l.id === updated.id ? updated : l)).filter((l) => l.favourite);
  }
</script>

<Card title={`Favourites (${filtered.length.toLocaleString()})`}>
  <div class="search-row">
    <SearchInput bind:value={search} />
  </div>
  {#if loading}
    <p class="empty">Loading…</p>
  {:else}
    <LinkList
      links={visible}
      tagsByLink={pageTags}
      topicsByLink={pageTopics}
      onChange={onRowChange}
      empty={search ? 'No favourites match your search.' : 'Nothing favourited yet — hit ★ on any link.'}
    />
    <Pagination total={filtered.length} pageSize={PAGE_SIZE} bind:page label="favourites" />
  {/if}
</Card>

<style>
  .search-row {
    margin-bottom: var(--space-3);
  }

  .empty {
    color: var(--text-muted-color);
    text-align: center;
    padding: var(--space-5) 0;
  }
</style>
