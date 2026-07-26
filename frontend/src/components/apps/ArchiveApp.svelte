<script lang="ts">
  /**
   * The archive: cold slushed links moved out of the hot store by yearly
   * archival. Read-mostly — paginated, searchable, with an unarchive action
   * to pull a link back into the active set.
   */
  import { onMount } from 'svelte';
  import Card from '../Card.svelte';
  import LinkRow from '../LinkRow.svelte';
  import Pagination from '../Pagination.svelte';
  import SearchInput from '../SearchInput.svelte';
  import { matchesSearch, tagsForLinks } from '../../lib/services/links';
  import { listArchived, unarchive } from '../../lib/services/archive';
  import type { Link, Tag } from '../../lib/db/types';

  const PAGE_SIZE = 100;

  let links = $state<Link[]>([]);
  let pageTags = $state<Map<string, Tag[]>>(new Map());
  let search = $state('');
  let page = $state(0);
  let loading = $state(true);

  const filtered = $derived(
    links.filter((l) => matchesSearch(l, pageTags.get(l.id) ?? [], search))
  );
  const visible = $derived(filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE));

  $effect(() => {
    const slice = visible;
    void tagsForLinks(slice).then((m) => (pageTags = m));
  });

  onMount(refresh);

  async function refresh() {
    links = await listArchived();
    loading = false;
  }

  async function onUnarchive(link: Link) {
    await unarchive(link);
    links = links.filter((l) => l.id !== link.id);
  }

  function onRowChange(updated: Link) {
    links = links.map((l) => (l.id === updated.id ? updated : l));
  }
</script>

<Card title={`Archive (${filtered.length.toLocaleString()})`}>
  <p class="hint">
    Cold slushed links moved out of the main view to keep things fast. They
    stay searchable here; unarchive one to pull it back into the active set.
  </p>
  <div class="search-row">
    <SearchInput bind:value={search} />
  </div>
  {#if loading}
    <p class="empty">Loading…</p>
  {:else if visible.length === 0}
    <p class="empty">
      {search ? 'Nothing archived matches your search.' : 'Nothing archived yet.'}
    </p>
  {:else}
    <div class="list">
      {#each visible as link (link.id)}
        <div class="arch-row">
          <div class="arch-link">
            <LinkRow {link} tags={pageTags.get(link.id) ?? []} onChange={onRowChange} readOnly />
          </div>
          <button class="btn" title="Move back to the active set" onclick={() => onUnarchive(link)}>
            Unarchive
          </button>
        </div>
      {/each}
    </div>
    <Pagination total={filtered.length} pageSize={PAGE_SIZE} bind:page label="archived links" />
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

  .empty {
    color: var(--text-muted-color);
    text-align: center;
    padding: var(--space-5) 0;
  }

  .list {
    display: flex;
    flex-direction: column;
  }

  .arch-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    border-bottom: 1px solid var(--border-color);
  }

  .arch-row:last-child {
    border-bottom: none;
  }

  .arch-link {
    flex: 1;
    min-width: 0;
  }

  .arch-link :global(.link-item) {
    border-bottom: none;
  }
</style>
