<script lang="ts">
  /**
   * EXPERIMENT (see experiments.md #1, mounted only on /dsl-auto-complete):
   * a capture textarea with autocomplete for the per-line !options DSL.
   *
   *   - typing `!t` suggests commands (`!tags=[]`, `!topics=[]`, …)
   *   - typing inside `!tags=[r` suggests matching existing tag names
   *     (topics likewise), inserted with commas escaped
   *
   * Completely separate from CaptureBox — deleting this file and its page
   * removes the experiment. It reuses only pure services (the DSL parser,
   * captureLinks) so behavior matches the real capture box exactly.
   */
  import { onMount, tick } from 'svelte';
  import { all } from '../../lib/db/repo';
  import { captureLinks, parseUrls } from '../../lib/services/capture';
  import type { Link, Tag, Topic } from '../../lib/db/types';

  let text = $state('');
  let caret = $state(0);
  let el = $state<HTMLTextAreaElement | null>(null);
  let tagNames = $state<string[]>([]);
  let topicNames = $state<string[]>([]);
  let selectedIndex = $state(0);
  let report = $state('');
  let busy = $state(false);

  onMount(async () => {
    const [tags, topics] = await Promise.all([all<Tag>('tags'), all<Topic>('topics')]);
    tagNames = tags.map((t) => t.name).sort((a, b) => a.localeCompare(b));
    topicNames = topics.map((t) => t.name).sort((a, b) => a.localeCompare(b));
  });

  /** Command menu: canonical insertion per DSL command. */
  const COMMAND_SUGGESTIONS = [
    { full: 'tags', insert: '!tags=[]', caretOffset: -1, hint: 'comma-separated names, or false' },
    { full: 'topics', insert: '!topics=[]', caretOffset: -1, hint: 'comma-separated names, or false' },
    { full: 'favourite', insert: '!favourite', caretOffset: 0, hint: 'bare = true; =false to clear' },
    { full: 'done', insert: '!done', caretOffset: 0, hint: 'mark read on capture' },
    { full: 'resources', insert: '!resource', caretOffset: 0, hint: 'flag as a resource' },
    { full: 'clean', insert: '!clean=false', caretOffset: 0, hint: 'keep the URL exactly as pasted' },
    { full: 'weeks', insert: '!week=', caretOffset: 0, hint: '0 = this week, 1 = next…, false = none' },
  ];

  interface Suggestion {
    label: string;
    hint: string;
    insert: string;
    /** Where the replaced region starts (replacement runs to the caret). */
    start: number;
    /** Caret lands at start + insert.length + this (e.g. -1 = inside []). */
    caretOffset: number;
  }

  /** What the text just before the caret is asking for, if anything. */
  const context = $derived.by(() => {
    const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
    const before = text.slice(lineStart, caret);
    // Inside an unclosed !tags=[ / !topics=[ value?
    const value = before.match(/(?:^|\s)!([A-Za-z]+)=\[((?:\\.|[^\]])*)$/);
    if (value) {
      const w = value[1].toLowerCase();
      const cmd =
        w.startsWith('ta') && 'tags'.startsWith(w) ? 'tags'
        : w.startsWith('to') && 'topics'.startsWith(w) ? 'topics'
        : null;
      if (!cmd) return null;
      // The partial item = everything after the last unescaped comma.
      const partial = value[2].split(/(?<!\\),/).pop() ?? '';
      const trimmed = partial.trimStart();
      return { kind: 'value' as const, cmd, partial: trimmed, start: caret - trimmed.length };
    }
    // A bare/partial !command token?
    const cmd = before.match(/(?:^|\s)(![A-Za-z]*)$/);
    if (cmd) {
      return { kind: 'command' as const, prefix: cmd[1].slice(1), start: caret - cmd[1].length };
    }
    return null;
  });

  const suggestions = $derived.by((): Suggestion[] => {
    const ctx = context;
    if (!ctx) return [];
    if (ctx.kind === 'command') {
      const p = ctx.prefix.toLowerCase();
      return COMMAND_SUGGESTIONS.filter((c) => c.full.startsWith(p)).map((c) => ({
        label: c.insert,
        hint: c.hint,
        insert: c.insert,
        start: ctx.start,
        caretOffset: c.caretOffset,
      }));
    }
    const names = ctx.cmd === 'tags' ? tagNames : topicNames;
    const q = ctx.partial.toLowerCase();
    const starts = names.filter((n) => n.toLowerCase().startsWith(q));
    const contains = q ? names.filter((n) => !n.toLowerCase().startsWith(q) && n.toLowerCase().includes(q)) : [];
    return [...starts, ...contains].slice(0, 8).map((name) => ({
      label: name,
      hint: ctx.cmd === 'tags' ? 'existing tag' : 'existing topic',
      insert: name.replace(/,/g, '\\,'),
      start: ctx.start,
      caretOffset: 0,
    }));
  });

  // New suggestion list → highlight its first entry.
  $effect(() => {
    void suggestions;
    selectedIndex = 0;
  });

  function syncCaret() {
    if (el) caret = el.selectionStart ?? 0;
  }

  async function accept(s: Suggestion) {
    text = text.slice(0, s.start) + s.insert + text.slice(caret);
    const target = s.start + s.insert.length + s.caretOffset;
    // Wait for the binding to write the new value into the DOM — setting
    // the selection any earlier gets clobbered back to the end.
    await tick();
    el?.focus();
    el?.setSelectionRange(target, target);
    caret = target;
  }

  function onKeydown(e: KeyboardEvent) {
    if (suggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIndex = (selectedIndex + 1) % suggestions.length;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIndex = (selectedIndex - 1 + suggestions.length) % suggestions.length;
    } else if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault();
      accept(suggestions[selectedIndex]);
    } else if (e.key === 'Escape') {
      // Dismiss by moving the caret out of suggestion range is overkill for
      // an experiment — blanking the tracked caret hides the menu until the
      // next input/click.
      caret = 0;
    }
  }

  /** Live view of what the DSL parser makes of the current text. */
  const preview = $derived(parseUrls(text));

  async function capture() {
    if (!text.trim() || busy) return;
    busy = true;
    try {
      const { added, duplicates, merged, invalid, badOptions } = await captureLinks(text);
      const parts = [`${added.length} added`];
      if (duplicates.length > 0) parts.push(`${duplicates.length} already saved`);
      if (merged.length > 0) parts.push(`${merged.length} existing updated`);
      if (invalid.length > 0) parts.push(`${invalid.length} not a link`);
      if (badOptions.length > 0) parts.push(`${badOptions.length} options not understood`);
      report = parts.join(' · ');
      text = '';
    } finally {
      busy = false;
    }
  }
