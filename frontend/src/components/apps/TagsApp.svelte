<script lang="ts">
  /**
   * Tags index: the hierarchy, with per-tag link counts and
   * create/rename/delete.
   *
   * A DAG has no single correct tree rendering, so each tag is listed once
   * under its PRIMARY parent (the lowest-id one — device-independent, so every
   * device draws the same shape) and any further parents are named inline.
   */
  import { onMount } from 'svelte';
  import Card from '../Card.svelte';
  import SearchInput from '../SearchInput.svelte';
  import { all, byIndex, put, softDelete, softDeleteMany, withSyncFields } from '../../lib/db/repo';
  import { reconcileTags, tagCounts, type TagCount } from '../../lib/services/links';
  import { parentMap, reconcileTagParents } from '../../lib/services/tagTree';
  import { clearTagFromTopics } from '../../lib/services/topics';
  import { href } from '../../lib/paths';
  import type { LinkTag, Tag, TagParent } from '../../lib/db/types';

  interface Row {
    tag: Tag;
    depth: number;
    /** Parents beyond the primary one, for the "also under" note. */
    alsoUnder: Tag[];
  }

  let rows = $state<Row[]>([]);
  let counts = $state<Map<string, TagCount>>(new Map());
  let newName = $state('');
  let loading = $state(true);
  let renamingId = $state<string | null>(null);
  let renameValue = $state('');
  let nested = $state(true);
  let search = $state('');

  /**
   * Name search. A filtered list can't be a tree — a match's parent may not
   * match — so searching flattens the rows and drops the indentation rather
   * than leaving orphaned children indented under nothing.
   */
  const searching = $derived(search.trim() !== '');
  const visible = $derived(
    searching
      ? rows.filter((r) => r.tag.name.toLowerCase().includes(search.trim().toLowerCase()))
      : rows
  );

  const tagCount = (id: string): TagCount => counts.get(id) ?? { direct: 0, total: 0 };

  onMount(refresh);

  async function refresh() {
    // Collapse any same-name duplicates from cross-device sync before listing,
    // then repair the graph so the layout below can assume it is acyclic.
    await reconcileTags();
    await reconcileTagParents();
    const [tags, c, parents] = await Promise.all([all<Tag>('tags'), tagCounts(), parentMap()]);
    tags.sort((a, b) => a.name.localeCompare(b.name));
    rows = layout(tags, parents);
    counts = c;
    loading = false;
  }

  /**
   * Depth-first over the primary-parent tree. Cycle-safe by construction: a tag
   * is emitted at most once (`placed`), and anything a cycle keeps out of the
   * tree is appended at the end rather than silently vanishing.
   */
  function layout(tags: Tag[], parents: Map<string, string[]>): Row[] {
    const byId = new Map(tags.map((t) => [t.id, t]));
    const primary = new Map<string, string>();
    const extra = new Map<string, Tag[]>();
    for (const tag of tags) {
      const ids = (parents.get(tag.id) ?? []).filter((id) => byId.has(id)).sort();
      if (ids.length === 0) continue;
      primary.set(tag.id, ids[0]);
      extra.set(
        tag.id,
        ids.slice(1).map((id) => byId.get(id)!)
      );
    }

    const childrenOfPrimary = new Map<string, Tag[]>();
    for (const tag of tags) {
      const p = primary.get(tag.id);
      if (p) childrenOfPrimary.set(p, [...(childrenOfPrimary.get(p) ?? []), tag]);
    }

    const out: Row[] = [];
    const placed = new Set<string>();
    const emit = (tag: Tag, depth: number) => {
      if (placed.has(tag.id)) return;
      placed.add(tag.id);
      out.push({ tag, depth, alsoUnder: extra.get(tag.id) ?? [] });
      if (depth >= 8) return; // paranoia; reconcile should have made this moot
      for (const child of childrenOfPrimary.get(tag.id) ?? []) emit(child, depth + 1);
    };
    for (const tag of tags) {
      if (!primary.has(tag.id)) emit(tag, 0);
    }
    // Anything still unplaced sat in a cycle — show it rather than lose it.
    for (const tag of tags) emit(tag, 0);
    return out;
  }

  async function create() {
    const name = newName.trim();
    if (!name || rows.some((r) => r.tag.name.toLowerCase() === name.toLowerCase())) return;
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
    // …and its nesting edges, in BOTH directions. Leaving them behind would
    // strand live rows pointing at a tombstoned tag on every device — the
    // referential invariant the harness checks after every convergence.
    const asChild = await byIndex<TagParent>('tag_parents', 'child_id', tag.id);
    const asParent = await byIndex<TagParent>('tag_parents', 'parent_id', tag.id);
    await softDeleteMany('tag_parents', [...asChild, ...asParent].map((e) => e.id));
    // …and the topics carrying it, for the same reason.
    await clearTagFromTopics(tag.id);
    await softDelete('tags', tag.id);
    await refresh();
  }
