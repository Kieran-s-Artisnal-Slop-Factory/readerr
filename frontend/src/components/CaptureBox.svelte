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
  import { currentWeekStart, weekStartPlus } from '../lib/services/weeks';
  import type { Link, Tag, Topic } from '../lib/db/types';

  let { onAdded }: { onAdded: (links: Link[]) => void } = $props();

  let text = $state('');
  let busy = $state(false);
  let report = $state('');
  let tags = $state<Tag[]>([]);
  let topics = $state<Topic[]>([]);
  let selectedTagIds = $state<string[]>([]);
  let selectedTopicIds = $state<string[]>([]);
  let selectedWeek = $state('');
  let organizeOpen = $state(false);

  const selectionCount = $derived(
    selectedTagIds.length + selectedTopicIds.length + (selectedWeek ? 1 : 0)
  );

  /** This week plus the next four Mondays. */
  const weekOptions = (() => {
    const thisWeek = currentWeekStart();
    const label = (ws: string) =>
      new Date(`${ws}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return [0, 1, 2, 3, 4].map((n) => {
      const ws = weekStartPlus(thisWeek, n);
      return { value: ws, label: n === 0 ? `This week (${label(ws)})` : `Week of ${label(ws)}` };
    });
  })();

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
        weekStart: selectedWeek || null,
      });
      const parts = [`${added.length} added`];
      const labels = selectedTagIds.length + selectedTopicIds.length;
      if (labels > 0 && added.length > 0) parts.push(`${labels} label${labels === 1 ? '' : 's'} applied`);
      if (selectedWeek && added.length > 0) parts.push('queued for the week');
      if (duplicates.length > 0) parts.push(`${duplicates.length} already saved`);
      if (invalid.length > 0) parts.push(`${invalid.length} not a link`);
      report = parts.join(' · ');
      text = '';
      selectedTagIds = [];
      selectedTopicIds = [];
      selectedWeek = '';
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
    {organizeOpen ? '▾' : '▸'} Tags, topics & week
    {#if selectionCount > 0}
      <span class="badge">{selectionCount}</span>
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
      <div class="organize-group">
        <span class="organize-label">Reading week</span>
        <select class="week-select" bind:value={selectedWeek}>
          <option value="">None (backlog only)</option>
          {#each weekOptions as opt (opt.value)}
            <option value={opt.value}>{opt.label}</option>
          {/each}
        </select>
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

  .week-select {
    max-width: 16rem;
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    background: var(--surface-color);
    color: var(--text-color);
    font-size: var(--font-size-sm);
  }
</style>
