<script lang="ts">
  /** A list of LinkRows with a shared tags-per-link lookup. */
  import LinkRow from './LinkRow.svelte';
  import type { Link, Tag, Topic } from '../lib/db/types';

  let {
    links,
    tagsByLink = new Map(),
    topicsByLink = new Map(),
    onChange,
    onAssignmentsChange,
    empty = 'Nothing here yet.',
  }: {
    links: Link[];
    tagsByLink?: Map<string, Tag[]>;
    topicsByLink?: Map<string, Topic[]>;
    onChange: (updated: Link) => void;
    /** Enables per-row inline tag/topic editing; fired after changes. */
    onAssignmentsChange?: () => void;
    empty?: string;
  } = $props();
</script>

{#if links.length === 0}
  <p class="empty">{empty}</p>
{:else}
  <div class="list">
    {#each links as link (link.id)}
      <LinkRow
        {link}
        tags={tagsByLink.get(link.id) ?? []}
        topics={topicsByLink.get(link.id) ?? []}
        {onChange}
        {onAssignmentsChange}
      />
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
