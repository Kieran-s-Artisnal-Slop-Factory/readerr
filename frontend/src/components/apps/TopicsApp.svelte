<script lang="ts">
  /**
   * Topics index: search, status/tag filters, per-row status control, bulk
   * operations, create.
   *
   * Ordering is status-first (in-progress, then unmarked, then done) rather
   * than plain alphabetical — the status exists precisely to weight a topic
   * up or retire it, so it has to move the row. See `orderTopics`
   * (services/topics.ts).
   */
  import { onMount } from 'svelte';
  import Card from '../Card.svelte';
  import ChipFilter from '../ChipFilter.svelte';
  import SearchInput from '../SearchInput.svelte';
  import TopicBulkPanel from '../TopicBulkPanel.svelte';
  import { all, byIndex, put, softDelete, softDeleteMany, withSyncFields } from '../../lib/db/repo';
  import { reconcileTopics, topicLinkCounts } from '../../lib/services/links';
  import {
    STATUS_FILTERS,
    clearTopicTags,
    filterTopics,
    orderTopics,
    setTopicStatus,
    tagsForTopics,
    topicStatus,
  } from '../../lib/services/topics';
  import { href } from '../../lib/paths';
  import type { LinkTopic, Tag, Topic, TopicStatus } from '../../lib/db/types';

  let topics = $state<Topic[]>([]);
  let counts = $state<Map<string, number>>(new Map());
  let tagsByTopic = $state<Map<string, Tag[]>>(new Map());
  let newName = $state('');
  let loading = $state(true);

  let search = $state('');
  let statusFilters = $state<string[]>([]);
  let tagFilters = $state<string[]>([]);
  let selectedIds = $state<string[]>([]);

  /** Only tags actually in use on a topic are worth offering as filters. */
  const tagOptions = $derived.by(() => {
    const used = new Map<string, string>();
    for (const tags of tagsByTopic.values()) {
      for (const tag of tags) used.set(tag.id, tag.name);
    }
    return [...used]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  });

  const visible = $derived(
    orderTopics(
      filterTopics(topics, {
        search,
        statuses: statusFilters,
        tagIds: tagFilters,
        tagsByTopic,
      })
    )
  );

  const narrowed = $derived(
    search.trim() !== '' || statusFilters.length > 0 || tagFilters.length > 0
  );

  const selectedTopics = $derived(topics.filter((t) => selectedIds.includes(t.id)));
  const allVisibleSelected = $derived(
    visible.length > 0 && visible.every((t) => selectedIds.includes(t.id))
  );

  onMount(refresh);

  async function refresh() {
    // Collapse any same-name duplicates from cross-device sync before listing.
    await reconcileTopics();
    const [rows, c] = await Promise.all([all<Topic>('topics'), topicLinkCounts()]);
    topics = rows;
    counts = c;
    // One pass for every row's chips — asking per topic would be an index
    // read per row on a page that lists them all.
    tagsByTopic = await tagsForTopics(rows.map((t) => t.id));
    // Drop selections whose topic is gone (a bulk delete just ran).
    const liveIds = new Set(rows.map((t) => t.id));
    selectedIds = selectedIds.filter((id) => liveIds.has(id));
    loading = false;
  }

  async function create() {
    const name = newName.trim();
    if (!name || topics.some((t) => t.name.toLowerCase() === name.toLowerCase())) return;
    const topic = await put('topics', withSyncFields({ name, body_md: '', status: '' }));
    newName = '';
    location.assign(href(`/topic/?id=${topic.id}`));
  }

  async function remove(topic: Topic) {
    if (!confirm(`Delete topic "${topic.name}"? Its document is deleted too; the links stay.`)) {
      return;
    }
    // Tombstone the topic, its link references AND its tag edges, so the
    // deletion syncs whole and leaves nothing pointing at a dead topic.
    const joins = await byIndex<LinkTopic>('link_topics', 'topic_id', topic.id);
    await softDeleteMany('link_topics', joins.map((j) => j.id));
    await clearTopicTags(topic.id);
    await softDelete('topics', topic.id);
    await refresh();
  }

  async function cycleStatus(topic: Topic, status: TopicStatus) {
    // Clicking the active status clears it, so one control both sets and
    // unsets without a separate "clear" button per row.
    await setTopicStatus(topic, topicStatus(topic) === status ? '' : status);
    await refresh();
  }

  function toggleSelect(id: string) {
    selectedIds = selectedIds.includes(id)
      ? selectedIds.filter((s) => s !== id)
      : [...selectedIds, id];
  }

  function toggleAllVisible() {
    if (allVisibleSelected) {
      const drop = new Set(visible.map((t) => t.id));
      selectedIds = selectedIds.filter((id) => !drop.has(id));
    } else {
      selectedIds = [...new Set([...selectedIds, ...visible.map((t) => t.id)])];
    }
  }

  const statusLabel = (s: TopicStatus) =>
    s === 'in-progress' ? 'In progress' : s === 'done' ? 'Done' : '';
</script>

