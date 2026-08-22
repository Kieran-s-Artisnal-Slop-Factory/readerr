<script lang="ts">
  /** Per-origin statistics (#7): where your links come from and end up. */
  import { onMount } from 'svelte';
  import Card from '../Card.svelte';
  import SearchInput from '../SearchInput.svelte';
  import {
    DEFAULT_VARIABILITY_TOP_N,
    formatBytes,
    historyStats,
    originStats,
    storageStats,
    tagDistribution,
    variability,
    type HistoryStats,
    type OriginStats,
    type StorageStats,
    type TagDistribution,
  } from '../../lib/services/stats';
  import { href } from '../../lib/paths';

  /** Tag rows shown before the "show all" toggle — the head of a long tail. */
  const TAG_ROWS_SHOWN = 25;

  let rows = $state<OriginStats[]>([]);
  let search = $state('');
  let loading = $state(true);
  let history = $state<HistoryStats | null>(null);
  let storage = $state<StorageStats | null>(null);
  let tags = $state<TagDistribution | null>(null);
  let tagSearch = $state('');
  /** Long tails are the norm; the card opens on the head of the list. */
  let tagLimit = $state(TAG_ROWS_SHOWN);
  /** Tags nothing carries are noise in a distribution — hidden by default. */
  let hideUnusedTags = $state(true);
  /**
   * One-off domains are the bulk of the table for most libraries and say
   * nothing about where your reading comes from, so they start hidden.
   */
  let hideSingles = $state(true);
  let topN = $state(DEFAULT_VARIABILITY_TOP_N);

  /** Rows of the averages table: label + a key into HistoryTotals. */
  const AVG_METRICS = [
    { key: 'read', label: 'Links read' },
    { key: 'favourites', label: 'Favourites' },
    { key: 'resources', label: 'Resources' },
    { key: 'topics', label: 'Topics created' },
  ] as const;

  const fmtAvg = (n: number) => (n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(1));

  /** Search-matching rows — what the totals cover, hidden singles included. */
  const matching = $derived(
    rows.filter((r) => r.origin.toLowerCase().includes(search.trim().toLowerCase()))
  );

  const visible = $derived(hideSingles ? matching.filter((r) => r.links > 1) : matching);

  const hiddenCount = $derived(matching.length - visible.length);

  /** Library-wide, so it deliberately ignores the search box and the toggle. */
  const spread = $derived(variability(rows, topN));

  const totals = $derived(
    matching.reduce(
      (acc, r) => ({
        links: acc.links + r.links,
        resources: acc.resources + r.resources,
        slushed: acc.slushed + r.slushed,
        favourites: acc.favourites + r.favourites,
        inTopics: acc.inTopics + r.inTopics,
      }),
      { links: 0, resources: 0, slushed: 0, favourites: 0, inTopics: 0 }
    )
  );

  /** Tag rows the search leaves — what the "x of y" count describes. */
  const tagMatching = $derived(
    (tags?.rows ?? [])
      .filter((r) => !hideUnusedTags || r.links > 0)
      .filter((r) => r.name.toLowerCase().includes(tagSearch.trim().toLowerCase()))
  );
  const tagVisible = $derived(tagMatching.slice(0, tagLimit));
  /** The bar scale: the biggest visible share is a full-width bar. */
  const tagPeak = $derived(Math.max(0, ...tagMatching.map((r) => r.shareOfAssignments)));

  onMount(async () => {
    [rows, history, tags] = await Promise.all([originStats(), historyStats(), tagDistribution()]);
    loading = false;
    // Storage last — the server round-trip shouldn't hold up the page.
    storage = await storageStats();
  });
</script>

