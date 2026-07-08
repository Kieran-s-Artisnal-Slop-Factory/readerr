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
import type { Link } from '../db/types';
import { assignTag, assignTopic } from './links';
import { getSyncUrl } from '../sync';

export interface CaptureResult {
  added: Link[];
  /** URLs skipped because a live link with the same URL already exists. */
  duplicates: string[];
  /** Non-empty lines that don't parse as http(s) URLs. */
  invalid: string[];
}

/** Parse pasted text into normalized http(s) URLs, one per line. */
export function parseUrls(text: string): { urls: string[]; invalid: string[] } {
  const urls: string[] = [];
  const invalid: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const u = new URL(trimmed);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        urls.push(u.toString());
      } else {
        invalid.push(trimmed);
      }
    } catch {
      invalid.push(trimmed);
    }
  }
  return { urls, invalid };
}

export interface CaptureAssign {
  tagIds?: string[];
  topicIds?: string[];
}

/**
 * Store pasted URLs as backlog links, skipping duplicates. Any tag/topic
 * ids in `assign` are attached to every newly captured link.
 */
export async function captureLinks(text: string, assign?: CaptureAssign): Promise<CaptureResult> {
  const { urls, invalid } = parseUrls(text);
  const duplicates: string[] = [];
  const fresh: Link[] = [];
  const seen = new Set<string>();

  for (const url of urls) {
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
        title: url,
        title_fetched: false,
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
    for (const tagId of assign?.tagIds ?? []) await assignTag(link.id, tagId);
    for (const topicId of assign?.topicIds ?? []) await assignTopic(link.id, topicId);
  }
  void fetchTitles(added);
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
