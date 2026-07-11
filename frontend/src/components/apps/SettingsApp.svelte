<script lang="ts">
  import { onMount } from 'svelte';
  import { requestPersistentStorage, type PersistState } from '../../lib/db/persistence';
  import { downloadExport, importData, clearAllData } from '../../lib/db/export';
  import { downloadMarkdownExport } from '../../lib/db/export-markdown';
  import { seedDataset } from '../../lib/db/seed';
  import { syncNow, getSyncStatus, getSyncUrl, setSyncUrl, setSyncMode, testConnection, type SyncStatus } from '../../lib/sync';
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
  // One domain per line (or comma-separated) in the textarea.
  let whitelistText = $state('');

  /** Example URLs demonstrating what the current cleaning setting does. */
  const STRIP_EXAMPLES = [
    'https://kieranwood.ca/',
    'https://kieranwood.ca/?ref=dailydev',
    'https://www.youtube.com/watch?v=2T-JGtLXH1E&si=share123',
    'https://example.com/article?utm_source=newsletter&page=2',
  ];

  const whitelist = $derived(
    whitelistText
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean)
  );

  const stripPreview = $derived(
    STRIP_EXAMPLES.map((url) => ({ from: url, to: cleanUrl(url, stripMode, whitelist) }))
  );

  async function saveStripMode() {
    await saveUserSettings({ strip_query_params: stripMode, strip_whitelist: whitelist });
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
    syncTest = null; // a URL change invalidates the last test result
  }

  let testing = $state(false);
  let syncTest = $state<{ ok: boolean; message: string } | null>(null);

  async function testSyncServer() {
    testing = true;
    syncTest = null;
    try {
      syncTest = await testConnection(syncUrl);
    } finally {
      testing = false;
    }
  }

  onMount(async () => {
    const stored = localStorage.getItem('readerr-theme');
    theme = stored === 'light' || stored === 'dark' ? stored : 'system';
    syncUrl = getSyncUrl();
    syncStatus = await getSyncStatus();
    const userSettings = await getUserSettings();
    stripMode = userSettings?.strip_query_params ?? 'off';
    whitelistText = (userSettings?.strip_whitelist ?? []).join('\n');
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

  // Range export inputs ('YYYY-MM-DD').
  let rangeFrom = $state('');
  let rangeTo = $state('');
  // Template export selections.
  let templateTags = $state(true);
  let templateTopics = $state(true);

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
    const isFull = ((envelope as { scope?: string })?.scope ?? 'full') === 'full';
    const warning = isFull
      ? 'This is a full backup — importing it REPLACES all current data. Continue?'
      : 'This is a partial export — its rows will be merged into your existing data (nothing is deleted). Continue?';
    if (!confirm(warning)) {
      input.value = '';
      return;
    }
    try {
      const result = await importData(envelope as Parameters<typeof importData>[0]);
      if (result.mode === 'replaced') {
        message = 'Import complete. Reloading…';
        location.reload();
      } else {
        message = `Merged ${result.rows} rows in.`;
        input.value = '';
      }
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

  let seeding = $state(false);
  let seedLinksPerWeek = $state(20);
  let seedWeeks = $state(13);

  const seedEstimate = $derived(seedLinksPerWeek * seedWeeks);

  /** 104 → "2 years", 105 → "2 years +", 156 → "3 years". */
  const seedYearsLabel = $derived.by(() => {
    if (seedWeeks < 52) return 'less than a year';
    const years = Math.floor(seedWeeks / 52);
    const exact = seedWeeks % 52 === 0;
    return `${years} year${years === 1 ? '' : 's'}${exact ? '' : ' +'}`;
  });

  async function loadDemoData() {
    if (
      !confirm(
        `Load demo data: ~${seedEstimate.toLocaleString()} links over ${seedWeeks} weeks (${seedYearsLabel})? ` +
          'It mixes into whatever is already here and will sync like real data — best used on a fresh install. ' +
          'Large datasets take a while to write and are deliberately heavy.'
      )
    ) {
      return;
    }
    seeding = true;
    try {
      const s = await seedDataset(
        { linksPerWeek: seedLinksPerWeek, weeks: seedWeeks },
        (m) => (message = m)
      );
      message = `Demo data loaded: ${s.links.toLocaleString()} links across ${s.weeks} weeks, ${s.tags} tags, ${s.topics.toLocaleString()} topics, ${s.notes.toLocaleString()} notes, ${s.favourites} favourites, ${s.resources} resources.`;
    } finally {
      seeding = false;
    }
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
        <label for="set-theme">Dark/Light</label>
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
      {#if stripMode === 'all'}
        <div style="margin-bottom: var(--space-3);">
          <label for="set-strip-whitelist">Whitelisted domains (one per line)</label>
          <p class="muted" style="margin-bottom: var(--space-2); font-size: var(--font-size-sm);">
            These domains (and their subdomains) keep their query params —
            only tracking junk is removed. e.g. <code>youtube.com</code> so
            ?v= video links survive full stripping.
          </p>
          <textarea
            id="set-strip-whitelist"
            rows="3"
            placeholder={'youtube.com\nnews.ycombinator.com'}
            bind:value={whitelistText}
            onchange={saveStripMode}
          ></textarea>
        </div>
      {/if}
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
      {#if syncTest}
        <div class="test-banner" class:ok={syncTest.ok} role="status">
          {syncTest.ok ? '✅' : '⚠️'}
          {syncTest.message}
        </div>
      {/if}
      <div class="actions">
        <button class="btn" onclick={testSyncServer} disabled={testing}>
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        <button class="btn btn-primary" onclick={runSync} disabled={syncing}>
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
      </div>
    </Card>

    <Card title="Backup">
      <div class="backup-section">
        <h3>Full backup</h3>
        <p class="muted">
          A complete copy of everything, including deletion history — the
          file to keep safe. <strong>Importing a full backup replaces all
          current data.</strong> Markdown export writes every topic, tag, and
          link (with notes and excerpts) as plain markdown files instead —
          your prose is never locked in.
        </p>
        <div class="actions">
          <button class="btn btn-primary" onclick={() => downloadExport('full')}>Export JSON</button>
          <button class="btn btn-primary" onclick={exportMarkdown} disabled={exporting}>
            {exporting ? 'Exporting…' : 'Export Markdown'}
          </button>
          <label class="btn" style="margin-bottom: 0;">
            Import JSON
            <input type="file" accept="application/json" onchange={onImportFile} hidden />
          </label>
        </div>
      </div>

      <div class="backup-section">
        <h3>Curated export</h3>
        <p class="muted">
          A smaller file with just the links that made it somewhere — anything
          favourited, tagged, or referenced in a topic — plus their notes,
          excerpts, and those tags/topics. Importing a curated file
          <strong>merges</strong> into existing data; it never deletes.
        </p>
        <div class="actions">
          <button class="btn" onclick={() => downloadExport('curated')}>Export curated JSON</button>
        </div>
      </div>

      <div class="backup-section">
        <h3>Template export</h3>
        <p class="muted">
          Just your organizational scheme — tags and/or topics with their
          notes and documents, <strong>no links</strong>. Handy for starting
          a fresh install with your structure in place. Merges on import.
        </p>
        <div class="template-row">
          <label class="check">
            <input type="checkbox" bind:checked={templateTags} /> Tags
          </label>
          <label class="check">
            <input type="checkbox" bind:checked={templateTopics} /> Topics
          </label>
          <button
            class="btn"
            disabled={!templateTags && !templateTopics}
            onclick={() =>
              downloadExport('template', undefined, { tags: templateTags, topics: templateTopics })}
          >
            Export template
          </button>
        </div>
      </div>

      <div class="backup-section">
        <h3>Time range export</h3>
        <p class="muted">
          Links captured between two dates (inclusive), with their notes,
          excerpts, and referenced tags/topics. Also merges on import.
        </p>
        <div class="range-row">
          <label for="set-range-from">From</label>
          <input id="set-range-from" type="date" bind:value={rangeFrom} />
          <label for="set-range-to">To</label>
          <input id="set-range-to" type="date" bind:value={rangeTo} />
          <button
            class="btn"
            disabled={!rangeFrom || !rangeTo || rangeFrom > rangeTo}
            onclick={() => downloadExport('range', { from: rangeFrom, to: rangeTo })}
          >
            Export range
          </button>
        </div>
      </div>
    </Card>

    <Card title="Danger zone">
      <p class="muted" style="margin-bottom: var(--space-3);">
        Load a demo dataset to try the app out (or to feel how it behaves at
        multi-year scale), or wipe everything on this device (exports above
        are your only undo).
      </p>
      <div class="seed-slider">
        <label for="seed-links">Usage weight: {seedLinksPerWeek} links/week</label>
        <input id="seed-links" type="range" min="5" max="200" step="5" bind:value={seedLinksPerWeek} />
      </div>
      <div class="seed-slider">
        <label for="seed-weeks">Duration: {seedWeeks} weeks ({seedYearsLabel})</label>
        <input id="seed-weeks" type="range" min="1" max="520" step="1" bind:value={seedWeeks} />
      </div>
      <p class="muted" style="margin-bottom: var(--space-3); font-size: var(--font-size-sm);">
        ≈ {seedEstimate.toLocaleString()} links (notes, topics, favourites,
        and resources scale along).
      </p>
      <div class="actions">
        <button class="btn" onclick={loadDemoData} disabled={seeding}>
          {seeding ? 'Loading…' : 'Load demo data'}
        </button>
        <button class="btn btn-danger" onclick={clearData} disabled={seeding}>Clear all data</button>
      </div>
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

  .test-banner {
    border-radius: var(--radius-md);
    padding: var(--space-2) var(--space-3);
    margin-bottom: var(--space-3);
    font-size: var(--font-size-sm);
    border: 1px solid var(--color-danger);
    background: color-mix(in srgb, var(--color-danger) 12%, transparent);
    color: var(--text-color);
  }

  .test-banner.ok {
    border-color: var(--color-success);
    background: color-mix(in srgb, var(--color-success) 14%, transparent);
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

  .backup-section {
    padding-bottom: var(--space-3);
    margin-bottom: var(--space-3);
    border-bottom: 1px solid var(--border-color);
  }

  .backup-section:last-child {
    padding-bottom: 0;
    margin-bottom: 0;
    border-bottom: none;
  }

  .backup-section h3 {
    margin: 0 0 var(--space-2);
    font-size: var(--font-size-base);
  }

  .backup-section .muted {
    margin-bottom: var(--space-3);
  }

  .range-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .range-row label {
    margin: 0;
  }

  .range-row input {
    width: auto;
  }

  .template-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .template-row .check {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    margin: 0;
    cursor: pointer;
  }

  .template-row .check input {
    width: auto;
    margin: 0;
  }

  .seed-slider {
    margin-bottom: var(--space-3);
  }

  .seed-slider input[type='range'] {
    width: 100%;
    accent-color: var(--color-primary);
  }
</style>
