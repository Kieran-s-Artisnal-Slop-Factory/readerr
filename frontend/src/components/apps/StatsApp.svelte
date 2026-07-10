<script lang="ts">
  /** Per-origin statistics (#7): where your links come from and end up. */
  import { onMount } from 'svelte';
  import Card from '../Card.svelte';
  import SearchInput from '../SearchInput.svelte';
  import { originStats, type OriginStats } from '../../lib/services/stats';

  let rows = $state<OriginStats[]>([]);
  let search = $state('');
  let loading = $state(true);

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
    rows = await originStats();
    loading = false;
  });
</script>

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

<style>
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
    padding: var(--space-1) var(--space-2);
    border-bottom: 1px solid var(--border-color);
    white-space: nowrap;
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
