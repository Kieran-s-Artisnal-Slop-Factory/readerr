<script>
  let { title = undefined, children, footer = undefined } = $props();
</script>

<section class="card">
  {#if title}
    <h2 class="card-title">{title}</h2>
  {/if}
  <div class="card-body">
    {@render children?.()}
  </div>
  {#if footer}
    <div class="card-footer">
      {@render footer()}
    </div>
  {/if}
</section>

<style>
  .card {
    background: var(--surface-color);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-1);
    padding: var(--space-4);
  }

  .card-title {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--font-size-sm);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 800;
    color: var(--color-primary-strong);
    padding-bottom: var(--space-2);
    border-bottom: 1px solid var(--border-color);
    margin-bottom: var(--space-3);
  }

  .card-title::before {
    content: '';
    width: 4px;
    height: 1.1em;
    border-radius: var(--radius-full);
    background: var(--color-primary);
    flex-shrink: 0;
  }

  .card-footer {
    margin-top: var(--space-3);
    padding-top: var(--space-3);
    border-top: 1px solid var(--border-color);
    display: flex;
    gap: var(--space-2);
    justify-content: flex-end;
  }
</style>