<div class="stack">
<Card title="Storage">
  {#if !storage}
    <p class="empty">Measuring…</p>
  {:else}
    <ul class="fact-list">
      <li>
        <span class="fact-label">In this browser</span>
        <span>
          {#if storage.browserUsage !== null}
            {formatBytes(storage.browserUsage)}
            {#if storage.browserQuota}
              <span class="muted-inline">
                of {formatBytes(storage.browserQuota)} available
                ({((storage.browserUsage / storage.browserQuota) * 100).toFixed(1)}%)
              </span>
            {/if}
          {:else}
            not reported by this browser
          {/if}
        </span>
      </li>
      <li>
        <span class="fact-label">On the sync server</span>
        <span>
          {#if storage.serverBytes !== null}
            {formatBytes(storage.serverBytes)}
            <span class="muted-inline">(database file)</span>
          {:else}
            unavailable — offline mode, or the server can't be reached
          {/if}
        </span>
      </li>
    </ul>
  {/if}
</Card>

<Card title="History">
  {#if loading || !history}
    <p class="empty">Loading…</p>
  {:else}
    <ul class="fact-list">
      <li>
        <span class="fact-label">Instance set up</span>
        <span>
          {history.setupAt
            ? new Date(history.setupAt).toLocaleDateString(undefined, {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })
            : 'no data yet'}
        </span>
      </li>
      <li>
        <span class="fact-label">Longest daily capture streak</span>
        <span>{history.longestStreakDays.toLocaleString()} day{history.longestStreakDays === 1 ? '' : 's'}</span>
      </li>
      <li>
        <span class="fact-label">Largest bulk upload</span>
        <span>{history.largestBulkAdd.toLocaleString()} link{history.largestBulkAdd === 1 ? '' : 's'} in one paste</span>
      </li>
    </ul>

    <div class="table-wrap" style="margin-top: var(--space-3);">
      <table>
        <thead>
          <tr>
            <th class="origin">Averages</th>
            <th>Per week</th>
            <th>Per month</th>
            <th>Per year</th>
            <th>Lifetime</th>
          </tr>
        </thead>
        <tbody>
          {#each AVG_METRICS as metric (metric.key)}
            <tr>
              <td class="origin">{metric.label}</td>
              <td>{fmtAvg(history.perWeek[metric.key])}</td>
              <td>{fmtAvg(history.perMonth[metric.key])}</td>
              <td>{fmtAvg(history.perYear[metric.key])}</td>
              <td>{history.totals[metric.key].toLocaleString()}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <p class="hint" style="margin-top: var(--space-2); margin-bottom: 0;">
      Averages spread each lifetime total over the time since setup (young
      installs show at least one period). Archived links aren't counted.
    </p>
  {/if}
</Card>

<Card title="Variability">
  {#if loading}
    <p class="empty">Loading…</p>
  {:else}
    <p class="hint">
      How spread out your reading is — the share of links captured from
      anywhere other than your biggest domains. A low score means most of what
      you read comes from a handful of places.
    </p>
    <div class="variability">
      <span class="score">{spread.totalLinks === 0 ? '—' : `${spread.score.toFixed(1)}%`}</span>
      <label class="top-n">
        outside my top
        <select bind:value={topN} aria-label="How many top domains to exclude">
          {#each [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as n (n)}
            <option value={n}>{n}</option>
          {/each}
        </select>
        domain{topN === 1 ? '' : 's'}
      </label>
    </div>
    {#if spread.totalLinks === 0}
      <p class="hint" style="margin: 0;">No links yet.</p>
    {:else}
      <p class="hint" style="margin: 0;">
        {spread.otherLinks.toLocaleString()} of {spread.totalLinks.toLocaleString()} links come
        from outside {spread.topOrigins.join(', ')}.
        {#if spread.topOrigins.length < spread.topN}
          That's every domain you have, so there is nothing left outside it.
        {:else if spread.topOrigins.length === 1}
          That one accounts for the other {spread.topLinks.toLocaleString()}.
        {:else}
          Those {spread.topOrigins.length} account for {spread.topLinks.toLocaleString()} between
          them.
        {/if}
      </p>
    {/if}
  {/if}
</Card>

<Card title={`Tag distribution (${tagMatching.length.toLocaleString()})`}>
  <p class="hint">
    How your library divides across tags. The <strong>share</strong> counts each
    (link, tag) pairing once, so it adds up to 100%; <strong>of library</strong>
    is the fraction of all links carrying that tag, which adds up to more than
    100% when links carry several tags. Nested tags aren't rolled up — each link
    counts for exactly the tags it carries.
  </p>
  {#if loading || !tags}
    <p class="empty">Loading…</p>
  {:else if tags.totalAssignments === 0}
    <p class="empty">
      {tags.totalLinks === 0 ? 'No links yet.' : 'No links are tagged yet.'}
    </p>
  {:else}
    <ul class="fact-list">
      <li>
        <span class="fact-label">Tagged links</span>
        <span>
          {tags.taggedLinks.toLocaleString()} of {tags.totalLinks.toLocaleString()}
          <span class="muted-inline">
            ({((tags.taggedLinks / tags.totalLinks) * 100).toFixed(1)}% — {tags.untaggedLinks.toLocaleString()}
            untagged)
          </span>
        </span>
      </li>
      <li>
        <span class="fact-label">Tag assignments</span>
        <span>
          {tags.totalAssignments.toLocaleString()}
          <span class="muted-inline">
            ({(tags.totalAssignments / Math.max(1, tags.taggedLinks)).toFixed(1)} per tagged link)
          </span>
        </span>
      </li>
    </ul>
    <div class="search-row">
      <SearchInput bind:value={tagSearch} placeholder="Filter tags…" />
    </div>
    <label class="toggle">
      <input type="checkbox" bind:checked={hideUnusedTags} />
      Hide tags with no links
      {#if hideUnusedTags && tags.unusedTags > 0}
        <span class="muted-inline">({tags.unusedTags.toLocaleString()} hidden)</span>
      {/if}
    </label>
    {#if tagMatching.length === 0}
      <p class="empty">No tags match.</p>
    {:else}
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th class="origin">Tag</th>
              <th>Links</th>
              <th>Share</th>
              <th>Of library</th>
            </tr>
          </thead>
          <tbody>
            {#each tagVisible as row (row.tagId)}
              <tr>
                <td class="origin">
                  <a class="tag-link" href={href(`/tag/?id=${row.tagId}`)}>{row.name}</a>
                </td>
                <td>{row.links.toLocaleString()}</td>
                <td>
                  <span class="share">
                    <span
                      class="share-bar"
                      style={`width: ${tagPeak === 0 ? 0 : (row.shareOfAssignments / tagPeak) * 100}%`}
                    ></span>
                    <span class="share-value">{row.shareOfAssignments.toFixed(1)}%</span>
                  </span>
                </td>
                <td>{row.shareOfLinks.toFixed(1)}%</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if tagMatching.length > tagVisible.length}
        <p class="hint" style="margin: var(--space-2) 0 0;">
          Showing the top {tagVisible.length.toLocaleString()} of {tagMatching.length.toLocaleString()}.
          <button class="btn" onclick={() => (tagLimit = Number.MAX_SAFE_INTEGER)}>Show all</button>
        </p>
      {:else if tagLimit > TAG_ROWS_SHOWN && tagMatching.length > TAG_ROWS_SHOWN}
        <p class="hint" style="margin: var(--space-2) 0 0;">
          <button class="btn" onclick={() => (tagLimit = TAG_ROWS_SHOWN)}>Show fewer</button>
        </p>
      {/if}
    {/if}
  {/if}
</Card>

<Card title={`Origins (${visible.length.toLocaleString()})`}>
  <p class="hint">
    Every domain you've captured from, with how many links it produced and
    where they ended up. Tags aren't counted.
  </p>
  <div class="search-row">
    <SearchInput bind:value={search} placeholder="Filter origins…" />
  </div>
  <label class="toggle">
    <input type="checkbox" bind:checked={hideSingles} />
    Hide domains with only one link
    {#if hideSingles && hiddenCount > 0}
      <span class="muted-inline">({hiddenCount.toLocaleString()} hidden)</span>
    {/if}
  </label>
  {#if loading}
    <p class="empty">Loading…</p>
  {:else if visible.length === 0}
    <p class="empty">
      {#if matching.length > 0}
        Every matching domain has just one link.
      {:else}
        {search ? 'No origins match.' : 'No links yet.'}
      {/if}
    </p>
  {:else}
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th class="origin">Origin</th>
            <th>Links</th>
            <th>Resources</th>
            <th>Slush</th>
            <th>Favourites</th>
            <th>In topics</th>
          </tr>
        </thead>
        <tbody>
          {#each visible as row (row.origin)}
            <tr>
              <td class="origin">{row.origin}</td>
              <td>{row.links}</td>
              <td>{row.resources || '·'}</td>
              <td>{row.slushed || '·'}</td>
              <td>{row.favourites || '·'}</td>
              <td>{row.inTopics || '·'}</td>
            </tr>
          {/each}
        </tbody>
        <tfoot>
          <tr>
            <td class="origin">Total</td>
            <td>{totals.links}</td>
            <td>{totals.resources}</td>
            <td>{totals.slushed}</td>
            <td>{totals.favourites}</td>
            <td>{totals.inTopics}</td>
          </tr>
        </tfoot>
      </table>
    </div>
    {#if hideSingles && hiddenCount > 0}
      <p class="hint" style="margin: var(--space-2) 0 0;">
        The total still counts the {hiddenCount.toLocaleString()} hidden single-link
        domain{hiddenCount === 1 ? '' : 's'} — they're only hidden from the table.
      </p>
    {/if}
  {/if}
</Card>
</div>

<style>
  .stack {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .fact-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .fact-list li {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--border-color);
  }

  .fact-list li:last-child {
    border-bottom: none;
  }

  .fact-label {
    color: var(--text-muted-color);
    font-weight: 600;
    font-size: var(--font-size-sm);
    flex-shrink: 0;
  }

  .muted-inline {
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
  }

  .hint {
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
    margin: 0 0 var(--space-3);
  }

  .search-row {
    margin-bottom: var(--space-3);
  }

  .toggle {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }

  .toggle input {
    width: auto;
    margin: 0;
  }

  .variability {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    margin-bottom: var(--space-2);
  }

  .score {
    font-size: 2.5rem;
    font-weight: 700;
    line-height: 1;
    color: var(--color-primary);
  }

  .top-n {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
  }

  .top-n select {
    width: auto;
    margin: 0;
  }

  .empty {
    color: var(--text-muted-color);
    text-align: center;
    padding: var(--space-5) 0;
  }

  .table-wrap {
    overflow-x: auto;
  }

  .tag-link {
    color: var(--text-color);
    text-decoration: none;
    font-weight: 600;
  }

  .tag-link:hover {
    color: var(--color-primary-strong);
    text-decoration: underline;
  }

  /* The bar sits behind its own percentage so the column stays one cell wide. */
  .share {
    position: relative;
    display: inline-flex;
    justify-content: flex-end;
    align-items: center;
    min-width: 7rem;
    padding: 0 var(--space-2);
    border-radius: var(--radius-sm);
    background: var(--color-primary-soft);
    overflow: hidden;
  }

  .share-bar {
    position: absolute;
    inset: 0 auto 0 0;
    background: var(--color-primary);
    opacity: 0.35;
  }

  .share-value {
    position: relative;
    font-variant-numeric: tabular-nums;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--font-size-sm);
  }

  th,
  td {
    text-align: right;
    padding: var(--space-2) var(--space-4);
    border-bottom: 1px solid var(--border-color);
    white-space: nowrap;
  }

  th:first-child,
  td:first-child {
    padding-left: var(--space-2);
  }

  th:last-child,
  td:last-child {
    padding-right: var(--space-2);
  }

  th.origin,
  td.origin {
    text-align: left;
    max-width: 18rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  th {
    color: var(--text-muted-color);
    font-weight: 600;
  }

  tbody tr:hover {
    background: var(--color-primary-soft);
  }

  tfoot td {
    border-bottom: none;
    font-weight: 700;
  }
</style>
