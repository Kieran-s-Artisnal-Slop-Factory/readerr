/**
 * The inbox: subscribed RSS/Atom feeds, the items they produce, and triage.
 *
 * Shape of the feature:
 *   - `feeds` and `feed_items` are ordinary synced rows, so a subscription
 *     made on the laptop shows up on the phone and an item triaged on either
 *     is triaged everywhere.
 *   - Fetching prefers the backend's GET /feed (server-side, so no CORS
 *     involved) and falls back to reading the feed IN THE BROWSER when there
 *     is no usable server — offline mode, a static host, or a server too old
 *     to have the endpoint. The browser path works for any site whose CORS
 *     headers allow it, and says plainly when they don't. Everything else
 *     about the inbox is local either way.
 *   - Fetch bookkeeping is per-device and LOCAL-ONLY (`feed_state`): the daily
 *     refresh must never write a synced row, or a background job on an idle
 *     device would clobber a rename made elsewhere under row-level LWW.
 *   - An item is identified by (feed_id, guid). Import checks that pair
 *     INCLUDING tombstones, so a deleted item never comes back on the next
 *     fetch, and duplicate rows minted by two devices collapse on read via the
 *     same pair-dedupe link_tags uses.
 */
import {
  all,
  byIndex,
  byIndexWithDeleted,
  bulkPut,
  dedupePairs,
  patch,
  put,
  putReconciled,
  softDelete,
  softDeleteMany,
  withSyncFields,
} from '../db/repo';
import { getDB } from '../db/db';
import { healsAllowed, isTestMode } from '../testMode';
import { getSyncMode, getSyncUrl } from '../sync';
import { captureLinks, cleanUrl } from './capture';
import { getUserSettings } from './settings';
import type { Feed, FeedItem, FeedItemStatus, Link } from '../db/types';

/** How much history the "add feed" form pulls in by default. */
export const DEFAULT_IMPORT_DAYS = 30;

/** Options offered for that window; 0 means "only what arrives from now on". */
export const IMPORT_DAY_CHOICES = [0, 7, 14, 30, 60, 90, 365] as const;

/** A feed is checked at most once a day (per device). */
export const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Fetching (backend /feed)
// ---------------------------------------------------------------------------

/** One entry as the backend hands it over, before it becomes a FeedItem. */
export interface FetchedItem {
  guid: string;
  url: string;
  title: string;
  /** UTC RFC3339, or '' when the feed gave no parseable date. */
  published_at: string;
  summary: string;
}

export interface FetchedFeed {
  title: string;
  siteUrl: string;
  items: FetchedItem[];
}

/** Thrown for every failure the UI shows next to a feed. */
export class FeedError extends Error {}

/**
 * Fetch and parse a feed through the backend. Rejects with a FeedError whose
 * message is meant to be shown verbatim — the caller has no better wording to
 * add, and the reason (404, not XML, unreachable) is the whole diagnosis.
 */
export async function fetchFeed(feedUrl: string): Promise<FetchedFeed> {
  const viaServer = await serverFetch(feedUrl);
  if (viaServer.feed) return viaServer.feed;
  // No usable server: read the feed straight from the browser. This is the
  // whole reason the inbox doesn't require a backend — but it is also where
  // CORS bites, so a failure here names the backend as the fix.
  return directFetch(feedUrl, viaServer.serverNote);
}

interface ServerAttempt {
  /** The parsed feed, when the sync server answered. */
  feed: FetchedFeed | null;
  /**
   * Why the server didn't answer, in a form worth showing the user if the
   * direct attempt also fails — e.g. "the sync server has no /feed endpoint".
   * Empty when there was no server to try in the first place.
   */
  serverNote: string;
}

/**
 * Try the backend's /feed. Server-side fetching has no CORS problem and no
 * per-site luck involved, so it is always preferred when there is a server.
 *
 * Every failure here is soft: it returns a note instead of throwing, because
 * the browser can still try for itself.
 */
