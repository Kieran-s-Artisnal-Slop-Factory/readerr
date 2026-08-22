<script lang="ts">
  /**
   * "Add series": the one place a multi-part series is created in a single
   * pass — title, description, overview URL, labels, and the parts with their
   * order, titles, weeks and own labels.
   *
   * Parts go through the ordinary capture pipeline (createSeries), so URL
   * cleaning, duplicate merging and week scheduling behave exactly as they do
   * in the capture box — a part you already had joins the series instead of
   * becoming a second copy.
   */
  import { ensureTagIdsByName, ensureTopicIdsByName } from '../lib/services/links';
  import { createSeries, type NewSeriesPart } from '../lib/services/series';
  import { upcomingWeekOptions } from '../lib/services/weeks';
  import type { Link } from '../lib/db/types';

  let {
    onCreated,
    label = 'Add series',
  }: {
    /** Fired after a series is created, so the host can refresh its list. */
    onCreated?: (series: Link) => void;
    label?: string;
  } = $props();

  interface PartDraft extends NewSeriesPart {
    key: string;
    position: number;
    tagText: string;
    topicText: string;
  }

  const weekOptions = upcomingWeekOptions();

  let open = $state(false);
  let saving = $state(false);
  let error = $state('');

  let title = $state('');
  let description = $state('');
  let overviewUrl = $state('');
  let tagText = $state('');
  let topicText = $state('');
  let weekStart = $state('');
  let parts = $state<PartDraft[]>([]);

  const blankPart = (position: number): PartDraft => ({
    key: crypto.randomUUID(),
    position,
    url: '',
    title: '',
    weekStart: '',
    tagText: '',
    topicText: '',
  });

  function reset() {
    title = '';
    description = '';
    overviewUrl = '';
    tagText = '';
    topicText = '';
    weekStart = '';
    parts = [blankPart(1), blankPart(2)];
    error = '';
  }

  function openModal() {
    reset();
    open = true;
  }

  function addPartRow() {
    parts = [...parts, blankPart(parts.length + 1)];
  }

  function removePartRow(key: string) {
    parts = parts.filter((p) => p.key !== key).map((p, i) => ({ ...p, position: i + 1 }));
  }

  const canSave = $derived(title.trim() !== '' && parts.some((p) => p.url.trim() !== ''));

  const names = (raw: string): string[] =>
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  async function save() {
    if (!canSave || saving) return;
    saving = true;
    error = '';
    try {
      const series = await createSeries({
        title,
        descriptionMd: description,
        overviewUrl,
        // Typing a name that doesn't exist creates it, exactly like the
        // capture box's !tags= does.
        tagIds: await ensureTagIdsByName(names(tagText)),
        topicIds: await ensureTopicIdsByName(names(topicText)),
        weekStart: weekStart || null,
        parts: await Promise.all(
          // The stored order is the position column the user typed, not the
          // order of the rows on screen.
          [...parts]
            .filter((p) => p.url.trim())
            .sort((a, b) => a.position - b.position)
            .map(async (p) => ({
              url: p.url,
              title: p.title?.trim() || undefined,
              weekStart: p.weekStart || null,
              tagIds: await ensureTagIdsByName(names(p.tagText)),
              topicIds: await ensureTopicIdsByName(names(p.topicText)),
            }))
        ),
      });
      open = false;
      onCreated?.(series.series);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      saving = false;
    }
  }
</script>

<button class="btn" onclick={openModal}>{label}</button>

{#if open}
  <div class="scrim" role="presentation">
    <div class="modal" role="dialog" aria-modal="true" aria-label="Add series">
      <h2>Add series</h2>
      <p class="hint">
        A series is one link that holds the others: schedule it, favourite it or
        tag it like anything else, and tick the parts off as you read them.
      </p>

      {#if error}
        <p class="error">{error}</p>
      {/if}

      <label class="field">
        <span>Title</span>
        <input type="text" bind:value={title} placeholder="Async Rust, from the ground up" />
      </label>

      <label class="field">
        <span>Description</span>
        <textarea rows="2" bind:value={description} placeholder="Markdown — kept as the series' note"
        ></textarea>
      </label>

      <div class="row">
        <label class="field grow">
          <span>Overview URL</span>
          <input type="text" bind:value={overviewUrl} placeholder="optional — the landing page" />
        </label>
        <label class="field">
          <span>Reading week</span>
          <select bind:value={weekStart}>
            <option value="">None (backlog only)</option>
            {#each weekOptions as opt (opt.value)}
              <option value={opt.value}>{opt.label}</option>
            {/each}
          </select>
        </label>
      </div>

      <div class="row">
        <label class="field grow">
          <span>Series tags</span>
          <input type="text" bind:value={tagText} placeholder="rust, async" />
        </label>
        <label class="field grow">
          <span>Series topics</span>
          <input type="text" bind:value={topicText} placeholder="Concurrency" />
        </label>
      </div>

      <h3>Parts</h3>
      <div class="parts">
        {#each parts as part, i (part.key)}
          <div class="part">
            <label class="field pos">
              <span>#</span>
              <input type="number" min="1" bind:value={parts[i].position} />
            </label>
            <label class="field grow">
              <span>URL</span>
              <input type="text" bind:value={parts[i].url} placeholder="https://…" />
            </label>
            <label class="field grow">
              <span>Title</span>
              <input type="text" bind:value={parts[i].title} placeholder="blank = fetched" />
            </label>
            <label class="field">
              <span>Week</span>
              <select bind:value={parts[i].weekStart}>
                <option value="">None</option>
                {#each weekOptions as opt (opt.value)}
                  <option value={opt.value}>{opt.label}</option>
                {/each}
              </select>
            </label>
            <label class="field grow">
              <span>Tags</span>
              <input type="text" bind:value={parts[i].tagText} placeholder="pinning" />
            </label>
            <label class="field grow">
              <span>Topics</span>
              <input type="text" bind:value={parts[i].topicText} placeholder="" />
            </label>
            <button
              class="btn btn-danger"
              title="Remove this part"
              onclick={() => removePartRow(part.key)}
            >
              ✕
            </button>
          </div>
        {/each}
      </div>
      <button class="btn" onclick={addPartRow}>Add another part</button>

      <div class="actions">
        <button class="btn" onclick={() => (open = false)} disabled={saving}>Cancel</button>
        <button class="btn btn-primary" onclick={save} disabled={!canSave || saving}>
          {saving ? 'Creating…' : 'Create series'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgb(0 0 0 / 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-4);
    z-index: 50;
  }

  .modal {
    background: var(--surface-color);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-2);
    padding: var(--space-4);
    width: min(60rem, 100%);
    max-height: 90vh;
    overflow: auto;
  }

  .modal h2 {
    margin-top: 0;
  }

  .hint {
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
    margin: 0 0 var(--space-3);
  }

  .error {
    color: var(--color-danger);
    font-size: var(--font-size-sm);
    margin: 0 0 var(--space-3);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-bottom: var(--space-2);
  }

  .field span {
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
  }

  .field input,
  .field textarea,
  .field select {
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    background: var(--surface-color);
    color: var(--text-color);
    font: inherit;
    width: 100%;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
  }

  .grow {
    flex: 1;
    min-width: 9rem;
  }

  .parts {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-bottom: var(--space-2);
  }

  .part {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: var(--space-2);
    padding: var(--space-2);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
  }

  .pos {
    width: 4rem;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    margin-top: var(--space-3);
  }
</style>
