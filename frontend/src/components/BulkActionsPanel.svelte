<script lang="ts">
  /**
   * Bulk operations over a selection of links (graduated from the
   * /bulk-operations-test experiment): batch add/remove tags/topics,
   * set/clear favourite/resource/done, and assign or clear the reading
   * week. Hosts own the selection UI (checkboxes) and pass the selected
   * links in; the panel renders WordPress-style right where the selection
   * happens and reports back through onApplied so the host can refresh.
   */
  import { onMount } from 'svelte';
  import ChipSelect from './ChipSelect.svelte';
  import { all, put, withSyncFields } from '../lib/db/repo';
  import {
    assignTag,
    assignTopic,
    markLinkDone,
    toggleRead,
    unassignTag,
    unassignTopic,
  } from '../lib/services/links';
  import { setLinkWeek, upcomingWeekOptions } from '../lib/services/weeks';
  import type { Link, Tag, Topic } from '../lib/db/types';

  let {
    links,
    onApplied,
    onClearSelection,
  }: {
    /** The currently selected links (bulk targets). */
    links: Link[];
    /** Fired after every applied operation so the host can refresh. */
    onApplied: () => void;
    onClearSelection: () => void;
  } = $props();

  let allTags = $state<Tag[]>([]);
  let allTopics = $state<Topic[]>([]);
  let tagIdsToApply = $state<string[]>([]);
  let topicIdsToApply = $state<string[]>([]);
  let weekChoice = $state('');
  let busy = $state(false);
  let message = $state('');

  const weekOptions = upcomingWeekOptions();

  onMount(async () => {
    const [tags, topics] = await Promise.all([all<Tag>('tags'), all<Topic>('topics')]);
    allTags = tags.sort((a, b) => a.name.localeCompare(b.name));
    allTopics = topics.sort((a, b) => a.name.localeCompare(b.name));
  });

  async function createTag(name: string): Promise<string> {
    const tag = await put('tags', withSyncFields({ name, notes_md: '' }));
    allTags = [...allTags, tag].sort((a, b) => a.name.localeCompare(b.name));
    return tag.id;
  }

  async function createTopic(name: string): Promise<string> {
    const topic = await put('topics', withSyncFields({ name, body_md: '' }));
    allTopics = [...allTopics, topic].sort((a, b) => a.name.localeCompare(b.name));
    return topic.id;
  }

  /** Run an operation over every selected link, then report + refresh. */
  async function forSelected(label: string, op: (link: Link) => Promise<unknown>) {
    if (busy || links.length === 0) return;
    busy = true;
    try {
      for (const link of links) await op(link);
      message = `${label} applied to ${links.length} link${links.length === 1 ? '' : 's'}.`;
      onApplied();
    } finally {
      busy = false;
    }
  }

  const addTags = () =>
    forSelected('Tags added', async (l) => {
      for (const id of tagIdsToApply) await assignTag(l.id, id);
    });
  const removeTags = () =>
    forSelected('Tags removed', async (l) => {
      for (const id of tagIdsToApply) await unassignTag(l.id, id);
    });
  const addTopics = () =>
    forSelected('Topics added', async (l) => {
      for (const id of topicIdsToApply) await assignTopic(l.id, id);
    });
  const removeTopics = () =>
    forSelected('Topics removed', async (l) => {
      for (const id of topicIdsToApply) await unassignTopic(l.id, id);
    });
  // Favouriting rescues from the slush (matches toggleFavourite); clearing
  // leaves slushed_at alone.
  const setFavourite = (v: boolean) =>
    forSelected(v ? 'Favourited' : 'Unfavourited', (l) =>
      l.favourite === v
        ? Promise.resolve()
        : put('links', { ...l, favourite: v, slushed_at: v ? null : l.slushed_at })
    );
  const setResource = (v: boolean) =>
    forSelected(v ? 'Marked as resources' : 'Unmarked as resources', (l) =>
      l.is_resource === v ? Promise.resolve() : put('links', { ...l, is_resource: v })
    );
  const setDone = (v: boolean) =>
    forSelected(v ? 'Marked done' : 'Marked unread', (l) => {
      if (v) return l.read_at ? Promise.resolve() : markLinkDone(l, false);
      return l.read_at ? toggleRead(l) : Promise.resolve();
    });
  const setWeek = () => forSelected('Week set', (l) => setLinkWeek(l.id, weekChoice || null));
  const clearWeek = () => forSelected('Week cleared', (l) => setLinkWeek(l.id, null));
</script>

<div class="bulk-panel" role="region" aria-label="Bulk operations">
  <div class="bulk-head">
    <strong>Bulk operations — {links.length} selected</strong>
    <button class="btn" disabled={busy} onclick={onClearSelection}>Clear selection</button>
  </div>
  {#if message}
    <p class="bulk-msg">{message}</p>
  {/if}

  <div class="op-group">
    <span class="op-label">Tags</span>
    <ChipSelect items={allTags} bind:selected={tagIdsToApply} createPlaceholder="New tag…" pageLabel="tags" pageSize={10} onCreate={createTag} />
    <div class="op-actions">
      <button class="btn" disabled={busy || tagIdsToApply.length === 0} onclick={addTags}>Add to selected</button>
      <button class="btn btn-danger" disabled={busy || tagIdsToApply.length === 0} onclick={removeTags}>Remove from selected</button>
    </div>
  </div>

  <div class="op-group">
    <span class="op-label">Topics</span>
    <ChipSelect items={allTopics} bind:selected={topicIdsToApply} createPlaceholder="New topic…" pageLabel="topics" pageSize={10} onCreate={createTopic} />
    <div class="op-actions">
      <button class="btn" disabled={busy || topicIdsToApply.length === 0} onclick={addTopics}>Add to selected</button>
      <button class="btn btn-danger" disabled={busy || topicIdsToApply.length === 0} onclick={removeTopics}>Remove from selected</button>
    </div>
  </div>

  <div class="op-group">
    <span class="op-label">Flags</span>
    <div class="op-actions">
      <button class="btn" disabled={busy} onclick={() => setFavourite(true)}>★ Favourite</button>
      <button class="btn" disabled={busy} onclick={() => setFavourite(false)}>Unfavourite</button>
      <button class="btn" disabled={busy} onclick={() => setResource(true)}>⚒ Resource</button>
      <button class="btn" disabled={busy} onclick={() => setResource(false)}>Not a resource</button>
      <button class="btn" disabled={busy} onclick={() => setDone(true)}>✓ Mark done</button>
      <button class="btn" disabled={busy} onclick={() => setDone(false)}>Mark unread</button>
    </div>
  </div>

  <div class="op-group last">
    <span class="op-label">Reading week</span>
    <div class="op-actions">
      <select bind:value={weekChoice}>
        <option value="">None (backlog only)</option>
        {#each weekOptions as opt (opt.value)}
          <option value={opt.value}>{opt.label}</option>
        {/each}
      </select>
      <button class="btn" disabled={busy} onclick={setWeek}>Set week</button>
      <button class="btn" disabled={busy} onclick={clearWeek}>Clear week</button>
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

  .op-actions select {
    width: auto;
  }
</style>
