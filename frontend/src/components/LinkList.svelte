<script lang="ts">
  /**
   * A list of LinkRows with a shared tags-per-link lookup. Hosts that offer
   * bulk operations pass `selectable` and bind `selectedIds` — each row
   * gains a checkbox; without it the list renders exactly as before.
   * Select-all belongs to the host's ListToolbar, which can reach the whole
   * filtered list rather than only the rows on this page.
   */
  import LinkRow from './LinkRow.svelte';
  import {
    liveChecked,
    NO_ANCHOR,
    selectOnClick,
    type SelectionAnchor,
  } from '../lib/services/rangeSelect';
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

  // Shift+click extends from the last plainly-clicked row (rangeSelect.ts).
  let anchor = $state<SelectionAnchor>(NO_ANCHOR);

  /** Returns whether the clicked row ended up selected. */
  function toggle(id: string, shiftKey = false): boolean {
    const result = selectOnClick(
      selectedIds,
      links.map((l) => l.id),
      id,
      shiftKey,
      anchor
    );
    selectedIds = result.selected;
    anchor = result.anchor;
    return result.selected.includes(id);
  }

</script>

{#if links.length === 0}
  <p class="empty">{empty}</p>
{:else if selectable}
  <!-- Select-all lives in the host's ListToolbar, where it can cover the
       whole filtered list rather than just this page. -->
  <div class="select-bar">
    <span class="select-hint">Shift+click for a range</span>
  </div>
  <div class="list">
    {#each links as link (link.id)}
      <div class="select-row" class:selected={selectedSet.has(link.id)}>
        <!--
          click, not change: only a MouseEvent carries shiftKey.

          The click default is deliberately NOT prevented. Cancelling it makes
          the browser run its "canceled activation steps", which revert
          .checked *after* the handler has already set it — so the tick sat a
          frame behind until an effect corrected it. Letting the native toggle
          stand means the box is right synchronously, and the assignment below
          only has to correct the rows a shift-range flips the other way.
          mousedown is still cancelled for shift, purely to stop the browser
          selecting the text between the two clicks.
        -->
        <input
          type="checkbox"
          class="row-check"
          use:liveChecked={{ checked: selectedSet.has(link.id) }}
          onmousedown={(e) => e.shiftKey && e.preventDefault()}
          onclick={(e) => {
            e.currentTarget.checked = toggle(link.id, e.shiftKey);
          }}
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

  .select-bar {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    margin: 0 0 var(--space-2);
  }

  .select-hint {
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
  }

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
