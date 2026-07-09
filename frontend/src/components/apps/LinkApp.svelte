<script lang="ts">
  /**
   * Link detail: edit title/url and flags, assign tags/topics, keep excerpts
   * (notable quotations) and a free-form note. The note row is created
   * lazily on first edit; both prose fields autosave via MarkdownEditor's
   * debounced onChange.
   */
  import { onMount } from 'svelte';
  import Card from '../Card.svelte';
  import MarkdownEditor from '../MarkdownEditor.svelte';
  import TagPicker from '../TagPicker.svelte';
  import TopicPicker from '../TopicPicker.svelte';
  import { byIndex, get, put, softDelete, withSyncFields } from '../../lib/db/repo';
  import { domainOf, toggleFavourite, toggleRead, toggleResource } from '../../lib/services/links';
  import { weekHistoryForLink, type HistoryEntry } from '../../lib/services/weeks';
  import type { Excerpt, Link, Note } from '../../lib/db/types';

  let link = $state<Link | null>(null);
  let note = $state<Note | null>(null);
  let excerpts = $state<Excerpt[]>([]);
  let history = $state<HistoryEntry[]>([]);
  let missing = $state(false);
  // Editing title/url is explicit (form + save) since it's rare.
  let editingMeta = $state(false);
  let editTitle = $state('');
  let editUrl = $state('');

  onMount(async () => {
    const id = new URLSearchParams(location.search).get('id');
    if (!id) {
      missing = true;
      return;
    }
    link = (await get<Link>('links', id)) ?? null;
    if (!link) {
      missing = true;
      return;
    }
    const notes = await byIndex<Note>('notes', 'link_id', id);
    note = notes[0] ?? null;
    excerpts = (await byIndex<Excerpt>('excerpts', 'link_id', id)).sort(
      (a, b) => a.position - b.position
    );
    history = await weekHistoryForLink(id);
  });

  function describeHistory(h: HistoryEntry): string {
    const kind = h.entry.kind === 'review' ? 'review' : 'reading';
    if (h.entry.outcome === 'read') return `${kind} — done`;
    if (h.entry.outcome === 'slushed') return `${kind} — done, slushed`;
    if (h.entry.outcome === 'rolled') return `${kind} — not finished, returned to backlog`;
    return h.entry.done_at ? `${kind} — done` : `${kind} — in progress`;
  }

  function formatWeek(weekStart: string): string {
    return new Date(`${weekStart}T00:00:00`).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  }

  async function saveNote(md: string) {
    if (!link) return;
    if (note) {
      note = await put('notes', { ...note, body_md: md });
    } else if (md.trim()) {
      note = await put('notes', withSyncFields({ link_id: link.id, body_md: md }));
    }
  }

  async function addExcerpt() {
    if (!link) return;
    const position = excerpts.length > 0 ? excerpts[excerpts.length - 1].position + 1 : 0;
    const row = await put(
      'excerpts',
      withSyncFields({ link_id: link.id, content_md: '', position })
    );
    excerpts = [...excerpts, row];
  }

  async function saveExcerpt(excerpt: Excerpt, md: string) {
    const updated = await put('excerpts', { ...excerpt, content_md: md });
    excerpts = excerpts.map((e) => (e.id === updated.id ? updated : e));
  }

  async function deleteExcerpt(excerpt: Excerpt) {
    await softDelete('excerpts', excerpt.id);
    excerpts = excerpts.filter((e) => e.id !== excerpt.id);
  }

  function startEditMeta() {
    if (!link) return;
    editTitle = link.title;
    editUrl = link.url;
    editingMeta = true;
  }

  async function saveMeta() {
    if (!link) return;
    link = await put('links', { ...link, title: editTitle.trim() || link.url, url: editUrl.trim() });
    editingMeta = false;
  }
</script>

