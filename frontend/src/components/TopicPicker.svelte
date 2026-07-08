<script lang="ts">
  /**
   * Assign/unassign topics on a link as toggleable chips, with inline create.
   * Mirrors TagPicker; kept separate because topics link out to their pages.
   */
  import { onMount } from 'svelte';
  import { all, put, withSyncFields } from '../lib/db/repo';
  import { assignTopic, topicsForLink, unassignTopic } from '../lib/services/links';
  import type { Topic } from '../lib/db/types';

  let {
    linkId,
    onChange,
  }: {
    linkId: string;
    /** Fired after any assignment change, so list pages can refresh chips. */
    onChange?: () => void;
  } = $props();

  let allTopics = $state<Topic[]>([]);
  let assignedIds = $state<Set<string>>(new Set());
  let newName = $state('');

  onMount(refresh);

  async function refresh() {
    const [topics, assigned] = await Promise.all([all<Topic>('topics'), topicsForLink(linkId)]);
    topics.sort((a, b) => a.name.localeCompare(b.name));
    allTopics = topics;
    assignedIds = new Set(assigned.map((t) => t.id));
  }

  async function toggle(topic: Topic) {
    if (assignedIds.has(topic.id)) await unassignTopic(linkId, topic.id);
    else await assignTopic(linkId, topic.id);
    await refresh();
    onChange?.();
  }

  async function create() {
    const name = newName.trim();
    if (!name) return;
    const existing = allTopics.find((t) => t.name.toLowerCase() === name.toLowerCase());
    const topic = existing ?? (await put('topics', withSyncFields({ name, body_md: '' })));
    await assignTopic(linkId, topic.id);
    newName = '';
    await refresh();
    onChange?.();
  }
</script>

<div class="picker">
  <div class="chips">
    {#each allTopics as topic (topic.id)}
      <button
        type="button"
        class="chip"
        class:selected={assignedIds.has(topic.id)}
        aria-pressed={assignedIds.has(topic.id)}
        onclick={() => toggle(topic)}
      >
        {topic.name}
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
    <input type="text" placeholder="New topic…" bind:value={newName} />
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
