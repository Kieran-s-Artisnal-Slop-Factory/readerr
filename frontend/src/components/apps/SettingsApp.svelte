<script lang="ts">
  import { onMount } from 'svelte';
  import { requestPersistentStorage, type PersistState } from '../../lib/db/persistence';
  import { downloadExport, importData, clearAllData } from '../../lib/db/export';
  import { downloadMarkdownExport } from '../../lib/db/export-markdown';
  import { syncNow, getSyncStatus, getSyncUrl, setSyncUrl, setSyncMode, type SyncStatus } from '../../lib/sync';
  import { cleanUrl } from '../../lib/services/capture';
  import { getUserSettings, saveUserSettings } from '../../lib/services/settings';
  import { href } from '../../lib/paths';
  import Card from '../Card.svelte';
  import ThemeEditor from '../ThemeEditor.svelte';
  import type { StripMode } from '../../lib/db/types';

  type Theme = 'system' | 'light' | 'dark';

  let loading = $state(true);
  let persistState: PersistState | 'unknown' = $state('unknown');
  let message = $state('');
  let theme: Theme = $state('system');
  let syncUrl = $state('');
  let syncStatus: SyncStatus = $state({ lastSyncAt: null, lastError: null });
  let syncing = $state(false);
  let exporting = $state(false);
  let stripMode = $state<StripMode>('off');

  /** Example URLs demonstrating what the current cleaning setting does. */
  const STRIP_EXAMPLES = [
    'https://kieranwood.ca/',
    'https://kieranwood.ca/?ref=dailydev',
    'https://www.youtube.com/watch?v=2T-JGtLXH1E&si=share123',
    'https://example.com/article?utm_source=newsletter&page=2',
  ];

  const stripPreview = $derived(
    STRIP_EXAMPLES.map((url) => ({ from: url, to: cleanUrl(url, stripMode) }))
  );

  async function saveStripMode() {
    await saveUserSettings({ strip_query_params: stripMode });
    message = 'Link handling saved.';
  }

  function formatTimestamp(iso: string): string {
    return new Date(iso).toLocaleString();
  }

  function applyTheme() {
    if (theme === 'system') {
      localStorage.removeItem('readerr-theme');
      document.documentElement.style.colorScheme = '';
    } else {
      localStorage.setItem('readerr-theme', theme);
      document.documentElement.style.colorScheme = theme;
    }
  }

  async function runSync() {
    syncing = true;
    const result = await syncNow();
    syncing = false;
    message = result.ok
      ? result.pushed === 0 && result.pulled === 0
        ? 'Sync complete: no changes to push or pull.'
        : `Sync complete: pushed ${result.pushed}, pulled ${result.pulled}.`
      : `Sync failed: ${result.error}`;
    syncStatus = await getSyncStatus();
  }

  function saveSyncUrl() {
    setSyncUrl(syncUrl);
    syncUrl = getSyncUrl();
    if (syncUrl) setSyncMode('sync'); // configuring a server opts back into syncing
    message = 'Sync server saved.';
  }

  onMount(async () => {
    const stored = localStorage.getItem('readerr-theme');
    theme = stored === 'light' || stored === 'dark' ? stored : 'system';
    syncUrl = getSyncUrl();
    syncStatus = await getSyncStatus();
    stripMode = (await getUserSettings())?.strip_query_params ?? 'off';
    if (typeof navigator !== 'undefined' && navigator.storage?.persisted) {
      persistState = (await navigator.storage.persisted()) ? 'granted' : 'denied';
    } else {
      persistState = 'unsupported';
    }
    loading = false;
  });

  async function askPersist() {
    persistState = await requestPersistentStorage();
  }

  async function exportMarkdown() {
    exporting = true;
    try {
      await downloadMarkdownExport();
      message = 'Markdown export ready.';
    } finally {
      exporting = false;
    }
  }

  async function onImportFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    let envelope: unknown;
    try {
      envelope = JSON.parse(await file.text());
    } catch {
      message = 'Import failed: that file is not valid JSON.';
      input.value = '';
      return;
    }
    if (!confirm('Importing a backup REPLACES all current data. Continue?')) {
      input.value = '';
      return;
    }
    try {
      await importData(envelope as Parameters<typeof importData>[0]);
      message = 'Import complete. Reloading…';
      location.reload();
    } catch (err) {
      message = `Import failed: ${err instanceof Error ? err.message : err}`;
      input.value = '';
    }
  }

  async function clearData() {
    if (!confirm('Delete ALL local data? This cannot be undone — export a backup first if in doubt.')) {
      return;
    }
    await clearAllData();
    location.href = href('/');
  }
</script>

