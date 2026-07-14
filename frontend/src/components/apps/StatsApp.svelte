<script lang="ts">
  /** Per-origin statistics (#7): where your links come from and end up. */
  import { onMount } from 'svelte';
  import Card from '../Card.svelte';
  import SearchInput from '../SearchInput.svelte';
  import {
    formatBytes,
    historyStats,
    originStats,
    storageStats,
    type HistoryStats,
    type OriginStats,
    type StorageStats,
  } from '../../lib/services/stats';

  let rows = $state<OriginStats[]>([]);
  let search = $state('');
  let loading = $state(true);
  let history = $state<HistoryStats | null>(null);
  let storage = $state<StorageStats | null>(null);

  /** Rows of the averages table: label + a key into HistoryTotals. */
  const AVG_METRICS = [
    { key: 'read', label: 'Links read' },
    { key: 'favourites', label: 'Favourites' },
    { key: 'resources', label: 'Resources' },
    { key: 'topics', label: 'Topics created' },
  ] as const;

  const fmtAvg = (n: number) => (n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(1));

  const visible = $derived(
    rows.filter((r) => r.origin.toLowerCase().includes(search.trim().toLowerCase()))
  );

  const totals = $derived(
    visible.reduce(
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

  onMount(async () => {
    [rows, history] = await Promise.all([originStats(), historyStats()]);
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

<Card title={`Origins (${visible.length})`}>
  <p class="hint">
    Every domain you've captured from, with how many links it produced and
    where they ended up. Tags aren't counted.
  </p>
  <div class="search-row">
    <SearchInput bind:value={search} placeholder="Filter origins…" />
  </div>
  {#if loading}
    <p class="empty">Loading…</p>
  {:else if visible.length === 0}
    <p class="empty">{search ? 'No origins match.' : 'No links yet.'}</p>
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

  .empty {
    color: var(--text-muted-color);
    text-align: center;
    padding: var(--space-5) 0;
  }

  .table-wrap {
    overflow-x: auto;
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
