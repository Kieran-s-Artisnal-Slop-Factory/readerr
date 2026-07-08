<script lang="ts">
  /**
   * The slush archive: read links that weren't part of a topic or
   * favourited when their week closed — things with nothing written about
   * them. They stick around here rather than cluttering the backlog.
   */
  import { onMount } from 'svelte';
  import Card from '../Card.svelte';
  import LinkList from '../LinkList.svelte';
  import { all } from '../../lib/db/repo';
  import { tagsByLinkMap } from '../../lib/services/links';
  import type { Link, Tag } from '../../lib/db/types';

  let links = $state<Link[]>([]);
  let tagsByLink = $state<Map<string, Tag[]>>(new Map());

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

<Card title={`Slush (${links.length})`}>
  <p class="hint">
    Read links that weren't favourited or referenced in a topic when their
    week closed.
  </p>
  <LinkList {links} {tagsByLink} onChange={onRowChange} empty="Nothing slushed yet." />
</Card>

<style>
  .hint {
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
    margin: 0 0 var(--space-3);
  }
</style>
