<script lang="ts">
  /**
   * Inbox: subscribed feeds and the items awaiting triage.
   *
   * Every item is one of three things — something to read this week, something
   * for the backlog, or something you don't care about — so the row is three
   * buttons and nothing else. Triaged items stay browsable (with undo) behind
   * the view switch; only 'new' shows by default.
   */
  import { onMount } from 'svelte';
  import Card from '../Card.svelte';
  import SearchInput from '../SearchInput.svelte';
  import {
    DEFAULT_IMPORT_DAYS,
    IMPORT_DAY_CHOICES,
    addFeed,
    feedStates,
    countByFeed,
    ignoreAll,
    inboxEntries,
    listFeeds,
    maybeRefreshDueFeeds,
    newCountsByFeed,
    refreshFeeds,
    removeFeed,
    renameFeed,
    savedLinksFor,
    setFeedPaused,
    triageItem,
    untriageItem,
    type FeedState,
    type InboxEntry,
  } from '../../lib/services/feeds';
  import { currentWeekStart, formatWeekRange, upcomingWeekOptions } from '../../lib/services/weeks';
  import { getSyncMode } from '../../lib/sync';
  import { href } from '../../lib/paths';
  import type { Feed, FeedItemStatus, Link } from '../../lib/db/types';

  let feeds = $state<Feed[]>([]);
  let states = $state<Map<string, FeedState>>(new Map());
  let counts = $state<Map<string, number>>(new Map());
  let entries = $state<InboxEntry[]>([]);
  let savedLinks = $state<Map<string, Link>>(new Map());
  let loading = $state(true);
  let busy = $state(false);
  let notice = $state('');
  let error = $state('');

  // Add-feed form
  let newUrl = $state('');
  let newDays = $state<number>(DEFAULT_IMPORT_DAYS);
  let adding = $state(false);

  // Feed list editing
  let renamingId = $state<string | null>(null);
  let renameValue = $state('');
  let showFeeds = $state(true);

  // Item list
  let view = $state<FeedItemStatus>('new');
  let search = $state('');
  let feedFilter = $state('');
  let weekStart = $state(currentWeekStart());

  /**
   * No sync server configured. Feeds still work — the browser fetches them
   * itself — but only for sites whose CORS headers allow it, so the page says
   * so up front rather than letting each feed fail mysteriously.
   */
  const noServer = $derived(getSyncMode() === 'offline');
  const weekOptions = upcomingWeekOptions();

  const visible = $derived(
    entries.filter((e) => {
      if (feedFilter && e.item.feed_id !== feedFilter) return false;
      const q = search.trim().toLowerCase();
      if (!q) return true;
      return (
        e.item.title.toLowerCase().includes(q) ||
        e.item.url.toLowerCase().includes(q) ||
        e.item.summary.toLowerCase().includes(q) ||
        e.feed.title.toLowerCase().includes(q)
      );
    })
  );

  const newTotal = $derived([...counts.values()].reduce((n, c) => n + c, 0));

  onMount(async () => {
    await reload();
    loading = false;
    // The once-a-day check for every feed this device hasn't looked at
    // recently. Skipped in test mode and while the browser is disconnected.
    const results = await maybeRefreshDueFeeds(feeds);
    if (results.length > 0) {
      const imported = results.reduce((n, r) => n + r.imported, 0);
      const failed = results.filter((r) => r.error).length;
      notice =
        `Checked ${results.length} feed${results.length === 1 ? '' : 's'}: ` +
        `${imported} new item${imported === 1 ? '' : 's'}` +
        (failed ? `, ${failed} couldn't be reached` : '') +
        '.';
      await reload();
    }
  });

  async function reload() {
    // One reconcile, one pass: listFeeds() folds duplicate subscriptions, and
    // everything below reuses that list instead of re-reading the feeds.
    feeds = await listFeeds();
    const [nextStates, nextEntries] = await Promise.all([
      feedStates(),
      inboxEntries(view, feeds),
    ]);
    states = nextStates;
    entries = nextEntries;
    // In the default view the entries ARE the untriaged items, so the per-feed
    // counts fall out of the list already read.
    counts = view === 'new' ? countByFeed(nextEntries) : await newCountsByFeed(feeds);
    // Only the triaged views need the "where did it go" link; the inbox
    // proper is by definition items you don't have yet.
    savedLinks = view === 'new' ? new Map() : await savedLinksFor(entries.map((e) => e.item));
  }

  async function withBusy(fn: () => Promise<void>) {
    busy = true;
    error = '';
    try {
      await fn();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  async function submitFeed(e: SubmitEvent) {
    e.preventDefault();
    if (!newUrl.trim()) return;
    adding = true;
    error = '';
    notice = '';
    try {
      const result = await addFeed(newUrl, newDays);
      notice =
        `Subscribed to “${result.feed.title}” — imported ${result.imported} item` +
        `${result.imported === 1 ? '' : 's'}` +
        (result.outsideWindow ? `, skipped ${result.outsideWindow} older than the window` : '') +
        '.';
      newUrl = '';
      await reload();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      adding = false;
    }
  }

  function refreshAll() {
    return withBusy(async () => {
      notice = '';
      const results = await refreshFeeds(feeds);
      const imported = results.reduce((n, r) => n + r.imported, 0);
      const failed = results.filter((r) => r.error);
      notice =
        `Refreshed ${results.length} feed${results.length === 1 ? '' : 's'}: ` +
        `${imported} new item${imported === 1 ? '' : 's'}.`;
      if (failed.length) error = failed.map((f) => `${f.feed.title}: ${f.error}`).join(' · ');
      await reload();
    });
  }

  function refreshOne(feed: Feed) {
    return withBusy(async () => {
      notice = '';
      const [result] = await refreshFeeds([{ ...feed, paused: false }]);
      if (result?.error) error = result.error;
      else notice = `${feed.title}: ${result?.imported ?? 0} new.`;
      await reload();
    });
  }

  function triage(entry: InboxEntry, action: 'week' | 'backlog' | 'ignore') {
    return withBusy(async () => {
      await triageItem(entry.item, action, action === 'week' ? weekStart : null);
      // Drop it from the list — and decrement its feed — rather than re-reading
      // every feed's items to learn what we already know.
      entries = entries.filter((e) => e.item.id !== entry.item.id);
      counts = bumpCount(entry.item.feed_id, -1);
    });
  }

  /** Adjust one feed's untriaged count in place (never below zero). */
  function bumpCount(feedId: string, delta: number): Map<string, number> {
    const next = new Map(counts);
    next.set(feedId, Math.max(0, (next.get(feedId) ?? 0) + delta));
    return next;
  }

  function undo(entry: InboxEntry) {
    return withBusy(async () => {
      await untriageItem(entry.item);
      entries = entries.filter((e) => e.item.id !== entry.item.id);
      counts = bumpCount(entry.item.feed_id, 1);
    });
  }

  function dismissAll() {
    const scope = feedFilter ? feeds.find((f) => f.id === feedFilter)?.title : 'the whole inbox';
    if (!confirm(`Ignore every untriaged item in ${scope}?`)) return;
    return withBusy(async () => {
      const n = await ignoreAll(feedFilter || undefined, feeds);
      notice = `Ignored ${n} item${n === 1 ? '' : 's'}.`;
      await reload();
    });
  }

  function remove(feed: Feed) {
    if (!confirm(`Unsubscribe from “${feed.title}”? Its inbox items go too; saved links stay.`)) {
      return;
    }
    return withBusy(async () => {
      await removeFeed(feed);
      if (feedFilter === feed.id) feedFilter = '';
      await reload();
    });
  }

  function saveRename(feed: Feed) {
    const title = renameValue;
    renamingId = null;
    return withBusy(async () => {
      await renameFeed(feed, title);
      await reload();
    });
  }

  function togglePause(feed: Feed) {
    return withBusy(async () => {
      await setFeedPaused(feed, !feed.paused);
      await reload();
    });
  }

  async function switchView(next: FeedItemStatus) {
    view = next;
    await withBusy(reload);
  }

  const dateOf = (entry: InboxEntry): string => {
    const raw = entry.item.published_at ?? entry.item.fetched_at;
    return new Date(raw).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const lastChecked = (feed: Feed): string => {
    const state = states.get(feed.id);
    if (!state) return 'not checked yet';
    const when = new Date(state.last_checked_at).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    return state.ok ? `checked ${when}` : `failed ${when}`;
  };
</script>

<div class="stack">
  {#if noServer}
    <p class="banner">
      No sync server, so this device fetches feeds <strong>itself</strong>.
      That works for any site that allows it — some don't (their choice, not
      readerr's), and those say so when you add them. A
      <a href={href('/settings/')}>sync server</a> can fetch any feed on your
      behalf.
    </p>
  {/if}

  {#if error}
    <p class="banner banner-error">{error}</p>
  {/if}
  {#if notice}
    <p class="banner banner-ok">{notice}</p>
  {/if}

  <Card title={`Feeds (${feeds.length})`}>
    <form class="add-feed" onsubmit={submitFeed}>
      <input
        type="text"
        placeholder="https://blog.cloudflare.com/rss/"
        bind:value={newUrl}
        disabled={adding}
      />
      <label class="days">
        pull last
        <select bind:value={newDays} disabled={adding}>
          {#each IMPORT_DAY_CHOICES as days (days)}
            <option value={days}>{days === 0 ? 'nothing' : `${days} days`}</option>
          {/each}
        </select>
      </label>
      <button type="submit" class="btn btn-primary" disabled={adding || !newUrl.trim()}>
        {adding ? 'Adding…' : 'Add feed'}
      </button>
    </form>

    {#if loading}
      <p class="empty">Loading…</p>
    {:else if feeds.length === 0}
      <p class="empty">
        No feeds yet. Paste a feed URL above — most blogs publish one at
        <code>/rss/</code>, <code>/feed/</code>, or <code>/atom.xml</code>.
      </p>
    {:else}
      <div class="list-head">
        <button class="btn" onclick={refreshAll} disabled={busy}>
          {busy ? 'Working…' : 'Refresh all'}
        </button>
        <label class="toggle">
          <input type="checkbox" bind:checked={showFeeds} />
          Show feed list
        </label>
      </div>
      {#if showFeeds}
        <ul class="feed-list">
          {#each feeds as feed (feed.id)}
            <li class:paused={feed.paused}>
              {#if renamingId === feed.id}
                <form
                  class="rename"
                  onsubmit={(e) => {
                    e.preventDefault();
                    void saveRename(feed);
                  }}
                >
                  <input type="text" bind:value={renameValue} />
                  <button type="submit" class="btn">Save</button>
                  <button type="button" class="btn" onclick={() => (renamingId = null)}>
                    Cancel
                  </button>
                </form>
              {:else}
                <div class="feed-main">
                  <span class="feed-title">
                    {#if feed.site_url}
                      <a href={feed.site_url} target="_blank" rel="noreferrer noopener">
                        {feed.title}
                      </a>
                    {:else}
                      {feed.title}
                    {/if}
                  </span>
                  <span class="feed-meta">
                    {counts.get(feed.id) ?? 0} new · {lastChecked(feed)}
                    {#if feed.paused}· paused{/if}
                  </span>
                  {#if states.get(feed.id)?.error}
                    <span class="feed-error">{states.get(feed.id)?.error}</span>
                  {/if}
                </div>
                <span class="row-actions">
                  <button class="btn" onclick={() => (feedFilter = feedFilter === feed.id ? '' : feed.id)}>
                    {feedFilter === feed.id ? 'Show all' : 'Only this'}
                  </button>
                  <button class="btn" onclick={() => refreshOne(feed)} disabled={busy}>
                    Refresh
                  </button>
                  <button class="btn" onclick={() => togglePause(feed)} disabled={busy}>
                    {feed.paused ? 'Resume' : 'Pause'}
                  </button>
                  <button
                    class="btn"
                    onclick={() => {
                      renamingId = feed.id;
                      renameValue = feed.title;
                    }}
                  >
                    Rename
                  </button>
                  <button class="btn btn-danger" onclick={() => remove(feed)} disabled={busy}>
                    Remove
                  </button>
                </span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </Card>

  <Card
    title={view === 'new'
      ? `Inbox (${visible.length.toLocaleString()}${newTotal !== visible.length ? ` of ${newTotal.toLocaleString()}` : ''})`
      : `${view === 'added' ? 'Added' : 'Ignored'} (${visible.length.toLocaleString()})`}
  >
    <div class="views">
      {#each [['new', 'To triage'], ['added', 'Added'], ['ignored', 'Ignored']] as [value, label] (value)}
        <button
          class="btn"
          class:active={view === value}
          onclick={() => switchView(value as FeedItemStatus)}
        >
          {label}
        </button>
      {/each}
    </div>

    <div class="filters">
      <SearchInput bind:value={search} placeholder="Search items…" />
      <label class="week-pick">
        add to
        <select bind:value={weekStart} aria-label="Reading week for the → Week button">
          {#each weekOptions as opt (opt.value)}
            <option value={opt.value}>{opt.label}</option>
          {/each}
        </select>
      </label>
    </div>

    {#if feedFilter}
      <p class="hint">
        Showing {feeds.find((f) => f.id === feedFilter)?.title ?? 'one feed'} only.
        <button class="btn" onclick={() => (feedFilter = '')}>Clear</button>
      </p>
    {/if}

    {#if loading}
      <p class="empty">Loading…</p>
    {:else if visible.length === 0}
      <p class="empty">
        {#if view === 'new'}
          {entries.length === 0
            ? 'Nothing waiting — the inbox is clear.'
            : 'Nothing matches that search.'}
        {:else}
          Nothing here.
        {/if}
      </p>
    {:else}
      <ul class="item-list">
        {#each visible as entry (entry.item.id)}
          <li>
            <div class="item-main">
              <a class="item-title" href={entry.item.url} target="_blank" rel="noreferrer noopener">
                {entry.item.title}
              </a>
              <span class="item-meta">
                {entry.feed.title} · {dateOf(entry)}
                {#if savedLinks.get(entry.item.id)}
                  · <a href={href(`/link/?id=${savedLinks.get(entry.item.id)!.id}`)}>in your library</a>
                {/if}
              </span>
              {#if entry.item.summary}
                <p class="item-summary">{entry.item.summary}</p>
              {/if}
            </div>
            <div class="item-actions">
              {#if view === 'new'}
                <button class="btn btn-primary" onclick={() => triage(entry, 'week')} disabled={busy}>
                  → {formatWeekRange(weekStart)}
                </button>
                <button class="btn" onclick={() => triage(entry, 'backlog')} disabled={busy}>
                  → Backlog
                </button>
                <button class="btn" onclick={() => triage(entry, 'ignore')} disabled={busy}>
                  Ignore
                </button>
              {:else}
                <button class="btn" onclick={() => undo(entry)} disabled={busy}>
                  Back to inbox
                </button>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
      {#if view === 'new'}
        <div class="bulk">
          <button class="btn btn-danger" onclick={dismissAll} disabled={busy}>
            Ignore everything {feedFilter ? 'in this feed' : 'shown'}
          </button>
        </div>
      {/if}
    {/if}
  </Card>
</div>

<style>
  .stack {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .banner {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    background: var(--color-primary-soft);
    border: 1px solid var(--color-primary);
  }

  .banner-error {
    background: var(--surface-raised-color);
    border-color: var(--color-danger);
    color: var(--color-danger);
  }

  .banner-ok {
    background: var(--surface-raised-color);
  }

  .add-feed {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
  }

  .add-feed input[type='text'] {
    flex: 1;
    min-width: 14rem;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    background: var(--surface-color);
    color: var(--text-color);
  }

  .days,
  .week-pick {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
  }

  .days select,
  .week-pick select {
    width: auto;
    margin: 0;
  }

  .list-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    margin-bottom: var(--space-2);
  }

  .toggle {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
  }

  .feed-list,
  .item-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .feed-list li,
  .item-list li {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--border-color);
  }

  .feed-list li:last-child,
  .item-list li:last-child {
    border-bottom: none;
  }

  .feed-list li.paused {
    opacity: 0.6;
  }

  .feed-main,
  .item-main {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }

  .feed-title,
  .item-title {
    font-weight: 600;
    color: var(--text-color);
    text-decoration: none;
  }

  .feed-title a,
  .item-title {
    color: inherit;
    text-decoration: none;
  }

  .feed-title a:hover,
  .item-title:hover {
    color: var(--color-primary-strong);
    text-decoration: underline;
  }

  .feed-meta,
  .item-meta {
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
  }

  .feed-error {
    font-size: var(--font-size-sm);
    color: var(--color-danger);
  }

  .item-summary {
    margin: var(--space-1) 0 0;
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .row-actions,
  .item-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    justify-content: flex-end;
  }

  .views {
    display: flex;
    gap: var(--space-1);
    margin-bottom: var(--space-3);
  }

  .views .active {
    background: var(--color-primary-soft);
    color: var(--color-primary-strong);
  }

  .filters {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
    margin-bottom: var(--space-3);
  }

  .filters :global(.search) {
    flex: 1;
    min-width: 12rem;
  }

  .hint {
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
    margin: 0 0 var(--space-3);
  }

  .empty {
    color: var(--text-muted-color);
    text-align: center;
    padding: var(--space-5) 0;
  }

  .bulk {
    display: flex;
    justify-content: flex-end;
    margin-top: var(--space-3);
  }

  .rename {
    display: flex;
    gap: var(--space-2);
    flex: 1;
  }

  .rename input {
    flex: 1;
    min-width: 0;
    padding: var(--space-1) var(--space-3);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    background: var(--surface-color);
    color: var(--text-color);
  }
</style>
