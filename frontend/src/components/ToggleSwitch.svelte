<script lang="ts">
  /**
   * An on/off switch with its label beside it.
   *
   * A plain `<input type="checkbox">` with the global `.check` label class is
   * built for full-width settings rows; dropped into a narrow card it stretches
   * the box away from its own text and reads as broken. This owns its layout
   * instead: the control and the label are one flex line, always adjacent.
   *
   * It is still a real checkbox underneath — visually hidden, not replaced —
   * so it keeps focus, the space bar, and form semantics.
   */
  let {
    checked = $bindable(false),
    label,
    hint = '',
    disabled = false,
  }: {
    checked?: boolean;
    label: string;
    /** Optional second line, e.g. what the option costs you. */
    hint?: string;
    disabled?: boolean;
  } = $props();
</script>

<label class="toggle" class:disabled>
  <input type="checkbox" bind:checked {disabled} />
  <span class="track" aria-hidden="true"><span class="knob"></span></span>
  <span class="text">
    <span class="label">{label}</span>
    {#if hint}<span class="hint">{hint}</span>{/if}
  </span>
</label>

<style>
  .toggle {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    cursor: pointer;
    /* The row is only as wide as it needs to be, so it never stretches. */
    width: fit-content;
    max-width: 100%;
  }

  .toggle.disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  /* Visually hidden, not display:none — it stays focusable and clickable. */
  .toggle input {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: 0;
    padding: 0;
    opacity: 0;
    pointer-events: none;
  }

  .track {
    position: relative;
    flex-shrink: 0;
    width: 2.2rem;
    height: 1.2rem;
    margin-top: 0.1rem;
    border: 1px solid var(--border-color);
    border-radius: var(--radius-full);
    background: var(--bg-color);
    transition:
      background 0.15s ease,
      border-color 0.15s ease;
  }

  .knob {
    position: absolute;
    top: 50%;
    left: 0.15rem;
    width: 0.85rem;
    height: 0.85rem;
    border-radius: var(--radius-full);
    background: var(--text-muted-color);
    transform: translateY(-50%);
    transition:
      transform 0.15s ease,
      background 0.15s ease;
  }

  .toggle input:checked + .track {
    background: var(--color-primary-soft);
    border-color: var(--color-primary);
  }

  .toggle input:checked + .track .knob {
    background: var(--color-primary-strong);
    transform: translate(0.95rem, -50%);
  }

  .toggle input:focus-visible + .track {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  .text {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .label {
    font-size: var(--font-size-sm);
  }

  .hint {
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
  }
</style>
