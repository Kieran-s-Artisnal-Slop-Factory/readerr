/**
 * Per-origin statistics (#7): for every domain you've captured from, how
 * many links and resources it produced and where they ended up — slush,
 * favourites, topics. Tags are deliberately ignored.
 *
 * Plus lifetime/history statistics for the stats page: setup date, capture
 * streaks, bulk-paste records, and rate averages. Archived links live in a
 * separate store and are deliberately not counted (they left the working
 * set); the numbers describe the live library.
 */
import { all } from '../db/repo';
import { domainOf, linkTagAssignments } from './links';
import { isSeries } from './series';
import { getUserSettings } from './settings';
import { getSyncMode, getSyncUrl } from '../sync';
import type { Link, LinkTopic, Tag, Topic } from '../db/types';

export interface OriginStats {
  origin: string;
  links: number;
  resources: number;
  slushed: number;
  favourites: number;
  /** Links from this origin referenced in at least one topic. */
  inTopics: number;
}

export async function originStats(): Promise<OriginStats[]> {
  const [allLinks, linkTopics] = await Promise.all([
    all<Link>('links'),
    all<LinkTopic>('link_topics'),
  ]);
  // A series is a container, not something captured from a domain — and one
  // with no overview page carries a synthesised `series:` URL that would
  // otherwise show up as its own bogus "origin". Its parts are counted
  // normally; they are the actual reading.
  const links = allLinks.filter((l) => !isSeries(l));
  const topicLinkIds = new Set(linkTopics.map((j) => j.link_id));

  const byOrigin = new Map<string, OriginStats>();
  for (const link of links) {
    const origin = domainOf(link.url);
    let row = byOrigin.get(origin);
    if (!row) {
      row = { origin, links: 0, resources: 0, slushed: 0, favourites: 0, inTopics: 0 };
      byOrigin.set(origin, row);
    }
    row.links++;
    if (link.is_resource) row.resources++;
    if (link.slushed_at) row.slushed++;
    if (link.favourite) row.favourites++;
    if (topicLinkIds.has(link.id)) row.inTopics++;
  }

  return [...byOrigin.values()].sort((a, b) => b.links - a.links || a.origin.localeCompare(b.origin));
}

/** Default for the variability metric's window — "outside your top 3 domains". */
export const DEFAULT_VARIABILITY_TOP_N = 3;

export interface Variability {
  /** Percentage of links coming from outside the top N origins, 0–100. */
  score: number;
  /** The window this score was computed over. */
  topN: number;
  /** The origins that made up the window (fewer than topN if you have fewer). */
  topOrigins: string[];
  /** Links attributed to the window, and to everything else. */
  topLinks: number;
  otherLinks: number;
  totalLinks: number;
}

/**
 * How spread out your reading is: the share of links that come from anywhere
 * other than your N biggest domains. 1,200 links with 980 of them from the top
 * three scores ((1200-980)/1200)*100 = 18.3% — low, meaning most of what you
 * capture comes from a handful of places.
 *
 * Takes the rows `originStats` already produced (they arrive sorted by link
 * count) rather than re-reading the DB, so the page can recompute instantly
 * when you change N. Ties at the boundary are broken the same way the table
 * orders them — by count, then origin name — so the score matches what the
 * "top N" rows visibly are.
 */
export function variability(
  rows: OriginStats[],
  topN: number = DEFAULT_VARIABILITY_TOP_N
): Variability {
  const window = Math.max(1, Math.round(topN));
  const ranked = [...rows].sort((a, b) => b.links - a.links || a.origin.localeCompare(b.origin));
  const totalLinks = ranked.reduce((sum, r) => sum + r.links, 0);
  const top = ranked.slice(0, window);
  const topLinks = top.reduce((sum, r) => sum + r.links, 0);
  const otherLinks = totalLinks - topLinks;
  return {
    // No links at all is 0%, not NaN. Fewer origins than the window means the
    // window is everything, which is 0% — correctly, there is no variety.
    score: totalLinks === 0 ? 0 : (otherLinks / totalLinks) * 100,
    topN: window,
    topOrigins: top.map((r) => r.origin),
    topLinks,
    otherLinks,
    totalLinks,
  };
}

