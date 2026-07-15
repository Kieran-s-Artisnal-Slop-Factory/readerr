<script lang="ts">
  /**
   * Floating capture button (see capture FAB.md): a corner FAB that opens a
   * floating panel hosting the full CaptureBox — every capture feature, no
   * reimplementation. Desktop gets a popover anchored above the button;
   * narrow screens get a bottom sheet. The panel stays open after an add
   * (CaptureBox resets itself and shows its report) so several batches can
   * be captured in a row; Escape, the backdrop, or the ✕ close it.
   *
   * Currently an experiment mounted ONLY on /fab-test — nothing else in the
   * app references this component yet.
   */
  import CaptureBox from './CaptureBox.svelte';
  import type { Link } from '../lib/db/types';

  let open = $state(false);
  let panelEl = $state<HTMLDivElement | null>(null);
  let fabEl = $state<HTMLButtonElement | null>(null);

  function close() {
    open = false;
    fabEl?.focus();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && open) close();
  }

  // Cross-island refresh hook: list pages can listen for this to live-update
  // (capture FAB.md). No consumers yet — the in-panel report is the feedback.
  function onCaptured(links: Link[]) {
    window.dispatchEvent(new CustomEvent('readerr-captured', { detail: links }));
  }

  // Focus the paste box as soon as the panel opens.
  $effect(() => {
    if (open && panelEl) panelEl.querySelector('textarea')?.focus();
  });
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
  <button class="fab-backdrop" aria-label="Close capture panel" onclick={close}></button>
  <div
    id="capture-fab-panel"
    class="fab-panel"
    role="dialog"
    aria-modal="true"
    aria-label="Capture links"
    bind:this={panelEl}
  >
    <!-- Compact host: fewer chips per page, generic add label. -->
    <CaptureBox onAdded={onCaptured} chipPageSize={10} addLabel="Add Link(s)" />
  </div>
{/if}

<button
  class="fab"
  class:open
  bind:this={fabEl}
  aria-expanded={open}
  aria-controls="capture-fab-panel"
  aria-label={open ? 'Close capture' : 'Capture links'}
  title={open ? 'Close capture' : 'Capture links'}
  onclick={() => (open ? close() : (open = true))}
>
  <span class="fab-icon" aria-hidden="true">+</span>
</button>

<style>
  /*
   * z-index budget (documented next to the existing values): Navbar is 10,
   * the archive-suggestion modal is 100. The FAB button sits above content
   * but below any modal; its open panel/backdrop sit just below the modal
   * so a higher-priority interrupt still wins.
   */
  .fab {
    position: fixed;
    right: 1.5rem;
    bottom: calc(1.5rem + env(safe-area-inset-bottom, 0px));
    width: 3.5rem;
    height: 3.5rem;
    border: none;
    border-radius: var(--radius-full);
    background: var(--color-primary);
    color: var(--bg-color);
    font-size: 1.75rem;
    line-height: 1;
    cursor: pointer;
    box-shadow: var(--shadow-2);
    z-index: 95; /* above its own panel so the ✕ affordance stays clickable */
    display: grid;
    place-items: center;
  }

  .fab:hover {
    background: var(--color-primary-strong);
  }

  .fab-icon {
    transition: transform 0.15s ease;
  }

  .fab.open .fab-icon {
    transform: rotate(45deg); /* + becomes ✕ */
  }

  @media (prefers-reduced-motion: reduce) {
    .fab-icon {
      transition: none;
    }
  }

  .fab-backdrop {
    position: fixed;
    inset: 0;
    border: none;
    padding: 0;
    background: rgb(0 0 0 / 0.35);
    cursor: default;
    z-index: 90;
  }

  .fab-panel {
    position: fixed;
    right: 1.5rem;
    bottom: calc(5.75rem + env(safe-area-inset-bottom, 0px)); /* clears the button */
    width: min(26rem, calc(100vw - 3rem));
    max-height: min(75dvh, 40rem);
    overflow-y: auto;
    background: var(--surface-raised-color);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-2);
    padding: var(--space-4);
    z-index: 91;
  }

  /* Narrow screens: the panel becomes a full-width bottom sheet. */
  @media (max-width: 48rem) {
    .fab-panel {
      right: 0;
      left: 0;
      bottom: 0;
      width: auto;
      max-height: 85dvh;
      border-radius: var(--radius-lg) var(--radius-lg) 0 0;
      border-bottom: none;
      padding-bottom: calc(var(--space-4) + 4.5rem + env(safe-area-inset-bottom, 0px));
    }
  }
</style>
