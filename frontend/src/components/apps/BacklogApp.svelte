<script lang="ts">
  /**
   * Backlog: quick-paste capture plus every captured link, newest first.
   * Filters are in-memory (booleans aren't valid IndexedDB keys and the
   * dataset is personal-scale).
   */
  import { onMount } from 'svelte';
  import Card from '../Card.svelte';
  import CaptureBox from '../CaptureBox.svelte';
  import ChipFilter from '../ChipFilter.svelte';
  import LinkList from '../LinkList.svelte';
  import SearchInput from '../SearchInput.svelte';
  import { all } from '../../lib/db/repo';
  import { retryMissingTitles } from '../../lib/services/capture';
  import { matchesSearch, tagsByLinkMap } from '../../lib/services/links';
  import type { Link, Tag } from '../../lib/db/types';

  let links = $state<Link[]>([]);
  let tagsByLink = $state<Map<string, Tag[]>>(new Map());
  let filters = $state<string[]>([]);
  let search = $state('');
  let loading = $state(true);

  const FILTER_OPTIONS = [
    { value: 'unread', label: 'Unread' },
    { value: 'read', label: 'Read' },
    { value: 'favourite', label: 'Favourites' },
    { value: 'resource', label: 'Resources' },
  ];

  const visible = $derived(
    links.filter((l) => {
      if (filters.includes('unread') && l.read_at) return false;
      if (filters.includes('read') && !l.read_at) return false;
      if (filters.includes('favourite') && !l.favourite) return false;
      if (filters.includes('resource') && !l.is_resource) return false;
      return matchesSearch(l, tagsByLink.get(l.id) ?? [], search);
    })
  );

  async function refresh() {
    const [rows, byLink] = await Promise.all([all<Link>('links'), tagsByLinkMap()]);
    // Slushed links live in the slush archive, not the backlog.
    links = rows
      .filter((l) => !l.slushed_at)
      .sort((a, b) => (a.added_at < b.added_at ? 1 : -1));
    tagsByLink = byLink;
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

  <Card title={`Backlog (${visible.length})`}>
    <div class="controls">
      <SearchInput bind:value={search} />
      <ChipFilter options={FILTER_OPTIONS} bind:selected={filters} />
    </div>
    {#if loading}
      <p class="empty">Loading…</p>
    {:else}
      <LinkList links={visible} {tagsByLink} onChange={onRowChange}
        onAssignmentsChange={() => void refresh()}
        empty="No links yet — paste some above to get started." />
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
