<script lang="ts">
  /**
   * The sync indicator beside the logo. Three states, and the distinction that
   * matters is between the last two:
   *
   *   wifi        — a server is configured and the last thing we heard was
   *                 good. Your writes are leaving this device.
   *   wifi-off    — a server IS configured but we can't reach it (the browser
   *                 is offline, or the last sync failed). Something is wrong
   *                 and will right itself; shown in the danger colour.
   *   hdd-rack /  — there is no server at all: offline mode, or a static
   *   struck out    install whose same-origin probe found nothing. Nothing is
   *                 wrong — this is just a local-only library — so it is drawn
   *                 in the muted colour, not the error one.
   *
   * It costs no requests of its own. `hasValidSyncUrl` is config only,
   * `navigator.onLine` is free, and the rest comes from state sync already
   * keeps: the stored `lastError`, plus the SYNC_EVENT every attempt fires.
   * (`ensureSyncAvailable` may issue the once-per-session /healthz probe for a
   * blank URL, which the app does anyway — see docs/dev/sync.md.)
   *
   * Icons are Bootstrap Icons (MIT), inlined so the page fetches nothing.
   */
  import { onMount } from 'svelte';
  import { href } from '../lib/paths';

  type State = 'connected' | 'unreachable' | 'local';

  let {
    /** Told the state on every change, so the host can avoid saying it twice. */
    onState,
  }: { onState?: (state: State) => void } = $props();

  let conn = $state<State>('local');
  let detail = $state('');

  const LABELS: Record<State, string> = {
    connected: 'Synced',
    unreachable: 'Sync server unreachable',
    local: 'Local only',
  };

  const TITLES: Record<State, string> = {
    connected: 'Connected to your sync server — changes on this device reach the others.',
    unreachable:
      "Your sync server is configured but can't be reached right now. Everything keeps working here and syncs when it comes back.",
    local:
      'No sync server — this library lives on this device only. Set one up in Settings → Sync.',
  };

  /** Set the state and tell the host about it in one place. */
  function settle(next: State, note = '') {
    conn = next;
    detail = note;
    onState?.(next);
  }

  async function refresh() {
    const [{ hasValidSyncUrl, ensureSyncAvailable, getSyncStatus }] = await Promise.all([
      import('../lib/sync'),
    ]);
    if (!hasValidSyncUrl() || !(await ensureSyncAvailable())) {
      settle('local');
      return;
    }
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      settle('unreachable', "You're offline.");
      return;
    }
    const status = await getSyncStatus();
    if (status.lastError) {
      settle('unreachable', status.lastError);
      return;
    }
    const status_at = status.lastSyncAt;
    settle('connected', status_at ? `Last synced ${new Date(status_at).toLocaleString()}.` : '');
  }

  onMount(() => {
    void refresh();
    const onSync = () => void refresh();
    const onNet = () => void refresh();
    window.addEventListener('readerr-sync', onSync);
    window.addEventListener('online', onNet);
    window.addEventListener('offline', onNet);
    return () => {
      window.removeEventListener('readerr-sync', onSync);
      window.removeEventListener('online', onNet);
      window.removeEventListener('offline', onNet);
    };
  });
</script>

<a
  class="conn {conn}"
  href={href('/settings/')}
  title={detail ? `${TITLES[conn]}\n\n${detail}` : TITLES[conn]}
  aria-label={`Sync status: ${LABELS[conn]}`}
