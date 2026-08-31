<script lang="ts">
  /**
   * Tag page: overview notes (markdown), the tag's place in the hierarchy, the
   * links carrying it, and — separately — the links that reach it only through
   * a nested child tag.
   */
  import { onMount } from 'svelte';
  import Card from '../Card.svelte';
  import ChipSelect from '../ChipSelect.svelte';
  import LinkList from '../LinkList.svelte';
  import MarkdownEditor from '../MarkdownEditor.svelte';
  import Pagination from '../Pagination.svelte';
  import ToggleSwitch from '../ToggleSwitch.svelte';
  import { href } from '../../lib/paths';
  import { all, get, put, withSyncFields } from '../../lib/db/repo';
  import {
    linksFromChildTags,
    linksTaggedDirectly,
    reconcileTags,
    tagsForLinks,
  } from '../../lib/services/links';
  import {
    childrenOf,
    parentIdsOf,
    reconcileTagParents,
    setTagParents,
    wouldCycle,
  } from '../../lib/services/tagTree';
  import { topicStatus, topicsForTag } from '../../lib/services/topics';
  import { downloadTagHtml, downloadTagMarkdown } from '../../lib/services/tagExport';
  import type { Link, Tag, Topic } from '../../lib/db/types';

  const PAGE_SIZE = 100;

  let tag = $state<Tag | null>(null);
  let links = $state<Link[]>([]);
  let inherited = $state<{ link: Link; via: Tag[] }[]>([]);
  let tagsByLink = $state<Map<string, Tag[]>>(new Map());
  let missing = $state(false);
  let page = $state(0);
  /** Topics carrying this tag (topic_tags) — their own section below. */
  let topics = $state<Topic[]>([]);

  // Export options. Embedding is off by default: most exports are an index,
  // and a tag with twenty topics would otherwise produce a very long file.
  let embedTopics = $state(false);
  let topicsAsFiles = $state(false);
  let exporting = $state('');

  async function exportTag(kind: 'md' | 'html') {
    if (!tag || exporting) return;
    exporting = kind;
    try {
      if (kind === 'md') {
        await downloadTagMarkdown(tag, { embedTopics, topicsAsFiles });
      } else {
        await downloadTagHtml(tag, { embedTopics });
      }
    } finally {
      exporting = '';
    }
  }

  // Hierarchy
  let allTags = $state<Tag[]>([]);
  let parentIds = $state<string[]>([]);
  let children = $state<Tag[]>([]);
  let editingParents = $state(false);
  let draftParentIds = $state<string[]>([]);
  let parentError = $state('');
  let savingParents = $state(false);

  const visible = $derived(links.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE));

  // Never offer a tag as its own parent.
  const parentOptions = $derived(allTags.filter((t) => t.id !== tag?.id));
  const parentTags = $derived(
    parentIds.map((id) => allTags.find((t) => t.id === id)).filter((t): t is Tag => !!t)
  );

  // Resolve tag chips for the visible page only.
  $effect(() => {
    const slice = visible;
    void tagsForLinks(slice).then((m) => (tagsByLink = m));
  });

  onMount(async () => {
    // Heal same-name duplicates first so this tag's link list and count reflect
    // the merged survivor (the index only ever links here with a survivor id).
    await reconcileTags();
    // …then repair the graph, so a cycle synced in from another device can't
    // make this page's traversals disagree with the stored data.
    await reconcileTagParents();
    const id = new URLSearchParams(location.search).get('id');
    tag = id ? ((await get<Tag>('tags', id)) ?? null) : null;
    if (!tag) {
      missing = true;
      return;
    }
    allTags = (await all<Tag>('tags')).sort((a, b) => a.name.localeCompare(b.name));
    await loadHierarchy();
    await loadLinks();
    topics = await topicsForTag(tag.id);
  });

  async function loadHierarchy() {
    if (!tag) return;
    parentIds = await parentIdsOf(tag.id);
    children = await childrenOf(tag.id);
  }

  async function loadLinks() {
    if (!tag) return;
    const rows = await linksTaggedDirectly(tag.id);
    rows.sort((a, b) => (a.added_at < b.added_at ? 1 : -1));
    links = rows;
    const fromChildren = await linksFromChildTags(tag.id);
    fromChildren.sort((a, b) => (a.link.added_at < b.link.added_at ? 1 : -1));
    inherited = fromChildren;
  }

  async function createTag(name: string): Promise<string> {
    const created = await put('tags', withSyncFields({ name, notes_md: '' }));
    allTags = [...allTags, created].sort((a, b) => a.name.localeCompare(b.name));
    return created.id;
  }

  function openParentEditor() {
    draftParentIds = [...parentIds];
    parentError = '';
    editingParents = true;
  }

  async function saveParents() {
    if (!tag) return;
    parentError = '';
    // Insert-time cycle check: a courtesy, not a guarantee — the other device's
    // conflicting edge may not have arrived. reconcileTagParents is the backstop.
    for (const id of draftParentIds) {
      if (id !== tag.id && (await wouldCycle(tag.id, id))) {
        const name = allTags.find((t) => t.id === id)?.name ?? 'that tag';
        parentError = `“${name}” is already nested under ${tag.name}, so this would make a loop.`;
        return;
      }
    }
    savingParents = true;
    try {
      await setTagParents(tag.id, draftParentIds);
      editingParents = false;
      await loadHierarchy();
      await loadLinks();
    } finally {
      savingParents = false;
    }
  }

  async function saveNotes(md: string) {
    if (!tag) return;
    tag = await put('tags', { ...tag, notes_md: md });
  }

  function onRowChange(updated: Link) {
    links = links.map((l) => (l.id === updated.id ? updated : l));
    inherited = inherited.map((r) => (r.link.id === updated.id ? { ...r, link: updated } : r));
  }