{#if missing}
  <p class="empty">Link not found. <a href="./..">Back to the backlog.</a></p>
{:else if link}
  <div class="stack">
    <Card>
      {#if editingMeta}
        <form
          class="meta-form"
          onsubmit={(e) => {
            e.preventDefault();
            void saveMeta();
          }}
        >
          <input type="text" bind:value={editTitle} placeholder="Title" />
          <input type="url" bind:value={editUrl} placeholder="URL" required />
          <div class="meta-actions">
            <button type="button" class="btn" onclick={() => (editingMeta = false)}>Cancel</button>
            <button type="submit" class="btn btn-primary">Save</button>
          </div>
        </form>
      {:else}
        <div class="header">
          <div class="header-main">
            <a class="title" href={link.url} target="_blank" rel="noopener noreferrer">
              {link.title}
            </a>
            <span class="domain">{domainOf(link.url)}</span>
          </div>
          <button class="btn" onclick={startEditMeta}>Edit</button>
        </div>
      {/if}
      <div class="flags">
        <button
          class="flag"
          class:active={!!link.read_at}
          onclick={async () => (link = await toggleRead(link!))}
        >
          ✓ {link.read_at ? 'Read' : 'Unread'}
        </button>
        <button
          class="flag"
          class:active={link.favourite}
          onclick={async () => (link = await toggleFavourite(link!))}
        >
          ★ Favourite
        </button>
        <button
          class="flag"
          class:active={link.is_resource}
          onclick={async () => (link = await toggleResource(link!))}
        >
          ⚒ Resource
        </button>
      </div>
    </Card>

    <Card title="Tags">
      <TagPicker linkId={link.id} />
    </Card>

    <Card title="Topics">
      <TopicPicker linkId={link.id} />
    </Card>

    <Card title="Excerpts">
      <div class="excerpts">
        {#each excerpts as excerpt (excerpt.id)}
          <div class="excerpt">
            <MarkdownEditor
              value={excerpt.content_md}
              placeholder="Notable quotation…"
              exportName={`${link.title} excerpt`}
              onChange={(md) => saveExcerpt(excerpt, md)}
            />
            <button class="btn btn-danger" onclick={() => deleteExcerpt(excerpt)}>Delete</button>
          </div>
        {/each}
        <button class="btn" onclick={addExcerpt}>+ Add excerpt</button>
      </div>
    </Card>

    <Card title="Notes">
      <MarkdownEditor
        value={note?.body_md ?? ''}
        placeholder="Notes about this link…"
        exportName={link.title}
        onChange={saveNote}
      />
    </Card>

    <Card title="History">
      {#if history.length === 0}
        <p class="empty">Never scheduled into a week yet.</p>
      {:else}
        <ul class="history">
          {#each history as h (h.entry.id)}
            <li>
              <span class="history-week">Week of {formatWeek(h.week.week_start)}</span>
              <span class="history-detail">{describeHistory(h)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </Card>
  </div>
{/if}

<style>
  .stack {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .empty {
    color: var(--text-muted-color);
    text-align: center;
    padding: var(--space-5) 0;
  }

  .header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .header-main {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .title {
    font-size: var(--font-size-lg);
    font-weight: 700;
    color: var(--text-color);
    text-decoration: none;
    overflow-wrap: anywhere;
  }

  .title:hover {
    color: var(--color-primary-strong);
    text-decoration: underline;
  }

  .domain {
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
  }

  .meta-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .meta-form input {
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    background: var(--surface-color);
    color: var(--text-color);
  }

  .meta-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
  }

  .flags {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-top: var(--space-3);
  }

  .flag {
    border: 1px solid var(--border-color);
    border-radius: var(--radius-full);
    background: var(--surface-color);
    padding: var(--space-1) var(--space-3);
    font-size: var(--font-size-sm);
    font-weight: 600;
    cursor: pointer;
    color: var(--text-muted-color);
  }

  .flag:hover {
    border-color: var(--color-primary);
  }

  .flag.active {
    background: var(--color-primary-soft);
    border-color: var(--color-primary);
    color: var(--color-primary-strong);
  }

  .excerpts {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .excerpt {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    align-items: flex-end;
  }

  .excerpt :global(.editor) {
    width: 100%;
  }

  .history {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .history li {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
    padding: var(--space-1) 0;
    border-bottom: 1px solid var(--border-color);
  }

  .history li:last-child {
    border-bottom: none;
  }

  .history-week {
    font-weight: 600;
  }

  .history-detail {
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
  }
</style>
