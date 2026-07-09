<script lang="ts">
  /**
   * The slush archive: read links that weren't part of a topic or
   * favourited when their week closed — things with nothing written about
   * them. Each row can be re-scheduled ("reviewed") into an upcoming week,
   * which moves it out of the slush and into that week's Review section.
   */
  import { onMount } from 'svelte';
  import Card from '../Card.svelte';
  import LinkRow from '../LinkRow.svelte';
  import SearchInput from '../SearchInput.svelte';
  import { all } from '../../lib/db/repo';
  import { matchesSearch, tagsByLinkMap } from '../../lib/services/links';
  import { reviewLink, upcomingWeekOptions } from '../../lib/services/weeks';
  import type { Link, Tag } from '../../lib/db/types';

  let links = $state<Link[]>([]);
  let tagsByLink = $state<Map<string, Tag[]>>(new Map());
  let search = $state('');
  let message = $state('');

  const weekOptions = upcomingWeekOptions();

  const visible = $derived(
    links.filter((l) => matchesSearch(l, tagsByLink.get(l.id) ?? [], search))
  );

  onMount(refresh);

  async function refresh() {
    const [rows, tags] = await Promise.all([all<Link>('links'), tagsByLinkMap()]);
    links = rows
      .filter((l) => l.slushed_at)
      .sort((a, b) => ((a.slushed_at ?? '') < (b.slushed_at ?? '') ? 1 : -1));
    tagsByLink = tags;
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

<Card title={`Slush (${visible.length})`}>
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
  {#if visible.length === 0}
    <p class="empty">
      {search ? 'Nothing in the slush matches your search.' : 'Nothing slushed yet.'}
    </p>
  {:else}
    <div class="list">
      {#each visible as link (link.id)}
        <div class="slush-row">
          <div class="slush-link">
            <LinkRow {link} tags={tagsByLink.get(link.id) ?? []} onChange={onRowChange} />
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
</style>
