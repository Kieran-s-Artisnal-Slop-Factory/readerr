<script lang="ts">
  import { onMount } from 'svelte';
  import { requestPersistentStorage, type PersistState } from '../../lib/db/persistence';
  import { downloadExport, importData, clearAllData, wipeLocalData } from '../../lib/db/export';
  import { downloadMarkdownExport } from '../../lib/db/export-markdown';
  import {
    DEFAULT_SEED_OPTIONS,
    resolveSeedOptions,
    seedDataset,
    type SeedOptions,
  } from '../../lib/db/seed';
  import { archivableCount, archivedCount, archiveNow } from '../../lib/services/archive';
  import {
    syncFresh,
    getSyncMode,
    getSyncStatus,
    getSyncUrl,
    setSyncUrl,
    setSyncMode,
    testConnection,
    serverHasData,
    resetServer,
    resetLocalSyncState,
    localHasData,
    type SyncStatus,
  } from '../../lib/sync';
  import {
    clearSyncLog,
    getSyncLogPrefs,
    getSyncLogStats,
    listSyncEvents,
    pruneSyncLog,
    saveSyncLogPrefs,
    type SyncLogEvent,
    type SyncLogPrefs,
    type SyncLogStats,
  } from '../../lib/services/syncLog';
  import Pagination from '../Pagination.svelte';
  import { cleanUrl, stripExistingLinks } from '../../lib/services/capture';
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
  let autoTitle = $state(true);
  // 'custom' is a UI-only mode: stored as default_week='current' + an offset.
  let defaultWeekMode = $state<'none' | 'current' | 'custom'>('none');
  let defaultWeekOffset = $state(1);
  let captureTagSort = $state<'recent' | 'alpha'>('recent');
  // Archival
  let archiveEnabled = $state(false);
  let archiveMonths = $state(24);
  let archivable = $state(0);
  let archived = $state(0);
  let archiving = $state(false);

  async function refreshArchiveCounts() {
    archivable = await archivableCount(archiveMonths);
    archived = await archivedCount();
  }

  async function saveArchival() {
    archiveMonths = Math.max(1, Math.round(archiveMonths) || 24);
    await saveUserSettings({ archive_enabled: archiveEnabled, archive_after_months: archiveMonths });
    await refreshArchiveCounts();
    message = 'Archival settings saved.';
  }

  async function runArchiveNow() {
    archiving = true;
    try {
      const moved = await archiveNow(archiveMonths);
      await refreshArchiveCounts();
      message = `Archived ${moved.toLocaleString()} link${moved === 1 ? '' : 's'}.`;
    } finally {
      archiving = false;
    }
  }

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

  let strippingExisting = $state(false);

  /** One-time bulk apply of the strip setting to the already-saved library. */
  async function runStripExisting() {
    if (strippingExisting) return;
    if (
      !confirm(
        'Rewrite the URLs of all existing links using the setting above? ' +
          'Removed query params cannot be restored.'
      )
    ) {
      return;
    }
    strippingExisting = true;
    try {
      const { changed, collided } = await stripExistingLinks();
      const parts = [
        changed === 0
          ? 'No stored URLs needed cleaning.'
          : `Cleaned ${changed.toLocaleString()} link URL${changed === 1 ? '' : 's'}.`,
      ];
      if (collided > 0) {
        parts.push(
          `${collided} skipped — another saved link already has the cleaned URL.`
        );
      }
      message = parts.join(' ');
    } finally {
      strippingExisting = false;
    }
  }

  async function saveStripMode() {
    await saveUserSettings({ strip_query_params: stripMode, strip_whitelist: whitelist });
    message = 'Link handling saved.';
  }

  async function saveAutoTitle() {
    await saveUserSettings({ auto_title: autoTitle });
    message = 'Link handling saved.';
  }

  async function saveTagSort() {
    await saveUserSettings({ capture_tag_sort: captureTagSort });
    message = 'Link handling saved.';
  }

  async function saveDefaultWeek() {
    if (defaultWeekMode === 'none') {
      await saveUserSettings({ default_week: 'none', default_week_offset: 0 });
    } else if (defaultWeekMode === 'current') {
      await saveUserSettings({ default_week: 'current', default_week_offset: 0 });
    } else {
      const n = Math.min(12, Math.max(1, Math.round(defaultWeekOffset) || 1));
      defaultWeekOffset = n;
      await saveUserSettings({ default_week: 'current', default_week_offset: n });
    }
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
    const result = await syncFresh();
    syncing = false;
    message = result.ok
      ? result.pushed === 0 && result.pulled === 0
        ? 'Sync complete: no changes to push or pull.'
        : `Sync complete: pushed ${result.pushed}, pulled ${result.pulled}.`
      : `Sync failed: ${result.error}`;
    syncStatus = await getSyncStatus();
    await refreshSyncLog();
  }

  // Conflict resolution when a newly configured server AND this device both
  // already hold data (see docs/dev/sync.md).
  let conflictOpen = $state(false);
  let resolving = $state(false);

  /**
   * The explicit escape hatch for a decommissioned server: with sync off,
   * background sync stops entirely and the week page closes stale weeks from
   * local data (instead of deferring until a sync that can never succeed).
   */
  function toggleSyncMode(e: Event) {
    const on = (e.currentTarget as HTMLInputElement).checked;
    setSyncMode(on ? 'sync' : 'offline');
    syncEnabled = on;
    message = on
      ? 'Sync enabled — it runs automatically in the background.'
      : 'Sync disabled on this device — everything stays local until you turn it back on.';
  }

  async function saveSyncUrl() {
    const previous = getSyncUrl();
    setSyncUrl(syncUrl);
    syncUrl = getSyncUrl();
    if (syncUrl) setSyncMode('sync'); // configuring a server opts back into syncing
    syncEnabled = getSyncMode() === 'sync';
    message = 'Sync server saved.';
    syncTest = null; // a URL change invalidates the last test result
    conflictOpen = false;
    if (!syncUrl || syncUrl === previous) return;

    // A different server: find out what exists on each side.
    const server = await serverHasData(syncUrl);
    if (server === null) {
      message =
        "Sync server saved — couldn't probe it for existing data (unreachable, or an older backend). The next sync merges normally.";
      return;
    }
    const local = await localHasData();
    if (server && local) {
      conflictOpen = true; // both sides have data — the user decides
      return;
    }
    if (server && !local) {
      // Nothing local yet: adopting the server copy is the default.
      await resolveConflict('replace-local');
      return;
    }
    // Empty server: forget any old server's bookkeeping and push everything.
    await resetLocalSyncState();
    await runSync();
  }

  async function resolveConflict(option: 'replace-local' | 'replace-server' | 'merge') {
    resolving = true;
    try {
      if (option === 'replace-local') {
        if (
          (await localHasData()) &&
          !confirm(
            'Replace ALL local data with the server copy? Local-only rows (like archived links) are cleared too — export a backup first if in doubt.'
          )
        ) {
          return;
        }
        await wipeLocalData();
        const r = await syncFresh();
        if (!r.ok) {
          message = `Sync failed: ${r.error}`;
          return;
        }
        message = `Server data pulled: ${r.pulled.toLocaleString()} rows. Reloading…`;
        location.reload();
        return;
      }
      if (option === 'replace-server') {
        if (
          !confirm(
            "Wipe ALL data on the server and replace it with this device's copy? Any other device syncing to it will pull this dataset."
          )
        ) {
          return;
        }
        await resetServer();
        await resetLocalSyncState();
        const r = await syncFresh();
        message = r.ok
          ? `Server wiped and repopulated: pushed ${r.pushed.toLocaleString()} rows.`
          : `Sync failed: ${r.error}`;
      } else {
        // merge: push all local (server keeps per-row newest), pull all server.
        await resetLocalSyncState();
        const r = await syncFresh();
        message = r.ok
          ? `Merged: pushed ${r.pushed.toLocaleString()}, pulled ${r.pulled.toLocaleString()} rows.`
          : `Sync failed: ${r.error}`;
      }
      conflictOpen = false;
      syncStatus = await getSyncStatus();
      await refreshSyncLog();
    } catch (err) {
      message = `Failed: ${err instanceof Error ? err.message : err}`;
    } finally {
      resolving = false;
    }
  }

  let testing = $state(false);
  let syncTest = $state<{ ok: boolean; message: string } | null>(null);

  // Sync history (local-only log; see services/syncLog.ts).
  let syncEnabled = $state(true);
  let logPrefs = $state<SyncLogPrefs>({ errorTracking: 'all', retentionDays: 30, trackSuccess: false });
  let logStats = $state<SyncLogStats>({ errors: 0, successes: 0, lastSyncedAt: null });
  let logEvents = $state<SyncLogEvent[]>([]);
  let logPage = $state(0);
  const LOG_PAGE_SIZE = 30;
  const logVisible = $derived(logEvents.slice(logPage * LOG_PAGE_SIZE, (logPage + 1) * LOG_PAGE_SIZE));

  async function refreshSyncLog() {
    logStats = getSyncLogStats();
    logEvents = await listSyncEvents();
  }

  async function saveLogPrefs() {
    logPrefs = {
      ...logPrefs,
      retentionDays: Math.max(1, Math.round(logPrefs.retentionDays) || 30),
    };
    saveSyncLogPrefs({ ...logPrefs });
    await pruneSyncLog(); // a shorter retention applies immediately
    await refreshSyncLog();
    message = 'Sync history settings saved.';
  }

  async function clearHistory() {
    if (!confirm('Clear the sync history log? The error/success counters stay.')) return;
    await clearSyncLog();
    await refreshSyncLog();
  }

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
    syncEnabled = getSyncMode() === 'sync';
    logPrefs = getSyncLogPrefs();
    await pruneSyncLog();
    await refreshSyncLog();
    const userSettings = await getUserSettings();
    stripMode = userSettings?.strip_query_params ?? 'off';
    whitelistText = (userSettings?.strip_whitelist ?? []).join('\n');
    autoTitle = userSettings?.auto_title ?? true;
    const dw = userSettings?.default_week ?? 'none';
    const off = userSettings?.default_week_offset ?? 0;
    defaultWeekMode = dw === 'none' ? 'none' : off > 0 ? 'custom' : 'current';
    defaultWeekOffset = off > 0 ? off : 1;
    archiveEnabled = userSettings?.archive_enabled ?? false;
    archiveMonths = userSettings?.archive_after_months ?? 24;
    captureTagSort = userSettings?.capture_tag_sort ?? 'recent';
    void refreshArchiveCounts();
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

  /**
   * Everything past the two volume sliders. Cloned from the defaults so the
   * simple path (open Settings, hit the button) still produces the same
   * friendly demo library it always did; the panel below only matters when
   * you want to stress a specific page.
   */
  let adv = $state(structuredClone(DEFAULT_SEED_OPTIONS));

  const seedOptions = $derived<SeedOptions>({
    linksPerWeek: seedLinksPerWeek,
    weeks: seedWeeks,
    ...adv,
  });

  /** What a run will actually use — clamped, with the derived topic count. */
  const seedResolved = $derived(resolveSeedOptions(seedOptions));

  const seedEstimate = $derived(seedLinksPerWeek * seedWeeks);

  function resetSeedOptions() {
    adv = structuredClone(DEFAULT_SEED_OPTIONS);
  }

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
      const s = await seedDataset(seedOptions, (m) => (message = m));
      message =
        `Demo data loaded: ${s.links.toLocaleString()} links across ${s.weeks} weeks from ` +
        `${s.origins.toLocaleString()} domains · ${s.tags.toLocaleString()} tags ` +
        `(${s.tagAssignments.toLocaleString()} assignments, ${s.tagEdges.toLocaleString()} nested) · ` +
        `${s.topics.toLocaleString()} topics (${s.references.toLocaleString()} references) · ` +
        `${s.notes.toLocaleString()} notes · ${s.excerpts.toLocaleString()} excerpts · ` +
        `${s.favourites.toLocaleString()} favourites · ${s.resources.toLocaleString()} resources · ` +
        `${s.slushed.toLocaleString()} slushed · ${s.reviews.toLocaleString()} reviews` +
        (s.archived > 0 ? ` · ${s.archived.toLocaleString()} archived` : '') +
        '.';
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
      <div style="margin-top: var(--space-3);">
        <button
          class="btn"
          onclick={runStripExisting}
          disabled={strippingExisting || stripMode === 'off'}
          title={stripMode === 'off' ? 'Pick a stripping mode above first.' : undefined}
        >
          {strippingExisting ? 'Stripping…' : 'Run stripping on existing links'}
        </button>
        <p class="muted" style="margin: var(--space-1) 0 0; font-size: var(--font-size-sm);">
          New pastes are cleaned automatically; this applies the setting above
          to every link already saved.
        </p>
      </div>

      <label class="check" style="margin-top: var(--space-4);">
        <input type="checkbox" bind:checked={autoTitle} onchange={saveAutoTitle} />
        Automatically title bare links
      </label>
      <p class="muted" style="margin-top: var(--space-1); font-size: var(--font-size-sm);">
        When a link is pasted without a title, fetch the page and use its
        title (retrying a few times). This applies to every capture box in
        the app. With a sync server the fetch runs on the backend; in
        offline mode titles aren't fetched. Off keeps bare links showing
        their URL.
      </p>

      <div style="margin-top: var(--space-4);">
        <label for="set-default-week">Default reading week for captured links</label>
        <select id="set-default-week" bind:value={defaultWeekMode} onchange={saveDefaultWeek}>
          <option value="none">None — leave unscheduled (backlog only)</option>
          <option value="current">This week — preselect the current week</option>
          <option value="custom">Custom — a set number of weeks ahead</option>
        </select>
      </div>
      {#if defaultWeekMode === 'custom'}
        <div class="week-offset-row">
          <label for="set-week-offset">Weeks ahead</label>
          <input
            id="set-week-offset"
            type="number"
            min="1"
            max="12"
            bind:value={defaultWeekOffset}
            onchange={saveDefaultWeek}
          />
          <span class="muted">(1–12; captured links preselect that week)</span>
        </div>
      {/if}

      <div style="margin-top: var(--space-4);">
        <label for="set-tag-sort">Capture box tag ordering</label>
        <select id="set-tag-sort" bind:value={captureTagSort} onchange={saveTagSort}>
          <option value="recent">Most recently used first</option>
          <option value="alpha">Alphabetical</option>
        </select>
        <p class="muted" style="margin-top: var(--space-1); font-size: var(--font-size-sm);">
          How the tag chips under the capture box are ordered on each page.
          Recently-used keeps the tags you reach for most on the first page;
          alphabetical is easier to scan when you know the name.
        </p>
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
        <label class="check">
          <input type="checkbox" checked={syncEnabled} onchange={toggleSyncMode} />
          Sync enabled on this device
        </label>
        <p class="muted" style="margin: var(--space-1) 0 0; font-size: var(--font-size-sm);">
          Off makes this device fully local-only: no backup, no other devices,
          and the weekly close runs from local data alone. Saving a server URL
          turns it back on.
        </p>
      </div>
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
      {#if conflictOpen}
        <div class="conflict" role="alertdialog" aria-label="Resolve sync data conflict">
          <p>
            <strong>Both this device and that server already have data.</strong>
            Choose how to combine them:
          </p>
          <div class="conflict-option">
            <button class="btn btn-primary" disabled={resolving} onclick={() => resolveConflict('merge')}>
              Merge both
            </button>
            <span class="muted">
              Download the server's data, combine it with what's here (newest
              edit wins per item), and push the result back. Recommended.
            </span>
          </div>
          <div class="conflict-option">
            <button class="btn" disabled={resolving} onclick={() => resolveConflict('replace-local')}>
              Use server data
            </button>
            <span class="muted">Wipe this device and replace everything with the server copy.</span>
          </div>
          <div class="conflict-option">
            <button class="btn btn-danger" disabled={resolving} onclick={() => resolveConflict('replace-server')}>
              Use local data
            </button>
            <span class="muted">Wipe the server and replace everything with this device's copy.</span>
          </div>
        </div>
      {/if}
      <div class="actions">
        <button class="btn" onclick={testSyncServer} disabled={testing}>
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        <button
          class="btn btn-primary"
          onclick={runSync}
          disabled={syncing || !syncEnabled}
          title={syncEnabled ? undefined : 'Sync is disabled on this device.'}
        >
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
      </div>

      {#if syncEnabled}
        <details class="sync-history">
          <summary>Sync history</summary>
          <p class="log-stats">
            <strong>{logStats.errors.toLocaleString()}</strong> error{logStats.errors === 1 ? '' : 's'}
            · <strong>{logStats.successes.toLocaleString()}</strong> successful
            sync{logStats.successes === 1 ? '' : 's'}
            · last synced {logStats.lastSyncedAt ? formatTimestamp(logStats.lastSyncedAt) : 'never'}
          </p>

          <div class="log-options">
            <div>
              <label for="set-log-errors">Track errors</label>
              <select id="set-log-errors" bind:value={logPrefs.errorTracking} onchange={saveLogPrefs}>
                <option value="all">Track all errors</option>
                <option value="explicit">Only explicit errors (ignore offline failures)</option>
                <option value="none">Do not track errors</option>
              </select>
            </div>
            <div class="week-offset-row">
              <label for="set-log-days">Keep history for</label>
              <input
                id="set-log-days"
                type="number"
                min="1"
                bind:value={logPrefs.retentionDays}
                onchange={saveLogPrefs}
              />
              <span class="muted">days</span>
            </div>
            <label class="check">
              <input type="checkbox" bind:checked={logPrefs.trackSuccess} onchange={saveLogPrefs} />
              Track successful syncs too
            </label>
            <p class="muted" style="margin: 0; font-size: var(--font-size-sm);">
              ⚠️ Background sync runs on nearly every page load — logging
              successes grows the history quickly and uses noticeably more
              storage. Errors and the counters above are tracked regardless.
            </p>
          </div>

          {#if logEvents.length === 0}
            <p class="empty-log">No sync events logged yet.</p>
          {:else}
            <ul class="log-list">
              {#each logVisible as evt (evt.id)}
                <li class:err={!evt.ok}>
                  <span class="log-icon">{evt.ok ? '✅' : '⚠️'}</span>
                  <span class="log-time">{formatTimestamp(evt.at)}</span>
                  <span class="log-detail">
                    {#if evt.ok}
                      pushed {evt.pushed} · pulled {evt.pulled}
                    {:else}
                      {evt.error}{evt.offline ? ' (offline)' : ''}
                    {/if}
                  </span>
                </li>
              {/each}
            </ul>
            <Pagination total={logEvents.length} pageSize={LOG_PAGE_SIZE} bind:page={logPage} label="events" />
            <div class="actions" style="margin-top: var(--space-3);">
              <button class="btn" onclick={clearHistory}>Clear history</button>
            </div>
          {/if}
        </details>
      {/if}
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

    <Card title="Archival">
      <p class="muted" style="margin-bottom: var(--space-3);">
        As your library grows, moving old, cold links out of the main view
        keeps everything fast. Archival relocates <strong>slushed links</strong>
        (read, but not favourited or in a topic) older than the age below into
        a separate <strong>Archive</strong> tab — still searchable, and
        reversible. Nothing else is ever touched.
      </p>
      <label class="check">
        <input type="checkbox" bind:checked={archiveEnabled} onchange={saveArchival} />
        Enable archival mode
      </label>
      <div class="week-offset-row" style="margin-top: var(--space-3);">
        <label for="set-archive-months">Archive slushed links older than</label>
        <input
          id="set-archive-months"
          type="number"
          min="1"
          bind:value={archiveMonths}
          onchange={saveArchival}
        />
        <span class="muted">months</span>
      </div>
      <p class="muted" style="margin-top: var(--space-3); font-size: var(--font-size-sm);">
        {archivable.toLocaleString()} link{archivable === 1 ? '' : 's'} currently
        archivable · {archived.toLocaleString()} already archived.
      </p>
      <div class="actions">
        <button class="btn" onclick={runArchiveNow} disabled={archiving || archivable === 0}>
          {archiving ? 'Archiving…' : 'Archive now'}
        </button>
      </div>
    </Card>

    <Card title="Onboarding">
    If you wish to re-do the onboarding experience, or accidentally navigated away, click the link below
      <a class="btn" href="/onboarding">Go back to onboarding</a>
    </Card>

    <Card title="Danger zone">
      <p class="muted" style="margin-bottom: var(--space-3);">
        Load a demo dataset to try the app out (or to feel how it behaves at
        multi-year scale), or wipe everything on this device (exports above
        are your only undo).
      </p>
      <div class="seed-slider">
        <label for="seed-links">Usage weight: {seedLinksPerWeek} links/week</label>
        <input id="seed-links" type="range" min="5" max="500" step="5" bind:value={seedLinksPerWeek} />
      </div>
      <div class="seed-slider">
        <label for="seed-weeks">Duration: {seedWeeks} weeks ({seedYearsLabel})</label>
        <input id="seed-weeks" type="range" min="1" max="1040" step="1" bind:value={seedWeeks} />
      </div>
      <p class="muted" style="margin-bottom: var(--space-3); font-size: var(--font-size-sm);">
        ≈ {seedEstimate.toLocaleString()} links (notes, topics, favourites,
        and resources scale along).
      </p>
      {#if seedEstimate >= 75_000}
      <p class="muted" style="color:var(--color-danger);margin-bottom: var(--space-3); font-size: var(--font-size-sm);">
        This will take some time to seed, and the app may become slow/unresponsive on some pages afterward
      </p>
      {/if}

      <details class="seed-advanced">
        <summary>Advanced — shape the dataset</summary>
        <p class="muted seed-note">
          Everything here defaults to the friendly demo library. Change it to
          stress a specific page: a few hundred tags, a lopsided tag
          distribution, deep nesting, heavy prose. Percentages are exact —
          "12% favourites" means exactly 12% of generated links, not a coin
          flip per link. Where two settings can't both hold (slush needs a
          read link) the physical limit wins and the summary reports what was
          really written.
        </p>

        <fieldset>
          <legend>Origins</legend>
          <div class="field-grid">
            <label>
              Domains to draw from
              <input type="number" min="1" max="5000" bind:value={adv.origins} />
            </label>
          </div>
          <p class="hint">
            Links are spread across the pool Zipf-style, so the first few
            domains dominate the way they do in a real library — which is what
            the stats page's variability metric measures.
          </p>
        </fieldset>

        <fieldset>
          <legend>Lifecycle</legend>
          <div class="field-grid">
            <label>
              Favourites (% of links)
              <input type="number" min="0" max="100" step="0.5" bind:value={adv.favouritePct} />
            </label>
            <label>
              Resources (% of links)
              <input type="number" min="0" max="100" step="0.5" bind:value={adv.resourcePct} />
            </label>
            <label>
              Slushed (% of links)
              <input type="number" min="0" max="100" step="1" bind:value={adv.slushPct} />
            </label>
            <label>
              Reviewed at least once (% of links)
              <input type="number" min="0" max="100" step="1" bind:value={adv.links.reviewedPct} />
            </label>
          </div>
          <label class="check">
            <input type="checkbox" bind:checked={adv.archive.enabled} />
            Archive old slushed links after seeding
          </label>
          {#if adv.archive.enabled}
            <div class="field-grid">
              <label>
                Archive slushed links older than (months)
                <input type="number" min="1" max="600" bind:value={adv.archive.afterMonths} />
              </label>
            </div>
            <p class="hint">
              This also switches archival on in your settings. Archived links
              move to a local-only store, so anything archived here stays on
              this device until a sync reset moves it back.
            </p>
          {/if}
          <p class="hint">
            Only a link you read can be slushed, and never a favourite, so a
            slush request above roughly 75% is capped by what's eligible.
          </p>
        </fieldset>

        <fieldset>
          <legend>Tags</legend>
          <div class="field-grid">
            <label>
              How many tags
              <input type="number" min="0" max="10000" bind:value={adv.tags.count} />
            </label>
            <label>
              Average tags per link
              <input type="number" min="0" max="20" step="0.1" bind:value={adv.tags.tagsPerLink} />
            </label>
            <label>
              Top tags to pin (0–5)
              <input type="number" min="0" max="5" bind:value={adv.tags.topCount} />
            </label>
            <label>
              …accounting for (% of links)
              <input type="number" min="0" max="100" bind:value={adv.tags.topSharePct} />
            </label>
            <label>
              Ceiling for every other tag (% of links)
              <input type="number" min="0" max="100" bind:value={adv.tags.tailMaxSharePct} />
            </label>
            <label>
              With an about section (% of tags)
              <input type="number" min="0" max="100" bind:value={adv.tags.describedPct} />
            </label>
            <label>
              About section: min sentences
              <input
                type="number"
                min="1"
                max="500"
                bind:value={adv.tags.descriptionLength.minSentences}
              />
            </label>
            <label>
              About section: max paragraphs
              <input
                type="number"
                min="1"
                max="100"
                bind:value={adv.tags.descriptionLength.maxParagraphs}
              />
            </label>
          </div>
          <p class="hint">
            "3 tags accounting for 40%" splits that share evenly between the
            top three; the rest share what's left, each capped by the ceiling.
          </p>
        </fieldset>

        <fieldset>
          <legend>Tag nesting</legend>
          <div class="field-grid">
            <label>
              Nesting depth (1 = flat)
              <input type="number" min="1" max="6" bind:value={adv.tags.maxDepth} />
            </label>
            <label>
              Nested under a parent (% of tags)
              <input type="number" min="0" max="100" bind:value={adv.tags.nestedPct} />
            </label>
            <label>
              Average parents per nested tag
              <input type="number" min="1" max="5" step="0.1" bind:value={adv.tags.parentsPerTag} />
            </label>
          </div>
          <p class="hint">
            A tag is only ever nested under an earlier one, so the generated
            graph is acyclic by construction. Above one parent per tag it's a
            DAG rather than a tree — the shape the hierarchy code is built for.
          </p>
        </fieldset>

        <fieldset>
          <legend>Topics</legend>
          <label class="check">
            <input
              type="checkbox"
              checked={adv.topics.count === null}
              onchange={(e) =>
                (adv.topics.count = e.currentTarget.checked ? null : seedResolved.topics.count)}
            />
            Scale topic count with usage ({seedResolved.topics.count.toLocaleString()} for these
            sliders)
          </label>
          <div class="field-grid">
            {#if adv.topics.count !== null}
              <label>
                How many topics
                <input type="number" min="0" max="100000" bind:value={adv.topics.count} />
              </label>
            {/if}
            <label>
              Total references (% of links)
              <input type="number" min="0" max="500" step="0.5" bind:value={adv.topics.referencesPct} />
            </label>
            <label>
              Top topics to pin (0–5)
              <input type="number" min="0" max="5" bind:value={adv.topics.topCount} />
            </label>
            <label>
              …accounting for (% of references)
              <input type="number" min="0" max="100" bind:value={adv.topics.topSharePct} />
            </label>
            <label>
              Fewest references per topic
              <input type="number" min="0" max="100000" bind:value={adv.topics.minRefs} />
            </label>
            <label>
              Most references per topic
              <input type="number" min="0" max="100000" bind:value={adv.topics.maxRefs} />
            </label>
            <label>
              With a body document (% of topics)
              <input type="number" min="0" max="100" bind:value={adv.topics.describedPct} />
            </label>
            <label>
              Body: min sentences
              <input
                type="number"
                min="1"
                max="500"
                bind:value={adv.topics.descriptionLength.minSentences}
              />
            </label>
            <label>
              Body: max paragraphs
              <input
                type="number"
                min="1"
                max="100"
                bind:value={adv.topics.descriptionLength.maxParagraphs}
              />
            </label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Notes &amp; excerpts</legend>
          <div class="field-grid">
            <label>
              Links with a note (%)
              <input type="number" min="0" max="100" bind:value={adv.links.notesPct} />
            </label>
            <label>
              Note: min sentences
              <input
                type="number"
                min="1"
                max="500"
                bind:value={adv.links.notesLength.minSentences}
              />
            </label>
            <label>
              Note: max paragraphs
              <input
                type="number"
                min="1"
                max="100"
                bind:value={adv.links.notesLength.maxParagraphs}
              />
            </label>
            <label>
              Links with an excerpt (%)
              <input type="number" min="0" max="100" bind:value={adv.links.excerptsPct} />
            </label>
            <label>
              Excerpt: min sentences
              <input
                type="number"
                min="1"
                max="500"
                bind:value={adv.links.excerptLength.minSentences}
              />
            </label>
            <label>
              Excerpt: max paragraphs
              <input
                type="number"
                min="1"
                max="100"
                bind:value={adv.links.excerptLength.maxParagraphs}
              />
            </label>
          </div>
        </fieldset>

        <div class="actions">
          <button class="btn" onclick={resetSeedOptions} disabled={seeding}>
            Reset advanced options
          </button>
        </div>
      </details>

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

  .check {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    cursor: pointer;
  }

  .check input {
    width: auto;
    margin: 0;
  }

  .week-offset-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-top: var(--space-2);
  }

  .week-offset-row input {
    width: 5rem;
  }

  .conflict {
    border: 1px solid var(--color-warning);
    background: color-mix(in srgb, var(--color-warning) 10%, transparent);
    border-radius: var(--radius-md);
    padding: var(--space-3);
    margin-bottom: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .conflict p {
    margin: 0;
  }

  .conflict-option {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .conflict-option .btn {
    flex-shrink: 0;
    min-width: 9.5rem;
  }

  .conflict-option .muted {
    font-size: var(--font-size-sm);
  }

  .sync-history {
    margin-top: var(--space-4);
    border-top: 1px solid var(--border-color);
    padding-top: var(--space-3);
  }

  .sync-history summary {
    cursor: pointer;
    font-weight: 600;
    color: var(--text-color);
  }

  .log-stats {
    margin: var(--space-3) 0;
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
  }

  .log-options {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding-bottom: var(--space-3);
    margin-bottom: var(--space-3);
    border-bottom: 1px solid var(--border-color);
  }

  .log-list {
    list-style: none;
    margin: 0;
    padding: 0;
    font-size: var(--font-size-sm);
  }

  .log-list li {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    padding: var(--space-1) 0;
    border-bottom: 1px solid var(--border-color);
  }

  .log-list li:last-child {
    border-bottom: none;
  }

  .log-icon {
    flex-shrink: 0;
  }

  .log-time {
    flex-shrink: 0;
    color: var(--text-muted-color);
    white-space: nowrap;
  }

  .log-detail {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .log-list li.err .log-detail {
    color: var(--color-danger);
  }

  .empty-log {
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
    margin: 0;
  }

  .seed-slider {
    margin-bottom: var(--space-3);
  }

  .seed-slider input[type='range'] {
    width: 100%;
    accent-color: var(--color-primary);
  }

  .seed-advanced {
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    padding: var(--space-2) var(--space-3);
    margin-bottom: var(--space-3);
  }

  .seed-advanced summary {
    cursor: pointer;
    font-weight: 600;
    font-size: var(--font-size-sm);
  }

  .seed-advanced[open] summary {
    margin-bottom: var(--space-3);
  }

  .seed-note {
    font-size: var(--font-size-sm);
    margin-bottom: var(--space-3);
  }

  .seed-advanced fieldset {
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    padding: var(--space-2) var(--space-3) var(--space-3);
    margin: 0 0 var(--space-3);
  }

  .seed-advanced legend {
    font-weight: 600;
    font-size: var(--font-size-sm);
    padding: 0 var(--space-2);
  }

  .field-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
    gap: var(--space-2) var(--space-3);
  }

  .field-grid label {
    display: flex;
    flex-direction: column;
    gap: var(--space-1, 0.25rem);
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
  }

  .field-grid input {
    margin: 0;
  }

  .seed-advanced .hint {
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
    margin: var(--space-2) 0 0;
  }

  .seed-advanced .check {
    margin-bottom: var(--space-2);
  }
</style>