/** One tag's slice of the library, for the tag distribution card. */
export interface TagShare {
  tagId: string;
  name: string;
  /** Live links carrying this tag directly (nesting is not rolled up). */
  links: number;
  /** Share of all tag assignments, 0–100. These sum to 100. */
  shareOfAssignments: number;
  /** Share of the whole library, 0–100. These sum to MORE than 100 when
   * links carry several tags — which is why the two are reported apart. */
  shareOfLinks: number;
}

export interface TagDistribution {
  rows: TagShare[];
  /** (link, tag) pairs across the library — the denominator of the shares. */
  totalAssignments: number;
  totalLinks: number;
  taggedLinks: number;
  untaggedLinks: number;
  /** Live tags that no link carries; they hold a 0% row each. */
  unusedTags: number;
}

/**
 * How the library divides across tags. A link can carry several tags, so
 * "percentage" is ambiguous — both readings are computed:
 *
 *   - shareOfAssignments treats each (link, tag) pair as one unit, so the
 *     column is a true distribution summing to 100%;
 *   - shareOfLinks answers "what fraction of my library is tagged X", which
 *     is what people usually mean, and deliberately sums past 100%.
 *
 * Counts are DIRECT assignments only — no descendant roll-up — so every link
 * contributes to exactly the tags it carries and the distribution stays a
 * partition. Archived links live in their own store and aren't counted,
 * matching the rest of this page.
 */
export async function tagDistribution(): Promise<TagDistribution> {
  const [tags, joins, links] = await Promise.all([
    all<Tag>('tags'),
    // Deduped (link, tag) pairs — same view the tags index counts from, so a
    // duplicate join synced in from another device can't inflate a share.
    linkTagAssignments(),
    all<Link>('links'),
  ]);

  const liveLinkIds = new Set(links.map((l) => l.id));
  // A join whose link was deleted elsewhere but whose tombstone hasn't
  // arrived yet would otherwise count toward a tag's share.
  const live = joins.filter((j) => liveLinkIds.has(j.link_id));

  const linksByTag = new Map<string, Set<string>>();
  const taggedLinkIds = new Set<string>();
  for (const j of live) {
    taggedLinkIds.add(j.link_id);
    const set = linksByTag.get(j.tag_id);
    if (set) set.add(j.link_id);
    else linksByTag.set(j.tag_id, new Set([j.link_id]));
  }

  const totalAssignments = [...linksByTag.values()].reduce((n, set) => n + set.size, 0);
  const totalLinks = links.length;

  const rows: TagShare[] = tags.map((tag) => {
    const count = linksByTag.get(tag.id)?.size ?? 0;
    return {
      tagId: tag.id,
      name: tag.name,
      links: count,
      shareOfAssignments: totalAssignments === 0 ? 0 : (count / totalAssignments) * 100,
      shareOfLinks: totalLinks === 0 ? 0 : (count / totalLinks) * 100,
    };
  });
  rows.sort((a, b) => b.links - a.links || a.name.localeCompare(b.name));

  return {
    rows,
    totalAssignments,
    totalLinks,
    taggedLinks: taggedLinkIds.size,
    untaggedLinks: totalLinks - taggedLinkIds.size,
    unusedTags: rows.filter((r) => r.links === 0).length,
  };
}

/** Totals for the metrics the averages table tracks. */
export interface HistoryTotals {
  read: number;
  favourites: number;
  resources: number;
  topics: number;
}

export interface HistoryStats {
  /** When this instance was set up (onboarding, or the first capture). */
  setupAt: string | null;
  /** Longest run of consecutive days with at least one link captured. */
  longestStreakDays: number;
  /** Most links ever captured in one paste (5s-gap batching heuristic). */
  largestBulkAdd: number;
  totals: HistoryTotals;
  /** totals averaged over the instance's lifetime, per period. */
  perWeek: HistoryTotals;
  perMonth: HistoryTotals;
  perYear: HistoryTotals;
}

