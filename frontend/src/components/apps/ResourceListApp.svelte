<script lang="ts">
  /**
   * A resource list's overview page: description document, member
   * management (search existing links or paste a URL — members become
   * resources), and exports to markdown / txt / csv / JSON.
   */
  import { onMount } from 'svelte';
  import Card from '../Card.svelte';
  import LinkRow from '../LinkRow.svelte';
  import LinkSearchPicker from '../LinkSearchPicker.svelte';
  import MarkdownEditor from '../MarkdownEditor.svelte';
  import { all, get, put } from '../../lib/db/repo';
  import { captureLinks, fetchTitles } from '../../lib/services/capture';
  import { tagsForLink } from '../../lib/services/links';
  import {
    addToList,
    downloadList,
    listMembers,
    removeFromList,
    type ListMember,
    type ListExportFormat,
  } from '../../lib/services/resourceLists';
  import { downloadListHtml, downloadListMarkdown } from '../../lib/services/resourceListExport';
  import type { Link, ResourceList, Tag } from '../../lib/db/types';

  let list = $state<ResourceList | null>(null);
  let members = $state<ListMember[]>([]);
  let tagsByLink = $state<Map<string, Tag[]>>(new Map());
  let allLinks = $state<Link[]>([]);
  let query = $state('');
  let adding = $state(false);
  let missing = $state(false);

  const memberLinkIds = $derived(new Set(members.map((m) => m.link.id)));

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

  async function addByUrl(url: string) {
    if (!list || adding) return;
    adding = true;
    try {
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
    // Markdown goes through the shared collection core (stats, about section,
    // the full link table); txt/csv/json stay the plain data dumps they are.
    if (format === 'md') {
      void downloadListMarkdown(list);
      return;
    }
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
      <LinkSearchPicker
        corpus={allLinks}
        bind:query
        exclude={memberLinkIds}
        {adding}
        onSelect={addExisting}
        onAddUrl={addByUrl}
      />

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
        Markdown gives the full document — stats, the about section, and a
        table of every link with its read / favourite / resource / reading-week
        / tag columns. txt is one bare URL per line; csv has title,url columns;
        JSON includes the description. HTML is a self-contained themed page
        whose table filters and sorts offline and exports its own CSV — the
        same page the mass export and a tag export produce.
      </p>
      <div class="export-actions">
        <button class="btn" onclick={() => exportAs('md')}>Markdown</button>
        <button class="btn" onclick={() => exportAs('txt')}>Plain txt</button>
        <button class="btn" onclick={() => exportAs('csv')}>CSV</button>
        <button class="btn" onclick={() => exportAs('json')}>JSON</button>
        <button class="btn" onclick={() => list && downloadListHtml(list)}>HTML</button>
      </div>
    </Card>
  </div>
{:else}
  <p class="empty">Loading…</p>
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
