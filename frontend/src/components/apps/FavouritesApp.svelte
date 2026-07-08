<script lang="ts">
  /** Everything flagged favourite, with tag and topic chips as context. */
  import { onMount } from 'svelte';
  import Card from '../Card.svelte';
  import LinkList from '../LinkList.svelte';
  import SearchInput from '../SearchInput.svelte';
  import { all } from '../../lib/db/repo';
  import { matchesSearch, tagsByLinkMap, topicsByLinkMap } from '../../lib/services/links';
  import type { Link, Tag, Topic } from '../../lib/db/types';

  let links = $state<Link[]>([]);
  let tagsByLink = $state<Map<string, Tag[]>>(new Map());
  let topicsByLink = $state<Map<string, Topic[]>>(new Map());
  let search = $state('');

  const visible = $derived(
    links.filter((l) => matchesSearch(l, tagsByLink.get(l.id) ?? [], search))
  );

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

<Card title={`Favourites (${visible.length})`}>
  <div class="search-row">
    <SearchInput bind:value={search} />
  </div>
  <LinkList
    links={visible}
    {tagsByLink}
    {topicsByLink}
    onChange={onRowChange}
    empty={search ? 'No favourites match your search.' : 'Nothing favourited yet — hit ★ on any link.'}
  />
</Card>

<style>
  .search-row {
    margin-bottom: var(--space-3);
  }
</style>