>
  {#if conn === 'connected'}
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M15.384 6.115a.485.485 0 0 0-.047-.736A12.44 12.44 0 0 0 8 3C5.259 3 2.723 3.882.663 5.379a.485.485 0 0 0-.048.736.52.52 0 0 0 .668.05A11.45 11.45 0 0 1 8 4c2.507 0 4.827.802 6.716 2.164.205.148.49.13.668-.049"/>
      <path d="M13.229 8.271a.482.482 0 0 0-.063-.745A9.46 9.46 0 0 0 8 6c-1.905 0-3.68.56-5.166 1.526a.48.48 0 0 0-.063.745.525.525 0 0 0 .652.065A8.46 8.46 0 0 1 8 7a8.46 8.46 0 0 1 4.576 1.336c.206.132.48.108.653-.065m-2.183 2.183c.226-.226.185-.605-.1-.75A6.5 6.5 0 0 0 8 9c-1.06 0-2.062.254-2.946.704-.285.145-.326.524-.1.75l.015.015c.16.16.407.19.611.09A5.5 5.5 0 0 1 8 10c.868 0 1.69.201 2.42.56.203.1.45.07.61-.091zM9.06 12.44c.196-.196.198-.52-.04-.66A2 2 0 0 0 8 11.5a2 2 0 0 0-1.02.28c-.238.14-.236.464-.04.66l.706.706a.5.5 0 0 0 .707 0l.707-.707z"/>
    </svg>
  {:else if conn === 'unreachable'}
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M10.706 3.294A12.6 12.6 0 0 0 8 3C5.259 3 2.723 3.882.663 5.379a.485.485 0 0 0-.048.736.52.52 0 0 0 .668.05A11.45 11.45 0 0 1 8 4q.946 0 1.852.148zM8 6c-1.905 0-3.68.56-5.166 1.526a.48.48 0 0 0-.063.745.525.525 0 0 0 .652.065 8.45 8.45 0 0 1 3.51-1.27zm2.596 1.404.785-.785q.947.362 1.785.907a.482.482 0 0 1 .063.745.525.525 0 0 1-.652.065 8.5 8.5 0 0 0-1.98-.932zM8 10l.933-.933a6.5 6.5 0 0 1 2.013.637c.285.145.326.524.1.75l-.015.015a.53.53 0 0 1-.611.09A5.5 5.5 0 0 0 8 10m4.905-4.905.747-.747q.886.451 1.685 1.03a.485.485 0 0 1 .047.737.52.52 0 0 1-.668.05 11.5 11.5 0 0 0-1.811-1.07M9.02 11.78c.238.14.236.464.04.66l-.707.706a.5.5 0 0 1-.707 0l-.707-.707c-.195-.195-.197-.518.04-.66A2 2 0 0 1 8 11.5c.374 0 .723.102 1.021.28zm4.355-9.905a.53.53 0 0 1 .75.75l-10.75 10.75a.53.53 0 0 1-.75-.75z"/>
    </svg>
  {:else}
    <!-- hdd-rack-fill, struck through: a server that is deliberately not there. -->
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M2 2a2 2 0 0 0-2 2v1a2 2 0 0 0 2 2h1v2H2a2 2 0 0 0-2 2v1a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1a2 2 0 0 0-2-2h-1V7h1a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm.5 3a.5.5 0 1 1 0-1 .5.5 0 0 1 0 1m2 0a.5.5 0 1 1 0-1 .5.5 0 0 1 0 1m-2 7a.5.5 0 1 1 0-1 .5.5 0 0 1 0 1m2 0a.5.5 0 1 1 0-1 .5.5 0 0 1 0 1M12 7v2H4V7z"/>
      <!--
        The slash is drawn twice: a stroke in the navbar's own background
        colour underneath, so the line reads as a gap through the filled rack
        rather than smudging into it, then the line itself on top.
      -->
      <path d="M13.6 1.9 2.4 14.1" stroke="var(--surface-color)" stroke-width="2.6" stroke-linecap="round" fill="none"/>
      <path d="M13.6 1.9 2.4 14.1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none"/>
    </svg>
  {/if}
</a>

<style>
  .conn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.6rem;
    height: 1.6rem;
    flex-shrink: 0;
    border-radius: var(--radius-md);
    color: var(--text-muted-color);
    text-decoration: none;
  }

  .conn svg {
    width: 1.05rem;
    height: 1.05rem;
  }

  .conn:hover {
    background: var(--color-primary-soft);
  }

  /* Connected is the quiet, everything-is-fine state; it doesn't shout. */
  .conn.connected {
    color: var(--text-muted-color);
  }

  .conn.connected:hover {
    color: var(--color-primary-strong);
  }

  /* Something is actually wrong — this is the one that gets the danger colour. */
  .conn.unreachable {
    color: var(--color-danger);
  }

  /* Local-only is a choice, not a fault: muted, never red. */
  .conn.local {
    color: var(--text-muted-color);
    opacity: 0.85;
  }
</style>
