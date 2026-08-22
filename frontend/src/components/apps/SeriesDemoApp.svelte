<script lang="ts">
  /**
   * Series — interactive prototype for the design in
   * docs/dev/experiments & plans/series.md.
   *
   * DELIBERATELY not wired to the database: everything here lives in one
   * localStorage key and touches neither IndexedDB nor sync. The point is to
   * judge the interaction — how a multi-part series is created, how it folds
   * into a reading list, how progress reads — before committing a schema
   * change and a new synced table to it.
   *
   * Where the demo makes a modelling claim, the code says which section of the
   * plan it is standing in for.
   */
  import { onMount } from 'svelte';
  import Card from '../Card.svelte';
  import { currentWeekStart, formatWeekRange, upcomingWeekOptions } from '../../lib/services/weeks';

  interface DemoPart {
    id: string;
    position: number;
    url: string;
    title: string;
    /** Monday 'YYYY-MM-DD', or '' for "not scheduled". */
    weekStart: string;
    tags: string[];
    topics: string[];
    read: boolean;
  }

  interface DemoSeries {
    id: string;
    kind: 'series';
    title: string;
    description: string;
    /** '' = no overview page; the plan synthesises `series:<uuid>` (§2.2). */
    overviewUrl: string;
    tags: string[];
    topics: string[];
    weekStart: string;
    read: boolean;
    parts: DemoPart[];
  }

  interface DemoLink {
    id: string;
    kind: 'link';
    title: string;
    url: string;
    tags: string[];
    weekStart: string;
    read: boolean;
  }

  type Row = DemoSeries | DemoLink;

  const STORAGE_KEY = 'readerr-series-demo';
  const weekOptions = upcomingWeekOptions();
  const thisWeek = currentWeekStart();

  let rows = $state<Row[]>([]);
  let expanded = $state<Record<string, boolean>>({});
  /** §4: a part shown under its series is not also a top-level row. */
  let hideNestedParts = $state(true);
  let modalOpen = $state(false);
  let prompt = $state<{ seriesId: string; title: string } | null>(null);

  // --- the "Add series" form (§5.1) ----------------------------------------
  let fTitle = $state('');
  let fDescription = $state('');
  let fOverview = $state('');
  let fTags = $state('');
  let fTopics = $state('');
  let fParts = $state<DemoPart[]>([]);

  const uid = () => crypto.randomUUID();
  const parseList = (raw: string): string[] =>
    raw.split(',').map((s) => s.trim()).filter(Boolean);

  function blankPart(position: number): DemoPart {
    return { id: uid(), position, url: '', title: '', weekStart: '', tags: [], topics: [], read: false };
  }

  onMount(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    rows = saved ? (JSON.parse(saved) as Row[]) : sampleRows();
    resetForm();
  });

  $effect(() => {
    // rows is the whole demo state; persist it so a reload keeps your fiddling.
    if (rows.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
  });

  function sampleRows(): Row[] {
    const part = (n: number, title: string, read: boolean): DemoPart => ({
      id: uid(),
      position: n,
      url: `https://without.boats/blog/async-rust-part-${n}/`,
      title,
      weekStart: '',
      tags: n === 3 ? ['pinning'] : [],
      topics: [],
      read,
    });
    return [
      {
        id: uid(),
        kind: 'series',
        title: 'Async Rust, from the ground up',
        description: 'A five-part walk through futures, executors, and pinning.',
        overviewUrl: 'https://without.boats/blog/async-rust/',
        tags: ['rust', 'async'],
        topics: ['Concurrency'],
        weekStart: thisWeek,
        read: false,
        parts: [
          part(1, 'Part 1 — What a future is', true),
          part(2, 'Part 2 — Writing an executor', true),
          part(3, 'Part 3 — Pin and why it exists', false),
          part(4, 'Part 4 — Cancellation', false),
          part(5, 'Part 5 — Where it all goes wrong', false),
        ],
      },
      {
        id: uid(),
        kind: 'link',
        title: 'The unreasonable effectiveness of SQLite',
        url: 'https://example.com/sqlite',
        tags: ['databases'],
        weekStart: thisWeek,
        read: false,
      },
    ];
  }

  const isSeries = (row: Row): row is DemoSeries => row.kind === 'series';

  const progressOf = (series: DemoSeries): string =>
    `${series.parts.filter((p) => p.read).length}/${series.parts.length}`;

  const seriesDone = (series: DemoSeries): boolean =>
    series.parts.length > 0 && series.parts.every((p) => p.read);

  /**
   * §4: parts are hidden from the top level while their series is on screen.
   * The demo has no separate "part promoted to top level" case, so the toggle
   * simply shows what the rule suppresses.
   */
  const looseParts = $derived(
    hideNestedParts
      ? []
      : rows.filter(isSeries).flatMap((s) => s.parts.map((p) => ({ series: s, part: p })))
  );

  function toggleExpanded(id: string) {
    expanded = { ...expanded, [id]: !expanded[id] };
  }

  function togglePart(series: DemoSeries, part: DemoPart) {
    part.read = !part.read;
    rows = [...rows];
    // §3.4: the last part being ticked OFFERS to close the series; it never
    // writes that decision itself.
    if (part.read && seriesDone(series) && !series.read) {
      prompt = { seriesId: series.id, title: series.title };
    }
  }

  function answerPrompt(markRead: boolean) {
    if (markRead && prompt) {
      const series = rows.find((r) => r.id === prompt!.seriesId);
      if (series) series.read = true;
      rows = [...rows];
    }
    prompt = null;
  }

  function toggleRowRead(row: Row) {
    row.read = !row.read;
    rows = [...rows];
  }

  function removeRow(id: string) {
    rows = rows.filter((r) => r.id !== id);
    if (!rows.length) localStorage.removeItem(STORAGE_KEY);
  }

  function resetDemo() {
    localStorage.removeItem(STORAGE_KEY);
    rows = sampleRows();
    expanded = {};
  }

  // --- modal ----------------------------------------------------------------

  function openModal() {
    resetForm();
    modalOpen = true;
  }

  function resetForm() {
    fTitle = '';
    fDescription = '';
    fOverview = '';
    fTags = '';
    fTopics = '';
    fParts = [blankPart(1), blankPart(2)];
  }

  function addPartRow() {
    fParts = [...fParts, blankPart(fParts.length + 1)];
  }

  function removePartRow(id: string) {
    fParts = fParts
      .filter((p) => p.id !== id)
      .map((p, i) => ({ ...p, position: i + 1 }));
  }

  const formValid = $derived(
    fTitle.trim() !== '' && fParts.some((p) => p.url.trim() !== '')
  );

  function saveSeries() {
    const parts = fParts
      .filter((p) => p.url.trim())
      // §3.1: order is (position, id) — the id breaks a tie deterministically.
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
      .map((p) => ({
        ...p,
        url: p.url.trim(),
        title: p.title.trim() || p.url.trim(),
        tags: typeof p.tags === 'string' ? parseList(p.tags) : p.tags,
        topics: typeof p.topics === 'string' ? parseList(p.topics) : p.topics,
      }));
    const series: DemoSeries = {
      id: uid(),
      kind: 'series',
      title: fTitle.trim(),
      description: fDescription.trim(),
      overviewUrl: fOverview.trim(),
      tags: parseList(fTags),
      topics: parseList(fTopics),
      weekStart: '',
      read: false,
      parts,
    };
    rows = [series, ...rows];
    expanded = { ...expanded, [series.id]: true };
    modalOpen = false;
  }

  const weekLabel = (weekStart: string): string =>
    weekStart ? formatWeekRange(weekStart) : 'unscheduled';
</script>

<div class="stack">
  <p class="banner">
    <strong>Prototype.</strong> This page is the UI half of
    <code>docs/dev/experiments &amp; plans/series.md</code>. Nothing here touches
    your library or syncs anywhere — it lives in one localStorage key so you can
    poke at the interaction before the data model gets built.
    <button class="btn" onclick={resetDemo}>Reset demo</button>
  </p>

  <Card title="Reading list (mock)">
    <div class="toolbar">
      <button class="btn btn-primary" onclick={openModal}>Add series</button>
      <label class="toggle">
        <input type="checkbox" bind:checked={hideNestedParts} />
        Hide parts that are shown inside their series
      </label>
    </div>

    <ul class="rows">
      {#each rows as row (row.id)}
        <li class="row" class:done={row.read}>
          <div class="row-main">
            <button
              class="tick"
              class:ticked={row.read}
              title={row.read ? 'Mark unread' : 'Mark read'}
              onclick={() => toggleRowRead(row)}
            >
              ✓
            </button>

            {#if isSeries(row)}
              <button class="disclosure" onclick={() => toggleExpanded(row.id)}>
                {expanded[row.id] ? '▾' : '▸'}
              </button>
            {:else}
              <span class="disclosure spacer"></span>
            {/if}

            <div class="row-text">
              <span class="row-title">
                {#if isSeries(row)}
                  {#if row.overviewUrl}
                    <a href={row.overviewUrl} target="_blank" rel="noreferrer noopener">
                      {row.title}
                    </a>
                  {:else}
                    <!-- §2.2: a synthesised series: URL is never a link. -->
                    {row.title}
                  {/if}
                  <span class="badge">series</span>
                  <span class="progress">{progressOf(row)}</span>
                {:else}
                  <a href={row.url} target="_blank" rel="noreferrer noopener">{row.title}</a>
                {/if}
              </span>
              <span class="row-meta">
                {weekLabel(row.weekStart)}
                {#each row.tags as tag (tag)}<span class="chip">#{tag}</span>{/each}
                {#if isSeries(row)}
                  {#each row.topics as topic (topic)}<span class="chip topic">{topic}</span>{/each}
                {/if}
              </span>
              {#if isSeries(row) && row.description}
                <span class="row-desc">{row.description}</span>
              {/if}
            </div>

            <button class="btn btn-danger" onclick={() => removeRow(row.id)}>Remove</button>
          </div>

          {#if isSeries(row) && expanded[row.id]}
            <ul class="parts">
              {#each row.parts as part (part.id)}
                <li class="part" class:done={part.read}>
                  <button
                    class="tick"
                    class:ticked={part.read}
                    title={part.read ? 'Mark unread' : 'Mark read'}
                    onclick={() => togglePart(row, part)}
                  >
                    ✓
                  </button>
                  <span class="part-pos">{part.position}</span>
                  <div class="row-text">
                    <a class="row-title" href={part.url} target="_blank" rel="noreferrer noopener">
                      {part.title}
                    </a>
                    <span class="row-meta">
                      {weekLabel(part.weekStart)}
                      {#each part.tags as tag (tag)}<span class="chip">#{tag}</span>{/each}
                    </span>
                  </div>
                </li>
              {/each}
            </ul>
          {/if}
        </li>
      {/each}

      {#each looseParts as { series, part } (part.id)}
        <li class="row loose">
          <div class="row-main">
            <span class="tick spacer"></span>
            <span class="disclosure spacer"></span>
            <div class="row-text">
              <span class="row-title">{part.title}</span>
              <span class="row-meta">
                would also appear here as a top-level row — suppressed because
                “{series.title}” is in this list
              </span>
            </div>
          </div>
        </li>
      {/each}
    </ul>

    {#if rows.length === 0}
      <p class="empty">Nothing in the mock list. <button class="btn" onclick={resetDemo}>Restore the sample</button></p>
    {/if}
  </Card>

  <Card title="What this is testing">
    <ul class="notes">
      <li><strong>One row, not five.</strong> A series in a week is a single entry that expands.</li>
      <li><strong>Progress, not a checkbox.</strong> <code>2/5</code> is computed from the parts, never stored (§2.3).</li>
      <li><strong>Ticking the last part asks.</strong> It offers to close the series rather than writing that decision for you (§3.4).</li>
      <li><strong>Parts don't double up.</strong> A part inside its series is not also a top-level row (§4) — untick the toggle above to see what the rule hides.</li>
      <li><strong>Tags at both levels.</strong> The series carries the broad ones; a part can add its own.</li>
    </ul>
  </Card>
</div>

{#if prompt}
  <div class="scrim" role="presentation">
    <div class="modal small" role="dialog" aria-modal="true" aria-label="Series finished">
      <p>That was the last part of <strong>{prompt.title}</strong>. Mark the whole series read?</p>
      <div class="modal-actions">
        <button class="btn" onclick={() => answerPrompt(false)}>Not yet</button>
        <button class="btn btn-primary" onclick={() => answerPrompt(true)}>Mark read</button>
      </div>
    </div>
  </div>
{/if}

{#if modalOpen}
  <div class="scrim" role="presentation">
    <div class="modal" role="dialog" aria-modal="true" aria-label="Add series">
      <h2>Add series</h2>

      <label class="field">
        <span>Title</span>
        <input type="text" bind:value={fTitle} placeholder="Async Rust, from the ground up" />
      </label>

      <label class="field">
        <span>Description</span>
        <textarea rows="2" bind:value={fDescription} placeholder="Markdown, shown on the series page"></textarea>
      </label>

      <label class="field">
        <span>Overview URL</span>
        <input type="text" bind:value={fOverview} placeholder="optional — the landing page for the series" />
      </label>

      <div class="two-up">
        <label class="field">
          <span>Series tags</span>
          <input type="text" bind:value={fTags} placeholder="rust, async" />
        </label>
        <label class="field">
          <span>Series topics</span>
          <input type="text" bind:value={fTopics} placeholder="Concurrency" />
        </label>
      </div>

      <h3>Parts</h3>
      <div class="parts-form">
        {#each fParts as part, i (part.id)}
          <div class="part-form">
            <label class="field pos">
              <span>#</span>
              <input type="number" min="1" bind:value={fParts[i].position} />
            </label>
            <label class="field grow">
              <span>URL</span>
              <input type="text" bind:value={fParts[i].url} placeholder="https://…" />
            </label>
            <label class="field grow">
              <span>Title</span>
              <input type="text" bind:value={fParts[i].title} placeholder="left blank = fetched" />
            </label>
            <label class="field">
              <span>Week</span>
              <select bind:value={fParts[i].weekStart}>
                <option value="">unscheduled</option>
                {#each weekOptions as opt (opt.value)}
                  <option value={opt.value}>{opt.label}</option>
                {/each}
              </select>
            </label>
            <label class="field grow">
              <span>Tags</span>
              <input type="text" bind:value={fParts[i].tags} placeholder="pinning" />
            </label>
            <label class="field grow">
              <span>Topics</span>
              <input type="text" bind:value={fParts[i].topics} placeholder="" />
            </label>
            <button class="btn btn-danger" onclick={() => removePartRow(part.id)}>✕</button>
          </div>
        {/each}
      </div>
      <button class="btn" onclick={addPartRow}>Add another part</button>

      <div class="modal-actions">
        <button class="btn" onclick={() => (modalOpen = false)}>Cancel</button>
        <button class="btn btn-primary" disabled={!formValid} onclick={saveSeries}>
          Create series
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .stack {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .banner {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    background: var(--color-primary-soft);
    border: 1px solid var(--color-primary);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    margin-bottom: var(--space-3);
  }

  .toggle {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
  }

  .rows,
  .parts,
  .notes {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .row {
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--border-color);
  }

  .row:last-child {
    border-bottom: none;
  }

  .row.done .row-title {
    text-decoration: line-through;
    opacity: 0.6;
  }

  .row.loose {
    opacity: 0.55;
    font-style: italic;
  }

  .row-main {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
  }

  .row-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 0;
  }

  .row-title {
    font-weight: 600;
    color: var(--text-color);
  }

  .row-title a {
    color: inherit;
    text-decoration: none;
  }

  .row-title a:hover {
    color: var(--color-primary-strong);
    text-decoration: underline;
  }

  .row-meta,
  .row-desc {
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }

  .badge {
    font-size: var(--font-size-sm);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    background: var(--color-primary-soft);
    color: var(--color-primary-strong);
    border-radius: var(--radius-full);
    padding: 0 var(--space-2);
  }

  .progress {
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
    font-variant-numeric: tabular-nums;
  }

  .chip {
    font-size: var(--font-size-sm);
    background: var(--surface-raised-color);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-full);
    padding: 0 var(--space-2);
  }

  .chip.topic {
    border-style: dashed;
  }

  .tick {
    width: 1.6rem;
    height: 1.6rem;
    flex-shrink: 0;
    border: 1px solid var(--border-color);
    border-radius: var(--radius-sm);
    background: var(--surface-color);
    color: transparent;
    cursor: pointer;
    line-height: 1;
  }

  .tick.ticked {
    background: var(--color-primary);
    border-color: var(--color-primary);
    color: var(--bg-color);
  }

  .tick.spacer,
  .disclosure.spacer {
    border: none;
    background: none;
  }

  .disclosure {
    width: 1.4rem;
    border: none;
    background: none;
    color: var(--text-muted-color);
    cursor: pointer;
    font-size: var(--font-size-base);
    padding: 0;
  }

  .parts {
    margin: var(--space-2) 0 0 calc(var(--space-4) + var(--space-3));
    border-left: 2px solid var(--border-color);
    padding-left: var(--space-3);
  }

  .part {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    padding: var(--space-1) 0;
  }

  .part.done .row-title {
    text-decoration: line-through;
    opacity: 0.6;
  }

  .part-pos {
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
    width: 1.2rem;
    text-align: right;
    padding-top: 2px;
  }

  .notes li {
    padding: var(--space-1) 0;
  }

  .empty {
    color: var(--text-muted-color);
    text-align: center;
    padding: var(--space-4) 0;
  }

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

  .modal.small {
    width: min(28rem, 100%);
  }

  .modal h2 {
    margin-top: 0;
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

  .two-up {
    display: flex;
    gap: var(--space-3);
  }

  .two-up .field {
    flex: 1;
  }

  .parts-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-bottom: var(--space-2);
  }

  .part-form {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: var(--space-2);
    padding: var(--space-2);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
  }

  .part-form .grow {
    flex: 1;
    min-width: 8rem;
  }

  .part-form .pos {
    width: 4rem;
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    margin-top: var(--space-3);
  }
</style>
