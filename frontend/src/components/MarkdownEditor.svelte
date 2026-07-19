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
  import { onDestroy, onMount } from 'svelte';
  import { marked } from 'marked';
  import { Crepe } from '@milkdown/crepe';
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
    window.addEventListener('pagehide', flushNow);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushNow();
    });
  });

  onDestroy(() => {
    window.removeEventListener('pagehide', flushNow);
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
