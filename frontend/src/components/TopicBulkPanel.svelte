<script lang="ts">
  /**
   * Bulk operations over a selection of topics — the topics-overview twin of
   * BulkActionsPanel: same panel shape, same op-group layout, same
   * "host owns the checkboxes, panel owns the operations" split.
   *
   * A separate component rather than a mode on BulkActionsPanel: that one's
   * operations are all link-shaped (favourite, reading week, done) and none
   * of them mean anything for a topic, so sharing it would be a component
   * with two disjoint halves and a discriminator.
   */
  import { onMount } from 'svelte';
  import ChipSelect from './ChipSelect.svelte';
  import { all, put, softDelete, softDeleteMany, withSyncFields } from '../lib/db/repo';
  import { byIndex } from '../lib/db/repo';
  import {
    assignTopicTag,
    clearTopicTags,
    setTopicStatus,
    unassignTopicTag,
  } from '../lib/services/topics';
  import type { LinkTopic, Tag, Topic, TopicStatus } from '../lib/db/types';

  let {
    topics,
    onApplied,
    onClearSelection,
  }: {
    /** The currently selected topics (bulk targets). */
    topics: Topic[];
    /** Fired after every applied operation so the host can refresh. */
    onApplied: () => void;
    onClearSelection: () => void;
  } = $props();

  let allTags = $state<Tag[]>([]);
  let tagIdsToApply = $state<string[]>([]);
  let busy = $state(false);
  let message = $state('');

  onMount(async () => {
    allTags = (await all<Tag>('tags')).sort((a, b) => a.name.localeCompare(b.name));
  });

  async function createTag(name: string): Promise<string> {
    const tag = await put('tags', withSyncFields({ name, notes_md: '' }));
    allTags = [...allTags, tag].sort((a, b) => a.name.localeCompare(b.name));
    return tag.id;
  }

  /** Run an operation over every selected topic, then report + refresh. */
  async function forSelected(label: string, op: (topic: Topic) => Promise<unknown>) {
    if (busy || topics.length === 0) return;
    busy = true;
    try {
      for (const topic of topics) await op(topic);
      message = `${label} applied to ${topics.length} topic${topics.length === 1 ? '' : 's'}.`;
      onApplied();
    } finally {
      busy = false;
    }
  }

  const applyStatus = (status: TopicStatus) =>
    forSelected(status ? `Marked ${status}` : 'Status cleared', (t) => setTopicStatus(t, status));

  const addTags = () =>
    forSelected('Tags added', async (t) => {
      for (const id of tagIdsToApply) await assignTopicTag(t.id, id);
    });

  const removeTags = () =>
    forSelected('Tags removed', async (t) => {
      for (const id of tagIdsToApply) await unassignTopicTag(t.id, id);
    });

  /**
   * Delete, with the full tombstone cascade each topic needs: its link
   * references AND its tag edges. Leaving either behind would strand live
   * rows pointing at a tombstoned topic on every device.
   */
  async function removeTopics() {
    const n = topics.length;
    if (!confirm(`Delete ${n} topic${n === 1 ? '' : 's'}? Their documents go too; the links stay.`)) {
      return;
    }
    await forSelected('Deleted', async (topic) => {
      const joins = await byIndex<LinkTopic>('link_topics', 'topic_id', topic.id);
      await softDeleteMany('link_topics', joins.map((j) => j.id));
      await clearTopicTags(topic.id);
      await softDelete('topics', topic.id);
    });
  }
</script>

<div class="bulk-panel" role="region" aria-label="Bulk topic operations">
  <div class="bulk-head">
    <strong>Bulk operations — {topics.length} selected</strong>
    <button class="btn" disabled={busy} onclick={onClearSelection}>Clear selection</button>
  </div>
  {#if message}
    <p class="bulk-msg">{message}</p>
  {/if}

  <div class="op-group">
    <span class="op-label">Status</span>
    <div class="op-actions">
      <button class="btn" disabled={busy} onclick={() => applyStatus('in-progress')}>
        ▶ In progress
      </button>
      <button class="btn" disabled={busy} onclick={() => applyStatus('done')}>✓ Done</button>
      <button class="btn" disabled={busy} onclick={() => applyStatus('')}>Clear status</button>
    </div>
  </div>

  <div class="op-group">
    <span class="op-label">Tags</span>
    <ChipSelect
      items={allTags}
      bind:selected={tagIdsToApply}
      createPlaceholder="New tag…"
      pageLabel="tags"
      pageSize={10}
      onCreate={createTag}
    />
    <div class="op-actions">
      <button class="btn" disabled={busy || tagIdsToApply.length === 0} onclick={addTags}>
        Add to selected
      </button>
      <button class="btn btn-danger" disabled={busy || tagIdsToApply.length === 0} onclick={removeTags}>
        Remove from selected
      </button>
    </div>
  </div>

  <div class="op-group last">
    <span class="op-label">Danger</span>
    <div class="op-actions">
      <button class="btn btn-danger" disabled={busy} onclick={removeTopics}>
        Delete selected
      </button>
    </div>
  </div>
</div>

<style>
  .bulk-panel {
    border: 1px solid var(--color-primary);
    border-radius: var(--radius-md);
    background: var(--color-primary-soft);
    padding: var(--space-3);
    margin-bottom: var(--space-3);
  }

  .bulk-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding-bottom: var(--space-3);
    margin-bottom: var(--space-3);
    border-bottom: 1px solid var(--border-color);
  }

  .bulk-msg {
    margin: 0 0 var(--space-2);
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
  }

  .op-group {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding-bottom: var(--space-3);
    margin-bottom: var(--space-3);
    border-bottom: 1px solid var(--border-color);
  }

  .op-group.last {
    padding-bottom: 0;
    margin-bottom: 0;
    border-bottom: none;
  }

  .op-label {
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-muted-color);
  }

  .op-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
</style>
