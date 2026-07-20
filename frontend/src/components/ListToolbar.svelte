<script lang="ts">
  /**
   * The controls that sit above a link list: select all/none, search, a
   * newest/oldest sort toggle, and the flag filters. Shared by the Reading
   * List's Done card, the Backlog and Favourites so the three behave
   * identically — each host only supplies what the sort means to it.
   */
  import ChipFilter from './ChipFilter.svelte';
  import SearchInput from './SearchInput.svelte';

  interface FilterOption {
    value: string;
    label: string;
  }

  let {
    search = $bindable(''),
    order = $bindable<'newest' | 'oldest'>('newest'),
    filters = $bindable<string[]>([]),
    filterOptions = [],
    sortLabels,
    searchPlaceholder = 'Search by title, URL, or tag…',
    selectedCount = 0,
    selectableCount = 0,
    onToggleAll,
  }: {
    search?: string;
    order?: 'newest' | 'oldest';
    filters?: string[];
    /** Empty hides the filter row entirely. */
    filterOptions?: FilterOption[];
    /** What newest/oldest means here — "Newest read", "Newest captured"… */
    sortLabels: { newest: string; oldest: string };
    searchPlaceholder?: string;
    /** How many of the listed rows are selected right now. */
    selectedCount?: number;
    /** How many rows select-all would take in (the filtered list, not the page). */
    selectableCount?: number;
    /** Omit to hide the select-all box (a list with no bulk operations). */
    onToggleAll?: (selectAll: boolean) => void;
  } = $props();

  /*
   * One box for both directions: anything selected shows it ticked and the
   * next click clears the lot; nothing selected takes everything in. That
   * makes "get me out of this selection" a single click from any state,
   * which is the common case — rather than an indeterminate box that needs
   * two clicks to mean anything.
   */
  const anySelected = $derived(selectedCount > 0);
  const selectAllTitle = $derived(
    anySelected
      ? `Clear the ${selectedCount.toLocaleString()} selected`
      : `Select all ${selectableCount.toLocaleString()}`
  );
</script>

<div class="toolbar">
  <div class="toolbar-row">
    {#if onToggleAll}
      <input
        type="checkbox"
        class="select-all"
        checked={anySelected}
        disabled={selectableCount === 0 && !anySelected}
        title={selectAllTitle}
        aria-label={selectAllTitle}
        onclick={(e) => {
          // Drive the box from the callback's outcome, never from the
          // browser's own toggle (see rangeSelect.ts's liveChecked).
          const selectAll = !anySelected;
          e.currentTarget.checked = selectAll;
          onToggleAll?.(selectAll);
        }}
      />
    {/if}
    <div class="search">
      <SearchInput bind:value={search} placeholder={searchPlaceholder} />
    </div>
    <div class="sort" role="group" aria-label="Sort order">
      <button class="sort-btn" class:active={order === 'newest'} onclick={() => (order = 'newest')}>
        {sortLabels.newest}
      </button>
      <button class="sort-btn" class:active={order === 'oldest'} onclick={() => (order = 'oldest')}>
        {sortLabels.oldest}
      </button>
    </div>
  </div>
  {#if filterOptions.length > 0}
    <ChipFilter options={filterOptions} bind:selected={filters} />
  {/if}
</div>

<style>
  .toolbar {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
  }

  .toolbar-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .select-all {
    width: auto;
    margin: 0;
    flex-shrink: 0;
    cursor: pointer;
  }

  .search {
    flex: 1;
    min-width: 11rem;
  }

  .sort {
    display: flex;
    flex-shrink: 0;
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  .sort-btn {
    border: none;
    background: var(--surface-color);
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
    font-weight: 600;
    padding: var(--space-2) var(--space-3);
    cursor: pointer;
    white-space: nowrap;
  }

  .sort-btn:hover {
    color: var(--text-color);
  }

  .sort-btn.active {
    background: var(--color-primary-soft);
    color: var(--color-primary-strong);
  }

  /* Below 40rem the sort pair takes its own line rather than crushing the
     search field into a sliver. */
  @media (max-width: 40rem) {
    .sort {
      width: 100%;
    }

    .sort-btn {
      flex: 1;
    }
  }
</style>
