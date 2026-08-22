/**
 * The inbox service (services/feeds.ts): fetching through the backend,
 * importing entries into rows, and triage.
 *
 * The rules worth pinning are the ones that decide whether an item can come
 * back after you've dealt with it: the per-feed guid check counts tombstones,
 * the add-time window is remembered on the feed so later refreshes don't drag
 * in the back catalogue, duplicate rows from two devices collapse onto the
 * most-decided triage state, and duplicate FEEDS fold onto one row with their
 * items re-pointed. Parsing itself lives in the backend (feed_test.go).
 */
import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDB } from '../src/lib/db/db';
import { STORES } from '../src/lib/db/types';
import { all, byIndex, put, softDelete, withSyncFields } from '../src/lib/db/repo';
import {
  DEFAULT_IMPORT_DAYS,
  FeedError,
  addFeed,
  dedupeItems,
  dueFeeds,
  fetchFeed,
  ignoreAll,
  importItems,
  inboxEntries,
  newCountsByFeed,
  normalizeFeedUrl,
  reconcileFeeds,
  removeFeed,
  triageItem,
  untriageItem,
  withScheme,
  type FetchedItem,
} from '../src/lib/services/feeds';
import type { Feed, FeedItem, Link, Week } from '../src/lib/db/types';

const NOW = new Date();
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

/**
 * sync.ts (reached through repo writes and fetchFeed) reads localStorage,
 * which Node doesn't have. Re-stubbed per test, since clearing the fetch stub
 * between tests clears every stubbed global with it.
 */
function stubStorage() {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, String(v)),
    removeItem: (k: string) => void storage.delete(k),
    clear: () => storage.clear(),
  });
  localStorage.setItem('readerr-sync-url', 'http://server.test');
  localStorage.setItem('readerr-sync-mode', 'sync');
}

beforeAll(stubStorage);

beforeEach(async () => {
  const db = await getDB();
  const names = [...Object.keys(STORES), 'archived_links', 'sync_meta', 'feed_state'];
  const tx = db.transaction(names, 'readwrite');
  for (const n of names) tx.objectStore(n).clear();
  await tx.done;
  vi.unstubAllGlobals();
  stubStorage();
});

function feedRow(over: Partial<Feed> = {}): Feed {
  return withSyncFields({
    title: 'Example Blog',
    feed_url: 'https://example.com/rss/',
    site_url: 'https://example.com/',
    added_at: NOW.toISOString(),
    since_at: daysAgo(DEFAULT_IMPORT_DAYS),
    paused: false,
    ...over,
  }) as Feed;
}

function entry(over: Partial<FetchedItem> = {}): FetchedItem {
  return {
    guid: 'guid-1',
    url: 'https://example.com/posts/1',
    title: 'First post',
    published_at: daysAgo(1),
    summary: 'A blurb.',
    ...over,
  };
}

