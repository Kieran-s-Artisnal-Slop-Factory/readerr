<script lang="ts">
  /**
   * A list of LinkRows with a shared tags-per-link lookup. Hosts that offer
   * bulk operations pass `selectable` and bind `selectedIds` — each row
   * gains a checkbox and a select-all row appears above the list; without
   * it the list renders exactly as before.
   */
  import LinkRow from './LinkRow.svelte';
  import type { Link, Tag, Topic } from '../lib/db/types';

  let {
    links,
    tagsByLink = new Map(),
    topicsByLink = new Map(),
    onChange,
    onAssignmentsChange,
    empty = 'Nothing here yet.',
    selectable = false,
    selectedIds = $bindable([]),
    refNumbers,
  }: {
    links: Link[];
    tagsByLink?: Map<string, Tag[]>;
    topicsByLink?: Map<string, Topic[]>;
    onChange: (updated: Link) => void;
    /** Footnote number per link id — set by the topic page. */
    refNumbers?: Map<string, number>;
    /** Enables per-row inline tag/topic editing; fired after changes. */
    onAssignmentsChange?: () => void;
    empty?: string;
    /** Show per-row checkboxes for bulk operations. */
    selectable?: boolean;
    selectedIds?: string[];
  } = $props();

  const selectedSet = $derived(new Set(selectedIds));
  const allSelected = $derived(links.length > 0 && links.every((l) => selectedSet.has(l.id)));

  function toggle(id: string) {
    selectedIds = selectedSet.has(id)
      ? selectedIds.filter((s) => s !== id)
      : [...selectedIds, id];
  }

  function toggleAll() {
    if (allSelected) {
      const ids = new Set(links.map((l) => l.id));
      selectedIds = selectedIds.filter((id) => !ids.has(id));
    } else {
      selectedIds = [...new Set([...selectedIds, ...links.map((l) => l.id)])];
    }
  }
</script>

{#if links.length === 0}
  <p class="empty">{empty}</p>
{:else if selectable}
  <label class="select-all">
    <input type="checkbox" checked={allSelected} onchange={toggleAll} />
    Select all shown ({links.length})
  </label>
  <div class="list">
    {#each links as link (link.id)}
      <div class="select-row" class:selected={selectedSet.has(link.id)}>
        <input
          type="checkbox"
          class="row-check"
          checked={selectedSet.has(link.id)}
          onchange={() => toggle(link.id)}
          aria-label={`Select ${link.title}`}
        />
        <div class="row-link">
          <LinkRow
            {link}
            tags={tagsByLink.get(link.id) ?? []}
            topics={topicsByLink.get(link.id) ?? []}
            refNumber={refNumbers?.get(link.id)}
            {onChange}
            {onAssignmentsChange}
          />
        </div>
      </div>
    {/each}
  </div>
{:else}
  <div class="list">
    {#each links as link (link.id)}
      <LinkRow
        {link}
        tags={tagsByLink.get(link.id) ?? []}
        topics={topicsByLink.get(link.id) ?? []}
        refNumber={refNumbers?.get(link.id)}
        {onChange}
        {onAssignmentsChange}
      />
    {/each}
  </div>
{/if}

<style>
  .empty {
    color: var(--text-muted-color);
    text-align: center;
    padding: var(--space-5) 0;
  }

  .list {
    display: flex;
    flex-direction: column;
  }

  .select-all {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0 0 var(--space-2);
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
    cursor: pointer;
  }

  .select-all input,
  .row-check {
    width: auto;
    margin: 0;
  }

  .select-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    border-bottom: 1px solid var(--border-color);
  }

  .select-row:last-child {
    border-bottom: none;
  }

  .select-row.selected {
    background: var(--color-primary-soft);
  }

  .row-check {
    flex-shrink: 0;
    margin-left: var(--space-2);
  }

  .row-link {
    flex: 1;
    min-width: 0;
  }

  .row-link :global(.link-item) {
    border-bottom: none;
  }
</style>
