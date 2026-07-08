<script lang="ts">
  import { onMount } from 'svelte';
  import { requestPersistentStorage, type PersistState } from '../../lib/db/persistence';
  import { downloadExport, importData, clearAllData } from '../../lib/db/export';
  import { downloadMarkdownExport } from '../../lib/db/export-markdown';
  import { syncNow, getSyncStatus, getSyncUrl, setSyncUrl, setSyncMode, type SyncStatus } from '../../lib/sync';
  import { getUserSettings, saveUserSettings } from '../../lib/services/settings';
  import { all } from '../../lib/db/repo';
  import { href } from '../../lib/paths';
  import Card from '../Card.svelte';
  import type { Tag } from '../../lib/db/types';

  type Theme = 'system' | 'light' | 'dark';

  let loading = $state(true);
  let persistState: PersistState | 'unknown' = $state('unknown');
  let message = $state('');
  let theme: Theme = $state('system');
  let syncUrl = $state('');
  let syncStatus: SyncStatus = $state({ lastSyncAt: null, lastError: null });
  let syncing = $state(false);
  let exporting = $state(false);
  let tags = $state<Tag[]>([]);
  // Bound as strings (empty = off) and parsed on save.
  let quotaInput = $state('');
  let focusTagInput = $state('');

  async function saveTriage() {
    const quota = parseInt(quotaInput, 10);
    await saveUserSettings({
      articles_per_week: Number.isFinite(quota) && quota > 0 ? quota : null,
      focus_tag_id: focusTagInput || null,
    });
    message = 'Triage settings saved.';
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
    const settings = await getUserSettings();
    quotaInput = settings?.articles_per_week ? String(settings.articles_per_week) : '';
    focusTagInput = settings?.focus_tag_id ?? '';
    tags = (await all<Tag>('tags')).sort((a, b) => a.name.localeCompare(b.name));
    // A focus tag that has since been deleted should read as "none".
    if (focusTagInput && !tags.some((t) => t.id === focusTagInput)) focusTagInput = '';
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
      <label for="set-theme">Theme</label>
      <select id="set-theme" bind:value={theme} onchange={applyTheme}>
        <option value="system">System (follow OS setting)</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </Card>

    <Card title="Triage">
      <p class="muted" style="margin-bottom: var(--space-3);">
        With a weekly quota set, the This Week page suggests backlog links to
        fill it — preferring the focus tag when one is chosen.
      </p>
      <div style="margin-bottom: var(--space-3);">
        <label for="set-quota">Articles per week (blank = off)</label>
        <input
          id="set-quota"
          type="number"
          min="1"
          bind:value={quotaInput}
          onchange={saveTriage}
          placeholder="e.g. 5"
        />
      </div>
      <div>
        <label for="set-focus">Weekly focus tag</label>
        <select id="set-focus" bind:value={focusTagInput} onchange={saveTriage}>
          <option value="">None</option>
          {#each tags as tag (tag.id)}
            <option value={tag.id}>{tag.name}</option>
          {/each}
        </select>
      </div>
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
</style>
