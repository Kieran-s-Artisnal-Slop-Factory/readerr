<script lang="ts">
  /**
   * Reusable multi-select chip filter. Bind `selected` to get the active
   * values; a Clear chip appears whenever anything is selected.
   */
  interface Option {
    value: string;
    label: string;
  }

  let {
    options,
    selected = $bindable([]),
    label = '',
  }: {
    options: Option[];
    selected?: string[];
    label?: string;
  } = $props();

  function toggle(value: string) {
    selected = selected.includes(value)
      ? selected.filter((v) => v !== value)
      : [...selected, value];
  }
</script>

<div class="chip-filter" role="group" aria-label={label || 'Filter'}>
  {#if label}
    <span class="cf-label">{label}</span>
  {/if}
  <div class="chips">
    {#each options as option (option.value)}
      <button
        type="button"
        class="chip"
        class:selected={selected.includes(option.value)}
        aria-pressed={selected.includes(option.value)}
        onclick={() => toggle(option.value)}
      >
        {option.label}
      </button>
    {/each}
    {#if selected.length > 0}
      <button type="button" class="chip clear" onclick={() => (selected = [])}>
        ✕ Clear
      </button>
    {/if}
  </div>
</div>

<style>
  .chip-filter {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .cf-label {
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
    font-weight: 600;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
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

  .chip.clear {
    border-style: dashed;
    color: var(--text-muted-color);
  }

  .chip.clear:hover {
    color: var(--color-danger);
    border-color: var(--color-danger);
  }
</style>