{#if loading}
  <p class="muted">Loading…</p>
{:else}
  <div class="stack">
    {#if message}
      <p class="notice">{message}</p>
    {/if}

    <Card title="Appearance">
      <div style="margin-bottom: var(--space-3);">
        <label for="set-theme">Mode</label>
        <select id="set-theme" bind:value={theme} onchange={applyTheme}>
          <option value="system">System (follow OS setting)</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </div>
      <ThemeEditor />
    </Card>

    <Card title="Link handling">
      <p class="muted" style="margin-bottom: var(--space-3);">
        How pasted URLs are cleaned before saving. This sets the default for
        the "Clean URLs" checkbox on the backlog capture box (you can still
        toggle it per paste). <strong>Tracking params only</strong> removes
        junk like utm_*, ref, and si while keeping meaningful params (a
        YouTube ?v= survives); <strong>all query params</strong> strips
        everything after the ?.
      </p>
      <div style="margin-bottom: var(--space-3);">
        <label for="set-strip">Strip query params</label>
        <select id="set-strip" bind:value={stripMode} onchange={saveStripMode}>
          <option value="off">Off — keep URLs exactly as pasted</option>
          <option value="trackers">Tracking params only (recommended)</option>
          <option value="all">All query params</option>
        </select>
      </div>
      <p class="muted" style="margin-bottom: var(--space-2); font-size: var(--font-size-sm);">
        With your current setting:
      </p>
      <ul class="strip-preview">
        {#each stripPreview as ex (ex.from)}
          <li>
            <code>{ex.from}</code>
            <span class="arrow">→</span>
            <code class:unchanged={ex.from === ex.to}>{ex.to}</code>
          </li>
        {/each}
      </ul>
    </Card>

    <Card title="Storage">
      {#if persistState === 'granted'}
        <p>✅ Persistent storage granted — the browser won't evict your data.</p>
      {:else if persistState === 'unsupported'}
        <p class="muted">This browser doesn't support persistent storage.</p>
      {:else}
        <p>
          ⚠️ Storage is <strong>not persistent</strong>: the browser may evict
          your data under storage pressure (iOS Safari does so after ~7 days of
          inactivity). Export a backup regularly.
        </p>
        <button class="btn" onclick={askPersist} style="margin-top: var(--space-2);">
          Request persistent storage
        </button>
      {/if}
    </Card>

    <Card title="Sync">
      {#if syncStatus.lastError}
        <p style="margin-bottom: var(--space-2);">
          ⚠️ Not currently syncing — last attempt failed:
          <span class="muted">{syncStatus.lastError}</span>
        </p>
      {:else if syncStatus.lastSyncAt}
        <p style="margin-bottom: var(--space-2);">
          ✅ Last synced {formatTimestamp(syncStatus.lastSyncAt)}.
        </p>
      {:else}
        <p class="muted" style="margin-bottom: var(--space-2);">
          Never synced. Syncing is optional — the app is fully functional
          offline; a sync server just backs up your data and shares it across
          devices. It also resolves page titles for captured links.
        </p>
      {/if}
      <div style="margin-bottom: var(--space-3);">
        <label for="set-sync-url">Sync server URL (blank = same origin)</label>
        <input
          id="set-sync-url"
          bind:value={syncUrl}
          onchange={saveSyncUrl}
          placeholder="e.g. http://192.168.1.10:8080"
        />
      </div>
      <button class="btn btn-primary" onclick={runSync} disabled={syncing}>
        {syncing ? 'Syncing…' : 'Sync now'}
      </button>
    </Card>

    <Card title="Backup">
      <p class="muted" style="margin-bottom: var(--space-3);">
        <strong>JSON backup</strong> is a full copy you can import back later.
        <strong>Markdown export</strong> writes every topic, tag, and link
        (with notes and excerpts) as plain markdown files — your prose is
        never locked in.
      </p>
      <div class="actions">
        <button class="btn btn-primary" onclick={() => downloadExport()}>Export JSON</button>
        <button class="btn btn-primary" onclick={exportMarkdown} disabled={exporting}>
          {exporting ? 'Exporting…' : 'Export Markdown'}
        </button>
        <label class="btn" style="margin-bottom: 0;">
          Import JSON
          <input type="file" accept="application/json" onchange={onImportFile} hidden />
        </label>
      </div>
    </Card>

    <Card title="Danger zone">
      <p class="muted" style="margin-bottom: var(--space-3);">
        Wipe everything on this device. Exports above are your only undo.
      </p>
      <button class="btn btn-danger" onclick={clearData}>Clear all data</button>
    </Card>
  </div>
{/if}

<style>
  .actions {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .notice {
    background: var(--color-primary-soft);
    border: 1px solid var(--color-primary);
    border-radius: var(--radius-md);
    padding: var(--space-2) var(--space-3);
  }

  .strip-preview {
    list-style: none;
    margin: 0;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    font-size: var(--font-size-sm);
    overflow-x: auto;
  }

  .strip-preview li {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    padding: var(--space-1) 0;
    white-space: nowrap;
  }

  .strip-preview code {
    color: var(--text-color);
  }

  .strip-preview code.unchanged {
    color: var(--text-muted-color);
  }

  .strip-preview .arrow {
    color: var(--color-primary-strong);
    flex-shrink: 0;
  }
</style>
