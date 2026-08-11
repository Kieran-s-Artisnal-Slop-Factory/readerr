<script lang="ts">
  /**
   * First-launch onboarding. Two paths: "start from scratch" marks
   * onboarding complete immediately, or a guided walkthrough explains each
   * feature and lets you set things up (tags, quota/focus, sync) as you go.
   * Every step is skippable; nothing here is mandatory.
   */
  import { onMount } from 'svelte';
  import Card from '../Card.svelte';
  import { all, put, withSyncFields } from '../../lib/db/repo';
  import { getUserSettings, saveUserSettings } from '../../lib/services/settings';
  import { importData } from '../../lib/db/export';
  import { requestPersistentStorage } from '../../lib/db/persistence';
  import { setSyncUrl, setSyncMode, syncFresh, testConnection } from '../../lib/sync';
  import {
    loadThemeConfig,
    saveThemeConfig,
    THEME_NAMES,
    THEMES,
    type ThemeName,
  } from '../../lib/theme';
  import { href } from '../../lib/paths';
  import type { Tag } from '../../lib/db/types';
    import BacklogApp from './BacklogApp.svelte';
    import TagApp from './TagApp.svelte';
    import TagsApp from './TagsApp.svelte';
    import TopicsApp from './TopicsApp.svelte';
    import FavouritesApp from './FavouritesApp.svelte';
    import PlanApp from './PlanApp.svelte';
    import WeekApp from './WeekApp.svelte';
    import SlushApp from './SlushApp.svelte';
  type Theme = 'system' | 'light' | 'dark';

  // Step 0 is the welcome/choice screen; 1..N are the walkthrough.
  const STEPS = ['Welcome', 'Appearance', 'Capture', 'Organize', 'Weekly flow', 'Plan ahead', 'Sync & backup'];
  // Deep link: /onboarding?page=N opens straight on a walkthrough step. Read
  // synchronously at init — the URL-sync effect below would otherwise strip
  // the param before an async read got to it.
  const initialPage = parseInt(new URLSearchParams(location.search).get('page') ?? '', 10);
  let step = $state(
    Number.isFinite(initialPage) ? Math.max(0, Math.min(STEPS.length - 1, initialPage)) : 0
  );

  // Appearance step — applies live so the choice previews itself.
  let themeChoice = $state<ThemeName>('gruvbox');
  let theme: Theme = $state('system');

  function chooseTheme(e: Event) {
    themeChoice = (e.target as HTMLSelectElement).value as ThemeName;
    saveThemeConfig({ ...loadThemeConfig(), base: themeChoice });
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

  // Organize step
  let tags = $state<Tag[]>([]);
  let newTagName = $state('');

  // Weekly flow step
  let quotaInput = $state('');

  // Sync step
  let syncUrlInput = $state('');
  let syncTestResult = $state('');
  let testing = $state(false);

  // Welcome-page restore path: connect to an existing backend and pull.
  let restoreOpen = $state(false);
  let restoreUrl = $state('');
  let restoring = $state(false);
  let restoreMessage = $state('');
  // Welcome-page import path: load a JSON export/backup file.
  let importMessage = $state('');

  /**
   * Onboard from an exported JSON file (full backups replace, partial
   * exports merge — onboarding starts empty so both amount to "load it").
   */
  async function onImportFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    importMessage = '';
    let envelope: unknown;
    try {
      envelope = JSON.parse(await file.text());
    } catch {
      importMessage = 'Import failed: that file is not valid JSON.';
      input.value = '';
      return;
    }
    try {
      const result = await importData(envelope as Parameters<typeof importData>[0]);
      importMessage = `Imported ${result.rows.toLocaleString()} rows.`;
      const settings = await getUserSettings();
      if (!settings?.onboarding_completed_at) {
        await saveUserSettings({ onboarding_completed_at: new Date().toISOString() });
      }
      location.href = href('/');
    } catch (err) {
      importMessage = `Import failed: ${err instanceof Error ? err.message : err}`;
      input.value = '';
    }
  }

  onMount(async () => {
    themeChoice = loadThemeConfig().base;
    tags = (await all<Tag>('tags')).sort((a, b) => a.name.localeCompare(b.name));
    // Ask for durable storage up front — cheap, and losing a reading list
    // to browser eviction is the worst first impression.
    void requestPersistentStorage();
  });

  // Keep ?page= in the URL so any step can be linked/reloaded directly.
  $effect(() => {
    const url = new URL(location.href);
    if (step === 0) url.searchParams.delete('page');
    else url.searchParams.set('page', String(step));
    history.replaceState(null, '', url);
  });

  /**
   * Onboard against an existing backend: point sync at it, pull everything,
   * and land on the reading list. The pulled settings usually carry their
   * own onboarding stamp; a fresh server-side row gets stamped here so the
   * first-launch gate can't bounce us back.
   */
  async function syncFromServer() {
    if (restoring) return;
    restoring = true;
    restoreMessage = '';
    try {
      const test = await testConnection(restoreUrl);
      if (!test.ok) {
        restoreMessage = test.message;
        return;
      }
      setSyncUrl(restoreUrl);
      setSyncMode('sync');
      // syncFresh: a run that starts AFTER the URL was set — joining an
      // in-flight run would sync against whatever was configured before.
      const result = await syncFresh();
      if (!result.ok) {
        restoreMessage = `Sync failed: ${result.error}`;
        return;
      }
      restoreMessage = `Connected — pulled ${result.pulled.toLocaleString()} rows.`;
      const settings = await getUserSettings();
      if (!settings?.onboarding_completed_at) {
        await saveUserSettings({ onboarding_completed_at: new Date().toISOString() });
      }
      location.href = href('/');
    } finally {
      restoring = false;
    }
  }

  async function finish() {
    // Persist the optional walkthrough choices, then mark complete. A blank
    // quota means "untouched", not "clear it" — matters if onboarding is
    // ever re-run over existing settings.
    const quota = parseInt(quotaInput, 10);
    await saveUserSettings({
      ...(Number.isFinite(quota) && quota > 0 ? { articles_per_week: quota } : {}),
      onboarding_completed_at: new Date().toISOString(),
    });
    if (syncUrlInput.trim()) {
      setSyncUrl(syncUrlInput);
      setSyncMode('sync');
    }
    location.href = href('/');
  }

  async function startFromScratch() {
    await saveUserSettings({ onboarding_completed_at: new Date().toISOString() });
    location.href = href('/');
  }

  async function addTag() {
    const name = newTagName.trim();
    if (!name || tags.some((t) => t.name.toLowerCase() === name.toLowerCase())) return;
    await put('tags', withSyncFields({ name, notes_md: '' }));
    tags = (await all<Tag>('tags')).sort((a, b) => a.name.localeCompare(b.name));
    newTagName = '';
  }

  async function runTest() {
    testing = true;
    const result = await testConnection(syncUrlInput);
    syncTestResult = result.message;
    testing = false;
  }
