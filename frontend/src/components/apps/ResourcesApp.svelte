<script lang="ts">
  /** Links flagged as resources — tools/apps/blogs, not articles to "read". */
  import { onMount } from 'svelte';
  import Card from '../Card.svelte';
  import LinkList from '../LinkList.svelte';
  import SearchInput from '../SearchInput.svelte';
  import { all } from '../../lib/db/repo';
  import { matchesSearch, tagsByLinkMap } from '../../lib/services/links';
  import {
    createResourceList,
    deleteResourceList,
    listMemberCounts,
    listResourceLists,
  } from '../../lib/services/resourceLists';
  import { href } from '../../lib/paths';
  import type { Link, ResourceList, Tag } from '../../lib/db/types';

  let links = $state<Link[]>([]);
  let tagsByLink = $state<Map<string, Tag[]>>(new Map());
  let search = $state('');
  let lists = $state<ResourceList[]>([]);
  let listCounts = $state<Map<string, number>>(new Map());
  let newListName = $state('');

  const visible = $derived(
    links.filter((l) => matchesSearch(l, tagsByLink.get(l.id) ?? [], search))
  );

  onMount(refresh);

  async function refresh() {
    const [rows, tags, allLists, counts] = await Promise.all([
      all<Link>('links'),
      tagsByLinkMap(),
      listResourceLists(),
      listMemberCounts(),
    ]);
    links = rows
      .filter((l) => l.is_resource)
      .sort((a, b) => (a.added_at < b.added_at ? 1 : -1));
    tagsByLink = tags;
    lists = allLists;
    listCounts = counts;
  }

  async function createList() {
    const name = newListName.trim();
    if (!name) return;
    const list = await createResourceList(name);
    newListName = '';
    location.assign(href(`/resource-list/?id=${list.id}`));
  }

  async function removeList(list: ResourceList) {
    if (!confirm(`Delete list "${list.name}"? The links themselves stay.`)) return;
    await deleteResourceList(list.id);
    await refresh();
  }

  function onRowChange(updated: Link) {
    links = links.map((l) => (l.id === updated.id ? updated : l)).filter((l) => l.is_resource);
  }
</script>

<div class="stack">
<Card title={`Resource lists (${lists.length})`}>
  <p class="hint">
    Group resources into themed lists (e.g. "CLI tools") — each has an
    overview page and exports to markdown, txt, csv, or JSON.
  </p>
  <form
    class="create"
    onsubmit={(e) => {
      e.preventDefault();
      void createList();
    }}
  >
    <input type="text" placeholder="New list…" bind:value={newListName} />
    <button type="submit" class="btn btn-primary" disabled={!newListName.trim()}>Create</button>
  </form>
  {#if lists.length > 0}
    <ul class="list-list">
      {#each lists as list (list.id)}
        <li>
          <a class="list-name" href={href(`/resource-list/?id=${list.id}`)}>{list.name}</a>
          <span class="count">{listCounts.get(list.id) ?? 0} links</span>
          <span class="row-actions">
            <button class="btn btn-danger" onclick={() => removeList(list)}>Delete</button>
          </span>
        </li>
      {/each}
    </ul>
  {/if}
</Card>

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
</div>

<style>
  .stack {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .search-row {
    margin-bottom: var(--space-3);
  }

  .hint {
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
    margin: 0 0 var(--space-3);
  }

  .create {
    display: flex;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
  }

  .create input {
    flex: 1;
    min-width: 0;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    background: var(--surface-color);
    color: var(--text-color);
  }

  .list-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .list-list li {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--border-color);
  }

  .list-list li:last-child {
    border-bottom: none;
  }

  .list-name {
    font-weight: 600;
    color: var(--text-color);
    text-decoration: none;
  }

  .list-name:hover {
    color: var(--color-primary-strong);
    text-decoration: underline;
  }

  .count {
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
  }

  .row-actions {
    margin-left: auto;
  }
</style>