/** Local calendar date of a UTC timestamp, 'YYYY-MM-DD'. */
function localDateOf(iso: string): string {
  const d = new Date(iso);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${dd}`;
}

export async function historyStats(): Promise<HistoryStats> {
  const [links, topics, settings] = await Promise.all([
    all<Link>('links'),
    all<Topic>('topics'),
    getUserSettings(),
  ]);

  const addedTimes = links.map((l) => l.added_at).sort();
  const setupAt =
    [settings?.onboarding_completed_at, addedTimes[0]]
      .filter((t): t is string => !!t)
      .sort()[0] ?? null;

  // Longest daily streak: consecutive local dates with ≥1 capture.
  const days = [...new Set(links.map((l) => localDateOf(l.added_at)))].sort();
  let longestStreakDays = days.length > 0 ? 1 : 0;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    const gap =
      (new Date(`${days[i]}T00:00:00`).getTime() - new Date(`${days[i - 1]}T00:00:00`).getTime()) /
      86_400_000;
    run = Math.round(gap) === 1 ? run + 1 : 1;
    if (run > longestStreakDays) longestStreakDays = run;
  }

  // Largest bulk paste: capture stamps each row moments apart, so links
  // whose added_at gaps stay under 5s form one batch.
  let largestBulkAdd = addedTimes.length > 0 ? 1 : 0;
  let batch = 1;
  for (let i = 1; i < addedTimes.length; i++) {
    const gap = new Date(addedTimes[i]).getTime() - new Date(addedTimes[i - 1]).getTime();
    batch = gap <= 5000 ? batch + 1 : 1;
    if (batch > largestBulkAdd) largestBulkAdd = batch;
  }

  const totals: HistoryTotals = {
    read: links.filter((l) => l.read_at).length,
    favourites: links.filter((l) => l.favourite).length,
    resources: links.filter((l) => l.is_resource).length,
    topics: topics.length,
  };

  // Rates over the instance's lifetime (floored at one period so a young
  // install shows its totals rather than inflated projections).
  const elapsedMs = setupAt ? Math.max(0, Date.now() - new Date(setupAt).getTime()) : 0;
  const per = (periodMs: number): HistoryTotals => {
    const periods = Math.max(1, elapsedMs / periodMs);
    return {
      read: totals.read / periods,
      favourites: totals.favourites / periods,
      resources: totals.resources / periods,
      topics: totals.topics / periods,
    };
  };

  return {
    setupAt,
    longestStreakDays,
    largestBulkAdd,
    totals,
    perWeek: per(7 * 86_400_000),
    perMonth: per(30.44 * 86_400_000),
    perYear: per(365.25 * 86_400_000),
  };
}

export interface StorageStats {
  /** navigator.storage.estimate() — null where unsupported. */
  browserUsage: number | null;
  browserQuota: number | null;
  /** Server database size in bytes; null when offline-mode or unreachable. */
  serverBytes: number | null;
}

export async function storageStats(): Promise<StorageStats> {
  let browserUsage: number | null = null;
  let browserQuota: number | null = null;
  if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
    try {
      const est = await navigator.storage.estimate();
      browserUsage = est.usage ?? null;
      browserQuota = est.quota ?? null;
    } catch {
      // unsupported — leave nulls
    }
  }

  let serverBytes: number | null = null;
  if (getSyncMode() === 'sync' && (typeof navigator === 'undefined' || navigator.onLine)) {
    try {
      const res = await fetch(`${getSyncUrl()}/dbsize`);
      if (res.ok) {
        serverBytes = ((await res.json()) as { bytes: number }).bytes ?? null;
      }
    } catch {
      // server unreachable — the UI says so
    }
  }

  return { browserUsage, browserQuota, serverBytes };
}

/** '3.2 MB', '481 kB' — for the storage card. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let u = -1;
  do {
    v /= 1024;
    u++;
  } while (v >= 1024 && u < units.length - 1);
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}
