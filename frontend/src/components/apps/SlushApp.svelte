<script lang="ts">
  /**
   * The slush archive: read links that weren't part of a topic or
   * favourited when their week closed. Each row can be re-scheduled
   * ("reviewed") into an upcoming week. Paginated at 250 with page-scoped
   * labels (scaling.md phase A).
   */
  import { onMount } from 'svelte';
  import Card from '../Card.svelte';
  import LinkRow from '../LinkRow.svelte';
  import Pagination from '../Pagination.svelte';
  import SearchInput from '../SearchInput.svelte';
  import { all } from '../../lib/db/repo';
  import { comparePriority, matchesSearch, tagsByLinkMap, tagsForLinks } from '../../lib/services/links';
  import { reviewLink, upcomingWeekOptions } from '../../lib/services/weeks';
  import type { Link, Tag } from '../../lib/db/types';

  const PAGE_SIZE = 250;

  let links = $state<Link[]>([]);
  let pageTags = $state<Map<string, Tag[]>>(new Map());
  let searchTags = $state<Map<string, Tag[]> | null>(null);
  let search = $state('');
  let page = $state(0);
  let loading = $state(true);
  let message = $state('');

  const weekOptions = upcomingWeekOptions();

  const filtered = $derived(
    links.filter((l) => matchesSearch(l, searchTags?.get(l.id) ?? [], search))
  );
  const visible = $derived(filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE));

  $effect(() => {
    const slice = visible;
    void tagsForLinks(slice).then((m) => (pageTags = m));
  });

  $effect(() => {
    if (search.trim() && !searchTags) {
      void tagsByLinkMap().then((m) => (searchTags = m));
    }
  });

  onMount(refresh);

  async function refresh() {
    const rows = await all<Link>('links');
    links = rows
      .filter((l) => l.slushed_at)
      .sort((a, b) => comparePriority(a, b, (l) => l.slushed_at ?? ''));
    searchTags = null;
    loading = false;
  }

  async function review(link: Link, e: Event) {
    const select = e.target as HTMLSelectElement;
    const weekStart = select.value;
    select.value = '';
    if (!weekStart) return;
    await reviewLink(link, weekStart);
    message = `"${link.title}" scheduled for review.`;
    await refresh();
  }

  function onRowChange(updated: Link) {
    // Un-marking read (or favouriting) pulls the link out of the slush.
    links = links.map((l) => (l.id === updated.id ? updated : l)).filter((l) => l.slushed_at);
  }
</script>

<Card title={`Slush (${filtered.length.toLocaleString()})`}>
  <p class="hint">
    Read links that weren't favourited or referenced in a topic when their
    week closed. Pick a week to give one another look.
  </p>
  {#if message}
    <p class="notice">{message}</p>
  {/if}
  <div class="search-row">
    <SearchInput bind:value={search} />
  </div>
  {#if loading}
    <p class="empty">Loading…</p>
  {:else if visible.length === 0}
    <p class="empty">
      {search ? 'Nothing in the slush matches your search.' : 'Nothing slushed yet.'}
    </p>
  {:else}
    <div class="list">
      {#each visible as link (link.id)}
        <div class="slush-row">
          <div class="slush-link">
            <LinkRow {link} tags={pageTags.get(link.id) ?? []} onChange={onRowChange} />
          </div>
          <select class="review-select" title="Re-schedule for another week" onchange={(e) => review(link, e)}>
            <option value="">Review in…</option>
            {#each weekOptions as opt (opt.value)}
              <option value={opt.value}>{opt.label}</option>
            {/each}
          </select>
        </div>
      {/each}
    </div>
    <Pagination total={filtered.length} pageSize={PAGE_SIZE} bind:page label="slushed links" />
  {/if}
</Card>

<style>
  .search-row {
    margin-bottom: var(--space-3);
  }

  .hint {
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
    margin: 0 0 var(--space-3);
  }

  .notice {
    background: var(--color-primary-soft);
    border: 1px solid var(--color-primary);
    border-radius: var(--radius-md);
    padding: var(--space-1) var(--space-3);
    margin: 0 0 var(--space-3);
    font-size: var(--font-size-sm);
  }

  .empty {
    color: var(--text-muted-color);
    text-align: center;
    padding: var(--space-5) 0;
  }

  .list {
    display: flex;
    flex-direction: column;
  }

  .slush-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    border-bottom: 1px solid var(--border-color);
  }

  .slush-row:last-child {
    border-bottom: none;
  }

  .slush-link {
    flex: 1;
    min-width: 0;
  }

  .slush-link :global(.link-item) {
    border-bottom: none;
  }

  .review-select {
    flex-shrink: 0;
    width: auto;
    max-width: 11rem;
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    background: var(--surface-color);
    color: var(--text-color);
    font-size: var(--font-size-sm);
  }

  /* Side by side, the picker leaves the link barely half a phone screen. */
  @media (max-width: 40rem) {
    .slush-row {
      flex-direction: column;
      align-items: stretch;
      gap: 0;
      padding-bottom: var(--space-3);
    }

    .review-select {
      max-width: none;
      width: 100%;
      margin-top: var(--space-1);
    }
  }
</style>
