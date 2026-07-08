<script lang="ts">
  /**
   * Topic page: the long-form document front and center, with the links
   * assigned to this topic listed below it. Links can be added right here —
   * paste a URL to capture-and-assign in one step, or search existing links
   * by title/url and assign them.
   */
  import { onMount } from 'svelte';
  import Card from '../Card.svelte';
  import LinkList from '../LinkList.svelte';
  import MarkdownEditor from '../MarkdownEditor.svelte';
  import { all, get, put } from '../../lib/db/repo';
  import { captureLinks, fetchTitles } from '../../lib/services/capture';
  import { assignTopic, domainOf, linksForTopic, tagsForLink } from '../../lib/services/links';
  import type { Link, Tag, Topic } from '../../lib/db/types';

  let topic = $state<Topic | null>(null);
  let links = $state<Link[]>([]);
  let tagsByLink = $state<Map<string, Tag[]>>(new Map());
  let missing = $state(false);
  let allLinks = $state<Link[]>([]);
  let query = $state('');
  let adding = $state(false);

  const assignedIds = $derived(new Set(links.map((l) => l.id)));

  const queryIsUrl = $derived.by(() => {
    try {
      const u = new URL(query.trim());
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  });

  /** Existing links matching the search, unassigned ones first. */
  const matches = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q || queryIsUrl) return [];
    return allLinks
      .filter((l) => l.title.toLowerCase().includes(q) || l.url.toLowerCase().includes(q))
      .filter((l) => !assignedIds.has(l.id))
      .slice(0, 8);
  });

  onMount(async () => {
    const id = new URLSearchParams(location.search).get('id');
    topic = id ? ((await get<Topic>('topics', id)) ?? null) : null;
    if (!topic) {
      missing = true;
      return;
    }
    await refresh();
  });

  async function refresh() {
    if (!topic) return;
    const [rows, everything] = await Promise.all([linksForTopic(topic.id), all<Link>('links')]);
    rows.sort((a, b) => (a.added_at < b.added_at ? 1 : -1));
    links = rows;
    allLinks = everything;
    const byLink = new Map<string, Tag[]>();
    for (const link of rows) {
      byLink.set(link.id, await tagsForLink(link.id));
    }
    tagsByLink = byLink;
  }

  async function saveBody(md: string) {
    if (!topic) return;
    topic = await put('topics', { ...topic, body_md: md });
  }

  function onRowChange(updated: Link) {
    links = links.map((l) => (l.id === updated.id ? updated : l));
  }

  /** Paste-a-URL path: capture (or reuse the existing row) and assign. */
  async function addByUrl() {
    if (!topic || !queryIsUrl || adding) return;
    adding = true;
    try {
      const url = new URL(query.trim()).toString();
      const { added } = await captureLinks(url);
      const link = added[0] ?? allLinks.find((l) => l.url === url);
      if (link) await assignTopic(link.id, topic.id);
      query = '';
      await refresh();
      // captureLinks resolves titles fire-and-forget; wait for this one so
      // the new row doesn't sit there titled with its raw URL.
      if (added.length > 0) {
        await fetchTitles(added);
        await refresh();
      }
    } finally {
      adding = false;
    }
  }

  async function addExisting(link: Link) {
    if (!topic) return;
    await assignTopic(link.id, topic.id);
    query = '';
    await refresh();
  }
</script>

{#if missing}
  <p class="empty">Topic not found. <a href="./..">Back to topics.</a></p>
{:else if topic}
  <div class="stack">
    <h1>{topic.name}</h1>
    <MarkdownEditor
      value={topic.body_md}
      placeholder="Write the topic document…"
      exportName={topic.name}
      onChange={saveBody}
    />
    <Card title={`Referenced links (${links.length})`}>
      <form
        class="adder"
        onsubmit={(e) => {
          e.preventDefault();
          void addByUrl();
        }}
      >
        <input
          type="text"
          placeholder="Paste a URL to add, or search your links…"
          bind:value={query}
        />
        {#if queryIsUrl}
          <button type="submit" class="btn btn-primary" disabled={adding}>
            {adding ? 'Adding…' : 'Add link'}
          </button>
        {/if}
      </form>
      {#if matches.length > 0}
        <ul class="matches">
          {#each matches as match (match.id)}
            <li>
              <button type="button" class="match" onclick={() => addExisting(match)}>
                <span class="match-title">{match.title}</span>
                <span class="match-domain">{domainOf(match.url)}</span>
              </button>
            </li>
          {/each}
        </ul>
      {:else if query.trim() && !queryIsUrl}
        <p class="no-match">No unassigned links match — paste a full URL to add a new one.</p>
      {/if}
      <LinkList
        {links}
        {tagsByLink}
        onChange={onRowChange}
        empty="No links yet — paste a URL above or search your existing links."
      />
    </Card>
  </div>
{/if}

<style>
  .stack {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  h1 {
    margin: 0;
  }

  .empty {
    color: var(--text-muted-color);
    text-align: center;
    padding: var(--space-5) 0;
  }

  .adder {
    display: flex;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
  }

  .adder input {
    flex: 1;
    min-width: 0;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    background: var(--surface-color);
    color: var(--text-color);
  }

  .matches {
    list-style: none;
    margin: 0 0 var(--space-3);
    padding: 0;
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  .match {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    width: 100%;
    padding: var(--space-2) var(--space-3);
    border: none;
    border-bottom: 1px solid var(--border-color);
    background: var(--surface-color);
    color: var(--text-color);
    cursor: pointer;
    text-align: left;
  }

  .matches li:last-child .match {
    border-bottom: none;
  }

  .match:hover {
    background: var(--color-primary-soft);
  }

  .match-title {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .match-domain {
    flex-shrink: 0;
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
  }

  .no-match {
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
    margin: 0 0 var(--space-3);
  }
</style>
