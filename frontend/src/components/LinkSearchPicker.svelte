<script lang="ts">
  /**
   * "Paste a URL to add, or search your links…" — the one adder used by the
   * reading list, topic pages, and resource lists.
   *
   * Two modes off one input, decided by whether what you typed parses as an
   * http(s) URL: paste a URL and you get an **Add link** button (capture +
   * attach); type anything else and you get a live result list from the
   * corpus the caller hands in.
   *
   * Results are scrollable and paged. The old inline copies of this markup
   * hard-capped at eight rows with no way to see the ninth, which on a
   * multi-thousand-link library meant the link you wanted was often simply
   * unreachable. `searchLinkCorpus` scans only as far as the current page
   * needs (links.ts), so "show more" stays cheap.
   */
  import { domainOf, searchLinkCorpus } from '../lib/services/links';
  import type { Link, Tag } from '../lib/db/types';

  /** Rows per page — enough to fill the scroll box, small enough to stay fast. */
  const PAGE_SIZE = 25;

  let {
    corpus,
    query = $bindable(''),
    exclude,
    accept,
    tagsByLink,
    placeholder = 'Paste a URL to add, or search your links…',
    noMatchText = 'No links match — paste a full URL to add a new one.',
    adding = false,
    onSelect,
    onAddUrl,
    onFocus,
  }: {
    /** Everything searchable. The caller decides when to load it. */
    corpus: readonly Link[];
    /** The typed text; bindable so the caller can clear it after adding. */
    query?: string;
    /** Ids to leave out — already a member/assignee/entry. */
    exclude?: ReadonlySet<string>;
    /** Extra predicate, e.g. the week adder skipping slushed links. */
    accept?: (link: Link) => boolean;
    /** Optional tag map; present links also match on tag name. */
    tagsByLink?: ReadonlyMap<string, Tag[]>;
    placeholder?: string;
    noMatchText?: string;
    /** True while the caller is capturing a pasted URL. */
    adding?: boolean;
    onSelect: (link: Link) => void | Promise<void>;
    onAddUrl: (url: string) => void | Promise<void>;
    /** Fired on first focus — WeekApp uses it to lazy-load the corpus. */
    onFocus?: () => void;
  } = $props();

  /** How many results are on screen; grows by PAGE_SIZE via "show more". */
  let shown = $state(PAGE_SIZE);

  const queryIsUrl = $derived.by(() => {
    try {
      const u = new URL(query.trim());
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  });

  const page = $derived(
    queryIsUrl
      ? { results: [], hasMore: false }
      : searchLinkCorpus(corpus, query, shown, { exclude, accept, tagsByLink })
  );

  // A new search starts at page one again — otherwise a wide query typed
  // after a narrow one would keep whatever depth the last one was expanded to.
  $effect(() => {
    void query;
    shown = PAGE_SIZE;
  });
</script>

<form
  class="adder"
  onsubmit={(e) => {
    e.preventDefault();
    if (queryIsUrl) void onAddUrl(new URL(query.trim()).toString());
  }}
>
  <input type="text" {placeholder} bind:value={query} onfocus={() => onFocus?.()} />
  {#if queryIsUrl}
    <button type="submit" class="btn btn-primary" disabled={adding}>
      {adding ? 'Adding…' : 'Add link'}
    </button>
  {/if}
</form>

{#if page.results.length > 0}
  <div class="matches-box">
    <ul class="matches">
      {#each page.results as match (match.id)}
        <li>
          <button type="button" class="match" onclick={() => void onSelect(match)}>
            <span class="match-title">{match.title}</span>
            <span class="match-domain">{domainOf(match.url)}</span>
          </button>
        </li>
      {/each}
    </ul>
    {#if page.hasMore}
      <button type="button" class="more" onclick={() => (shown += PAGE_SIZE)}>
        Show more results
      </button>
    {/if}
  </div>
{:else if query.trim() && !queryIsUrl}
  <p class="no-match">{noMatchText}</p>
{/if}

<style>
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

  .matches-box {
    margin: 0 0 var(--space-3);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  /*
   * The scroll box. Capped in rem rather than by row count so it stays a
   * sane fraction of the viewport whatever the row height ends up being;
   * "show more" is what reaches past it.
   */
  .matches {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 22rem;
    overflow-y: auto;
    overscroll-behavior: contain;
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

  .more {
    display: block;
    width: 100%;
    padding: var(--space-2);
    border: none;
    border-top: 1px solid var(--border-color);
    background: var(--bg-color);
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }

  .more:hover {
    background: var(--color-primary-soft);
    color: var(--text-color);
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
