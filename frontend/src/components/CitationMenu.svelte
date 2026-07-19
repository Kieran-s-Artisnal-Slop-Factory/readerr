<script lang="ts">
  /**
   * The `[^` autocomplete menu, anchored to the caret. Presentation and
   * keyboard-selection state only — the editor owns the trigger, the caret
   * coordinates, and the insertion; citationSuggest.ts owns the matching.
   *
   * Styled after the capture box's DSL menu so both completions feel like
   * the same feature, but positioned fixed (the caret coordinates come from
   * the editor's own viewport measurement, not from layout flow).
   */
  import type { CitationSuggestion } from '../lib/services/citationSuggest';

  let {
    suggestions,
    index,
    left,
    top,
    onAccept,
  }: {
    suggestions: CitationSuggestion[];
    /** Highlighted entry; the editor drives it with the arrow keys. */
    index: number;
    /** Caret position in viewport coordinates. */
    left: number;
    top: number;
    onAccept: (s: CitationSuggestion) => void;
  } = $props();

  // Where the library spills over into "not on this topic yet" — the first
  // unnumbered entry gets a divider so accepting it is visibly different.
  const firstUncited = $derived(suggestions.findIndex((s) => s.number === null));

  let menuEl = $state<HTMLUListElement | null>(null);

  // Flip above the caret when there isn't room below, and never let the
  // menu hang off the right edge on a narrow screen.
  const placement = $derived.by(() => {
    void suggestions;
    const height = menuEl?.offsetHeight ?? 0;
    const width = menuEl?.offsetWidth ?? 0;
    const room = window.innerHeight - top;
    return {
      left: Math.max(8, Math.min(left, window.innerWidth - width - 8)),
      top: height > 0 && room < height + 24 ? top - height - 22 : top,
    };
  });
</script>

<ul
  class="citation-menu"
  role="listbox"
  aria-label="Link citations"
  bind:this={menuEl}
  style="left: {placement.left}px; top: {placement.top}px"
>
  {#each suggestions as s, i (s.link.id)}
    {#if i === firstUncited && firstUncited > 0}
      <li class="divider" aria-hidden="true"><span>add to this topic</span></li>
    {/if}
    <li>
      <button
        type="button"
        role="option"
        aria-selected={i === index}
        class:active={i === index}
        onmousedown={(e) => {
          e.preventDefault(); // keep the editor focused
          onAccept(s);
        }}
      >
        <span class="marker" class:new={s.number === null}>
          {s.number === null ? '+' : `[^${s.number}]`}
        </span>
        <span class="label">{s.label}</span>
        <span class="hint">{s.hint}</span>
      </button>
    </li>
  {/each}
</ul>

<style>
  .citation-menu {
    position: fixed;
    z-index: 60;
    list-style: none;
    margin: 0;
    padding: var(--space-1);
    border: 1px solid var(--color-primary);
    border-radius: var(--radius-md);
    background: var(--surface-raised-color);
    box-shadow: var(--shadow-2);
    width: max-content;
    max-width: min(30rem, calc(100vw - 1rem));
  }

  .citation-menu button {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    width: 100%;
    padding: var(--space-1) var(--space-2);
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text-color);
    cursor: pointer;
    text-align: left;
  }

  .citation-menu button.active,
  .citation-menu button:hover {
    background: var(--color-primary-soft);
  }

  .marker {
    flex-shrink: 0;
    min-width: 3.25rem;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: var(--font-size-sm);
    color: var(--color-primary-strong);
  }

  .marker.new {
    color: var(--text-muted-color);
    text-align: center;
  }

  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hint {
    flex-shrink: 0;
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
  }

  .divider {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-2) 0;
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
  }

  .divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--border-color);
  }

  @media (max-width: 40rem) {
    .hint {
      display: none;
    }
  }
</style>
