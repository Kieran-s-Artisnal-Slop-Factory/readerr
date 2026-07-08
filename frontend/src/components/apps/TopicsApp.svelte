<script lang="ts">
  /** Topics index: list with referenced-link counts, create. */
  import { onMount } from 'svelte';
  import Card from '../Card.svelte';
  import { all, put, withSyncFields } from '../../lib/db/repo';
  import { topicLinkCounts } from '../../lib/services/links';
  import { href } from '../../lib/paths';
  import type { Topic } from '../../lib/db/types';

  let topics = $state<Topic[]>([]);
  let counts = $state<Map<string, number>>(new Map());
  let newName = $state('');

  onMount(refresh);

  async function refresh() {
    const [rows, c] = await Promise.all([all<Topic>('topics'), topicLinkCounts()]);
    rows.sort((a, b) => a.name.localeCompare(b.name));
    topics = rows;
    counts = c;
  }

  async function create() {
    const name = newName.trim();
    if (!name || topics.some((t) => t.name.toLowerCase() === name.toLowerCase())) return;
    const topic = await put('topics', withSyncFields({ name, body_md: '' }));
    newName = '';
    location.assign(href(`/topic/?id=${topic.id}`));
  }
</script>

<Card title={`Topics (${topics.length})`}>
  <form
    class="create"
    onsubmit={(e) => {
      e.preventDefault();
      void create();
    }}
  >
    <input type="text" placeholder="New topic…" bind:value={newName} />
    <button type="submit" class="btn btn-primary" disabled={!newName.trim()}>Create</button>
  </form>

  {#if topics.length === 0}
    <p class="empty">No topics yet — create one to start a long-form document.</p>
  {:else}
    <ul class="topic-list">
      {#each topics as topic (topic.id)}
        <li>
          <a class="topic-name" href={href(`/topic/?id=${topic.id}`)}>{topic.name}</a>
          <span class="count">{counts.get(topic.id) ?? 0} links</span>
        </li>
      {/each}
    </ul>
  {/if}
</Card>

<style>
  .create {
    display: flex;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
  }

  .create input {
    flex: 1;
    min-width: 0;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    background: var(--surface-color);
    color: var(--text-color);
  }

  .empty {
    color: var(--text-muted-color);
    text-align: center;
    padding: var(--space-5) 0;
  }

  .topic-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .topic-list li {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--border-color);
  }

  .topic-list li:last-child {
    border-bottom: none;
  }

  .topic-name {
    font-weight: 600;
    color: var(--text-color);
    text-decoration: none;
  }

  .topic-name:hover {
    color: var(--color-primary-strong);
    text-decoration: underline;
  }

  .count {
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
  }
</style>
