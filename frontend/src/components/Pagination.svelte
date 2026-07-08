<script lang="ts">
  /**
   * Reusable pager. Bind `page` (0-based); the parent slices its own list with
   * page * pageSize. Only renders when there's more than one page.
   */
  let {
    total,
    pageSize,
    page = $bindable(0),
    label = 'items',
  }: {
    total: number;
    pageSize: number;
    page?: number;
    label?: string;
  } = $props();

  const pageCount = $derived(Math.max(1, Math.ceil(total / pageSize)));

  // Clamp if the underlying list shrinks (e.g. after a delete or filter).
  $effect(() => {
    if (page > pageCount - 1) page = pageCount - 1;
    if (page < 0) page = 0;
  });

  const start = $derived(total === 0 ? 0 : page * pageSize + 1);
  const end = $derived(Math.min(total, (page + 1) * pageSize));
</script>

{#if total > pageSize}
  <div class="pagination">
    <button class="btn" disabled={page <= 0} onclick={() => (page -= 1)}>← Prev</button>
    <span class="muted">Showing {start}–{end} of {total} {label}</span>
    <button class="btn" disabled={page >= pageCount - 1} onclick={() => (page += 1)}>Next →</button>
  </div>
{/if}

<style>
  .pagination {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    flex-wrap: wrap;
    margin-top: var(--space-4);
  }

  .pagination span {
    font-size: var(--font-size-sm);
  }
</style>