async function serverFetch(feedUrl: string): Promise<ServerAttempt> {
  if (getSyncMode() === 'offline') return { feed: null, serverNote: '' };
  const base = getSyncUrl();
  let res: Response;
  try {
    res = await fetch(`${base}/feed?url=${encodeURIComponent(feedUrl)}`);
  } catch {
    return {
      feed: null,
      serverNote: `the sync server at ${describeBase(base)} could not be reached`,
    };
  }
  // 404 = no such endpoint. Overwhelmingly that means a server older than the
  // app (the frontend updates on reload; the Go binary only when rebuilt), or
  // no readerr backend at that URL at all.
  if (res.status === 404) {
    return { feed: null, serverNote: await describeMissingEndpoint(base) };
  }
  if (!res.ok) {
    return {
      feed: null,
      serverNote: `the sync server returned ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`,
    };
  }

  const body = (await res.json()) as {
    ok: boolean;
    title?: string;
    site_url?: string;
    items?: FetchedItem[];
    error?: string;
  };
  // The server reached the feed and the feed itself is the problem (404, not
  // XML, …). Trying again from the browser would only produce a worse message.
  if (!body.ok) throw new FeedError(body.error || 'The feed could not be read.');
  return {
    feed: {
      title: (body.title ?? '').trim(),
      siteUrl: (body.site_url ?? '').trim(),
      items: body.items ?? [],
    },
    serverNote: '',
  };
}

/**
 * Fetch and parse the feed in this browser.
 *
 * A thrown TypeError here is almost always CORS: the request went out and the
 * response was refused to the page because the site sends no
 * `Access-Control-Allow-Origin`. That is a rule of the web, not something
 * readerr can work around — the only fix is a server fetching on your behalf,
 * so the message says so, and carries along whatever went wrong with the
 * server if one was configured.
 */
async function directFetch(feedUrl: string, serverNote: string): Promise<FetchedFeed> {
  const because = serverNote ? ` (${serverNote})` : '';
  let res: Response;
  try {
    // No Accept header on purpose. `accept` counts as CORS-safelisted only
    // while its value avoids `,/;=` — which any real feed Accept string uses —
    // so sending one turns this into a PREFLIGHTED request, and a static feed
    // host that would happily serve the GET may not answer the OPTIONS at all.
    // Feeds serve XML regardless of what we ask for.
    res = await fetch(feedUrl);
  } catch {
    throw new FeedError(
      `Your browser wasn't allowed to read ${hostOf(feedUrl)} directly — the site doesn't send the CORS header that would permit it${because}. ` +
        'Feeds like this need a sync server to fetch them for you; set one up in Settings → Sync.'
    );
  }
  if (!res.ok) {
    throw new FeedError(`The feed returned HTTP ${res.status} when this browser asked for it.`);
  }
  const { parseFeedXml, FeedParseError } = await import('./feedParse');
  try {
    return parseFeedXml(await res.text(), feedUrl);
  } catch (err) {
    if (err instanceof FeedParseError) throw new FeedError(err.message);
    throw new FeedError(`This browser could not parse that feed${because}.`);
  }
}

/** How to name the sync target in an error the user has to act on. */
function describeBase(base: string): string {
  if (base) return base;
  return typeof location !== 'undefined' ? location.origin : 'this site';
}

/**
 * Explain a 404 on /feed. /healthz tells the two cases apart: it has existed
 * since the first release, so a server that answers it but 404s /feed is
 * simply older than the app, while one that answers neither isn't a readerr
 * backend at that URL at all.
 */
async function describeMissingEndpoint(base: string): Promise<string> {
  const where = describeBase(base);
  let alive = false;
  try {
    alive = (await fetch(`${base}/healthz`)).ok;
  } catch {
    alive = false;
  }
  return alive
    ? `the sync server at ${where} is running but has no /feed endpoint, so it is older than this app — rebuilding it would let it fetch feeds for you`
    : `nothing answered at ${where}, so there is no sync server to fetch feeds for you`;
}

// ---------------------------------------------------------------------------
// Local-only fetch bookkeeping (`feed_state`)
// ---------------------------------------------------------------------------

export interface FeedState {
  /** = the feed's id. */
  id: string;
  /** UTC ISO 8601 of this device's last attempt, successful or not. */
  last_checked_at: string;
  ok: boolean;
  /** Failure reason from the last attempt; '' when it succeeded. */
  error: string;
  /** New items the last successful check imported. */
  imported: number;
}

