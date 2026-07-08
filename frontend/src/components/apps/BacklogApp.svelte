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
  import { all } from '../../lib/db/repo';
  import { retryMissingTitles } from '../../lib/services/capture';
  import type { Link, LinkTag, Tag } from '../../lib/db/types';

  let links = $state<Link[]>([]);
  let tagsByLink = $state<Map<string, Tag[]>>(new Map());
  let filters = $state<string[]>([]);
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
      return true;
    })
  );

  async function refresh() {
    const [rows, joins, tags] = await Promise.all([
      all<Link>('links'),
      all<LinkTag>('link_tags'),
      all<Tag>('tags'),
    ]);
    rows.sort((a, b) => (a.added_at < b.added_at ? 1 : -1));
    const tagById = new Map(tags.map((t) => [t.id, t]));
    const byLink = new Map<string, Tag[]>();
    for (const j of joins) {
      const tag = tagById.get(j.tag_id);
      if (!tag) continue;
      const list = byLink.get(j.link_id) ?? [];
      list.push(tag);
      byLink.set(j.link_id, list);
    }
    links = rows;
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
    <ChipFilter options={FILTER_OPTIONS} bind:selected={filters} />
    {#if loading}
      <p class="empty">Loading…</p>
    {:else}
      <LinkList links={visible} {tagsByLink} onChange={onRowChange}
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

  .empty {
    color: var(--text-muted-color);
    text-align: center;
    padding: var(--space-5) 0;
  }
</style>
