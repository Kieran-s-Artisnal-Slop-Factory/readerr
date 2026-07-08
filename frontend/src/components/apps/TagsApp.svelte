<script lang="ts">
  /** Tags index: list with live-link counts, create/rename/delete. */
  import { onMount } from 'svelte';
  import Card from '../Card.svelte';
  import { all, byIndex, put, softDelete, softDeleteMany, withSyncFields } from '../../lib/db/repo';
  import { tagLinkCounts } from '../../lib/services/links';
  import { href } from '../../lib/paths';
  import type { LinkTag, Tag } from '../../lib/db/types';

  let tags = $state<Tag[]>([]);
  let counts = $state<Map<string, number>>(new Map());
  let newName = $state('');
  let renamingId = $state<string | null>(null);
  let renameValue = $state('');

  onMount(refresh);

  async function refresh() {
    const [rows, c] = await Promise.all([all<Tag>('tags'), tagLinkCounts()]);
    rows.sort((a, b) => a.name.localeCompare(b.name));
    tags = rows;
    counts = c;
  }

  async function create() {
    const name = newName.trim();
    if (!name || tags.some((t) => t.name.toLowerCase() === name.toLowerCase())) return;
    await put('tags', withSyncFields({ name, notes_md: '' }));
    newName = '';
    await refresh();
  }

  async function rename(tag: Tag) {
    const name = renameValue.trim();
    if (name && name !== tag.name) {
      await put('tags', { ...tag, name });
    }
    renamingId = null;
    await refresh();
  }

  async function remove(tag: Tag) {
    if (!confirm(`Delete tag "${tag.name}"? Links keep their other tags.`)) return;
    // Tombstone the tag and its assignments so the deletion syncs fully.
    const joins = await byIndex<LinkTag>('link_tags', 'tag_id', tag.id);
    await softDeleteMany('link_tags', joins.map((j) => j.id));
    await softDelete('tags', tag.id);
    await refresh();
  }
</script>

<Card title={`Tags (${tags.length})`}>
  <form
    class="create"
    onsubmit={(e) => {
      e.preventDefault();
      void create();
    }}
  >
    <input type="text" placeholder="New tag…" bind:value={newName} />
    <button type="submit" class="btn btn-primary" disabled={!newName.trim()}>Create</button>
  </form>

  {#if tags.length === 0}
    <p class="empty">No tags yet.</p>
  {:else}
    <ul class="tag-list">
      {#each tags as tag (tag.id)}
        <li>
          {#if renamingId === tag.id}
            <form
              class="rename"
              onsubmit={(e) => {
                e.preventDefault();
                void rename(tag);
              }}
            >
              <input type="text" bind:value={renameValue} />
              <button type="submit" class="btn">Save</button>
              <button type="button" class="btn" onclick={() => (renamingId = null)}>Cancel</button>
            </form>
          {:else}
            <a class="tag-name" href={href(`/tag/?id=${tag.id}`)}>{tag.name}</a>
            <span class="count">{counts.get(tag.id) ?? 0} links</span>
            <span class="row-actions">
              <button
                class="btn"
                onclick={() => {
                  renamingId = tag.id;
                  renameValue = tag.name;
                }}
              >
                Rename
              </button>
              <button class="btn btn-danger" onclick={() => remove(tag)}>Delete</button>
            </span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</Card>

<style>
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

  .empty {
    color: var(--text-muted-color);
    text-align: center;
    padding: var(--space-5) 0;
  }

  .tag-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .tag-list li {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--border-color);
  }

  .tag-list li:last-child {
    border-bottom: none;
  }

  .tag-name {
    font-weight: 600;
    color: var(--text-color);
    text-decoration: none;
  }

  .tag-name:hover {
    color: var(--color-primary-strong);
    text-decoration: underline;
  }

  .count {
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
  }

  .row-actions {
    margin-left: auto;
    display: flex;
    gap: var(--space-1);
  }

  .rename {
    display: flex;
    gap: var(--space-2);
    flex: 1;
  }

  .rename input {
    flex: 1;
    min-width: 0;
    padding: var(--space-1) var(--space-3);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    background: var(--surface-color);
    color: var(--text-color);
  }
</style>
