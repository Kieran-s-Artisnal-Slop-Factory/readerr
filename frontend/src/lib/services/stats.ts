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
import { domainOf } from './links';
import { getUserSettings } from './settings';
import { getSyncMode, getSyncUrl } from '../sync';
import type { Link, LinkTopic, Topic } from '../db/types';

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
  const [links, linkTopics] = await Promise.all([
    all<Link>('links'),
    all<LinkTopic>('link_topics'),
  ]);
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