export async function feedStates(): Promise<Map<string, FeedState>> {
  const rows = (await (await getDB()).getAll('feed_state')) as FeedState[];
  return new Map(rows.map((r) => [r.id, r]));
}

async function recordState(id: string, state: Omit<FeedState, 'id'>): Promise<void> {
  await (await getDB()).put('feed_state', { id, ...state });
}

async function forgetState(id: string): Promise<void> {
  await (await getDB()).delete('feed_state', id);
}

// ---------------------------------------------------------------------------
// Feeds
// ---------------------------------------------------------------------------

/**
 * The comparable form of a feed URL — case-insensitive scheme and host, no
 * trailing slash, no fragment. Query strings are kept: plenty of feeds live at
 * `?feed=rss`. This is the identity two devices must agree on, so it decides
 * both "already subscribed?" and which rows reconcileFeeds folds together.
 */
export function normalizeFeedUrl(raw: string): string {
  const trimmed = raw.trim();
  try {
    const u = new URL(trimmed);
    u.hash = '';
    u.protocol = u.protocol.toLowerCase();
    u.hostname = u.hostname.toLowerCase();
    const s = u.toString();
    return s.endsWith('/') ? s.slice(0, -1) : s;
  } catch {
    return trimmed.toLowerCase().replace(/\/+$/, '');
  }
}

/** A feed URL typed without a scheme still works — https is assumed. */
export function withScheme(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * Feeds are logical singletons keyed by their URL but stored under a random
 * UUID, so two devices that each subscribe to the same feed before syncing
 * mint rows that row-level LWW can never merge. This folds them the same way
 * reconcileTags folds same-name tags: smallest id wins (every device picks
 * the same one without coordinating), the survivor keeps the freshest title,
 * the strays' items are re-pointed onto it and de-duplicated, and the strays
 * are tombstoned. A group of one — the common case — writes nothing.
 */
export async function reconcileFeeds(): Promise<Feed[]> {
  const feeds = await all<Feed>('feeds');
  const groups = new Map<string, Feed[]>();
  for (const feed of feeds) {
    const key = normalizeFeedUrl(feed.feed_url);
    const g = groups.get(key);
    if (g) g.push(feed);
    else groups.set(key, [feed]);
  }
  // Test mode: folding is a write — the harness invokes it explicitly.
  if (!healsAllowed()) {
    return [...groups.values()].map((g) => pickSurvivor(g)).sort(byTitle);
  }

  const survivors: Feed[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      survivors.push(group[0]);
      continue;
    }
    const survivor = pickSurvivor(group);
    const strays = group.filter((f) => f.id !== survivor.id);
    // Preserve the freshest content time across the group instead of stamping
    // now (putReconciled), so folding a stale duplicate cannot clobber a
    // newer rename under LWW.
    const freshest = group.reduce((best, f) => (f.updated_at > best.updated_at ? f : best));
    await putReconciled('feeds', {
      ...survivor,
      title: freshest.title || survivor.title,
      site_url: freshest.site_url || survivor.site_url,
      // The earliest window wins: whichever device asked for more history
      // meant it, and narrowing it later would silently hide items.
      since_at: group.reduce((m, f) => (f.since_at < m ? f.since_at : m), survivor.since_at),
      paused: freshest.paused,
      updated_at: group.reduce((m, f) => (f.updated_at > m ? f.updated_at : m), ''),
    });
    for (const stray of strays) {
      for (const item of await byIndex<FeedItem>('feed_items', 'feed_id', stray.id)) {
        await put('feed_items', { ...item, feed_id: survivor.id });
      }
      await forgetState(stray.id);
    }
    await softDeleteMany('feeds', strays.map((f) => f.id));
    // Re-pointing can put two rows on the same (feed, guid) pair.
    await dedupeItems(await byIndex<FeedItem>('feed_items', 'feed_id', survivor.id));
    survivors.push(survivor);
  }
  return survivors.sort(byTitle);
}

/** Device-independent winner: smallest id (ids are identical everywhere). */
function pickSurvivor(group: Feed[]): Feed {
  return group.reduce((best, f) => (f.id < best.id ? f : best));
}