</script>

{#if missing}
  <p class="empty">Tag not found. <a href="./..">Back to tags.</a></p>
{:else if tag}
  <div class="stack">
    <h1>{tag.name}</h1>

    <Card title="Nesting">
      <div class="nest-row">
        <div class="nest-facts">
          <p class="nest-line">
            <span class="nest-label">Nested under</span>
            {#if parentTags.length > 0}
              {#each parentTags as p (p.id)}
                <a class="tag-chip" href={`${href('/tag/')}?id=${p.id}`}>{p.name}</a>
              {/each}
            {:else}
              <span class="muted">nothing — this is a top-level tag</span>
            {/if}
          </p>
          <p class="nest-line">
            <span class="nest-label">Child tags</span>
            {#if children.length > 0}
              {#each children as c (c.id)}
                <a class="tag-chip" href={`${href('/tag/')}?id=${c.id}`}>{c.name}</a>
              {/each}
            {:else}
              <span class="muted">none</span>
            {/if}
          </p>
        </div>
        <button class="btn" aria-expanded={editingParents} onclick={openParentEditor}>
          Edit parents
        </button>
      </div>

      {#if editingParents}
        <form
          class="parent-editor"
          aria-label="Parent tags"
          onsubmit={(e) => {
            e.preventDefault();
            void saveParents();
          }}
        >
          <span class="field-label">
            Parent tags — filtering a parent also returns this tag's links
          </span>
          <ChipSelect
            items={parentOptions}
            bind:selected={draftParentIds}
            createPlaceholder="New tag…"
            onCreate={createTag}
          />
          {#if parentError}
            <p class="error" role="alert">{parentError}</p>
          {/if}
          <div class="form-foot">
            <button type="button" class="btn" onclick={() => (editingParents = false)}>
              Cancel
            </button>
            <button type="submit" class="btn btn-primary" disabled={savingParents}>
              {savingParents ? 'Saving…' : 'Save parents'}
            </button>
          </div>
        </form>
      {/if}
    </Card>

    <Card title="About this tag">
      <MarkdownEditor
        value={tag.notes_md}
        placeholder="Notes about this tag…"
        exportName={tag.name}
        onChange={saveNotes}
      />
    </Card>

    <Card title="Export">
      <p class="muted section-hint">
        Everything filed under {tag.name}: the child tags and counts as
        metadata, the notes above as an About section, then a table of the
        direct links and one of the links reaching it through a child tag —
        favourites first, then read, then unread. HTML is a single
        self-contained page whose tables filter and sort offline and export
        their own CSV.
      </p>
      {#if topics.length > 0}
        <div class="export-options">
          <ToggleSwitch
            bind:checked={embedTopics}
            label="Include each topic's full document"
            hint="Sections at the bottom of the Markdown; a click-to-read modal in the HTML."
          />
          <ToggleSwitch
            bind:checked={topicsAsFiles}
            disabled={!embedTopics}
            label="One file per topic, bundled as a zip"
            hint="Markdown only. The tag keeps the topic index; the documents become their own files."
          />
        </div>
      {/if}
      <div class="export-actions">
        <button class="btn" disabled={!!exporting} onclick={() => void exportTag('md')}>
          {exporting === 'md' ? 'Exporting…' : 'Markdown'}
        </button>
        <button class="btn" disabled={!!exporting} onclick={() => void exportTag('html')}>
          {exporting === 'html' ? 'Exporting…' : 'HTML'}
        </button>
      </div>
    </Card>

    {#if topics.length > 0}
      <Card title={`Topics (${topics.length.toLocaleString()})`}>
        <p class="muted section-hint">
          Long-form documents tagged {tag.name}.
        </p>
        <ul class="topic-list">
          {#each topics as t (t.id)}
            <li class:done={topicStatus(t) === 'done'}>
              <a class="inherited-title" href={`${href('/topic/')}?id=${t.id}`}>{t.name}</a>
              {#if topicStatus(t)}
                <span class="status" class:done={topicStatus(t) === 'done'}>
                  {topicStatus(t) === 'done' ? 'Done' : 'In progress'}
                </span>
              {/if}
            </li>
          {/each}
        </ul>
      </Card>
    {/if}

    <Card title={`Links (${links.length.toLocaleString()})`}>
      <LinkList links={visible} {tagsByLink} onChange={onRowChange} empty="No links carry this tag yet." />
      <Pagination total={links.length} pageSize={PAGE_SIZE} bind:page label="links" />
    </Card>

    {#if inherited.length > 0}
      <Card title={`From child tags (${inherited.length.toLocaleString()})`}>
        <p class="muted section-hint">
          Links that reach {tag.name} through a nested tag. Anything tagged
          {tag.name} directly is listed above instead, never in both.
        </p>
        <ul class="inherited">
          {#each inherited as row (row.link.id)}
            <li>
              <a class="inherited-title" href={`${href('/link/')}?id=${row.link.id}`}>
                {row.link.title}
              </a>
              <span class="via">
                via
                {#each row.via as v (v.id)}
                  <a class="tag-chip" href={`${href('/tag/')}?id=${v.id}`}>{v.name}</a>
                {/each}
              </span>
            </li>
          {/each}
        </ul>
      </Card>
    {/if}
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

  .nest-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .nest-facts {
    min-width: 0;
  }

  .nest-line {
    margin: 0 0 var(--space-2);
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .nest-label {
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
    font-weight: 600;
  }

  .tag-chip {
    background: var(--color-primary-soft);
    color: var(--color-primary-strong);
    border-radius: var(--radius-full);
    padding: 0 var(--space-2);
    font-size: var(--font-size-sm);
    text-decoration: none;
  }

  .parent-editor {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding-top: var(--space-3);
    margin-top: var(--space-3);
    border-top: 1px solid var(--border-color);
  }

  .field-label {
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
    font-weight: 600;
  }

  .error {
    margin: 0;
    color: var(--color-danger, #b3261e);
    font-size: var(--font-size-sm);
  }

  .form-foot {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-3);
  }

  .section-hint {
    margin: 0 0 var(--space-3);
    font-size: var(--font-size-sm);
  }

  .export-options {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
  }

  .export-actions {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .topic-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .topic-list li {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--border-color);
  }

  .topic-list li:last-child {
    border-bottom: none;
  }

  .topic-list .status {
    border: 1px solid var(--color-primary);
    border-radius: var(--radius-full);
    background: var(--color-primary-soft);
    color: var(--color-primary-strong);
    font-size: var(--font-size-sm);
    font-weight: 600;
    padding: 0 var(--space-2);
    line-height: 1.7;
  }

  .topic-list .status.done {
    border-color: var(--border-color);
    background: transparent;
    color: var(--text-muted-color);
    font-weight: 400;
    opacity: 0.8;
  }

  /* Same recede-don't-hide treatment the topics overview gives a done row. */
  .topic-list li.done .inherited-title {
    color: var(--text-muted-color);
    font-weight: 400;
  }

  .topic-list li.done .inherited-title:hover {
    color: var(--color-primary-strong);
  }

  .inherited {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .inherited li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--border-color);
  }

  .inherited li:last-child {
    border-bottom: none;
  }

  .inherited-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .via {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-shrink: 0;
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
  }
</style>
