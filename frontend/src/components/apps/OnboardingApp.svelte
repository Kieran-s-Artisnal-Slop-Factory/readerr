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
  import { saveUserSettings } from '../../lib/services/settings';
  import { requestPersistentStorage } from '../../lib/db/persistence';
  import { setSyncUrl, setSyncMode, testConnection } from '../../lib/sync';
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
  let step = $state(0);

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

  onMount(async () => {
    themeChoice = loadThemeConfig().base;
    tags = (await all<Tag>('tags')).sort((a, b) => a.name.localeCompare(b.name));
    // Ask for durable storage up front — cheap, and losing a reading list
    // to browser eviction is the worst first impression.
    void requestPersistentStorage();
  });

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
      </div>
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
        You can attach tags and topics at capture time ("Tags &amp; topics"
        under the box), or later with the <strong>#</strong> button on any
        row. Nothing needs triaging up front; that's what the backlog is for.
      </p>
    </Card>

    <h3 style="margin-bottom: var(--space-3);"><strong>Try adding your first link below!</strong></h3>
    <BacklogApp/>
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
        <strong>Please note, clicking a tag or topic will end the onboarding process</strong>
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
</style>
