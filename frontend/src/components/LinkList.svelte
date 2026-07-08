<script lang="ts">
  /** A list of LinkRows with a shared tags-per-link lookup. */
  import LinkRow from './LinkRow.svelte';
  import type { Link, Tag } from '../lib/db/types';

  let {
    links,
    tagsByLink = new Map(),
    onChange,
    empty = 'Nothing here yet.',
  }: {
    links: Link[];
    tagsByLink?: Map<string, Tag[]>;
    onChange: (updated: Link) => void;
    empty?: string;
  } = $props();
</script>

{#if links.length === 0}
  <p class="empty">{empty}</p>
{:else}
  <div class="list">
    {#each links as link (link.id)}
      <LinkRow {link} tags={tagsByLink.get(link.id) ?? []} {onChange} />
    {/each}
  </div>
{/if}

<style>
  .empty {
    color: var(--text-muted-color);
    text-align: center;
    padding: var(--space-5) 0;
  }

  .list {
    display: flex;
    flex-direction: column;
  }
</style>
