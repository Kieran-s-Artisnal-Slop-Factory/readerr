<script lang="ts">
  /**
   * Quick-paste capture: the fastest way to dump links into the backlog.
   * One URL per line; adds everything, reports duplicates/invalid lines.
   * Optional tag/topic chips apply to every link in the paste and reset
   * after each add (so a stale selection can't mislabel the next dump).
   */
  import { onMount, tick } from 'svelte';
  import ChipSelect from './ChipSelect.svelte';
  import LinkRow from './LinkRow.svelte';
  import { all, get, put, withSyncFields } from '../lib/db/repo';
  import { captureLinks } from '../lib/services/capture';
  import { dslSuggestions, type DslSuggestion } from '../lib/services/dslSuggest';
  import { tagsByRecentUse, topicsByRecentUse } from '../lib/services/links';
  import { createResourceList, listResourceLists } from '../lib/services/resourceLists';
  import { getUserSettings } from '../lib/services/settings';
  import { upcomingWeekOptions } from '../lib/services/weeks';
  import type { Link, ResourceList, StripMode, Tag, Topic } from '../lib/db/types';

  let {
    onAdded,
    chipPageSize = 50,
    addLabel = 'Add Link(s)',
  }: {
    onAdded: (links: Link[]) => void;
    /** Tag/topic chips per page — compact hosts (the FAB) pass fewer. */
    chipPageSize?: number;
    addLabel?: string;
  } = $props();

  let text = $state('');
  let busy = $state(false);
  let report = $state('');
  let tags = $state<Tag[]>([]);
  let topics = $state<Topic[]>([]);
  let resourceLists = $state<ResourceList[]>([]);
  let selectedTagIds = $state<string[]>([]);
  let selectedTopicIds = $state<string[]>([]);
  let selectedListIds = $state<string[]>([]);
  let selectedWeek = $state('');
  let markDone = $state(false);
  let isResource = $state(false);
  // 3 = the default for unset links, so only 1/2 are passed on explicitly.
  let selectedPriority = $state(3);
  // Remembers the default so it can be restored after each capture resets.
  let defaultWeek = $state('');
  // Checkbox mirrors the Settings → Link handling default; the mode used
  // when checked is whatever that default says (falling back to trackers).
  let stripUrls = $state(false);
  let defaultStripMode = $state<StripMode>('trackers');
  // Tag chip ordering (Settings → Link handling); topics stay recency-sorted.
  let tagSort = $state<'recent' | 'alpha'>('recent');
  // The most recent captures, newest first — so a link is easy to find right
  // after adding it, even when it went to a future week or the backlog.
  let justAdded = $state<Link[]>([]);
  const JUST_ADDED_MAX = 10;

  // DSL autocomplete: !command suggestions and tag/topic name completion,
  // driven by the caret position (see lib/services/dslSuggest.ts).
  let textareaEl = $state<HTMLTextAreaElement | null>(null);
  let caret = $state(0);
  let suggestIndex = $state(0);
  let suggestDismissed = $state(false);

  const suggestions = $derived(
    suggestDismissed
      ? []
      : dslSuggestions(
          text,
          caret,
          tags.map((t) => t.name),
          topics.map((t) => t.name),
          resourceLists.map((l) => l.name)
        )
  );

  // A selected resource list means these ARE resources — the flag follows
  // the chips and the ⚒ toggle locks until the selection clears.
  const listLocked = $derived(selectedListIds.length > 0);
  $effect(() => {
    if (listLocked) isResource = true;
  });

  // A new suggestion list highlights its first entry.
  $effect(() => {
    void suggestions;
    suggestIndex = 0;
  });

  function syncCaret() {
    suggestDismissed = false;
    caret = textareaEl?.selectionStart ?? 0;
  }

  async function acceptSuggestion(s: DslSuggestion) {
    text = text.slice(0, s.start) + s.insert + text.slice(caret);
    const target = s.start + s.insert.length + s.caretOffset;
    // Wait for the binding to write the new value into the DOM — setting
    // the selection any earlier gets clobbered back to the end.
    await tick();
    textareaEl?.focus();
    textareaEl?.setSelectionRange(target, target);
    caret = target;
  }

  const selectionCount = $derived(
    selectedTagIds.length +
      selectedTopicIds.length +
      selectedListIds.length +
      (selectedWeek ? 1 : 0)
  );

  const weekOptions = upcomingWeekOptions();

  onMount(async () => {
    const settings = await getUserSettings();
    const mode = settings?.strip_query_params ?? 'off';
    stripUrls = mode !== 'off';
    if (mode !== 'off') defaultStripMode = mode;
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
    [tags, topics, resourceLists] = await Promise.all([
      tagsByRecentUse(),
      topicsByRecentUse(),
      listResourceLists(),
    ]);
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

  async function createList(name: string): Promise<string> {
    const list = await createResourceList(name);
    await refreshOptions();
    return list.id;
  }

  async function add() {
    if (!text.trim() || busy) return;
    busy = true;
    try {
      // autoTitle deliberately not passed — captureLinks falls back to the
      // Settings → Link handling default (the toggle moved there).
      const { added, duplicates, merged, invalid, badOptions } = await captureLinks(text, {
        tagIds: selectedTagIds,
        topicIds: selectedTopicIds,
        listIds: selectedListIds,
        weekStart: selectedWeek || null,
        markDone,
        isResource,
        stripMode: stripUrls ? defaultStripMode : 'off',
        // 3 means "unset" — only an explicit 1/2 travels, so re-capturing a
        // duplicate at the default never resets its stored priority.
        priority: selectedPriority !== 3 ? selectedPriority : undefined,
      });
      const parts = [`${added.length} added`];
      const labels = selectedTagIds.length + selectedTopicIds.length;
      if (labels > 0 && added.length > 0) parts.push(`${labels} label${labels === 1 ? '' : 's'} applied`);
      if (selectedWeek && added.length > 0) parts.push('queued for the week');
      if (selectedListIds.length > 0 && (added.length > 0 || merged.length > 0)) {
        parts.push(`added to ${selectedListIds.length} list${selectedListIds.length === 1 ? '' : 's'}`);
      }
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
      selectedListIds = [];
      // Restore the default week rather than clearing (respects the setting).
      selectedWeek = defaultWeek;
      markDone = false;
      isResource = false;
      selectedPriority = 3;
      if (added.length > 0 || merged.length > 0) {
        justAdded = [...added, ...merged, ...justAdded.filter(
          (l) => !added.some((a) => a.id === l.id) && !merged.some((m) => m.id === l.id)
        )].slice(0, JUST_ADDED_MAX);
        // Auto-title resolves fire-and-forget in the DB; once it has had a
        // moment, refresh our copies AND re-fire onAdded so the host list
        // re-renders too — otherwise rows sit titled with raw URLs until
        // the next navigation ("auto-title isn't working").
        setTimeout(async () => {
          await refreshJustAdded();
          onAdded([]);
        }, 2500);
      }
      onAdded(added);
    } finally {
      busy = false;
    }
  }

  async function refreshJustAdded() {
    justAdded = await Promise.all(
      justAdded.map(async (l) => (await get<Link>('links', l.id)) ?? l)
    );
  }

  function onKeydown(e: KeyboardEvent) {
    // With the suggestion menu open, the keyboard drives it first.
    if (suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        suggestIndex = (suggestIndex + 1) % suggestions.length;
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        suggestIndex = (suggestIndex - 1 + suggestions.length) % suggestions.length;
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        void acceptSuggestion(suggestions[suggestIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        suggestDismissed = true; // until the next keystroke/click
        return;
      }
    }
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
    bind:this={textareaEl}
    bind:value={text}
    onkeydown={onKeydown}
    oninput={syncCaret}
    onclick={syncCaret}
    onkeyup={syncCaret}
  ></textarea>
  {#if suggestions.length > 0}
    <ul class="dsl-menu" role="listbox" aria-label="DSL suggestions">
      {#each suggestions as s, i (s.label)}
        <li>
          <button
            type="button"
            role="option"
            aria-selected={i === suggestIndex}
            class:active={i === suggestIndex}
            onmousedown={(e) => {
              e.preventDefault(); // keep textarea focus
              void acceptSuggestion(s);
            }}
          >
            <code>{s.label}</code>
            <span class="dsl-hint-text">{s.hint}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
  <span class="helptext"><kbd>Enter</kbd> to add, <kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line</span>
  <span
    class="helptext"
    title={'Per-line options override the selections below for just that line. Commands match by prefix (!ta, !to, !l, !f, !d, !r, !c, !w). !tags=false skips the selected tags; !list=[name] adds to a resource list (created if new) and implies !resource; !week=0 is this week, !week=false none; \\, escapes a comma inside a name.'}
  >
    Per-line options: <code>!tags=[a,b]</code> <code>!topics=[x]</code>
    <code>!list=[y]</code> <code>!week=2</code> <code>!priority=1</code>
    <code>!favourite</code> <code>!done</code> <code>!resource</code>
    <code>!clean=false</code>
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
          pageSize={chipPageSize}
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
          pageSize={chipPageSize}
          onCreate={createTopic}
        />
      </div>
      <div class="organize-group">
        <span class="organize-label">Resource lists</span>
        <ChipSelect
          items={resourceLists}
          bind:selected={selectedListIds}
          createPlaceholder="New list…"
          pageLabel="lists"
          pageSize={chipPageSize}
          onCreate={createList}
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
      <div class="organize-group">
        <span class="organize-label">Priority</span>
        <select
          class="week-select"
          bind:value={selectedPriority}
          title="Lists show priority 1 first; 3 is the default."
        >
          <option value={1}>1 — top</option>
          <option value={2}>2 — soon</option>
          <option value={3}>3 — default</option>
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
      Clean
    </label>
    <button
      type="button"
      class="icon-btn"
      class:active={isResource}
      aria-pressed={isResource}
      disabled={listLocked}
      title={listLocked
        ? 'Links added to a resource list are always resources — clear the list selection to toggle.'
        : 'Flag these as resources (tools, apps, references) rather than articles to read.'}
      onclick={() => {
        if (!listLocked) isResource = !isResource;
      }}
    >
      ⚒
    </button>
    <button
      type="button"
      class="icon-btn"
      class:active={markDone}
      aria-pressed={markDone}
      title="Already read these? They join this week as done."
      onclick={() => (markDone = !markDone)}
    >
      ✓
    </button>
    <button class="btn btn-primary" onclick={add} disabled={busy || !text.trim()}>
      {busy ? 'Adding…' : addLabel}
    </button>
  </div>
  {#if report}
    <div class="report">{report}</div>
  {/if}
  {#if justAdded.length > 0}
    <div class="just-added">
      <span class="organize-label">Just Added</span>
      <div class="just-added-list">
        {#each justAdded as link (link.id)}
          <LinkRow
            {link}
            onChange={(updated) =>
              (justAdded = justAdded.map((l) => (l.id === updated.id ? updated : l)))}
          />
        {/each}
      </div>
    </div>
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

  /* Same flag toggles as LinkRow: ✓ done, ⚒ resource. */
  .icon-btn {
    width: 2rem;
    height: 2rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    background: var(--surface-color);
    color: var(--text-muted-color);
    cursor: pointer;
    font-size: var(--font-size-base);
    flex-shrink: 0;
  }

  .icon-btn:hover {
    border-color: var(--color-primary);
    color: var(--color-primary-strong);
  }

  /* Locked (a resource list is selected): stays lit, reads non-interactive. */
  .icon-btn:disabled {
    cursor: not-allowed;
    opacity: 0.85;
  }

  .icon-btn.active {
    background: var(--color-primary-soft);
    border-color: var(--color-primary);
    color: var(--color-primary-strong);
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

  .dsl-menu {
    list-style: none;
    margin: 0;
    padding: var(--space-1);
    border: 1px solid var(--color-primary);
    border-radius: var(--radius-md);
    background: var(--surface-raised-color);
    box-shadow: var(--shadow-2);
    max-width: 28rem;
  }

  .dsl-menu button {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    width: 100%;
    padding: var(--space-1) var(--space-2);
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text-color);
    cursor: pointer;
    text-align: left;
  }

  .dsl-menu button.active,
  .dsl-menu button:hover {
    background: var(--color-primary-soft);
  }

  .dsl-hint-text {
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
    white-space: nowrap;
  }

  .just-added {
    margin-top: var(--space-2);
    padding-top: var(--space-2);
    border-top: 1px solid var(--border-color);
  }

  .just-added-list {
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    margin-top: var(--space-1);
  }
</style>