const byTitle = (a: Feed, b: Feed): number =>
  (a.title || a.feed_url).localeCompare(b.title || b.feed_url);

/** Every subscribed feed, duplicates folded, sorted by title. */
export async function listFeeds(): Promise<Feed[]> {
  return reconcileFeeds();
}

export async function findFeedByUrl(url: string): Promise<Feed | null> {
  const key = normalizeFeedUrl(url);
  return (await all<Feed>('feeds')).find((f) => normalizeFeedUrl(f.feed_url) === key) ?? null;
}

export interface AddFeedResult {
  feed: Feed;
  imported: number;
  /** Items skipped because they predate the requested window. */
  outsideWindow: number;
}

/**
 * Subscribe to a feed and pull its last `days` of items (0 = nothing
 * historical; only what shows up from now on). Throws a FeedError if the feed
 * can't be read or is already subscribed — nothing is written in that case.
 */
export async function addFeed(rawUrl: string, days = DEFAULT_IMPORT_DAYS): Promise<AddFeedResult> {
  const feedUrl = withScheme(rawUrl);
  if (!feedUrl) throw new FeedError('Enter a feed URL.');
  const existing = await findFeedByUrl(feedUrl);
  if (existing) throw new FeedError(`Already subscribed as “${existing.title || existing.feed_url}”.`);

  const fetched = await fetchFeed(feedUrl);
  const addedAt = nowIso();
  const feed = await put<Feed>(
    'feeds',
    withSyncFields({
      title: fetched.title || hostOf(feedUrl),
      feed_url: feedUrl,
      site_url: fetched.siteUrl,
      added_at: addedAt,
      since_at: new Date(Date.now() - Math.max(0, days) * 86_400_000).toISOString(),
      paused: false,
    })
  );

  const result = await importItems(feed, fetched.items);
  await recordState(feed.id, {
    last_checked_at: addedAt,
    ok: true,
    error: '',
    imported: result.imported,
  });
  return { feed, ...result };
}

export async function renameFeed(feed: Feed, title: string): Promise<Feed | undefined> {
  const clean = title.trim();
  if (!clean || clean === feed.title) return feed;
  return patch<Feed>('feeds', feed.id, () => ({ title: clean }));
}

export async function setFeedPaused(feed: Feed, paused: boolean): Promise<Feed | undefined> {
  return patch<Feed>('feeds', feed.id, () => ({ paused }));
}

/**
 * Unsubscribe. The feed's items go with it — leaving them behind would strand
 * live rows pointing at a tombstoned parent, which is exactly the referential
 * invariant the sync harness checks after every convergence.
 */
