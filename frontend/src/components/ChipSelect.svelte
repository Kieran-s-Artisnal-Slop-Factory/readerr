<script lang="ts">
  /**
   * Multi-select chips over existing items with inline create — unlike
   * TagPicker/TopicPicker this only collects a selection (bind `selected`);
   * nothing is assigned until the caller acts on it. Used by CaptureBox to
   * pre-pick tags/topics for the links about to be captured.
   */
  import Pagination from './Pagination.svelte';

  interface Item {
    id: string;
    name: string;
  }

  let {
    items,
    selected = $bindable([]),
    createPlaceholder = 'New…',
    onCreate,
    pageSize = 50,
    pageLabel = 'items',
  }: {
    items: Item[];
    selected?: string[];
    createPlaceholder?: string;
    /** Create a new item and return its id; it gets selected automatically. */
    onCreate: (name: string) => Promise<string>;
    /** Chips per page; the caller controls the ordering. */
    pageSize?: number;
    pageLabel?: string;
  } = $props();

  let newName = $state('');
  let page = $state(0);
  let query = $state('');

  // A search box appears once the list is long enough to be unwieldy.
  const SEARCH_THRESHOLD = 100;
  const searchable = $derived(items.length > SEARCH_THRESHOLD);
  const matched = $derived(
    query.trim()
      ? items.filter((i) => i.name.toLowerCase().includes(query.trim().toLowerCase()))
      : items
  );

  // Reset to the first page whenever the filter changes.
  $effect(() => {
    void query;
    page = 0;
  });

  const pageItems = $derived(matched.slice(page * pageSize, (page + 1) * pageSize));
  // Selected chips must stay visible (and deselectable) even when the
  // pager has moved past them or the filter hides them.
  const offPageSelected = $derived(
    items.filter((i) => selected.includes(i.id) && !pageItems.some((p) => p.id === i.id))
  );

  function toggle(id: string) {
    selected = selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id];
  }

  async function create() {
    const name = newName.trim();
    if (!name) return;
    const existing = items.find((i) => i.name.toLowerCase() === name.toLowerCase());
    const id = existing?.id ?? (await onCreate(name));
    if (!selected.includes(id)) selected = [...selected, id];
    newName = '';
  }
</script>

<div class="chip-select">
  {#if searchable}
    <input
      type="search"
      class="chip-search"
      placeholder={`Search ${pageLabel}…`}
      bind:value={query}
    />
  {/if}
  <div class="chips">
    {#each [...offPageSelected, ...pageItems] as item (item.id)}
      <button
        type="button"
        class="chip"
        class:selected={selected.includes(item.id)}
        aria-pressed={selected.includes(item.id)}
        onclick={() => toggle(item.id)}
      >
        {item.name}
      </button>
    {/each}
    <input
      type="text"
      class="create"
      placeholder={createPlaceholder}
      bind:value={newName}
      onkeydown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          void create();
        }
      }}
      onblur={() => void create()}
    />
  </div>
  <Pagination total={matched.length} {pageSize} bind:page label={pageLabel} />
</div>

<style>
  .chip-search {
    width: 100%;
    margin-bottom: var(--space-2);
    padding: var(--space-1) var(--space-3);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    background: var(--surface-color);
    color: var(--text-color);
    font-size: var(--font-size-sm);
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
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
    width: 8rem;
    border: 1px dashed var(--border-color);
    border-radius: var(--radius-full);
    background: transparent;
    padding: 0 var(--space-3);
    font-size: var(--font-size-sm);
    line-height: 1.9;
    color: var(--text-color);
  }

  .create:focus {
    outline: none;
    border-color: var(--color-primary);
  }
</style>
