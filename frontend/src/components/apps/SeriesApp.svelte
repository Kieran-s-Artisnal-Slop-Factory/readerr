<script lang="ts">
  /**
   * Series index (Collections → Series): every multi-part thing you're
   * working through, with how far in you are.
   *
   * The rows are ordinary LinkRows, because a series is an ordinary link —
   * so each one expands to its parts, ticks off, favourites and opens exactly
   * as it does in the reading week or the backlog. What this page adds is
   * finding them: nothing else lists series and only series.
   */
  import { onMount } from 'svelte';
  import Card from '../Card.svelte';
  import LinkList from '../LinkList.svelte';
  import ListToolbar from '../ListToolbar.svelte';
  import Pagination from '../Pagination.svelte';
  import SeriesModal from '../SeriesModal.svelte';
  import {
    compareByOrder,
    FLAG_FILTERS,
    matchesFlagFilters,
    matchesSearch,
    tagsByLinkMap,
    tagsForLinks,
  } from '../../lib/services/links';
  import { listSeries, type SeriesSummary } from '../../lib/services/series';
  import type { Link, Tag } from '../../lib/db/types';

  const PAGE_SIZE = 50;
  // Every row here is a series already — that chip would filter nothing out.
  const FILTER_OPTIONS = FLAG_FILTERS.filter((f) => f.value !== 'series');

  let rows = $state<SeriesSummary[]>([]);
  let pageTags = $state<Map<string, Tag[]>>(new Map());
  let searchTags = $state<Map<string, Tag[]> | null>(null);
  let search = $state('');
  let order = $state<'newest' | 'oldest'>('newest');
  let filters = $state<string[]>([]);
  let page = $state(0);
  let loading = $state(true);

  const byId = $derived(new Map(rows.map((r) => [r.series.id, r])));

  const filtered = $derived(
    rows
      .map((r) => r.series)
      .filter((l) => matchesFlagFilters(l, filters))
      .filter((l) => matchesSearch(l, searchTags?.get(l.id) ?? [], search))
      .sort(compareByOrder(order))
  );
  const visible = $derived(filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE));

  /** Roll-up across every series, not just the page or the search. */
  const totals = $derived({
    series: rows.length,
    parts: rows.reduce((n, r) => n + r.progress.total, 0),
    read: rows.reduce((n, r) => n + r.progress.read, 0),
    finished: rows.filter((r) => r.progress.complete).length,
  });

  $effect(() => {
    const slice = visible;
    void tagsForLinks(slice).then((m) => (pageTags = m));
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
    rows = await listSeries();
    searchTags = null; // stale after any data change
  }

  function onRowChange(updated: Link) {
    // A part changing bubbles up here too (LinkRow passes it on), so only
    // touch the row that is actually a series on this page.
    const row = byId.get(updated.id);
    if (row) rows = rows.map((r) => (r.series.id === updated.id ? { ...r, series: updated } : r));
  }
</script>

<div class="stack">
  <Card title={`Series (${filtered.length.toLocaleString()})`}>
    <p class="hint">
      A series is one link holding the parts that make it up. Expand a row to
      tick parts off; open one (<b>›</b>) for its overview, notes and part
      ordering.
    </p>

    <div class="bar">
      <SeriesModal onCreated={() => void refresh()} />
      {#if !loading && totals.series > 0}
        <span class="totals">
          {totals.parts.toLocaleString()} part{totals.parts === 1 ? '' : 's'} ·
          {totals.read.toLocaleString()} read ·
          {totals.finished.toLocaleString()} finished
        </span>
      {/if}
    </div>

    <ListToolbar
      bind:search
      bind:order
      bind:filters
      filterOptions={FILTER_OPTIONS}
      sortLabels={{ newest: 'Newest created', oldest: 'Oldest created' }}
    />

    {#if loading}
      <p class="empty">Loading…</p>
    {:else}
      <LinkList
        links={visible}
        tagsByLink={pageTags}
        onChange={onRowChange}
        onAssignmentsChange={() => void refresh()}
        empty={search || filters.length > 0
          ? 'No series match that.'
          : 'No series yet — “Add series” turns a run of posts into one link.'}
      />
      <Pagination total={filtered.length} pageSize={PAGE_SIZE} bind:page label="series" />
    {/if}
  </Card>
</div>

<style>
  .stack {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .hint {
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
    margin: 0 0 var(--space-3);
  }

  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
    margin-bottom: var(--space-3);
  }

  .totals {
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
  }

  .empty {
    color: var(--text-muted-color);
    text-align: center;
    padding: var(--space-5) 0;
  }
</style>