</script>

<div class="dslbox">
  <textarea
    bind:this={el}
    bind:value={text}
    rows="5"
    placeholder={'Paste links with !options — try typing !t on a line with a URL\ne.g. https://example.com !ta'}
    oninput={syncCaret}
    onclick={syncCaret}
    onkeyup={syncCaret}
    onkeydown={onKeydown}
  ></textarea>

  {#if suggestions.length > 0}
    <ul class="menu" role="listbox" aria-label="DSL suggestions">
      {#each suggestions as s, i (s.label)}
        <li>
          <button
            type="button"
            role="option"
            aria-selected={i === selectedIndex}
            class:active={i === selectedIndex}
            onmousedown={(e) => {
              e.preventDefault(); // keep textarea focus
              accept(s);
            }}
          >
            <code>{s.label}</code>
            <span class="hint">{s.hint}</span>
          </button>
        </li>
      {/each}
    </ul>
    <p class="keys">
      <kbd>↑</kbd><kbd>↓</kbd> choose · <kbd>Tab</kbd>/<kbd>Enter</kbd> accept · <kbd>Esc</kbd> dismiss
    </p>
  {/if}

  <div class="actions">
    <button class="btn btn-primary" onclick={capture} disabled={busy || !text.trim()}>
      {busy ? 'Adding…' : 'Add Link(s)'}
    </button>
  </div>
  {#if report}
    <p class="report">{report}</p>
  {/if}

  <div class="preview">
    <span class="preview-label">Parse preview</span>
    {#if preview.entries.length === 0 && preview.invalid.length === 0}
      <p class="muted">Nothing to parse yet.</p>
    {:else}
      <ul>
        {#each preview.entries as entry (entry.url)}
          <li>
            <code>{entry.url}</code>
            {#if entry.title}<span class="muted">“{entry.title}”</span>{/if}
            {#if Object.keys(entry.opts).length > 0}
              <code class="opts">{JSON.stringify(entry.opts)}</code>
            {/if}
          </li>
        {/each}
        {#each preview.invalid as line (line)}
          <li class="bad">not a link: <code>{line}</code></li>
        {/each}
      </ul>
      {#if preview.badOptions.length > 0}
        <p class="bad">Options not understood: <code>{preview.badOptions.join(' ')}</code></p>
      {/if}
    {/if}
  </div>
</div>

<style>
  .dslbox {
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

  .menu {
    list-style: none;
    margin: 0;
    padding: var(--space-1);
    border: 1px solid var(--color-primary);
    border-radius: var(--radius-md);
    background: var(--surface-raised-color);
    box-shadow: var(--shadow-2);
    max-width: 28rem;
  }

  .menu button {
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

  .menu button.active,
  .menu button:hover {
    background: var(--color-primary-soft);
  }

  .menu .hint {
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
    white-space: nowrap;
  }

  .keys {
    margin: 0;
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
  }

  .report {
    margin: 0;
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
    text-align: right;
  }

  .preview {
    border-top: 1px solid var(--border-color);
    padding-top: var(--space-2);
  }

  .preview-label {
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-muted-color);
  }

  .preview ul {
    list-style: none;
    margin: var(--space-1) 0 0;
    padding: 0;
    font-size: var(--font-size-sm);
  }

  .preview li {
    padding: var(--space-1) 0;
    overflow-wrap: anywhere;
  }

  .preview .opts {
    color: var(--color-primary-strong);
    margin-left: var(--space-2);
  }

  .muted {
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
  }

  .bad {
    color: var(--color-danger);
    font-size: var(--font-size-sm);
  }
</style>
