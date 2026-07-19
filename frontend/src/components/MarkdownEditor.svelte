<script lang="ts">
  /**
   * The one markdown editor used everywhere prose is edited (link notes,
   * excerpts, tag notes, topic documents).
   *
   * Markdown is the canonical stored format; this component is just a view
   * over the string. WYSIWYG mode is Milkdown Crepe (ProseMirror + remark —
   * markdown in, markdown out). Source mode is CodeMirror 6 over the exact
   * same string — the bailout for when you want the raw text, since
   * remark-stringify normalizes formatting (list markers, escaping) on
   * round-trip.
   *
   * Changes are debounced (400ms) before onChange fires; parents can treat
   * onChange as "autosave now".
   */
  import { onDestroy, onMount, tick } from 'svelte';
  import { marked } from 'marked';
  import { Crepe } from '@milkdown/crepe';
  import { editorViewCtx } from '@milkdown/kit/core';
  import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
  import CitationMenu from './CitationMenu.svelte';
  import { citationText, type CitationSuggestion } from '../lib/services/citationSuggest';
  import { EditorView, keymap } from '@codemirror/view';
  import { EditorState } from '@codemirror/state';
  import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
  import { markdown } from '@codemirror/lang-markdown';
  import '@milkdown/crepe/theme/common/style.css';
  import '@milkdown/crepe/theme/frame.css';

  let {
    value = '',
    onChange,
    placeholder = 'Write…',
    exportName = 'document',
    onExportMarkdown,
    onExportHtml,
    citationSuggest,
    onCitationAccept,
  }: {
    value?: string;
    onChange: (md: string) => void;
    placeholder?: string;
    /** Basename for the Export MD / Export HTML downloads. */
    exportName?: string;
    /**
     * Replace the toolbar's exports when the document means more than its
     * own text — the topic page swaps both in so its citations resolve
     * against the topic's references instead of exporting as bare `[^1]`.
     */
    onExportMarkdown?: () => void;
    onExportHtml?: () => void;
    /**
     * Enables `[^` link autocomplete. `suggest` is the pure matcher
     * (citationSuggest.ts) over whatever the host knows about; `resolve`
     * turns the accepted entry into the number to insert, which is where
     * the topic page assigns a not-yet-referenced link and issues one.
     */
    citationSuggest?: (text: string, caret: number) => CitationSuggestion[];
    /** Returns the number to insert, or null to insert nothing. */
    onCitationAccept?: (s: CitationSuggestion) => Promise<number | null>;
  } = $props();

  let mode = $state<'wysiwyg' | 'source'>('wysiwyg');
  let root: HTMLDivElement;
  let crepe: Crepe | null = null;
  let cm: EditorView | null = null;
  // The live markdown string; editors are recreated from it on mode switch.
  let current = value;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  function emit(md: string) {
    current = md;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => onChange(md), 400);
  }

  /** Flush a pending debounce immediately (mode switch / unmount). */
  function flush() {
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
      onChange(current);
    }
  }

  // ===== `[^` citation autocomplete =====
  // The menu is shared; only "what is left of the caret", "where is the
  // caret on screen", and "replace this range" differ per editor.

  let suggestions = $state<CitationSuggestion[]>([]);
  let suggestIndex = $state(0);
  let caretXY = $state({ left: 0, top: 0 });
  // Escape closes the menu until the next edit or caret move.
  let suggestDismissed = false;

  /** The ProseMirror view, once Crepe has built it. */
  function proseView(): ProseView | null {
    if (!crepe) return null;
    try {
      return crepe.editor.action((ctx) => ctx.get(editorViewCtx));
    } catch {
      return null; // not created yet, or already destroyed
    }
  }

  /**
   * Text left of the caret and its offset, in the coordinate space the
   * insertion below expects. ProseMirror reports within the current text
   * block (a citation never spans blocks); CodeMirror reports the whole
   * document, since its offsets are absolute.
   */
  function caretContext(): { text: string; caret: number } | null {
    if (mode === 'source') {
      if (!cm) return null;
      const head = cm.state.selection.main.head;
      return { text: cm.state.doc.toString().slice(0, head), caret: head };
    }
    const view = proseView();
    if (!view) return null;
    // Destructuring ProseMirror's `$from` by name is a Svelte compile
    // error — the `$` prefix is reserved for stores/runes.
    const selection = view.state.selection;
    const head = selection.$from;
    if (!selection.empty || !head.parent.isTextblock) return null;
    const offset = head.parentOffset;
    return { text: head.parent.textBetween(0, offset, '\n', '￼'), caret: offset };
  }

  function caretCoords(): { left: number; top: number } | null {
    if (mode === 'source') {
      const box = cm?.coordsAtPos(cm.state.selection.main.head);
      return box ? { left: box.left, top: box.bottom + 4 } : null;
    }
    const view = proseView();
    if (!view) return null;
    const box = view.coordsAtPos(view.state.selection.from);
    return { left: box.left, top: box.bottom + 4 };
  }

  /** Recompute the menu from the caret. Cheap; runs on every key/click. */
  function syncCitations() {
    if (!citationSuggest) return;
    const ctx = suggestDismissed ? null : caretContext();
    const next = ctx ? citationSuggest(ctx.text, ctx.caret) : [];
    if (next.length > 0) {
      const xy = caretCoords();
      if (xy) caretXY = xy;
    }
    // A changed list highlights its first entry again.
    if (next.length !== suggestions.length || next[0]?.link.id !== suggestions[0]?.link.id) {
      suggestIndex = 0;
    }
    suggestions = next;
  }

  function closeCitations(dismiss = false) {
    suggestDismissed = dismiss;
    suggestions = [];
  }

  async function acceptCitation(s: CitationSuggestion) {
    const ctx = caretContext();
    if (!ctx || !onCitationAccept) return closeCitations();
    // Assigning a new link is async; the caret can't move meanwhile
    // (mousedown is prevented, Enter is consumed), but the menu goes first
    // so a slow assign can't leave it hanging over the text.
    closeCitations();
    const number = await onCitationAccept(s);
    if (number === null) return; // assigning failed — leave the text alone
    const text = citationText(number);

    if (mode === 'source') {
      if (!cm) return;
      const at = s.start + text.length;
      cm.dispatch({
        changes: { from: s.start, to: ctx.caret, insert: text },
        selection: { anchor: at },
      });
      cm.focus();
      return;
    }

    const view = proseView();
    if (!view) return;
    const head = view.state.selection.$from;
    const from = head.pos - (ctx.caret - s.start);
    view.dispatch(view.state.tr.insertText(text, from, head.pos));
    view.focus();
  }

  /**
   * Arrow/Enter/Tab/Escape belong to the menu while it is open, and both
   * editors would otherwise swallow them (a newline, a list indent). The
   * listener sits on the shared root in the CAPTURE phase so it wins
   * without either editor needing to know the menu exists.
   */
  function onRootKeydown(e: KeyboardEvent) {
    if (suggestions.length === 0) {
      // Any other key may have created a trigger — re-check after it lands.
      if (e.key === 'Escape') suggestDismissed = false;
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      suggestIndex = (suggestIndex + 1) % suggestions.length;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      suggestIndex = (suggestIndex - 1 + suggestions.length) % suggestions.length;
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      void acceptCitation(suggestions[suggestIndex]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeCitations(true);
    }
  }

  function onRootActivity() {
    suggestDismissed = false;
    // Let the editor apply the keystroke before reading the caret back.
    void tick().then(syncCitations);
  }

  function attachCitations() {
    if (!citationSuggest) return;
    root.addEventListener('keydown', onRootKeydown, true);
    root.addEventListener('keyup', onRootActivity);
    root.addEventListener('click', onRootActivity);
  }

  function detachCitations() {
    root?.removeEventListener('keydown', onRootKeydown, true);
    root?.removeEventListener('keyup', onRootActivity);
    root?.removeEventListener('click', onRootActivity);
    suggestions = [];
  }

  async function mountCrepe() {
    crepe = new Crepe({
      root,
      defaultValue: current,
      featureConfigs: {
        [Crepe.Feature.Placeholder]: { text: placeholder },
      },
    });
    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, md) => emit(md));
    });
    await crepe.create();
  }

  function mountCodeMirror() {
    cm = new EditorView({
      parent: root,
      state: EditorState.create({
        doc: current,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown(),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) emit(update.state.doc.toString());
          }),
        ],
      }),
    });
  }

  async function destroyEditor() {
    flush();
    if (crepe) {
      await crepe.destroy();
      crepe = null;
    }
    if (cm) {
      cm.destroy();
      cm = null;
    }
    root.innerHTML = '';
  }

  async function setMode(next: 'wysiwyg' | 'source') {
    if (mode === next) return;
    closeCitations();
    await destroyEditor();
    mode = next;
    if (next === 'wysiwyg') await mountCrepe();
    else mountCodeMirror();
  }

  function download(content: string, extension: string, type: string) {
    const safe = exportName.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'document';
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safe}.${extension}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportMarkdown() {
    download(current, 'md', 'text/markdown');
  }

  function exportHtml() {
    const body = marked.parse(current, { async: false });
    const html = [
      '<!doctype html>',
      '<html lang="en">',
      '<head>',
      '<meta charset="utf-8">',
      `<title>${exportName.replace(/</g, '&lt;')}</title>`,
      '</head>',
      '<body>',
      body,
      '</body>',
      '</html>',
    ].join('\n');
    download(html, 'html', 'text/html');
  }

  // Save the moment focus leaves the editor (clicking a link, a toolbar
  // button, etc.) and when the page is being hidden/unloaded. An MPA
  // navigation doesn't reliably run onDestroy, so without this a note typed
  // within the last 400ms (the debounce window) would be lost on navigation.
  function flushNow() {
    flush();
  }

  onMount(() => {
    void mountCrepe();
    // The listeners live on the root, which outlives both editors, so mode
    // switches don't need to re-attach them.
    attachCitations();
    window.addEventListener('pagehide', flushNow);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushNow();
    });
  });

  onDestroy(() => {
    window.removeEventListener('pagehide', flushNow);
    detachCitations();
    void destroyEditor();
  });
