<script lang="ts">
  /** Everything flagged favourite, with tag and topic chips as context. */
  import { onMount } from 'svelte';
  import Card from '../Card.svelte';
  import LinkList from '../LinkList.svelte';
  import { all } from '../../lib/db/repo';
  import { tagsByLinkMap, topicsByLinkMap } from '../../lib/services/links';
  import type { Link, Tag, Topic } from '../../lib/db/types';

  let links = $state<Link[]>([]);
  let tagsByLink = $state<Map<string, Tag[]>>(new Map());
  let topicsByLink = $state<Map<string, Topic[]>>(new Map());

  onMount(async () => {
    const [rows, tags, topics] = await Promise.all([
      all<Link>('links'),
      tagsByLinkMap(),
      topicsByLinkMap(),
    ]);
    links = rows
      .filter((l) => l.favourite)
      .sort((a, b) => (a.added_at < b.added_at ? 1 : -1));
    tagsByLink = tags;
    topicsByLink = topics;
  });

  function onRowChange(updated: Link) {
    // Unfavouriting removes the row from this view.
    links = links.map((l) => (l.id === updated.id ? updated : l)).filter((l) => l.favourite);
  }
</script>

<Card title={`Favourites (${links.length})`}>
  <LinkList
    {links}
    {tagsByLink}
    {topicsByLink}
    onChange={onRowChange}
    empty="Nothing favourited yet — hit ★ on any link."
  />
</Card>
