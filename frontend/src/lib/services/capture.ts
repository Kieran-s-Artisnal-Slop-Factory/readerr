/**
 * Quick-paste capture: turn a blob of pasted text into backlog links.
 *
 * Capture is instant and fully offline — links are stored immediately with
 * title = url and title_fetched = false. Titles are then resolved
 * fire-and-forget through the backend's GET /title endpoint (the browser
 * can't fetch cross-origin pages itself); rows that still have
 * title_fetched = false are retried by retryMissingTitles() on backlog
 * mount, which is the whole retry mechanism — no queue needed.
 */
import { all, byIndex, bulkPut, put, withSyncFields } from '../db/repo';
import type { Link, StripMode } from '../db/types';
import { assignTag, assignTopic, markLinkDone } from './links';
import { getUserSettings } from './settings';
import { setLinkWeek } from './weeks';
import { getSyncUrl } from '../sync';

/** Query params that only exist to track you — safe to drop from any URL. */
const TRACKING_PARAMS = [
  /^utm_/i,
  /^ref$/i,
  /^ref_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^dclid$/i,
  /^msclkid$/i,
  /^mc_[ce]id$/i,
  /^igshid$/i,
  /^si$/i,
  /^source$/i,
  /^cmpid$/i,
];

/**
 * Clean a URL per the strip mode. 'trackers' removes only known tracking
 * params (a YouTube ?v= survives); 'all' drops the whole query string.
 */
export function cleanUrl(url: string, mode: StripMode): string {
  if (mode === 'off') return url;
  try {
    const u = new URL(url);
    if (mode === 'all') {
      u.search = '';
    } else {
      for (const key of [...u.searchParams.keys()]) {
        if (TRACKING_PARAMS.some((re) => re.test(key))) u.searchParams.delete(key);
      }
    }
    return u.toString();
  } catch {
    return url;
  }
}

export interface CaptureResult {
  added: Link[];
  /** URLs skipped because a live link with the same URL already exists. */
  duplicates: string[];
  /** Non-empty lines that don't parse as http(s) URLs. */
  invalid: string[];
}

export interface ParsedLine {
  url: string;
  /** Provided by markdown-format lines; null means "fetch it". */
  title: string | null;
}

/**
 * Parse pasted text, one link per line. Whitespace is stripped and three
 * formats are accepted (bullets compose with the others):
 *   - plain URL:       https://example.com
 *   - bullet pointed:  - https://example.com
 *   - markdown:        [Title](https://example.com)
 */
export function parseUrls(text: string): { entries: ParsedLine[]; invalid: string[] } {
  const entries: ParsedLine[] = [];
  const invalid: string[] = [];

  const toHttpUrl = (raw: string): string | null => {
    try {
      const u = new URL(raw);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
    } catch {
      return null;
    }
  };

  for (const line of text.split('\n')) {
    let trimmed = line.trim();
    if (!trimmed) continue;
    // Strip a leading list bullet: -, *, or •.
    trimmed = trimmed.replace(/^[-*•]\s+/, '');

    const md = trimmed.match(/^\[(.+)\]\((\S+)\)$/);
    const url = toHttpUrl(md ? md[2] : trimmed);
    if (!url) {
      invalid.push(trimmed);
      continue;
    }
    entries.push({ url, title: md ? md[1].trim() : null });
  }
  return { entries, invalid };
}

export interface CaptureAssign {
  tagIds?: string[];
  topicIds?: string[];
  /** Monday 'YYYY-MM-DD' — queues every captured link for that week. */
  weekStart?: string | null;
  /** Mark everything done on capture (joins this week, slushes if unremarked). */
  markDone?: boolean;
  /** URL cleaning; omitted = the user_settings default. */
  stripMode?: StripMode;
}

/**
 * Store pasted URLs as backlog links, skipping duplicates. Any tag/topic
 * ids in `assign` are attached to every newly captured link.
 */
export async function captureLinks(text: string, assign?: CaptureAssign): Promise<CaptureResult> {
  const { entries, invalid } = parseUrls(text);
  const stripMode =
    assign?.stripMode ?? (await getUserSettings())?.strip_query_params ?? 'off';
  const duplicates: string[] = [];
  const fresh: Link[] = [];
  const seen = new Set<string>();

  for (const { url: rawUrl, title } of entries) {
    const url = cleanUrl(rawUrl, stripMode);
    if (seen.has(url)) {
      duplicates.push(url); // dedupe within the paste itself
      continue;
    }
    seen.add(url);
    const existing = await byIndex<Link>('links', 'url', url);
    if (existing.length > 0) {
      duplicates.push(url);
      continue;
    }
    fresh.push(
      withSyncFields({
        url,
        // A markdown-supplied title is authoritative — don't fetch over it.
        title: title ?? url,
        title_fetched: title !== null,
        added_at: new Date().toISOString(),
        read_at: null,
        favourite: false,
        is_resource: false,
        slushed_at: null,
      })
    );
  }

  const added = fresh.length > 0 ? await bulkPut('links', fresh) : [];
  for (const link of added) {
    // Labels first: markLinkDone's slush check must see topic assignments.
    for (const tagId of assign?.tagIds ?? []) await assignTag(link.id, tagId);
    for (const topicId of assign?.topicIds ?? []) await assignTopic(link.id, topicId);
    if (assign?.weekStart) await setLinkWeek(link.id, assign.weekStart);
    if (assign?.markDone) await markLinkDone(link);
  }
  void fetchTitles(added.filter((l) => !l.title_fetched));
  return { added, duplicates, invalid };
}

/**
 * Resolve titles through the backend. Errors are swallowed — the row keeps
 * title_fetched = false and gets retried later.
 */
export async function fetchTitles(links: Link[]): Promise<void> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;
  const base = getSyncUrl();
  await Promise.allSettled(
    links.map(async (link) => {
      const res = await fetch(`${base}/title?url=${encodeURIComponent(link.url)}`);
      if (!res.ok) return;
      const json = (await res.json()) as { ok: boolean; title?: string };
      if (!json.ok || !json.title) return;
      await put<Link>('links', { ...link, title: json.title, title_fetched: true });
    })
  );
}

/** Retry title resolution for every link still missing one. */
export async function retryMissingTitles(): Promise<void> {
  const links = await all<Link>('links');
  const missing = links.filter((l) => !l.title_fetched);
  if (missing.length > 0) await fetchTitles(missing);
}