/** Stub the backend's GET /feed with a fixed payload. */
function stubFeedEndpoint(payload: unknown, ok = true) {
  const fetchMock = vi.fn(async () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => payload,
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('normalizeFeedUrl / withScheme', () => {
  it('treats case, trailing slash, and fragment as noise', () => {
    expect(normalizeFeedUrl('HTTPS://Example.COM/rss/')).toBe(
      normalizeFeedUrl('https://example.com/rss')
    );
    expect(normalizeFeedUrl('https://example.com/rss#top')).toBe('https://example.com/rss');
  });

  it('keeps the query string — plenty of feeds live at ?feed=rss', () => {
    expect(normalizeFeedUrl('https://example.com/?feed=rss')).not.toBe(
      normalizeFeedUrl('https://example.com/')
    );
  });

  it('assumes https when no scheme is typed', () => {
    expect(withScheme('example.com/rss')).toBe('https://example.com/rss');
    expect(withScheme('http://example.com/rss')).toBe('http://example.com/rss');
  });
});

describe('fetchFeed', () => {
  it('returns the backend payload on success', async () => {
    stubFeedEndpoint({
      ok: true,
      title: 'Example Blog',
      site_url: 'https://example.com/',
      items: [entry()],
    });
    const fetched = await fetchFeed('https://example.com/rss/');
    expect(fetched.title).toBe('Example Blog');
    expect(fetched.items).toHaveLength(1);
  });

  it('surfaces the backend reason verbatim', async () => {
    stubFeedEndpoint({ ok: false, error: 'the feed returned HTTP 404' });
    await expect(fetchFeed('https://example.com/rss/')).rejects.toThrow('HTTP 404');
  });

  it('refuses in offline mode — the browser cannot read feeds itself', async () => {
    localStorage.setItem('readerr-sync-mode', 'offline');
    const fetchMock = stubFeedEndpoint({ ok: true, items: [] });
    await expect(fetchFeed('https://example.com/rss/')).rejects.toBeInstanceOf(FeedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('addFeed', () => {
  it('subscribes, imports inside the window, and skips older items', async () => {
    stubFeedEndpoint({
      ok: true,
      title: 'Example Blog',
      site_url: 'https://example.com/',
      items: [
        entry({ guid: 'a', published_at: daysAgo(2) }),
        entry({ guid: 'b', url: 'https://example.com/posts/2', published_at: daysAgo(100) }),
      ],
    });

    const result = await addFeed('example.com/rss/', 30);
    expect(result.imported).toBe(1);
    expect(result.outsideWindow).toBe(1);
    expect(result.feed.title).toBe('Example Blog');
    expect(result.feed.feed_url).toBe('https://example.com/rss/');

    const items = await all<FeedItem>('feed_items');
    expect(items.map((i) => i.guid)).toEqual(['a']);
    expect(items[0].status).toBe('new');
  });

  it('refuses a second subscription to the same feed and writes nothing', async () => {
    stubFeedEndpoint({ ok: true, title: 'Example Blog', items: [entry()] });
    await addFeed('https://example.com/rss/', 30);
    await expect(addFeed('HTTPS://example.com/rss', 30)).rejects.toThrow(/already subscribed/i);
    expect(await all<Feed>('feeds')).toHaveLength(1);
  });

  it('pull-nothing (0 days) still subscribes, importing only what comes later', async () => {
    stubFeedEndpoint({
      ok: true,
      title: 'Example Blog',
      items: [entry({ published_at: daysAgo(1) })],
    });
    const result = await addFeed('https://example.com/rss/', 0);
    expect(result.imported).toBe(0);
    expect(result.outsideWindow).toBe(1);
  });
});

describe('importItems', () => {
  it('skips guids it has already imported, tombstones included', async () => {
    const feed = await put<Feed>('feeds', feedRow());
    expect((await importItems(feed, [entry()])).imported).toBe(1);
    // Same entry again: no second row.
    expect((await importItems(feed, [entry()])).imported).toBe(0);

    // Now delete the row (the "I never want to see this" case) and re-fetch.
    const [item] = await all<FeedItem>('feed_items');
    await softDelete('feed_items', item.id);
    expect((await importItems(feed, [entry()])).imported).toBe(0);
    expect(await all<FeedItem>('feed_items')).toHaveLength(0);
  });

  it('imports an undated item rather than dropping it', async () => {
    const feed = await put<Feed>('feeds', feedRow());
    const result = await importItems(feed, [entry({ published_at: '' })]);
    expect(result.imported).toBe(1);
    expect((await all<FeedItem>('feed_items'))[0].published_at).toBeNull();
  });

  it('marks an item already in the library as added, so the inbox stays clean', async () => {
    const feed = await put<Feed>('feeds', feedRow());
    await put<Link>(
      'links',
      withSyncFields({
        url: 'https://example.com/posts/1',
        title: 'First post',
        title_fetched: true,
        added_at: NOW.toISOString(),
        read_at: null,
        favourite: false,
        is_resource: false,
        slushed_at: null,
        priority: null,
      }) as Link
    );

    await importItems(feed, [entry()]);
    const [item] = await all<FeedItem>('feed_items');
    expect(item.status).toBe('added');
    expect(await inboxEntries('new')).toHaveLength(0);
  });

  it('ignores a duplicated guid within one fetch', async () => {
    const feed = await put<Feed>('feeds', feedRow());
    const result = await importItems(feed, [entry(), entry({ title: 'Same guid' })]);
    expect(result.imported).toBe(1);
  });
});

describe('triage', () => {
  async function seedOneItem(): Promise<{ feed: Feed; item: FeedItem }> {
    const feed = await put<Feed>('feeds', feedRow());
    await importItems(feed, [entry({ title: 'Go 1.25 [release] notes' })]);
    const [item] = await all<FeedItem>('feed_items');
    return { feed, item };
  }

  it('backlog captures the item as a link and marks it added', async () => {
    const { item } = await seedOneItem();
    const result = await triageItem(item, 'backlog');
    expect(result.item?.status).toBe('added');
    expect(result.item?.triaged_at).toBeTruthy();
    const links = await all<Link>('links');
    expect(links).toHaveLength(1);
    // Brackets can't survive the capture DSL, so the exact title is restored.
    expect(links[0].title).toBe('Go 1.25 [release] notes');
    expect(links[0].title_fetched).toBe(true);
    expect(await inboxEntries('new')).toHaveLength(0);
  });

  it('week capture queues the link for that reading week', async () => {
    const { item } = await seedOneItem();
    await triageItem(item, 'week', '2026-08-17');
    const weeks = await all<Week>('weeks');
    expect(weeks).toHaveLength(1);
    expect(weeks[0].week_start).toBe('2026-08-17');
    expect(await all('week_links')).toHaveLength(1);
  });

  it('ignore saves nothing but keeps the item out of the inbox', async () => {
    const { item } = await seedOneItem();
    const result = await triageItem(item, 'ignore');
    expect(result.link).toBeNull();
    expect(await all<Link>('links')).toHaveLength(0);
    expect(await inboxEntries('new')).toHaveLength(0);
    expect(await inboxEntries('ignored')).toHaveLength(1);
  });

  it('undo puts an item back without touching the link it created', async () => {
    const { item } = await seedOneItem();
    await triageItem(item, 'backlog');
    const [saved] = await all<FeedItem>('feed_items');
    await untriageItem(saved);
    expect(await inboxEntries('new')).toHaveLength(1);
    expect(await all<Link>('links')).toHaveLength(1);
  });

  it('ignoreAll clears the untriaged items of one feed only', async () => {
    const feedA = await put<Feed>('feeds', feedRow());
    const feedB = await put<Feed>('feeds', feedRow({ feed_url: 'https://other.test/rss' }));
    await importItems(feedA, [entry({ guid: 'a1' }), entry({ guid: 'a2', url: 'https://example.com/posts/2' })]);
    await importItems(feedB, [entry({ guid: 'b1', url: 'https://other.test/posts/1' })]);

    expect(await ignoreAll(feedA.id)).toBe(2);
    const counts = await newCountsByFeed();
    expect(counts.get(feedA.id)).toBeUndefined();
    expect(counts.get(feedB.id)).toBe(1);
  });
});

describe('convergence', () => {
  it('collapses duplicate (feed, guid) rows onto the most decided status', async () => {
    const feed = await put<Feed>('feeds', feedRow());
    // Two devices each imported the same entry; one of them triaged it.
    const base = { feed_id: feed.id, guid: 'g', url: 'https://example.com/posts/1', title: 'x',
      published_at: daysAgo(1), fetched_at: daysAgo(1), summary: '' };
    await put<FeedItem>('feed_items', withSyncFields({ ...base, status: 'new' as const, triaged_at: null }) as FeedItem);
    await put<FeedItem>(
      'feed_items',
      withSyncFields({ ...base, status: 'added' as const, triaged_at: NOW.toISOString() }) as FeedItem
    );

    const survivors = await dedupeItems(await byIndex<FeedItem>('feed_items', 'feed_id', feed.id));
    expect(survivors).toHaveLength(1);
    // 'added' wins: an item you have dealt with must not return to the inbox.
    expect(survivors[0].status).toBe('added');
    expect(await inboxEntries('new')).toHaveLength(0);
  });

  it('folds two subscriptions to the same URL and re-points their items', async () => {
    const a = await put<Feed>('feeds', feedRow({ title: 'Old name' }));
    const b = await put<Feed>('feeds', feedRow({ title: 'New name', feed_url: 'https://example.com/rss' }));
    await importItems(a, [entry({ guid: 'a1' })]);
    await importItems(b, [entry({ guid: 'b1', url: 'https://example.com/posts/2' })]);

    const feeds = await reconcileFeeds();
    expect(feeds).toHaveLength(1);
    const survivor = feeds[0];
    // Smallest id survives — the same choice on every device.
    expect(survivor.id).toBe([a.id, b.id].sort()[0]);
    const items = await all<FeedItem>('feed_items');
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.feed_id === survivor.id)).toBe(true);
    // The narrower of the two windows never wins: history stays visible.
    expect(survivor.since_at <= a.since_at).toBe(true);
  });

  it('a fold that collides on (feed, guid) keeps one item', async () => {
    const a = await put<Feed>('feeds', feedRow());
    const b = await put<Feed>('feeds', feedRow({ feed_url: 'https://example.com/rss' }));
    await importItems(a, [entry({ guid: 'same' })]);
    await importItems(b, [entry({ guid: 'same' })]);

    await reconcileFeeds();
    const live = (await all<FeedItem>('feed_items')).filter((i) => !i.deleted_at);
    expect(live).toHaveLength(1);
  });
});

describe('scheduling and unsubscribe', () => {
  it('a feed with no recorded check is due; a paused one never is', async () => {
    const feed = await put<Feed>('feeds', feedRow());
    expect((await dueFeeds()).map((f) => f.id)).toEqual([feed.id]);
    await put<Feed>('feeds', { ...feed, paused: true });
    expect(await dueFeeds()).toHaveLength(0);
  });

  it('unsubscribing tombstones the feed and its items, leaving no orphans', async () => {
    const feed = await put<Feed>('feeds', feedRow());
    await importItems(feed, [entry(), entry({ guid: 'g2', url: 'https://example.com/posts/2' })]);

    await removeFeed(feed);
    expect(await all<Feed>('feeds')).toHaveLength(0);
    expect(await all<FeedItem>('feed_items')).toHaveLength(0);
    // Tombstones, not hard deletes — the deletion has to sync.
    expect(await (await getDB()).count('feed_items')).toBe(2);
  });
});
