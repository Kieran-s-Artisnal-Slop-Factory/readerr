<script lang="ts">
  /**
   * One backlog row: title (links out), domain, tag chips, flag toggles.
   * When onAssignmentsChange is provided, a # button expands inline
   * tag/topic pickers so links can be organized without leaving the list.
   */
  import TagPicker from './TagPicker.svelte';
  import TopicPicker from './TopicPicker.svelte';
  import { href } from '../lib/paths';
  import { domainOf, toggleFavourite, toggleRead, toggleResource } from '../lib/services/links';
  import type { Link, Tag, Topic } from '../lib/db/types';

  let {
    link,
    tags = [],
    topics = [],
    onChange,
    onAssignmentsChange,
  }: {
    link: Link;
    tags?: Tag[];
    topics?: Topic[];
    onChange: (updated: Link) => void;
    /** Enables the inline label editor; fired after assignments change. */
    onAssignmentsChange?: () => void;
  } = $props();

  let labelsOpen = $state(false);
</script>

<div class="link-item">
<article class="row" class:read={!!link.read_at}>
  <div class="row-main">
    <a class="title" href={link.url} target="_blank" rel="noopener noreferrer">
      {link.title}
    </a>
    <div class="meta">
      <span class="domain">{domainOf(link.url)}</span>
      {#each tags as tag (tag.id)}
        <a class="tag-chip" href={href(`/tag/?id=${tag.id}`)}>{tag.name}</a>
      {/each}
      {#each topics as topic (topic.id)}
        <a class="tag-chip topic-chip" href={href(`/topic/?id=${topic.id}`)}>§ {topic.name}</a>
      {/each}
    </div>
  </div>
  <div class="row-actions">
    <button
      class="icon-btn"
      class:active={!!link.read_at}
      title={link.read_at ? 'Mark unread' : 'Mark read'}
      onclick={async () => onChange(await toggleRead(link))}
    >
      ✓
    </button>
    <button
      class="icon-btn"
      class:active={link.favourite}
      title={link.favourite ? 'Unfavourite' : 'Favourite'}
      onclick={async () => onChange(await toggleFavourite(link))}
    >
      ★
    </button>
    <button
      class="icon-btn"
      class:active={link.is_resource}
      title={link.is_resource ? 'Not a resource' : 'Mark as resource'}
      onclick={async () => onChange(await toggleResource(link))}
    >
      ⚒
    </button>
    {#if onAssignmentsChange}
      <button
        class="icon-btn"
        class:active={labelsOpen}
        title="Tags & topics"
        aria-expanded={labelsOpen}
        onclick={() => (labelsOpen = !labelsOpen)}
      >
        #
      </button>
    {/if}
    <a class="icon-btn open" title="Notes & details" href={href(`/link/?id=${link.id}`)}>✎</a>
  </div>
</article>
{#if labelsOpen && onAssignmentsChange}
  <div class="labels">
    <div class="labels-group">
      <span class="labels-label">Tags</span>
      <TagPicker linkId={link.id} onChange={onAssignmentsChange} />
    </div>
    <div class="labels-group">
      <span class="labels-label">Topics</span>
      <TopicPicker linkId={link.id} onChange={onAssignmentsChange} />
    </div>
  </div>
{/if}
</div>

<style>
  .link-item {
    border-bottom: 1px solid var(--border-color);
  }

  .link-item:last-child {
    border-bottom: none;
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-3);
  }

  .labels {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: 0 var(--space-3) var(--space-3);
  }

  .labels-group {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .labels-label {
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
    font-weight: 600;
  }

  .row.read .title {
    color: var(--text-muted-color);
  }

  .row-main {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .title {
    color: var(--text-color);
    font-weight: 600;
    text-decoration: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .title:hover {
    color: var(--color-primary-strong);
    text-decoration: underline;
  }

  .meta {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
  }

  .tag-chip {
    border: 1px solid var(--border-color);
    border-radius: var(--radius-full);
    padding: 0 var(--space-2);
    text-decoration: none;
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
  }

  .tag-chip:hover {
    border-color: var(--color-primary);
    color: var(--color-primary-strong);
  }

  .topic-chip {
    border-style: dashed;
  }

  .row-actions {
    display: flex;
    gap: var(--space-1);
    flex-shrink: 0;
  }

  .icon-btn {
    width: 2rem;
    height: 2rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    background: var(--surface-color);
    color: var(--text-muted-color);
    cursor: pointer;
    text-decoration: none;
    font-size: var(--font-size-base);
  }

  .icon-btn:hover {
    border-color: var(--color-primary);
    color: var(--color-primary-strong);
  }

  .icon-btn.active {
    background: var(--color-primary-soft);
    border-color: var(--color-primary);
    color: var(--color-primary-strong);
  }
</style>
