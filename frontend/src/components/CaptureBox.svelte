<script lang="ts">
  /**
   * Quick-paste capture: the fastest way to dump links into the backlog.
   * One URL per line; adds everything, reports duplicates/invalid lines.
   * Optional tag/topic chips apply to every link in the paste and reset
   * after each add (so a stale selection can't mislabel the next dump).
   */
  import { onMount } from 'svelte';
  import ChipSelect from './ChipSelect.svelte';
  import { all, put, withSyncFields } from '../lib/db/repo';
  import { captureLinks } from '../lib/services/capture';
  import type { Link, Tag, Topic } from '../lib/db/types';

  let { onAdded }: { onAdded: (links: Link[]) => void } = $props();

  let text = $state('');
  let busy = $state(false);
  let report = $state('');
  let tags = $state<Tag[]>([]);
  let topics = $state<Topic[]>([]);
  let selectedTagIds = $state<string[]>([]);
  let selectedTopicIds = $state<string[]>([]);
  let organizeOpen = $state(false);

  onMount(refreshOptions);

  async function refreshOptions() {
    const [t, tp] = await Promise.all([all<Tag>('tags'), all<Topic>('topics')]);
    tags = t.sort((a, b) => a.name.localeCompare(b.name));
    topics = tp.sort((a, b) => a.name.localeCompare(b.name));
  }

  async function createTag(name: string): Promise<string> {
    const tag = await put('tags', withSyncFields({ name, notes_md: '' }));
    await refreshOptions();
    return tag.id;
  }

  async function createTopic(name: string): Promise<string> {
    const topic = await put('topics', withSyncFields({ name, body_md: '' }));
    await refreshOptions();
    return topic.id;
  }

  async function add() {
    if (!text.trim() || busy) return;
    busy = true;
    try {
      const { added, duplicates, invalid } = await captureLinks(text, {
        tagIds: selectedTagIds,
        topicIds: selectedTopicIds,
      });
      const parts = [`${added.length} added`];
      const labels = selectedTagIds.length + selectedTopicIds.length;
      if (labels > 0 && added.length > 0) parts.push(`${labels} label${labels === 1 ? '' : 's'} applied`);
      if (duplicates.length > 0) parts.push(`${duplicates.length} already saved`);
      if (invalid.length > 0) parts.push(`${invalid.length} not a URL`);
      report = parts.join(' · ');
      text = '';
      selectedTagIds = [];
      selectedTopicIds = [];
      onAdded(added);
    } finally {
      busy = false;
    }
  }

  function onKeydown(e: KeyboardEvent) {
    // Enter adds; Shift+Enter makes a new line for multi-URL pastes.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void add();
    }
  }
</script>

<div class="capture">
  <textarea
    placeholder="Paste links — one per line. Enter to add, Shift+Enter for a new line."
    rows="3"
    bind:value={text}
    onkeydown={onKeydown}
  ></textarea>
  <button
    type="button"
    class="organize-toggle"
    aria-expanded={organizeOpen}
    onclick={() => (organizeOpen = !organizeOpen)}
  >
    {organizeOpen ? '▾' : '▸'} Tags & topics
    {#if selectedTagIds.length + selectedTopicIds.length > 0}
      <span class="badge">{selectedTagIds.length + selectedTopicIds.length}</span>
    {/if}
  </button>
  {#if organizeOpen}
    <div class="organize">
      <div class="organize-group">
        <span class="organize-label">Tags</span>
        <ChipSelect
          items={tags}
          bind:selected={selectedTagIds}
          createPlaceholder="New tag…"
          onCreate={createTag}
        />
      </div>
      <div class="organize-group">
        <span class="organize-label">Topics</span>
        <ChipSelect
          items={topics}
          bind:selected={selectedTopicIds}
          createPlaceholder="New topic…"
          onCreate={createTopic}
        />
      </div>
    </div>
  {/if}
  <div class="capture-actions">
    {#if report}
      <span class="report">{report}</span>
    {/if}
    <button class="btn btn-primary" onclick={add} disabled={busy || !text.trim()}>
      {busy ? 'Adding…' : 'Add to backlog'}
    </button>
  </div>
</div>

<style>
  .capture {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  textarea {
    width: 100%;
    resize: vertical;
    font-family: inherit;
    font-size: var(--font-size-base);
    padding: var(--space-3);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    background: var(--surface-color);
    color: var(--text-color);
  }

  textarea:focus {
    outline: 2px solid var(--color-primary);
    outline-offset: -1px;
  }

  .capture-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-3);
  }

  .report {
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
  }

  .organize-toggle {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    border: none;
    background: none;
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
    font-weight: 600;
    cursor: pointer;
    padding: 0;
  }

  .organize-toggle:hover {
    color: var(--text-color);
  }

  .badge {
    background: var(--color-primary-soft);
    color: var(--color-primary-strong);
    border-radius: var(--radius-full);
    padding: 0 var(--space-2);
    font-size: var(--font-size-sm);
  }

  .organize {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-2) 0;
  }

  .organize-group {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .organize-label {
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
    font-weight: 600;
  }
</style>
