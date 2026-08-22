<script lang="ts">
  /**
   * Backlog: quick-paste capture plus every captured link, newest first,
   * not-done above done (#15), paginated at 100. Tag chips are resolved for
   * the visible page only; searching by tag name lazily loads the full tag
   * map on first keystroke.
   */
  import { onMount } from 'svelte';
  import BulkActionsPanel from '../BulkActionsPanel.svelte';
  import Card from '../Card.svelte';
  import CaptureBox from '../CaptureBox.svelte';
  import LinkList from '../LinkList.svelte';
  import ListToolbar from '../ListToolbar.svelte';
  import Pagination from '../Pagination.svelte';
  import SeriesModal from '../SeriesModal.svelte';
  import { all } from '../../lib/db/repo';
  import { retryMissingTitles } from '../../lib/services/capture';
  import {
    compareByOrder,
    FLAG_FILTERS,
    matchesFlagFilters,
    matchesSearch,
    tagsByLinkMap,
    tagsForLinks,
  } from '../../lib/services/links';
  import { href } from '../../lib/paths';
  import type { Link, Tag } from '../../lib/db/types';

  const PAGE_SIZE = 100;

  let links = $state<Link[]>([]);
  let pageTags = $state<Map<string, Tag[]>>(new Map());
  let searchTags = $state<Map<string, Tag[]> | null>(null);
  let filters = $state<string[]>([]);
  let search = $state('');
  let order = $state<'newest' | 'oldest'>('newest');
  let page = $state(0);
  let loading = $state(true);
  // Bulk operations selection (checkboxes come from LinkList's selectable mode).
  let selectedIds = $state<string[]>([]);

  // The backlog is the unread triage queue: read links leave it (marking one
  // read adds it to the current week) and slushed links live in the archive.
  const ordered = $derived(
    links
      .filter((l) => {
        if (l.read_at || l.slushed_at) return false;
        if (!matchesFlagFilters(l, filters)) return false;
        return matchesSearch(l, searchTags?.get(l.id) ?? [], search);
      })
      // Priority still decides first — the toggle flips capture order within
      // a priority band, so triage order survives (see docs/user).
      .sort(compareByOrder(order))
  );
  const visible = $derived(ordered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE));


  /** Select-all covers everything the filters leave, not just this page. */
  const selectedHere = $derived(ordered.filter((l) => selectedIds.includes(l.id)).length);

  function toggleAll(selectAll: boolean) {
    const ids = ordered.map((l) => l.id);
    if (selectAll) {
      selectedIds = [...new Set([...selectedIds, ...ids])];
    } else {
      const drop = new Set(ids);
      selectedIds = selectedIds.filter((id) => !drop.has(id));
    }
  }

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
    // Slushed links live in the slush archive, not the backlog. Ordering is
    // `ordered`'s job now, since it depends on the sort toggle.
    links = rows.filter((l) => !l.slushed_at);
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
    <div class="capture-extras">
      <!-- Multi-part writing doesn't paste as a flat list: it goes in as one
           series that holds its parts (docs/dev/experiments & plans/series.md). -->
      <SeriesModal onCreated={() => void refresh()} />
      <span class="capture-hint">…or add a multi-part series as one link.</span>
    </div>
  </Card>

  <Card title={`Backlog (${ordered.length.toLocaleString()})`}>
    <ListToolbar
      bind:search
      bind:order
      bind:filters
      filterOptions={FLAG_FILTERS}
      sortLabels={{ newest: 'Newest captured', oldest: 'Oldest captured' }}
      selectedCount={selectedHere}
      selectableCount={ordered.length}
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

  .empty {
    color: var(--text-muted-color);
    text-align: center;
    padding: var(--space-5) 0;
  }

  .capture-extras {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-top: var(--space-3);
    padding-top: var(--space-3);
    border-top: 1px solid var(--border-color);
  }

  .capture-hint {
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
  }

  .onboard-hint {
    background: var(--color-primary-soft);
    border: 1px solid var(--color-primary);
    border-radius: var(--radius-md);
    padding: var(--space-2) var(--space-3);
    margin: 0;
  }
</style>
