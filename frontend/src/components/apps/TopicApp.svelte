<script lang="ts">
  /**
   * Topic page: the long-form document front and center, with the links
   * assigned to this topic listed below it.
   */
  import { onMount } from 'svelte';
  import Card from '../Card.svelte';
  import LinkList from '../LinkList.svelte';
  import MarkdownEditor from '../MarkdownEditor.svelte';
  import { get, put } from '../../lib/db/repo';
  import { linksForTopic, tagsForLink } from '../../lib/services/links';
  import type { Link, Tag, Topic } from '../../lib/db/types';

  let topic = $state<Topic | null>(null);
  let links = $state<Link[]>([]);
  let tagsByLink = $state<Map<string, Tag[]>>(new Map());
  let missing = $state(false);

  onMount(async () => {
    const id = new URLSearchParams(location.search).get('id');
    topic = id ? ((await get<Topic>('topics', id)) ?? null) : null;
    if (!topic) {
      missing = true;
      return;
    }
    const rows = await linksForTopic(topic.id);
    rows.sort((a, b) => (a.added_at < b.added_at ? 1 : -1));
    links = rows;
    const byLink = new Map<string, Tag[]>();
    for (const link of rows) {
      byLink.set(link.id, await tagsForLink(link.id));
    }
    tagsByLink = byLink;
  });

  async function saveBody(md: string) {
    if (!topic) return;
    topic = await put('topics', { ...topic, body_md: md });
  }

  function onRowChange(updated: Link) {
    links = links.map((l) => (l.id === updated.id ? updated : l));
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
      onChange={saveBody}
    />
    <Card title={`Referenced links (${links.length})`}>
      <LinkList
        {links}
        {tagsByLink}
        onChange={onRowChange}
        empty="No links assigned — assign this topic from a link's detail page."
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
</style>
