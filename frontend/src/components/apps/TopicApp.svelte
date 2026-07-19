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
  import Pagination from '../Pagination.svelte';
  import { all, byIndex, get, put, softDelete, softDeleteMany } from '../../lib/db/repo';
  import { captureLinks, fetchTitles } from '../../lib/services/capture';
  import { assignTopic, domainOf, tagsForLinks } from '../../lib/services/links';
  import { topicReferences } from '../../lib/services/topics';
  import { downloadTopicHtml, downloadTopicMarkdown } from '../../lib/services/topicExport';
  import { href } from '../../lib/paths';
  import type { Link, LinkTopic, Tag, Topic } from '../../lib/db/types';

  const PAGE_SIZE = 100;

  let topic = $state<Topic | null>(null);
  let links = $state<Link[]>([]);
  /** Footnote number per link id — what `[^n]` in the document resolves to. */
  let refNumbers = $state<Map<string, number>>(new Map());
  let tagsByLink = $state<Map<string, Tag[]>>(new Map());
  let missing = $state(false);
  let allLinks = $state<Link[]>([]);
  let query = $state('');
  let adding = $state(false);
  let page = $state(0);

  const visible = $derived(links.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE));

  // Resolve tag chips for the visible page only (scaling.md phase A).
  $effect(() => {
    const slice = visible;
    void tagsForLinks(slice).then((m) => (tagsByLink = m));
  });

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
    const [refs, everything] = await Promise.all([topicReferences(topic.id), all<Link>('links')]);
    // Footnote order, not newest-first: the list doubles as the reference
    // key you read `[^3]` off, so it has to match the numbering.
    links = refs.map((r) => r.link);
    refNumbers = new Map(refs.map((r) => [r.link.id, r.number]));
    allLinks = everything;
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

  async function deleteTopic() {
    if (!topic) return;
    if (!confirm(`Delete topic "${topic.name}"? Its document is deleted too; the links stay.`)) {
      return;
    }
    const joins = await byIndex<LinkTopic>('link_topics', 'topic_id', topic.id);
    await softDeleteMany('link_topics', joins.map((j) => j.id));
    await softDelete('topics', topic.id);
    location.assign(href('/topics/'));
  }
</script>

{#if missing}
  <p class="empty">Topic not found. <a href="./..">Back to topics.</a></p>
{:else if topic}
  <div class="stack">
    <div class="topic-head">
      <h1>{topic.name}</h1>
      <div class="topic-actions">
        <button
          class="btn"
          title="Download this document and its references as a themed HTML page"
          onclick={() => topic && downloadTopicHtml(topic)}
        >
          Export HTML
        </button>
        <button class="btn btn-danger" onclick={deleteTopic}>Delete topic</button>
      </div>
    </div>
    <MarkdownEditor
      value={topic.body_md}
      placeholder="Write the topic document…"
      exportName={topic.name}
      onChange={saveBody}
      onExportMarkdown={() => topic && downloadTopicMarkdown(topic)}
      onExportHtml={() => topic && downloadTopicHtml(topic)}
    />
    <Card title={`Referenced links (${links.length.toLocaleString()})`}>
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
      <p class="hint">
        Cite any of these in the document above with its footnote marker —
        <code>[^1]</code>, <code>[^2]</code> — or click a marker to copy it. Numbers
        stay put when a reference is removed, so old citations never drift.
      </p>
      <LinkList
        links={visible}
        {tagsByLink}
        {refNumbers}
        onChange={onRowChange}
        empty="No links yet — paste a URL above or search your existing links."
      />
      <Pagination total={links.length} pageSize={PAGE_SIZE} bind:page label="links" />
    </Card>
  </div>
{:else}
  <p class="empty">Loading…</p>
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

  .topic-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--space-3);
  }

  .topic-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
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

  .hint {
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
    margin: 0 0 var(--space-2);
  }

  .hint code {
    font-family: var(--font-mono, ui-monospace, monospace);
  }

  .no-match {
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
    margin: 0 0 var(--space-3);
  }

  /* Title beside domain leaves too little of either to recognise a result. */
  @media (max-width: 40rem) {
    .match {
      flex-direction: column;
      align-items: stretch;
      gap: 2px;
    }

    .match-title {
      white-space: normal;
      overflow-wrap: anywhere;
    }
  }
</style>
