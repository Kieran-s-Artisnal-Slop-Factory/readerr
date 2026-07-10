<script lang="ts">
  /**
   * A resource list's overview page: description document, member
   * management (search existing links or paste a URL — members become
   * resources), and exports to markdown / txt / csv / JSON.
   */
  import { onMount } from 'svelte';
  import Card from '../Card.svelte';
  import LinkRow from '../LinkRow.svelte';
  import MarkdownEditor from '../MarkdownEditor.svelte';
  import { all, get, put } from '../../lib/db/repo';
  import { captureLinks, fetchTitles } from '../../lib/services/capture';
  import { domainOf, tagsForLink } from '../../lib/services/links';
  import {
    addToList,
    downloadList,
    listMembers,
    removeFromList,
    type ListMember,
    type ListExportFormat,
  } from '../../lib/services/resourceLists';
  import type { Link, ResourceList, Tag } from '../../lib/db/types';

  let list = $state<ResourceList | null>(null);
  let members = $state<ListMember[]>([]);
  let tagsByLink = $state<Map<string, Tag[]>>(new Map());
  let allLinks = $state<Link[]>([]);
  let query = $state('');
  let adding = $state(false);
  let missing = $state(false);

  const memberLinkIds = $derived(new Set(members.map((m) => m.link.id)));

  const queryIsUrl = $derived.by(() => {
    try {
      const u = new URL(query.trim());
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  });

  const matches = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q || queryIsUrl) return [];
    return allLinks
      .filter((l) => l.title.toLowerCase().includes(q) || l.url.toLowerCase().includes(q))
      .filter((l) => !memberLinkIds.has(l.id))
      .slice(0, 8);
  });

  onMount(async () => {
    const id = new URLSearchParams(location.search).get('id');
    list = id ? ((await get<ResourceList>('resource_lists', id)) ?? null) : null;
    if (!list) {
      missing = true;
      return;
    }
    await refresh();
  });

  async function refresh() {
    if (!list) return;
    const [rows, everything] = await Promise.all([listMembers(list.id), all<Link>('links')]);
    members = rows;
    allLinks = everything;
    const byLink = new Map<string, Tag[]>();
    for (const { link } of rows) {
      byLink.set(link.id, await tagsForLink(link.id));
    }
    tagsByLink = byLink;
  }

  async function saveDescription(md: string) {
    if (!list) return;
    list = await put('resource_lists', { ...list, description_md: md });
  }

  async function addByUrl() {
    if (!list || !queryIsUrl || adding) return;
    adding = true;
    try {
      const url = new URL(query.trim()).toString();
      const { added } = await captureLinks(url);
      const link = added[0] ?? allLinks.find((l) => l.url === url);
      if (link) await addToList(list.id, link);
      query = '';
      await refresh();
      if (added.length > 0) {
        await fetchTitles(added);
        await refresh();
      }
    } finally {
      adding = false;
    }
  }

  async function addExisting(link: Link) {
    if (!list) return;
    await addToList(list.id, link);
    query = '';
    await refresh();
  }

  async function remove(entryId: string) {
    await removeFromList(entryId);
    await refresh();
  }

  function exportAs(format: ListExportFormat) {
    if (!list) return;
    downloadList(list, members, format);
  }

  function onRowChange(updated: Link) {
    members = members.map((m) => (m.link.id === updated.id ? { ...m, link: updated } : m));
  }
</script>

{#if missing}
  <p class="empty">List not found. <a href="../resources/">Back to resources.</a></p>
{:else if list}
  <div class="stack">
    <h1>{list.name}</h1>
    <Card title="About this list">
      <MarkdownEditor
        value={list.description_md}
        placeholder="What belongs in this list…"
        exportName={list.name}
        onChange={saveDescription}
      />
    </Card>

    <Card title={`Links (${members.length})`}>
      <form
        class="adder"
        onsubmit={(e) => {
          e.preventDefault();
          void addByUrl();
        }}
      >
        <input
          type="text"
          placeholder="Paste a URL to add, or search your links…"
          bind:value={query}
        />
        {#if queryIsUrl}
          <button type="submit" class="btn btn-primary" disabled={adding}>
            {adding ? 'Adding…' : 'Add link'}
          </button>
        {/if}
      </form>
      {#if matches.length > 0}
        <ul class="matches">
          {#each matches as match (match.id)}
            <li>
              <button type="button" class="match" onclick={() => addExisting(match)}>
                <span class="match-title">{match.title}</span>
                <span class="match-domain">{domainOf(match.url)}</span>
              </button>
            </li>
          {/each}
        </ul>
      {:else if query.trim() && !queryIsUrl}
        <p class="no-match">No links match — paste a full URL to add a new one.</p>
      {/if}

      {#if members.length === 0}
        <p class="empty">No links yet — add some above.</p>
      {:else}
        <div class="member-list">
          {#each members as { entry, link } (entry.id)}
            <div class="member">
              <div class="member-row">
                <LinkRow {link} tags={tagsByLink.get(link.id) ?? []} onChange={onRowChange} />
              </div>
              <button class="corner-remove" title="Remove from this list" onclick={() => remove(entry.id)}>
                ✕
              </button>
            </div>
          {/each}
        </div>
      {/if}
    </Card>

    <Card title="Export">
      <p class="hint">
        Markdown gives a <code>- [title](url)</code> list; txt is one bare URL
        per line; csv has title,url columns; JSON includes the description.
      </p>
      <div class="export-actions">
        <button class="btn" onclick={() => exportAs('md')}>Markdown</button>
        <button class="btn" onclick={() => exportAs('txt')}>Plain txt</button>
        <button class="btn" onclick={() => exportAs('csv')}>CSV</button>
        <button class="btn" onclick={() => exportAs('json')}>JSON</button>
      </div>
    </Card>
  </div>
{/if}

<style>
  .stack {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  h1 {
    margin: 0;
  }

  .empty {
    color: var(--text-muted-color);
    text-align: center;
    padding: var(--space-5) 0;
  }

  .hint {
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
    margin: 0 0 var(--space-3);
  }

  .adder {
    display: flex;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
  }

  .adder input {
    flex: 1;
    min-width: 0;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    background: var(--surface-color);
    color: var(--text-color);
  }

  .matches {
    list-style: none;
    margin: 0 0 var(--space-3);
    padding: 0;
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  .match {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    width: 100%;
    padding: var(--space-2) var(--space-3);
    border: none;
    border-bottom: 1px solid var(--border-color);
    background: var(--surface-color);
    color: var(--text-color);
    cursor: pointer;
    text-align: left;
  }

  .matches li:last-child .match {
    border-bottom: none;
  }

  .match:hover {
    background: var(--color-primary-soft);
  }

  .match-title {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .match-domain {
    flex-shrink: 0;
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
  }

  .no-match {
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
    margin: 0 0 var(--space-3);
  }

  .member-list {
    display: flex;
    flex-direction: column;
  }

  .member {
    position: relative;
    border-bottom: 1px solid var(--border-color);
  }

  .member:last-child {
    border-bottom: none;
  }

  .member-row :global(.link-item) {
    border-bottom: none;
  }

  .corner-remove {
    position: absolute;
    top: 2px;
    right: 2px;
    width: 1.3rem;
    height: 1.3rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: var(--radius-full);
    background: none;
    color: var(--text-muted-color);
    cursor: pointer;
    font-size: var(--font-size-sm);
    opacity: 0.6;
  }

  .corner-remove:hover {
    opacity: 1;
    background: var(--color-primary-soft);
    color: var(--color-danger);
  }

  .export-actions {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
</style>
