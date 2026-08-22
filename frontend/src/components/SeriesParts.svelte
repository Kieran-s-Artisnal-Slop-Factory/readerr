<script lang="ts">
  /**
   * The parts of a series, on the series' own page: the folder view. Order,
   * add, remove — the editing surface the inline list row deliberately
   * doesn't carry.
   *
   * Reordering rewrites the whole run (services/series.ts), so the numbers
   * stay 1..n instead of accumulating ties between devices.
   */
  import { captureLinks } from '../lib/services/capture';
  import { byIndex } from '../lib/db/repo';
  import { href } from '../lib/paths';
  import {
    addPart,
    movePart,
    partsOf,
    progressOf,
    removePart,
    type SeriesPart,
  } from '../lib/services/series';
  import type { Link } from '../lib/db/types';

  let {
    series,
    onChange,
  }: {
    series: Link;
    /** Fired whenever membership changes, so the host can refresh counts. */
    onChange?: () => void;
  } = $props();

  let parts = $state<SeriesPart[]>([]);
  let loading = $state(true);
  let busy = $state(false);
  let error = $state('');
  let newUrl = $state('');
  let newTitle = $state('');

  const progress = $derived(progressOf(parts));

  $effect(() => {
    const id = series.id;
    void partsOf(id).then((rows) => {
      parts = rows;
      loading = false;
    });
  });

  async function reload() {
    parts = await partsOf(series.id);
    onChange?.();
  }

  async function withBusy(fn: () => Promise<void>) {
    busy = true;
    error = '';
    try {
      await fn();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  function move(linkId: string, delta: -1 | 1) {
    return withBusy(async () => {
      await movePart(series.id, linkId, delta);
      await reload();
    });
  }

  function remove(part: SeriesPart) {
    return withBusy(async () => {
      await removePart(series.id, part.link.id);
      await reload();
    });
  }

  /** Add a part by URL — captured exactly like a pasted link would be. */
  function add(e: SubmitEvent) {
    e.preventDefault();
    const url = newUrl.trim();
    if (!url || busy) return;
    return withBusy(async () => {
      const title = newTitle.trim();
      const result = await captureLinks(
        title ? `[${title.replace(/[[\]]/g, '')}](${url})` : url
      );
      // Already in the library? capture merged rather than adding, so find it.
      let link: Link | undefined = result.added[0];
      if (!link) {
        const [existing] = await byIndex<Link>('links', 'url', url);
        link = existing;
      }
      if (!link) {
        error = 'That did not look like a link.';
        return;
      }
      const edge = await addPart(series, link);
      if (!edge) error = 'A series can hold links, but not another series.';
      newUrl = '';
      newTitle = '';
      await reload();
    });
  }
</script>

<p class="hint">
  {#if loading}
    Loading…
  {:else if parts.length === 0}
    No parts yet. Add the first one below — anything already in your library
    joins the series instead of being captured twice.
  {:else}
    {progress.read} of {progress.total} read. Ticking a part marks that link
    read; this series' own ✓ is a separate statement that you're done with it.
  {/if}
</p>

{#if error}
  <p class="error">{error}</p>
{/if}

{#if parts.length > 0}
  <ol class="parts">
    {#each parts as part (part.link.id)}
      <li class:read={!!part.link.read_at}>
        <span class="number">{part.number}</span>
        <a class="part-title" href={part.link.url} target="_blank" rel="noreferrer noopener">
          {part.link.title}
        </a>
        <span class="actions">
          <button
            class="btn"
            title="Move up"
            disabled={busy || part.number === 1}
            onclick={() => move(part.link.id, -1)}
          >
            ↑
          </button>
          <button
            class="btn"
            title="Move down"
            disabled={busy || part.number === parts.length}
            onclick={() => move(part.link.id, 1)}
          >
            ↓
          </button>
          <a class="btn" href={href(`/link/?id=${part.link.id}`)}>Open</a>
          <button class="btn btn-danger" disabled={busy} onclick={() => remove(part)}>
            Remove
          </button>
        </span>
      </li>
    {/each}
  </ol>
{/if}

<form class="add" onsubmit={add}>
  <input type="text" bind:value={newUrl} placeholder="https://… (next part)" disabled={busy} />
  <input type="text" bind:value={newTitle} placeholder="Title (optional)" disabled={busy} />
  <button type="submit" class="btn btn-primary" disabled={busy || !newUrl.trim()}>Add part</button>
</form>

<style>
  .hint {
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
    margin: 0 0 var(--space-3);
  }

  .error {
    color: var(--color-danger);
    font-size: var(--font-size-sm);
    margin: 0 0 var(--space-2);
  }

  .parts {
    list-style: none;
    margin: 0 0 var(--space-3);
    padding: 0;
  }

  .parts li {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--border-color);
  }

  .parts li:last-child {
    border-bottom: none;
  }

  .parts li.read .part-title {
    text-decoration: line-through;
    opacity: 0.65;
  }

  .number {
    color: var(--text-muted-color);
    font-variant-numeric: tabular-nums;
    min-width: 1.2rem;
    text-align: right;
  }

  .part-title {
    flex: 1;
    min-width: 0;
    color: var(--text-color);
    font-weight: 600;
    text-decoration: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .part-title:hover {
    color: var(--color-primary-strong);
    text-decoration: underline;
  }

  .actions {
    display: flex;
    gap: var(--space-1);
    flex-shrink: 0;
  }

  .add {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .add input {
    flex: 1;
    min-width: 10rem;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    background: var(--surface-color);
    color: var(--text-color);
  }
</style>
