<script lang="ts">
  /** Search field for link list pages; bind `value` and filter on it. */
  let {
    value = $bindable(''),
    placeholder = 'Search by title, URL, or tag…',
  }: {
    value?: string;
    placeholder?: string;
  } = $props();
</script>

<div class="search">
  <input type="search" {placeholder} bind:value />
  {#if value}
    <button type="button" class="clear" title="Clear search" onclick={() => (value = '')}>✕</button>
  {/if}
</div>

<style>
  .search {
    position: relative;
    display: flex;
  }

  .search input {
    flex: 1;
    min-width: 0;
    padding: var(--space-2) var(--space-3);
    padding-right: 2.2rem;
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    background: var(--surface-color);
    color: var(--text-color);
  }

  .search input:focus {
    outline: 2px solid var(--color-primary);
    outline-offset: -1px;
  }

  .clear {
    position: absolute;
    right: var(--space-2);
    top: 50%;
    transform: translateY(-50%);
    border: none;
    background: none;
    color: var(--text-muted-color);
    cursor: pointer;
    padding: var(--space-1);
  }

  .clear:hover {
    color: var(--color-danger);
  }
</style>
