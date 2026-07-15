<script lang="ts">
  /**
   * Quick-paste capture: the fastest way to dump links into the backlog.
   * One URL per line; adds everything, reports duplicates/invalid lines.
   * Optional tag/topic chips apply to every link in the paste and reset
   * after each add (so a stale selection can't mislabel the next dump).
   */
  import { onMount } from 'svelte';
  import ChipSelect from './ChipSelect.svelte';
  import { all, put, withSyncFields } from '../lib/db/repo';
  import { captureLinks } from '../lib/services/capture';
  import { tagsByRecentUse, topicsByRecentUse } from '../lib/services/links';
  import { getUserSettings } from '../lib/services/settings';
  import { upcomingWeekOptions } from '../lib/services/weeks';
  import type { Link, StripMode, Tag, Topic } from '../lib/db/types';

  let { onAdded }: { onAdded: (links: Link[]) => void } = $props();

  let text = $state('');
  let busy = $state(false);
  let report = $state('');
  let tags = $state<Tag[]>([]);
  let topics = $state<Topic[]>([]);
  let selectedTagIds = $state<string[]>([]);
  let selectedTopicIds = $state<string[]>([]);
  let selectedWeek = $state('');
  let markDone = $state(false);
  let isResource = $state(false);
  let organizeOpen = $state(false);
  // Remembers the default so it can be restored after each capture resets.
  let defaultWeek = $state('');
  // Checkbox mirrors the Settings → Link handling default; the mode used
  // when checked is whatever that default says (falling back to trackers).
  let stripUrls = $state(false);
  let defaultStripMode = $state<StripMode>('trackers');
  let autoTitle = $state(true);
  // Tag chip ordering (Settings → Link handling); topics stay recency-sorted.
  let tagSort = $state<'recent' | 'alpha'>('recent');

  const selectionCount = $derived(
    selectedTagIds.length + selectedTopicIds.length + (selectedWeek ? 1 : 0)
  );

  const weekOptions = upcomingWeekOptions();

  onMount(async () => {
    const settings = await getUserSettings();
    const mode = settings?.strip_query_params ?? 'off';
    stripUrls = mode !== 'off';
    if (mode !== 'off') defaultStripMode = mode;
    autoTitle = settings?.auto_title ?? true;
    tagSort = settings?.capture_tag_sort ?? 'recent';
    // Preselect the configured default week (this week, or N weeks ahead).
    if (settings?.default_week === 'current') {
      const offset = Math.max(0, settings.default_week_offset ?? 0);
      defaultWeek = weekOptions[offset]?.value ?? weekOptions[0]?.value ?? '';
      selectedWeek = defaultWeek;
    }
    await refreshOptions();
  });

  async function refreshOptions() {
    // Most-recently-assigned first, so frequent labels stay on the first
    // page once the lists grow long enough to paginate — unless the user
    // prefers tags alphabetical (Settings → Link handling).
    [tags, topics] = await Promise.all([tagsByRecentUse(), topicsByRecentUse()]);
    if (tagSort === 'alpha') tags = [...tags].sort((a, b) => a.name.localeCompare(b.name));
  }

  async function createTag(name: string): Promise<string> {
    const tag = await put('tags', withSyncFields({ name, notes_md: '' }));
    await refreshOptions();
    return tag.id;
  }

  async function createTopic(name: string): Promise<string> {
    const topic = await put('topics', withSyncFields({ name, body_md: '' }));
    await refreshOptions();
    return topic.id;
  }

  async function add() {
    if (!text.trim() || busy) return;
    busy = true;
    try {
      const { added, duplicates, merged, invalid, badOptions } = await captureLinks(text, {
        tagIds: selectedTagIds,
        topicIds: selectedTopicIds,
        weekStart: selectedWeek || null,
        markDone,
        isResource,
        stripMode: stripUrls ? defaultStripMode : 'off',
        autoTitle,
      });
      const parts = [`${added.length} added`];
      const labels = selectedTagIds.length + selectedTopicIds.length;
      if (labels > 0 && added.length > 0) parts.push(`${labels} label${labels === 1 ? '' : 's'} applied`);
      if (selectedWeek && added.length > 0) parts.push('queued for the week');
      if (isResource && added.length > 0) parts.push('as resources');
      if (markDone && added.length > 0) parts.push('marked done');
      if (duplicates.length > 0) parts.push(`${duplicates.length} already saved`);
      if (merged.length > 0) parts.push(`${merged.length} existing updated`);
      if (invalid.length > 0) parts.push(`${invalid.length} not a link`);
      if (badOptions.length > 0) {
        parts.push(`${badOptions.length} option${badOptions.length === 1 ? '' : 's'} not understood (${badOptions.join(' ')})`);
      }
      report = parts.join(' · ');
      text = '';
      selectedTagIds = [];
      selectedTopicIds = [];
      // Restore the default week rather than clearing (respects the setting).
      selectedWeek = defaultWeek;
      markDone = false;
      isResource = false;
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
    placeholder="Paste links here. One per line. Plain URLs, bullet lists (- url), or [Title](url)"
    rows="3"
    bind:value={text}
    onkeydown={onKeydown}
  ></textarea>
  <span class="helptext"><kbd>Enter</kbd> to add, <kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line</span>
  <span
    class="helptext"
    title={'Per-line options override the selections below for just that line. Commands match by prefix (!ta, !to, !f, !d, !r, !c, !w). !tags=false skips the selected tags; !week=0 is this week, !week=false none; \\, escapes a comma inside a name.'}
  >
    Per-line options: <code>!tags=[a,b]</code> <code>!topics=[x]</code>
    <code>!week=2</code> <code>!favourite</code> <code>!done</code>
    <code>!resource</code> <code>!clean=false</code>
  </span>
  <hr style="margin: 0 auto; border: none; border-top: 1px solid var(--border-color); width:85%;padding: var(--space-2) 0;" />
    <div class="organize">
      <div class="organize-group">
        <span class="organize-label">Tags 
        {#if selectionCount > 0}
          <span class="badge">{selectionCount}</span>
        {/if}
        </span>

        <ChipSelect
          items={tags}
          bind:selected={selectedTagIds}
          createPlaceholder="New tag…"
          pageLabel="tags"
          onCreate={createTag}
        />
      </div>
      <div class="organize-group">
        <span class="organize-label">Topics</span>
        <ChipSelect
          items={topics}
          bind:selected={selectedTopicIds}
          createPlaceholder="New topic…"
          pageLabel="topics"
          onCreate={createTopic}
        />
      </div>
      <div class="organize-group">
        <span class="organize-label">Reading week</span>
        <select class="week-select" bind:value={selectedWeek}>
          <option value="">None (backlog only)</option>
          {#each weekOptions as opt (opt.value)}
            <option value={opt.value}>{opt.label}</option>
          {/each}
        </select>
      </div>
    </div>
  <div class="capture-actions">
    <label
      class="done-check"
      title={defaultStripMode === 'all'
        ? 'Remove the whole query string from pasted URLs (configure in Settings → Link handling).'
        : 'Remove tracking params (utm_*, ref, si, …) from pasted URLs (configure in Settings → Link handling).'}
    >
      <input type="checkbox" bind:checked={stripUrls} />
      Clean URLs
    </label>
    <label class="done-check" title="Fetch page titles for links pasted without one (configure the default in Settings → Link handling).">
      <input type="checkbox" bind:checked={autoTitle} />
      Auto-title
    </label>
    <label class="done-check" title="Flag these as resources (tools, apps, references) rather than articles to read.">
      <input type="checkbox" bind:checked={isResource} />
      Resource
    </label>
    <label class="done-check" title="Already read these? They join this week as done.">
      <input type="checkbox" bind:checked={markDone} />
      Mark as done
    </label>
    <button class="btn btn-primary" onclick={add} disabled={busy || !text.trim()}>
      {busy ? 'Adding…' : 'Add to backlog'}
    </button>
  </div>
  {#if report}
    <div class="report">{report}</div>
  {/if}
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
    text-align:right;
  }

  .done-check {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
    cursor: pointer;
    margin: 0;
  }

  .done-check input {
    width: auto;
    margin: 0;
  }

  .organize-toggle {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    border: none;
    background: none;
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
    font-weight: 600;
    cursor: pointer;
    padding: 0;
  }

  .organize-toggle:hover {
    color: var(--text-color);
  }

  .badge {
    background: var(--color-primary-soft);
    color: var(--color-primary-strong);
    border-radius: var(--radius-full);
    padding: 0 var(--space-2);
    font-size: var(--font-size-sm);
  }

  .organize {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-2) 0;
  }

  .organize-group {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .organize-label {
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
    font-weight: 600;
  }

  .week-select {
    max-width: 16rem;
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    background: var(--surface-color);
    color: var(--text-color);
    font-size: var(--font-size-sm);
  }
  .helptext{
    text-align: right;
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
  }
</style>
