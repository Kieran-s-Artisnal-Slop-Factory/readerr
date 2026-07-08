<script lang="ts">
  /** Links flagged as resources — tools/apps/blogs, not articles to "read". */
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
      .filter((l) => l.is_resource)
      .sort((a, b) => (a.added_at < b.added_at ? 1 : -1));
    tagsByLink = tags;
  });

  function onRowChange(updated: Link) {
    links = links.map((l) => (l.id === updated.id ? updated : l)).filter((l) => l.is_resource);
  }
</script>

<Card title={`Resources (${visible.length})`}>
  <div class="search-row">
    <SearchInput bind:value={search} />
  </div>
  <LinkList
    links={visible}
    {tagsByLink}
    onChange={onRowChange}
    empty={search ? 'No resources match your search.' : "No resources yet — hit ⚒ on any link that's a tool rather than an article."}
  />
</Card>

<style>
  .search-row {
    margin-bottom: var(--space-3);
  }
</style>
