<script lang="ts">
  /**
   * Quick-paste capture: the fastest way to dump links into the backlog.
   * One URL per line; adds everything, reports duplicates/invalid lines.
   */
  import { captureLinks } from '../lib/services/capture';
  import type { Link } from '../lib/db/types';

  let { onAdded }: { onAdded: (links: Link[]) => void } = $props();

  let text = $state('');
  let busy = $state(false);
  let report = $state('');

  async function add() {
    if (!text.trim() || busy) return;
    busy = true;
    try {
      const { added, duplicates, invalid } = await captureLinks(text);
      const parts = [`${added.length} added`];
      if (duplicates.length > 0) parts.push(`${duplicates.length} already saved`);
      if (invalid.length > 0) parts.push(`${invalid.length} not a URL`);
      report = parts.join(' · ');
      text = '';
      onAdded(added);
    } finally {
      busy = false;
    }
  }

  function onKeydown(e: KeyboardEvent) {
    // Enter adds; Shift+Enter makes a new line for multi-URL pastes.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void add();
    }
  }
</script>

<div class="capture">
  <textarea
    placeholder="Paste links — one per line. Enter to add, Shift+Enter for a new line."
    rows="3"
    bind:value={text}
    onkeydown={onKeydown}
  ></textarea>
  <div class="capture-actions">
    {#if report}
      <span class="report">{report}</span>
    {/if}
    <button class="btn btn-primary" onclick={add} disabled={busy || !text.trim()}>
      {busy ? 'Adding…' : 'Add to backlog'}
    </button>
  </div>
</div>

<style>
  .capture {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  textarea {
    width: 100%;
    resize: vertical;
    font-family: inherit;
    font-size: var(--font-size-base);
    padding: var(--space-3);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    background: var(--surface-color);
    color: var(--text-color);
  }

  textarea:focus {
    outline: 2px solid var(--color-primary);
    outline-offset: -1px;
  }

  .capture-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-3);
  }

  .report {
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
  }
</style>
