<script lang="ts">
  /** Tag page: overview notes (markdown) plus every link carrying the tag. */
  import { onMount } from 'svelte';
  import Card from '../Card.svelte';
  import LinkList from '../LinkList.svelte';
  import MarkdownEditor from '../MarkdownEditor.svelte';
  import { get, put } from '../../lib/db/repo';
  import { linksForTag, tagsForLink } from '../../lib/services/links';
  import type { Link, Tag } from '../../lib/db/types';

  let tag = $state<Tag | null>(null);
  let links = $state<Link[]>([]);
  let tagsByLink = $state<Map<string, Tag[]>>(new Map());
  let missing = $state(false);

  onMount(async () => {
    const id = new URLSearchParams(location.search).get('id');
    tag = id ? ((await get<Tag>('tags', id)) ?? null) : null;
    if (!tag) {
      missing = true;
      return;
    }
    const rows = await linksForTag(tag.id);
    rows.sort((a, b) => (a.added_at < b.added_at ? 1 : -1));
    links = rows;
    const byLink = new Map<string, Tag[]>();
    for (const link of rows) {
      byLink.set(link.id, await tagsForLink(link.id));
    }
    tagsByLink = byLink;
  });

  async function saveNotes(md: string) {
    if (!tag) return;
    tag = await put('tags', { ...tag, notes_md: md });
  }

  function onRowChange(updated: Link) {
    links = links.map((l) => (l.id === updated.id ? updated : l));
  }
</script>

{#if missing}
  <p class="empty">Tag not found. <a href="./..">Back to tags.</a></p>
{:else if tag}
  <div class="stack">
    <h1>{tag.name}</h1>
    <Card title="About this tag">
      <MarkdownEditor
        value={tag.notes_md}
        placeholder="Notes about this tag…"
        exportName={tag.name}
        onChange={saveNotes}
      />
    </Card>
    <Card title={`Links (${links.length})`}>
      <LinkList {links} {tagsByLink} onChange={onRowChange} empty="No links carry this tag yet." />
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

  .empty {
    color: var(--text-muted-color);
    text-align: center;
    padding: var(--space-5) 0;
  }
</style>
