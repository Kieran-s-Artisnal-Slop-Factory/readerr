<script lang="ts">
  /**
   * Backlog: quick-paste capture plus every captured link, newest first,
   * not-done above done (#15), paginated at 100 (scaling.md phase A). Tag
   * chips are resolved for the visible page only; searching by tag name
   * lazily loads the full tag map on first keystroke.
   */
  import { onMount } from 'svelte';
  import Card from '../Card.svelte';
  import CaptureBox from '../CaptureBox.svelte';
  import ChipFilter from '../ChipFilter.svelte';
  import LinkList from '../LinkList.svelte';
  import Pagination from '../Pagination.svelte';
  import SearchInput from '../SearchInput.svelte';
  import { all } from '../../lib/db/repo';
  import { retryMissingTitles } from '../../lib/services/capture';
  import { matchesSearch, tagsByLinkMap, tagsForLinks } from '../../lib/services/links';
  import type { Link, Tag } from '../../lib/db/types';

  const PAGE_SIZE = 100;

  let links = $state<Link[]>([]);
  let pageTags = $state<Map<string, Tag[]>>(new Map());
  let searchTags = $state<Map<string, Tag[]> | null>(null);
  let filters = $state<string[]>([]);
  let search = $state('');
  let page = $state(0);
  let loading = $state(true);

  const FILTER_OPTIONS = [
    { value: 'unread', label: 'Unread' },
    { value: 'read', label: 'Read' },
    { value: 'favourite', label: 'Favourites' },
    { value: 'resource', label: 'Resources' },
  ];

  const filtered = $derived(
    links.filter((l) => {
      if (l.slushed_at) return false; // marked done just now → moved to slush
      if (filters.includes('unread') && l.read_at) return false;
      if (filters.includes('read') && !l.read_at) return false;
      if (filters.includes('favourite') && !l.favourite) return false;
      if (filters.includes('resource') && !l.is_resource) return false;
      return matchesSearch(l, searchTags?.get(l.id) ?? [], search);
    })
  );

  // Not-done items first (#15), then done, both newest first.
  const ordered = $derived([
    ...filtered.filter((l) => !l.read_at),
    ...filtered.filter((l) => !!l.read_at),
  ]);
  const visible = $derived(ordered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE));

  // Resolve tag chips for the visible page only.
  $effect(() => {
    const slice = visible;
    void tagsForLinks(slice).then((m) => (pageTags = m));
  });

  // Tag-name search needs the full map; load it once on first search.
  $effect(() => {
    if (search.trim() && !searchTags) {
      void tagsByLinkMap().then((m) => (searchTags = m));
    }
  });

  async function refresh() {
    const rows = await all<Link>('links');
    // Slushed links live in the slush archive, not the backlog.
    links = rows
      .filter((l) => !l.slushed_at)
      .sort((a, b) => (a.added_at < b.added_at ? 1 : -1));
    searchTags = null; // stale after any data change
  }

  onMount(async () => {
    await refresh();
    loading = false;
    // Resolve titles for anything captured offline / that failed before.
    // refresh afterwards so resolved titles appear without a reload.
    retryMissingTitles().then(refresh);
  });

  function onRowChange(updated: Link) {
    links = links.map((l) => (l.id === updated.id ? updated : l));
  }
</script>

<div class="stack">
  <Card title="Capture">
    <CaptureBox onAdded={() => refresh().then(() => retryMissingTitles().then(refresh))} />
  </Card>

  <Card title={`Backlog (${ordered.length.toLocaleString()})`}>
    <div class="controls">
      <SearchInput bind:value={search} />
      <ChipFilter options={FILTER_OPTIONS} bind:selected={filters} />
    </div>
    {#if loading}
      <p class="empty">Loading…</p>
    {:else}
      <LinkList links={visible} tagsByLink={pageTags} onChange={onRowChange}
        onAssignmentsChange={() => void refresh()}
        empty="No links yet — paste some above to get started." />
      <Pagination total={ordered.length} pageSize={PAGE_SIZE} bind:page label="links" />
    {/if}
  </Card>
</div>

<style>
  .stack {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
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
</style>
