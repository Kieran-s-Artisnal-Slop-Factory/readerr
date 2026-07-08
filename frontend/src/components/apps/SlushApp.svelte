<script lang="ts">
  /**
   * The slush archive: read links that weren't part of a topic or
   * favourited when their week closed — things with nothing written about
   * them. They stick around here rather than cluttering the backlog.
   */
  import { onMount } from 'svelte';
  import Card from '../Card.svelte';
  import LinkList from '../LinkList.svelte';
  import SearchInput from '../SearchInput.svelte';
  import { all } from '../../lib/db/repo';
  import { matchesSearch, tagsByLinkMap } from '../../lib/services/links';
  import type { Link, Tag } from '../../lib/db/types';

  let links = $state<Link[]>([]);
  let tagsByLink = $state<Map<string, Tag[]>>(new Map());
  let search = $state('');

  const visible = $derived(
    links.filter((l) => matchesSearch(l, tagsByLink.get(l.id) ?? [], search))
  );

  onMount(async () => {
    const [rows, tags] = await Promise.all([all<Link>('links'), tagsByLinkMap()]);
    links = rows
      .filter((l) => l.slushed_at)
      .sort((a, b) => ((a.slushed_at ?? '') < (b.slushed_at ?? '') ? 1 : -1));
    tagsByLink = tags;
  });

  function onRowChange(updated: Link) {
    links = links.map((l) => (l.id === updated.id ? updated : l));
  }
</script>

<Card title={`Slush (${visible.length})`}>
  <p class="hint">
    Read links that weren't favourited or referenced in a topic when their
    week closed.
  </p>
  <div class="search-row">
    <SearchInput bind:value={search} />
  </div>
  <LinkList
    links={visible}
    {tagsByLink}
    onChange={onRowChange}
    empty={search ? 'Nothing in the slush matches your search.' : 'Nothing slushed yet.'}
  />
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
</style>
