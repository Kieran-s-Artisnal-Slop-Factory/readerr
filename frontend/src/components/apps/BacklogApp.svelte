<script lang="ts">
  /**
   * Backlog: quick-paste capture plus every captured link, newest first,
   * not-done above done (#15), paginated at 100 (scaling.md phase A). Tag
   * chips are resolved for the visible page only; searching by tag name
   * lazily loads the full tag map on first keystroke.
   */
  import { onMount } from 'svelte';
  import BulkActionsPanel from '../BulkActionsPanel.svelte';
  import Card from '../Card.svelte';
  import CaptureBox from '../CaptureBox.svelte';
  import ChipFilter from '../ChipFilter.svelte';
  import LinkList from '../LinkList.svelte';
  import Pagination from '../Pagination.svelte';
  import SearchInput from '../SearchInput.svelte';
  import { all } from '../../lib/db/repo';
  import { retryMissingTitles } from '../../lib/services/capture';
  import { comparePriority, matchesSearch, tagsByLinkMap, tagsForLinks } from '../../lib/services/links';
  import { href } from '../../lib/paths';
  import type { Link, Tag } from '../../lib/db/types';

  const PAGE_SIZE = 100;

  let links = $state<Link[]>([]);
  let pageTags = $state<Map<string, Tag[]>>(new Map());
  let searchTags = $state<Map<string, Tag[]> | null>(null);
  let filters = $state<string[]>([]);
  let search = $state('');
  let page = $state(0);
  let loading = $state(true);
  // Bulk operations selection (checkboxes come from LinkList's selectable mode).
  let selectedIds = $state<string[]>([]);

  const FILTER_OPTIONS = [
    { value: 'favourite', label: 'Favourites' },
    { value: 'resource', label: 'Resources' },
  ];

  // The backlog is the unread triage queue: read links leave it (marking one
  // read adds it to the current week) and slushed links live in the archive.
  const ordered = $derived(
    links.filter((l) => {
      if (l.read_at || l.slushed_at) return false;
      if (filters.includes('favourite') && !l.favourite) return false;
      if (filters.includes('resource') && !l.is_resource) return false;
      return matchesSearch(l, searchTags?.get(l.id) ?? [], search);
    })
  );
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
    // Slushed links live in the slush archive, not the backlog. Priority 1
    // floats to the top; newest capture wins within a priority.
    links = rows
      .filter((l) => !l.slushed_at)
      .sort((a, b) => comparePriority(a, b));
    searchTags = null; // stale after any data change
    // Selections whose links left the backlog (done/slushed) drop off.
    const ids = new Set(links.map((l) => l.id));
    selectedIds = selectedIds.filter((id) => ids.has(id));
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
  {#if !loading && links.length === 0}
    <p class="onboard-hint">
      Not sure what to do, <a href={href('/onboarding/')}>try the onboarding process</a>
    </p>
  {/if}

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
      {#if selectedIds.length > 0}
        <BulkActionsPanel
          links={links.filter((l) => selectedIds.includes(l.id))}
          onApplied={() => void refresh()}
          onClearSelection={() => (selectedIds = [])}
        />
      {/if}
      <LinkList links={visible} tagsByLink={pageTags} onChange={onRowChange}
        onAssignmentsChange={() => void refresh()}
        selectable bind:selectedIds
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

  .onboard-hint {
    background: var(--color-primary-soft);
    border: 1px solid var(--color-primary);
    border-radius: var(--radius-md);
    padding: var(--space-2) var(--space-3);
    margin: 0;
  }
</style>
