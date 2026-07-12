<script lang="ts">
  /**
   * One-time suggestion to enable yearly archival once the active link count
   * crosses 50k. Dismissing it sets a local flag so it never reappears; the
   * setting itself is always available in Settings regardless.
   */
  import { onMount } from 'svelte';
  import { getDB } from '../lib/db/db';
  import { getUserSettings, saveUserSettings } from '../lib/services/settings';
  import { href } from '../lib/paths';

  const THRESHOLD = 50_000;
  const DISMISS_KEY = 'readerr-archive-suggest-dismissed';

  let show = $state(false);

  onMount(async () => {
    if (localStorage.getItem(DISMISS_KEY) === '1') return;
    const settings = await getUserSettings();
    if (settings?.archive_enabled) return;
    const count = await (await getDB()).count('links');
    if (count > THRESHOLD) show = true;
  });

  function dismiss() {
    localStorage.setItem(DISMISS_KEY, '1');
    show = false;
  }

  async function enable() {
    await saveUserSettings({ archive_enabled: true });
    localStorage.setItem(DISMISS_KEY, '1');
    show = false;
    location.assign(href('/settings/'));
  }
</script>

{#if show}
  <div class="backdrop" role="dialog" aria-modal="true" aria-labelledby="archsug-title">
    <div class="modal">
      <h3 id="archsug-title">Keep things fast with archival?</h3>
      <p>
        You have over {THRESHOLD.toLocaleString()} links. Archival mode moves
        old slushed links (read, but not favourited or in a topic) out of the
        main views into a searchable <strong>Archive</strong> tab, so pages
        stay snappy. Nothing is deleted, and it's reversible.
      </p>
      <p class="muted">You can tune the age threshold, or turn this off, anytime in Settings.</p>
      <div class="actions">
        <button class="btn" onclick={dismiss}>Not now</button>
        <button class="btn btn-primary" onclick={enable}>Enable archival</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgb(0 0 0 / 0.5);
    display: grid;
    place-items: center;
    z-index: 100;
    padding: var(--space-4);
  }

  .modal {
    background: var(--surface-raised-color);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-2);
    padding: var(--space-5);
    max-width: 32rem;
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  h3 {
    margin: 0;
  }

  .actions {
    display: flex;
    gap: var(--space-2);
    justify-content: flex-end;
    margin-top: var(--space-3);
  }
</style>