</script>

<div class="editor" onfocusout={flushNow}>
  <div class="editor-toolbar">
    <button
      type="button"
      class="export"
      title="Download as markdown"
      onclick={() => (onExportMarkdown ?? exportMarkdown)()}
    >
      ↓ MD
    </button>
    <button
      type="button"
      class="export"
      title="Download as HTML"
      onclick={() => (onExportHtml ?? exportHtml)()}
    >
      ↓ HTML
    </button>
    <span class="divider"></span>
    <button
      type="button"
      class:active={mode === 'wysiwyg'}
      onclick={() => setMode('wysiwyg')}
    >
      Edit
    </button>
    <button
      type="button"
      class:active={mode === 'source'}
      title="Raw markdown"
      onclick={() => setMode('source')}
    >
      Source
    </button>
  </div>
  <div class="editor-root" class:source={mode === 'source'} bind:this={root}></div>
</div>
{#if suggestions.length > 0}
  <CitationMenu
    {suggestions}
    index={suggestIndex}
    left={caretXY.left}
    top={caretXY.top}
    onAccept={acceptCitation}
  />
{/if}

<style>
  .editor {
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    background: var(--surface-color);
    overflow: hidden;
  }

  .editor-toolbar {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-1);
    padding: var(--space-1) var(--space-2);
    border-bottom: 1px solid var(--border-color);
  }

  .editor-toolbar button {
    border: none;
    background: none;
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
    font-weight: 600;
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-md);
    cursor: pointer;
  }

  .editor-toolbar button:hover {
    color: var(--text-color);
  }

  .editor-toolbar button.active {
    background: var(--color-primary-soft);
    color: var(--color-primary-strong);
  }

  .divider {
    width: 1px;
    align-self: stretch;
    margin: var(--space-1) var(--space-1);
    background: var(--border-color);
  }

  .editor-root {
    min-height: 8rem;
  }

  /* Crepe brings its own padding; give CodeMirror matching breathing room. */
  .editor-root.source :global(.cm-editor) {
    min-height: 8rem;
    font-size: var(--font-size-base);
  }

  .editor-root.source :global(.cm-content) {
    padding: var(--space-3);
    font-family: var(--font-mono, ui-monospace, monospace);
  }

  .editor-root.source :global(.cm-editor.cm-focused) {
    outline: none;
  }

  /*
   * Map Crepe's design tokens onto the app theme so the editor follows
   * whatever theme (built-in or customized) is active — frame.css ships
   * fixed light-palette values that go unreadable on dark themes.
   */
  .editor-root :global(.milkdown) {
    background: transparent;
    color: var(--text-color);
    --crepe-color-background: transparent;
    --crepe-color-on-background: var(--text-color);
    --crepe-color-surface: var(--surface-color);
    --crepe-color-surface-low: var(--bg-color);
    --crepe-color-on-surface: var(--text-color);
    --crepe-color-on-surface-variant: var(--text-muted-color);
    --crepe-color-outline: var(--border-color);
    --crepe-color-primary: var(--color-primary);
    --crepe-color-secondary: var(--color-primary-soft);
    --crepe-color-on-secondary: var(--color-primary-strong);
    --crepe-color-inverse: var(--text-color);
    --crepe-color-on-inverse: var(--bg-color);
    --crepe-color-inline-code: var(--color-danger);
    --crepe-color-error: var(--color-danger);
    --crepe-color-hover: var(--surface-raised-color);
    --crepe-color-selected: var(--color-primary-soft);
    --crepe-color-inline-area: var(--bg-color);
    --crepe-font-title: var(--font-body);
    --crepe-font-default: var(--font-body);
  }

  /* The source view should follow the theme too (CM defaults are light). */
  .editor-root.source :global(.cm-editor) {
    background: transparent;
    color: var(--text-color);
  }

  .editor-root.source :global(.cm-cursor) {
    border-left-color: var(--text-color);
  }

  .editor-root.source :global(.cm-activeLine) {
    background: transparent;
  }

  .editor-root.source :global(.cm-selectionBackground),
  .editor-root.source :global(.cm-editor ::selection) {
    background: var(--color-primary-soft);
  }
</style>