export async function removeFeed(feed: Feed): Promise<void> {
  const items = await byIndex<FeedItem>('feed_items', 'feed_id', feed.id);
  await softDeleteMany('feed_items', items.map((i) => i.id));
  await softDelete('feeds', feed.id);
  await forgetState(feed.id);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/** The (feed, guid) pair an item row stands for — its logical identity. */
const itemPairKey = (i: FeedItem): string => `${i.feed_id} ${i.guid}`;

/**
 * Collapse duplicate (feed, guid) rows to one (see repo.dedupePairs). Must be
 * handed a COMPLETE set of live rows for the pairs it covers — a whole-store
 * read or every row of one feed, both of which are complete by construction
 * since a pair never spans feeds.
 *
 * The merge keeps the most decided triage state: a device that added the item
 * and a device that only saw it must not converge on "untriaged", or the item
 * would reappear in the inbox after it was dealt with.
 */
export async function dedupeItems(rows: FeedItem[]): Promise<FeedItem[]> {
  return dedupePairs('feed_items', rows, itemPairKey, (survivor, duplicates) => {
    const group = [survivor, ...duplicates];
    const winner = group.reduce((best, r) =>
      statusRank(r.status) > statusRank(best.status)
        ? r
        : statusRank(r.status) === statusRank(best.status) &&
            (r.triaged_at ?? '') > (best.triaged_at ?? '')
          ? r
          : best
    );
    // null = nothing to fold; dedupePairs still re-delivers the survivor as is.
    if (winner.status === survivor.status && winner.triaged_at === survivor.triaged_at) {
      return null;
    }
    // Carry the freshest updated_at in the group onto the survivor, exactly as
    // reconcileTags does. putReconciled deliberately does NOT stamp now, so a
    // fold that kept the survivor's own (older) timestamp could never beat the
    // server's stale copy of that same row under LWW: the triage would be
    // pulled straight back to 'new' and the item would reappear in the inbox.
    // The timestamp carried is a real one — the moment the triage was written.
    return {
      ...survivor,
      status: winner.status,
      triaged_at: winner.triaged_at,
      updated_at: group.reduce((m, r) => (r.updated_at > m ? r.updated_at : m), survivor.updated_at),
    };
  });
}

/** 'added' beats 'ignored' beats 'new' — triage never un-decides itself. */
function statusRank(status: FeedItemStatus): number {
  return status === 'added' ? 2 : status === 'ignored' ? 1 : 0;
}

export interface ImportResult {
  imported: number;
  outsideWindow: number;
}

/**
 * Turn fetched entries into rows, skipping anything the feed's window
 * excludes and anything already imported. "Already imported" counts
 * TOMBSTONED rows on purpose: without that, deleting an item would just make
 * the next fetch bring it back.
 *
 * An entry whose URL is already in the library is imported as 'added' rather
 * than 'new', so the inbox only ever shows things you haven't got.
 */
export async function importItems(feed: Feed, entries: FetchedItem[]): Promise<ImportResult> {
  const settings = await getUserSettings();
  const strip = settings?.strip_query_params ?? 'off';
  const whitelist = settings?.strip_whitelist ?? [];
  const extras = settings?.strip_extra_params ?? [];

  // Every guid this feed has ever produced on this device, tombstones and all.
  const seen = new Set(
    (await byIndexWithDeleted<FeedItem>('feed_items', 'feed_id', feed.id)).map((i) => i.guid)
  );

  const fetchedAt = nowIso();
  const fresh: FeedItem[] = [];
  let outsideWindow = 0;

  for (const entry of entries) {
    const guid = (entry.guid || entry.url).trim();
    if (!guid || !entry.url) continue;
    if (seen.has(guid)) continue;
    // No date at all counts as current: feeds that omit dates are usually
    // listing recent posts, and dropping them would empty the inbox.
    const published = normalizeDate(entry.published_at);
    if (published && published < feed.since_at) {
      outsideWindow++;
      continue;
    }
    seen.add(guid); // a feed can list the same guid twice in one document
    const alreadySaved = await findLink(entry.url, strip, whitelist, extras);
    fresh.push(
      withSyncFields({
        feed_id: feed.id,
        guid,
        url: entry.url,
        title: entry.title || entry.url,
        published_at: published,
        fetched_at: fetchedAt,
        summary: entry.summary ?? '',
        status: alreadySaved ? ('added' as const) : ('new' as const),
        triaged_at: alreadySaved ? fetchedAt : null,
      })
    );
  }

  if (fresh.length) await bulkPut('feed_items', fresh);
  return { imported: fresh.length, outsideWindow };
}

/** Feed dates arrive as RFC3339; store the same ISO shape the app uses. */
function normalizeDate(raw: string): string | null {
  if (!raw) return null;
  const t = new Date(raw);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

/**
 * The saved link for a feed item's URL, if there is one. Capture cleans URLs
 * before storing them, so the lookup has to try the cleaned form as well as
 * the raw one — otherwise every item with a `?utm_source=rss` would look
 * unsaved forever. Both lookups are index reads, not scans.
 */
async function findLink(
  url: string,
  strip: Parameters<typeof cleanUrl>[1],
  whitelist: string[],
  extras: string[]
): Promise<Link | null> {
  const candidates = new Set([url, cleanUrl(url, strip, whitelist, extras)]);
  for (const candidate of candidates) {
    const hits = await byIndex<Link>('links', 'url', candidate);
    if (hits.length > 0) return hits[0];
  }
  return null;
}

/** The saved link for each of these items, for the inbox's "already in your library" mark. */
export async function savedLinksFor(items: FeedItem[]): Promise<Map<string, Link>> {
  const settings = await getUserSettings();
  const strip = settings?.strip_query_params ?? 'off';
  const whitelist = settings?.strip_whitelist ?? [];
  const extras = settings?.strip_extra_params ?? [];
  const out = new Map<string, Link>();
  for (const item of items) {
    const link = await findLink(item.url, strip, whitelist, extras);
    if (link) out.set(item.id, link);
  }
  return out;
}

export interface RefreshResult {
  feed: Feed;
  imported: number;
  outsideWindow: number;
  /** Failure reason; '' when the check succeeded. */
  error: string;
}

/** Check one feed now, whatever its schedule says. Never throws. */
export async function refreshFeed(feed: Feed): Promise<RefreshResult> {
  const checkedAt = nowIso();
  try {
    const fetched = await fetchFeed(feed.feed_url);
    const result = await importItems(feed, fetched.items);
    // A feed that has since been renamed by its publisher keeps the title you
    // gave it — only fill in a site URL we never had.
    if (!feed.site_url && fetched.siteUrl) {
      await patch<Feed>('feeds', feed.id, () => ({ site_url: fetched.siteUrl }));
    }
    await recordState(feed.id, {
      last_checked_at: checkedAt,
      ok: true,
      error: '',
      imported: result.imported,
    });
    return { feed, ...result, error: '' };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await recordState(feed.id, { last_checked_at: checkedAt, ok: false, error, imported: 0 });
    return { feed, imported: 0, outsideWindow: 0, error };
  }
}

/**
 * Check several feeds one after another. Deliberately serial: a handful of
 * feeds is the normal case, and a burst of parallel fetches through one
 * backend buys nothing but timeouts.
 */
export async function refreshFeeds(feeds: Feed[]): Promise<RefreshResult[]> {
  const out: RefreshResult[] = [];
  for (const feed of feeds) {
    if (feed.paused) continue;
    out.push(await refreshFeed(feed));
  }
  return out;
}

/** Feeds this device hasn't checked in a day (paused ones never come due). */
export async function dueFeeds(feeds?: Feed[]): Promise<Feed[]> {
  const list = feeds ?? (await listFeeds());
  const states = await feedStates();
  const cutoff = Date.now() - REFRESH_INTERVAL_MS;
  return list.filter((f) => {
    if (f.paused) return false;
    const last = states.get(f.id)?.last_checked_at;
    return !last || new Date(last).getTime() < cutoff;
  });
}

/**
 * The once-a-day check, called when the inbox page opens. Skipped in test mode
 * (page loads must not write) and while the browser reports no connectivity.
 *
 * Offline MODE is not skipped: that setting means "no sync server", not "no
 * internet", and the browser can fetch feeds itself for any site whose CORS
 * headers allow it. A site that doesn't is recorded as a per-feed error, the
 * same as any other failure.
 */
export async function maybeRefreshDueFeeds(feeds?: Feed[]): Promise<RefreshResult[]> {
  if (isTestMode()) return [];
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return [];
  return refreshFeeds(await dueFeeds(feeds));
}

// ---------------------------------------------------------------------------
// Reading and triage
// ---------------------------------------------------------------------------

export interface InboxEntry {
  item: FeedItem;
  feed: Feed;
}

/**
 * Every item in a given triage state, newest first, with its feed attached.
 * Items are read per feed through the feed_id index (a complete set per pair,
 * which is what the dedupe needs) rather than as one whole-store scan.
 *
 * Pass `known` when the caller already has the feed list, so opening the page
 * doesn't reconcile and re-read the feeds once per thing it wants to know.
 */
export async function inboxEntries(
  status: FeedItemStatus = 'new',
  known?: Feed[]
): Promise<InboxEntry[]> {
  const feeds = known ?? (await listFeeds());
  const out: InboxEntry[] = [];
  for (const feed of feeds) {
    const items = await dedupeItems(await byIndex<FeedItem>('feed_items', 'feed_id', feed.id));
    for (const item of items) {
      if (item.status === status) out.push({ item, feed });
    }
  }
  return out.sort((a, b) => sortKey(b.item).localeCompare(sortKey(a.item)));
}

/** Undated items sort by when we first saw them, which is the best we have. */
const sortKey = (item: FeedItem): string => item.published_at ?? item.fetched_at;

/**
 * How many untriaged items each feed is holding (for the feed list). Pass the
 * entries when you already have them — the inbox view is usually showing
 * exactly this list, and a second pass over every feed would be pure waste.
 */
export function countByFeed(entries: InboxEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { item } of entries) {
    counts.set(item.feed_id, (counts.get(item.feed_id) ?? 0) + 1);
  }
  return counts;
}

export async function newCountsByFeed(feeds?: Feed[]): Promise<Map<string, number>> {
  return countByFeed(await inboxEntries('new', feeds));
}

/**
 * A title as the capture DSL can carry it: `[Title](url)` has no escape for
 * square brackets, and a newline would split the line into two captures.
 * triageItem restores the exact title straight afterwards, so this only has
 * to be *parseable*, not faithful.
 */
function captureSafeTitle(title: string): string {
  return title.replace(/\s+/g, ' ').replace(/[[\]]/g, '').trim() || title.trim();
}

export type TriageAction = 'week' | 'backlog' | 'ignore';

export interface TriageResult {
  item: FeedItem | undefined;
  /** The link that now holds this item, when one was created or matched. */
  link: Link | null;
}

/**
 * Act on one inbox item.
 *
 *   - 'backlog' captures it as a link;
 *   - 'week' captures it and queues it for that reading week (null = the
 *     current one, handled by the caller passing a Monday);
 *   - 'ignore' dismisses it without saving anything.
 *
 * Capture is the ordinary pipeline — URL cleaning, duplicate merging, week
 * scheduling — so an item that is already in the library merges into the
 * existing link instead of creating a second one.
 */
export async function triageItem(
  item: FeedItem,
  action: TriageAction,
  weekStart?: string | null
): Promise<TriageResult> {
  if (action === 'ignore') {
    const updated = await patch<FeedItem>('feed_items', item.id, () => ({
      status: 'ignored' as const,
      triaged_at: nowIso(),
    }));
    return { item: updated, link: null };
  }

  const title = item.title.trim() || item.url;
  const result = await captureLinks(`[${captureSafeTitle(title)}](${item.url})`, {
    weekStart: action === 'week' ? (weekStart ?? null) : null,
  });
  let link: Link | null = result.added[0] ?? result.merged[0] ?? null;
  // The markdown capture form can't carry square brackets, so restore the
  // exact title on a link we just created (an existing link keeps its own).
  const created = result.added[0];
  if (created && created.title !== title) {
    link =
      (await patch<Link>('links', created.id, () => ({ title, title_fetched: true }))) ?? link;
  }
  if (!link) {
    // The URL already existed and needed no changes — find it so the caller
    // can still link straight to it.
    link = await savedLinkFor(item);
  }

  const updated = await patch<FeedItem>('feed_items', item.id, () => ({
    status: 'added' as const,
    triaged_at: nowIso(),
  }));
  return { item: updated, link };
}

/** The library link an item points at, if any. */
export async function savedLinkFor(item: FeedItem): Promise<Link | null> {
  return (await savedLinksFor([item])).get(item.id) ?? null;
}

/** Triage a batch — same rules as triageItem, one pass. */
export async function triageItems(
  items: FeedItem[],
  action: TriageAction,
  weekStart?: string | null
): Promise<TriageResult[]> {
  const out: TriageResult[] = [];
  for (const item of items) out.push(await triageItem(item, action, weekStart));
  return out;
}

/**
 * Put a triaged item back in the inbox. Any link it created stays — undo here
 * means "I want to see this again", not "undo the capture", which the link's
 * own delete already covers.
 */
export async function untriageItem(item: FeedItem): Promise<FeedItem | undefined> {
  return patch<FeedItem>('feed_items', item.id, () => ({
    status: 'new' as const,
    triaged_at: null,
  }));
}

/** Dismiss every untriaged item of a feed (or of the whole inbox). */
export async function ignoreAll(feedId?: string, feeds?: Feed[]): Promise<number> {
  const entries = (await inboxEntries('new', feeds)).filter(
    (e) => !feedId || e.item.feed_id === feedId
  );
  const at = nowIso();
  for (const { item } of entries) {
    await put('feed_items', { ...item, status: 'ignored' as const, triaged_at: at });
  }
  return entries.length;
}
