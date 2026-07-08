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
  }: {
    value?: string;
    onChange: (md: string) => void;
    placeholder?: string;
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

  onMount(() => {
    void mountCrepe();
  });

  onDestroy(() => {
    void destroyEditor();
  });
</script>

<div class="editor">
  <div class="editor-toolbar">
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

  /* Let the app theme drive Crepe's colors where it uses plain background. */
  .editor-root :global(.milkdown) {
    background: transparent;
  }
</style>
