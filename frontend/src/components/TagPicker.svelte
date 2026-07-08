<script lang="ts">
  /**
   * Assign/unassign tags on a link as toggleable chips, with inline create.
   */
  import { onMount } from 'svelte';
  import { all, put, withSyncFields } from '../lib/db/repo';
  import { assignTag, tagsForLink, unassignTag } from '../lib/services/links';
  import type { Tag } from '../lib/db/types';

  let {
    linkId,
    onChange,
  }: {
    linkId: string;
    /** Fired after any assignment change, so list pages can refresh chips. */
    onChange?: () => void;
  } = $props();

  let allTags = $state<Tag[]>([]);
  let assignedIds = $state<Set<string>>(new Set());
  let newName = $state('');

  onMount(refresh);

  async function refresh() {
    const [tags, assigned] = await Promise.all([all<Tag>('tags'), tagsForLink(linkId)]);
    tags.sort((a, b) => a.name.localeCompare(b.name));
    allTags = tags;
    assignedIds = new Set(assigned.map((t) => t.id));
  }

  async function toggle(tag: Tag) {
    if (assignedIds.has(tag.id)) await unassignTag(linkId, tag.id);
    else await assignTag(linkId, tag.id);
    await refresh();
    onChange?.();
  }

  async function create() {
    const name = newName.trim();
    if (!name) return;
    const existing = allTags.find((t) => t.name.toLowerCase() === name.toLowerCase());
    const tag = existing ?? (await put('tags', withSyncFields({ name, notes_md: '' })));
    await assignTag(linkId, tag.id);
    newName = '';
    await refresh();
    onChange?.();
  }
</script>

<div class="picker">
  <div class="chips">
    {#each allTags as tag (tag.id)}
      <button
        type="button"
        class="chip"
        class:selected={assignedIds.has(tag.id)}
        aria-pressed={assignedIds.has(tag.id)}
        onclick={() => toggle(tag)}
      >
        {tag.name}
      </button>
    {/each}
  </div>
  <form
    class="create"
    onsubmit={(e) => {
      e.preventDefault();
      void create();
    }}
  >
    <input type="text" placeholder="New tag…" bind:value={newName} />
    <button type="submit" class="btn" disabled={!newName.trim()}>Add</button>
  </form>
</div>

<style>
  .picker {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
  }

  .chip {
    border: 1px solid var(--border-color);
    border-radius: var(--radius-full);
    background: var(--surface-color);
    padding: 0 var(--space-3);
    font-size: var(--font-size-sm);
    line-height: 1.9;
    cursor: pointer;
    color: var(--text-color);
  }

  .chip:hover {
    border-color: var(--color-primary);
  }

  .chip.selected {
    background: var(--color-primary-soft);
    border-color: var(--color-primary);
    color: var(--color-primary-strong);
    font-weight: 600;
  }

  .create {
    display: flex;
    gap: var(--space-2);
  }

  .create input {
    flex: 1;
    min-width: 0;
    padding: var(--space-1) var(--space-3);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-full);
    background: var(--surface-color);
    color: var(--text-color);
    font-size: var(--font-size-sm);
  }
</style>