</script>

<div class="onboarding">
  {#if step > 0}
    <div class="progress" aria-label="Onboarding progress">
      {#each STEPS.slice(1) as label, i}
        <span class="dot" class:done={i + 1 < step} class:current={i + 1 === step} title={label}></span>
      {/each}
    </div>
  {/if}

  {#if step === 0}
    <Card title="Welcome to Readerr">
      <p>
        Readerr is a <strong>local-first</strong> reading list and notes
        manager: everything lives in this browser, works fully offline, and
        is yours to export as plain markdown at any time.
      </p>
      <p class="muted">
        Dump links in fast, read them on your schedule, and keep what you
        learned — notes and quotes per link, or long-form documents per topic.
      </p>
      <div class="choice">
        <button class="btn btn-primary" onclick={() => (step = 1)}>Show me around</button>
        <button class="btn" onclick={startFromScratch}>Start from scratch</button>
        <button class="btn" aria-expanded={restoreOpen} onclick={() => (restoreOpen = !restoreOpen)}>
          Sync from existing server
        </button>
        <label class="btn" style="margin-bottom: 0;">
          Import a backup file
          <input type="file" accept="application/json" onchange={onImportFile} hidden />
        </label>
        <p class="muted">
        <small>You can come back from settings page later</small>
      </p>
      </div>
      {#if importMessage}
        <p class="muted restore-msg">{importMessage}</p>
      {/if}
      {#if restoreOpen}
        <div class="restore">
          <p class="muted">
            Already running a readerr backend? Point this device at it and
            everything syncs down — links, notes, settings, the lot.
          </p>
          <div class="restore-row">
            <input
              type="text"
              placeholder="e.g. http://192.168.1.10:8080"
              bind:value={restoreUrl}
              onkeydown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void syncFromServer();
                }
              }}
            />
            <button
              class="btn btn-primary"
              onclick={syncFromServer}
              disabled={restoring || !restoreUrl.trim()}
            >
              {restoring ? 'Syncing…' : 'Connect & sync'}
            </button>
          </div>
          {#if restoreMessage}
            <p class="muted restore-msg">{restoreMessage}</p>
          {/if}
        </div>
      {/if}
    </Card>
  {:else if step === 1}
    <Card title="Appearance">
      <p>
        Pick a look — it applies immediately, follows your OS light/dark
        setting, and every colour is customizable later in Settings
        (including sharing themes as JSON).
      </p>
      <div style="margin-bottom: var(--space-3);">
        <label for="set-theme">Dark/Light</label>
        <select id="set-theme" bind:value={theme} onchange={applyTheme}>
          <option value="system">System (follow OS setting)</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </div>
      <div class="theme-row">
        <label for="ob-theme">Theme</label>
        <select id="ob-theme" value={themeChoice} onchange={chooseTheme}>
          {#each THEME_NAMES as name (name)}
            <option value={name}>{THEMES[name].label}</option>
          {/each}
        </select>
      </div>
      <p class="muted theme-desc">{THEMES[themeChoice].description}</p>
    </Card>
  {:else if step === 2}
    <Card title="The backlog">
      <p>
        The <strong>Backlog</strong> is where new links land. Paste links one at a time, or batch paste many URLs (one per
        line <kbd>shift</kbd>+<kbd>enter</kbd> for a new line)
      </p>
      <p><strong>Accepted Formats</strong></p>
      <pre class="muted">
  https://kieranwood.ca
  - https://kieranwood.ca
  [Kieran's site](https://kieranwood.ca)
  - [Kieran's site](https://kieranwood.ca)
      </pre>

      <p class="muted">
        You can attach tags and topics at capture time, or later with the <strong>#</strong> button on any
        row. Nothing needs triaging up front; that's what the backlog is for.
      </p>
    </Card>

    <h3 style="margin-bottom: var(--space-3);"><strong>Try adding your first link below!</strong></h3>
    <BacklogApp/>
    <Card title="Per-link Batch Changes">
    <p><strong>This part is more advanced, so feel free to skip it</strong><br><br>On top of being able to batch-add links, you can also specify changes for single links directly inline! The format is:</p>
    <code>&lt;link&gt; !&lt;setting&gt;=&lt;value&gt; !&lt;setting&gt;=&lt;value&gt;</code>

    <p><br>For example, let's say I have 2 links I want to add, I want them both to have <code>tag1</code>, but I want to add 1 of them to my favourites and I also want to give it <code>tag2</code>. I can set my normal capture settings, including <button
        type="button"
        class="chip selected"
      >
        tag1
      </button> 
      but then when entering the URL's I can put:</p>
      <code>
<pre>
[Link 1 (just defaults)](https://kieranwood.ca)
[Link 2 (with overrides)](https://kieranwood.ca) !tags=[tag2] !favourite
</pre>
      </code>
    <p>There are many overrides available, below are details:</p>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <td>Setting</td>
            <td>Description</td>
            <td>Values</td>
            <td>Example</td>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>ta(gs)</td>
            <td>Which tags to assign. Use \ to escape commas (e.g. <code>tag\, with comma</code>)</td>
            <td>array (comma delimited), or false to exclude all tags</td>
            <td><code>!ta=[tag1, tag\, with comma]</code></td>
          </tr>

          <tr>
            <td>to(pics)</td>
            <td>Which topics to assign. Use \ to escape commas (e.g. <code>topic\, with comma</code>)</td>
            <td>array (comma delimited), or false to exclude all tags</td>
            <td><code>!to=[topic 1, topic\, with comma]</code></td>
          </tr>
          <tr>
            <td>f(avorite)</td>
            <td>Add the link to favourites</td>
            <td>true(implicit), false</td>
            <td><code>!f</code></td>
          </tr>
          <tr>
            <td>d(one)</td>
            <td>Set the link to done</td>
            <td>true(implicit), false</td>
            <td><code>!d</code></td>
          </tr>
          <tr>
            <td>r(esources)</td>
            <td>Set the link to be a resource</td>
            <td>true(implicit), false</td>
            <td><code>!r=false</code></td>
          </tr>
          <tr>
            <td>c(lean)</td>
            <td>Whether to apply the cleaning set in the settings</td>
            <td>true(implicit), false</td>
            <td><code>!c</code></td>
          </tr>
          <tr>
            <td>w(eeks)</td>
            <td>The number of weeks from now to schedule the link for</td>
            <td>0(current week) to 52, or false for just backlog</td>
            <td><code>!weeks=0</code></td>
          </tr>

        </tbody>
    </table>
    </div>

    <div class="muted"><strong>Notes:</strong>
    <ul>
      <li>Can use the full name, or abbreviation when using (e.g. <code>!w=false</code> is the same as <code>!weeks=false</code>)</li>
      <li>boolean values have multiple options. <code>true</code>, <code>yes</code>, and <code>1</code> are all equivalent, as are <code>false</code>, <code>no</code>, and <code>0</code></li>
    </ul>
    </div>
        
    </Card>
  {:else if step === 3}
    <Card title="Organize — tags, topics, flags">
      <p>
        <strong>Tags</strong> group links loosely (each tag page holds its own
        notes). <br><strong>Topics</strong> are long-form documents that reference
        links — the place where real writing happens.
        <br><strong>★ Favourite</strong> marks the good stuff and
        <br><strong>⚒ Resource</strong> marks tools and references that aren't
        really "read".
      </p>
      <br>
      <p style="font-size: var(--font-size-md); color: var(--color-danger);">
        <strong>Please note, clicking a tag or topic link after creating it will end the onboarding process, you can re-navigate to it from the settings</strong>
      </p>
    </Card>

    <TagsApp/>
    <TopicsApp/>
    <FavouritesApp/>
  {:else if step === 4}
    <Card title="Reading List">
      <p>
        Organization is based around moving links into weekly blocks.
        <br>The <strong>Reading List</strong> is home — your reading for the current week. Pick links from the backlog, read them, and close the week when done. Use <strong>← Previous</strong> / <strong>Next →</strong> to look at other weeks.
      </p>
    </Card>
    <WeekApp/>
    <Card title="Closing a week">
        On close, read links you favourited or wrote about stay
        <em>read</em>; read links with nothing written about them, that weren't add to any topics are
        archived to <strong>Slush</strong>. 
        <br><br>The system will automatically close the week on monday morning, the first time you open the app. 
        <br><br>You can always unslush any links from the <strong>Slush</strong> tab later, or schedule them to be <em>reviewed</em>, which allows you to revisit them on a scheduled week.
    </Card>
  {:else if step === 5}
    <Card title="Plan ahead">
      <p>
        The <strong>Plan</strong> tab is your automation system. It holds your default quota (how many articles per week) and focus tag (what tag to prioritize).
        <br><br>You can also scheduled plans for upcoming weeks or months that deviate from the defaults.<br><span class="muted"> e.g. "next week
        is compilers, grab 3 articles on them".</span> 
        <br><br>When a planned period arrives, its settings kick in automatically<br>
      </p>
      <div class="muted"> The precedence is:
        <ol>
          <li>Scheduled plan beats a default plan</li>
          <li>a weekly plan beats a monthly plan</li>
          <li>your defaults.</li>
        </ol>
      </div>
    </Card>
    <PlanApp/>
  {:else if step === 6}
    <Card title="Sync & backup">
      <p>
        Readerr is fully functional without any server. If you run the
        companion Go backend (one Docker container), it becomes an optional
        sync target — backing up your data, sharing it across devices, and
        resolving page titles.
      </p>
      <p class="muted">
        Have one running? Enter its URL (skippable — you can set this in
        Settings later). Settings also has JSON backup and export-everything-
        to-markdown, so your writing is never locked in to just your browser.
      </p>
      <div class="sync-row">
        <input type="text" placeholder="e.g. http://192.168.1.10:8080" bind:value={syncUrlInput} />
        <button class="btn" onclick={runTest} disabled={testing || !syncUrlInput.trim()}>
          {testing ? 'Testing…' : 'Test'}
        </button>
      </div>
      {#if syncTestResult}
        <p class="muted test-result">{syncTestResult}</p>
      {/if}
    </Card>
  {/if}

  {#if step > 0}
    <div class="nav-row">
      <button class="btn" onclick={() => (step -= 1)}>Back</button>
      <button class="btn skip" onclick={finish}>Skip the rest</button>
      {#if step < STEPS.length - 1}
        <button class="btn btn-primary" onclick={() => (step += 1)}>Next</button>
      {:else}
        <button class="btn btn-primary" onclick={finish}>Start reading</button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .onboarding {
    max-width: 38rem;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .onboarding p {
    margin: 0 0 var(--space-3);
  }

  .choice {
    display: flex;
    gap: var(--space-2);
    justify-content: flex-end;
    flex-wrap: wrap;
  }

  .restore {
    margin-top: var(--space-3);
    padding-top: var(--space-3);
    border-top: 1px solid var(--border-color);
  }

  .restore-row {
    display: flex;
    gap: var(--space-2);
  }

  .restore-row input {
    flex: 1;
    min-width: 0;
  }

  .restore-msg {
    margin: var(--space-2) 0 0;
    font-size: var(--font-size-sm);
  }

  .progress {
    display: flex;
    gap: var(--space-2);
    justify-content: center;
  }

  .dot {
    width: 0.6rem;
    height: 0.6rem;
    border-radius: var(--radius-full);
    background: var(--border-color);
  }

  .dot.done {
    background: var(--color-primary-soft);
  }

  .dot.current {
    background: var(--color-primary);
  }

  .nav-row {
    display: flex;
    gap: var(--space-2);
    justify-content: flex-end;
  }

  .nav-row .skip {
    margin-right: auto;
    border-style: dashed;
    color: var(--text-muted-color);
  }

  .tag-form,
  .sync-row {
    display: flex;
    gap: var(--space-2);
  }

  .tag-form input,
  .sync-row input {
    flex: 1;
    min-width: 0;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    background: var(--surface-color);
    color: var(--text-color);
  }

  .tag-chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    margin-top: var(--space-2);
  }

  .chip {
    border: 1px solid var(--color-primary);
    background: var(--color-primary-soft);
    color: var(--color-primary-strong);
    border-radius: var(--radius-full);
    padding: 0 var(--space-3);
    font-size: var(--font-size-sm);
    line-height: 1.9;
    font-weight: 600;
  }

  .quota-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .quota-row input {
    width: 10rem;
  }

  .theme-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .theme-row select {
    width: auto;
    min-width: 10rem;
  }

  .theme-desc {
    margin-top: var(--space-2);
  }

  .test-result {
    margin-top: var(--space-2);
  }
    .table-wrap {
      margin-top:var(--space-4);
    overflow-x: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--font-size-sm);
  }

  th,
  td {
    text-align: right;
    padding: var(--space-2) var(--space-4);
    border-bottom: 1px solid var(--border-color);
    white-space: nowrap;
  }

  th:first-child,
  td:first-child {
    padding-left: var(--space-2);
  }

  th:last-child,
  td:last-child {
    padding-right: var(--space-2);
  }

  th.origin,
  td.origin {
    text-align: left;
    max-width: 18rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  th {
    color: var(--text-muted-color);
    font-weight: 600;
  }

  tbody tr:hover {
    background: var(--color-primary-soft);
  }

  tfoot td {
    border-bottom: none;
    font-weight: 700;
  }

    .chip {
    border: 1px solid var(--border-color);
    border-radius: var(--radius-full);
    background: var(--surface-color);
    padding: 0 var(--space-3);
    font-size: var(--font-size-sm);
    line-height: 1.9;
    cursor: pointer;
    color: var(--text-color);
  }

  .chip:hover {
    border-color: var(--color-primary);
  }

  .chip.selected {
    background: var(--color-primary-soft);
    border-color: var(--color-primary);
    color: var(--color-primary-strong);
    font-weight: 600;
  }
</style>