</script>

<Card title={`Tags (${visible.length}${searching ? ` of ${rows.length}` : ''})`}>
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

  <div class="search-row">
    <SearchInput bind:value={search} placeholder="Search tags…" />
  </div>

  {#if loading}
    <p class="empty">Loading…</p>
  {:else if rows.length === 0}
    <p class="empty">No tags yet.</p>
  {:else if visible.length === 0}
    <p class="empty">No tags match “{search.trim()}”.</p>
  {:else}
    <div class="list-head">
      <label class="nest-toggle" class:disabled={searching}>
        <input type="checkbox" bind:checked={nested} disabled={searching} />
        Show nesting
        {#if searching}
          <span class="muted-inline">(off while searching)</span>
        {/if}
      </label>
    </div>
    <ul class="tag-list">
      {#each visible as row (row.tag.id)}
        <li style={nested && !searching ? `padding-left: calc(${row.depth} * var(--space-4))` : ''}>
          {#if renamingId === row.tag.id}
            <form
              class="rename"
              onsubmit={(e) => {
                e.preventDefault();
                void rename(row.tag);
              }}
            >
              <input type="text" bind:value={renameValue} />
              <button type="submit" class="btn">Save</button>
              <button type="button" class="btn" onclick={() => (renamingId = null)}>Cancel</button>
            </form>
          {:else}
            <a class="tag-name" href={href(`/tag/?id=${row.tag.id}`)}>{row.tag.name}</a>
            <span class="count">
              {tagCount(row.tag.id).direct}
              {tagCount(row.tag.id).direct === 1 ? 'link' : 'links'}
              {#if tagCount(row.tag.id).total > tagCount(row.tag.id).direct}
                <span class="inherited-count">
                  · {tagCount(row.tag.id).total} with child tags
                </span>
              {/if}
            </span>
            {#if nested && !searching && row.alsoUnder.length > 0}
              <span class="also">
                also under
                {#each row.alsoUnder as p (p.id)}
                  <a class="also-link" href={href(`/tag/?id=${p.id}`)}>{p.name}</a>
                {/each}
              </span>
            {/if}
            <span class="row-actions">
              <button
                class="btn"
                onclick={() => {
                  renamingId = row.tag.id;
                  renameValue = row.tag.name;
                }}
              >
                Rename
              </button>
              <button class="btn btn-danger" onclick={() => remove(row.tag)}>Delete</button>
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

  .search-row {
    margin-bottom: var(--space-3);
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

  .inherited-count {
    opacity: 0.8;
  }

  .list-head {
    display: flex;
    justify-content: flex-end;
    margin-bottom: var(--space-2);
  }

  .nest-toggle {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
  }

  .nest-toggle.disabled {
    opacity: 0.6;
  }

  .muted-inline {
    color: var(--text-muted-color);
    opacity: 0.8;
  }

  .also {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
  }

  .also-link {
    color: var(--color-primary-strong);
    text-decoration: none;
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