<Card title={`Topics (${narrowed ? `${visible.length} of ${topics.length}` : topics.length})`}>
  <form
    class="create"
    onsubmit={(e) => {
      e.preventDefault();
      void create();
    }}
  >
    <input type="text" placeholder="New topic…" bind:value={newName} />
    <button type="submit" class="btn btn-primary" disabled={!newName.trim()}>Create</button>
  </form>

  {#if topics.length > 0}
    <div class="toolbar">
      <SearchInput bind:value={search} placeholder="Search topics by name or tag…" />
      <div class="filters">
        <ChipFilter options={[...STATUS_FILTERS]} bind:selected={statusFilters} label="Status" />
        {#if tagOptions.length > 0}
          <ChipFilter options={tagOptions} bind:selected={tagFilters} label="Tags" />
        {/if}
      </div>
      {#if visible.length > 0}
        <label class="check select-all">
          <input type="checkbox" checked={allVisibleSelected} onchange={toggleAllVisible} />
          Select all {narrowed ? 'matching' : ''}
        </label>
      {/if}
    </div>
  {/if}

  {#if selectedTopics.length > 0}
    <TopicBulkPanel
      topics={selectedTopics}
      onApplied={() => void refresh()}
      onClearSelection={() => (selectedIds = [])}
    />
  {/if}

  {#if loading}
    <p class="empty">Loading…</p>
  {:else if topics.length === 0}
    <p class="empty">No topics yet — create one to start a long-form document.</p>
  {:else if visible.length === 0}
    <p class="empty">No topics match those filters.</p>
  {:else}
    <ul class="topic-list">
      {#each visible as topic (topic.id)}
        {@const status = topicStatus(topic)}
        <li class:bulk-selected={selectedIds.includes(topic.id)}>
          <input
            type="checkbox"
            class="row-check"
            checked={selectedIds.includes(topic.id)}
            onchange={() => toggleSelect(topic.id)}
            aria-label={`Select ${topic.name}`}
          />
          <a class="topic-name" href={href(`/topic/?id=${topic.id}`)}>{topic.name}</a>
          {#if status}
            <span class="status-badge" class:done={status === 'done'}>{statusLabel(status)}</span>
          {/if}
          {#each tagsByTopic.get(topic.id) ?? [] as tag (tag.id)}
            <a class="tag-chip" href={href(`/tag/?id=${tag.id}`)}>{tag.name}</a>
          {/each}
          <span class="count">{counts.get(topic.id) ?? 0} links</span>
          <span class="row-actions">
            <button
              class="btn status-btn"
              class:active={status === 'in-progress'}
              title={status === 'in-progress' ? 'Clear status' : 'Mark in progress'}
              onclick={() => cycleStatus(topic, 'in-progress')}
            >
              ▶
            </button>
            <button
              class="btn status-btn"
              class:active={status === 'done'}
              title={status === 'done' ? 'Clear status' : 'Mark done'}
              onclick={() => cycleStatus(topic, 'done')}
            >
              ✓
            </button>
            <button class="btn btn-danger" onclick={() => remove(topic)}>Delete</button>
          </span>
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

  .toolbar {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
  }

  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
  }

  /*
   * The global `.check` style is built for full-width settings rows; inside
   * this column toolbar that stretched the box away from its label.
   */
  .select-all {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    align-self: flex-start;
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
  }

  .select-all input {
    width: auto;
    margin: 0;
  }

  .empty {
    color: var(--text-muted-color);
    text-align: center;
    padding: var(--space-5) 0;
  }

  .topic-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .topic-list li {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--border-color);
  }

  .topic-list li:last-child {
    border-bottom: none;
  }

  .topic-list li.bulk-selected {
    background: var(--color-primary-soft);
  }

  .row-check {
    flex-shrink: 0;
    width: auto;
    margin: 0;
  }

  .topic-name {
    font-weight: 600;
    color: var(--text-color);
    text-decoration: none;
  }

  .topic-name:hover {
    color: var(--color-primary-strong);
    text-decoration: underline;
  }

  /* In-progress reads as "active"; done is deliberately quieter. */
  .status-badge {
    flex-shrink: 0;
    border: 1px solid var(--color-primary);
    border-radius: var(--radius-full);
    background: var(--color-primary-soft);
    color: var(--color-primary-strong);
    font-size: var(--font-size-sm);
    font-weight: 600;
    padding: 0 var(--space-2);
    line-height: 1.7;
  }

  .status-badge.done {
    border-color: var(--border-color);
    background: var(--surface-color);
    color: var(--text-muted-color);
    font-weight: 400;
  }

  .tag-chip {
    flex-shrink: 0;
    border: 1px solid var(--border-color);
    border-radius: var(--radius-full);
    background: var(--surface-color);
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
    padding: 0 var(--space-2);
    line-height: 1.7;
    text-decoration: none;
  }

  .tag-chip:hover {
    border-color: var(--color-primary);
    color: var(--color-primary-strong);
  }

  .count {
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
    white-space: nowrap;
  }

  .row-actions {
    margin-left: auto;
    display: flex;
    gap: var(--space-1);
    flex-shrink: 0;
  }

  .status-btn.active {
    background: var(--color-primary-soft);
    border-color: var(--color-primary);
    color: var(--color-primary-strong);
  }

  @media (max-width: 40rem) {
    .topic-list li {
      flex-wrap: wrap;
    }

    .row-actions {
      margin-left: 0;
    }
  }
</style>
