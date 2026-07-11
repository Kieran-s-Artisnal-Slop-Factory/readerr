/**
 * Quick-paste capture: turn a blob of pasted text into backlog links.
 *
 * Capture is instant and fully offline — links are stored immediately with
 * title = url and title_fetched = false. Titles are then resolved
 * fire-and-forget: through the backend's GET /title endpoint when a sync
 * server is available (it can read cross-origin pages the browser can't),
 * or by a direct client-side fetch in offline-only mode (best effort — CORS
 * limits which sites work). Rows that still have title_fetched = false are
 * retried by retryMissingTitles() on backlog mount — the whole retry
 * mechanism, no queue needed.
 */
import { all, byIndex, bulkPut, put, withSyncFields } from '../db/repo';
import type { Link, StripMode } from '../db/types';
import { assignTag, assignTopic, markLinkDone } from './links';
import { getUserSettings } from './settings';
import { setLinkWeek } from './weeks';
import { getSyncMode, getSyncUrl } from '../sync';

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

/** Does the URL's host match a whitelist entry (exact or subdomain)? */
function hostWhitelisted(host: string, whitelist: string[]): boolean {
  const h = host.toLowerCase().replace(/^www\./, '');
  return whitelist.some((raw) => {
    const entry = raw.trim().toLowerCase().replace(/^www\./, '');
    return entry !== '' && (h === entry || h.endsWith(`.${entry}`));
  });
}

/**
 * Clean a URL per the strip mode. 'trackers' removes only known tracking
 * params (a YouTube ?v= survives); 'all' drops the whole query string —
 * except on whitelisted domains, which fall back to trackers-only cleaning
 * so their meaningful params survive.
 */
export function cleanUrl(url: string, mode: StripMode, whitelist: string[] = []): string {
  if (mode === 'off') return url;
  try {
    const u = new URL(url);
    if (mode === 'all' && !hostWhitelisted(u.hostname, whitelist)) {
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
  /** Fetch titles for bare links; omitted = the user_settings default. */
  autoTitle?: boolean;
}

/**
 * Store pasted URLs as backlog links, skipping duplicates. Any tag/topic
 * ids in `assign` are attached to every newly captured link.
 */
export async function captureLinks(text: string, assign?: CaptureAssign): Promise<CaptureResult> {
  const { entries, invalid } = parseUrls(text);
  const settings = await getUserSettings();
  const stripMode = assign?.stripMode ?? settings?.strip_query_params ?? 'off';
  const whitelist = settings?.strip_whitelist ?? [];
  const duplicates: string[] = [];
  const fresh: Link[] = [];
  const seen = new Set<string>();

  for (const { url: rawUrl, title } of entries) {
    const url = cleanUrl(rawUrl, stripMode, whitelist);
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
  // Only chase titles when auto-title is on (default true); otherwise bare
  // links keep their URL as the title.
  const autoTitle = assign?.autoTitle ?? settings?.auto_title ?? true;
  if (autoTitle) void fetchTitles(added.filter((l) => !l.title_fetched));
  return { added, duplicates, invalid };
}

const TITLE_ATTEMPTS = 3;
const TITLE_RETRY_MS = 400;
const MAX_TITLE_LEN = 300;

/** Ask the backend's /title endpoint. Returns the title or null. */
async function fetchTitleViaBackend(url: string, base: string): Promise<string | null> {
  const res = await fetch(`${base}/title?url=${encodeURIComponent(url)}`);
  if (!res.ok) return null;
  const json = (await res.json()) as { ok: boolean; title?: string };
  return json.ok && json.title ? json.title : null;
}

/**
 * Fetch the page directly from the browser and extract its title — the
 * offline-mode fallback when there's no backend. Mirrors the backend's
 * extraction (og:title, then <title>). Cross-origin CORS blocks the body
 * for most sites, so this succeeds only where the site allows it; failures
 * fall back to the URL as title, same as the backend path.
 */
async function fetchTitleViaClient(url: string): Promise<string | null> {
  const res = await fetch(url, { headers: { Accept: 'text/html' } });
  if (!res.ok) return null;
  const html = await res.text();
  const og =
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ??
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
  const raw = og?.[1] ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (!raw) return null;
  // Decode entities via a detached textarea, collapse whitespace, cap length.
  const el = document.createElement('textarea');
  el.innerHTML = raw;
  const title = el.value.trim().replace(/\s+/g, ' ').slice(0, MAX_TITLE_LEN);
  return title || null;
}

/**
 * Resolve a title, retrying up to 3 times with 400ms between attempts. The
 * source depends on mode: the backend /title endpoint when a sync server is
 * available, otherwise a direct client-side fetch (offline mode). On success
 * the link row is updated; on failure the link keeps its URL as the title
 * (title_fetched stays false so a later pass can try again).
 */
async function fetchTitle(link: Link, mode: 'backend' | 'client', base: string): Promise<void> {
  for (let attempt = 0; attempt < TITLE_ATTEMPTS; attempt++) {
    try {
      const title =
        mode === 'backend'
          ? await fetchTitleViaBackend(link.url, base)
          : await fetchTitleViaClient(link.url);
      if (title) {
        await put<Link>('links', { ...link, title, title_fetched: true });
        return;
      }
    } catch {
      // network/CORS/parse error — fall through to retry
    }
    if (attempt < TITLE_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, TITLE_RETRY_MS));
    }
  }
}

/**
 * Resolve titles for the given links (each retried; errors swallowed). Uses
 * the backend when syncing is on (a server, even same-origin, is available);
 * in offline-only mode it fetches client-side instead.
 */
export async function fetchTitles(links: Link[]): Promise<void> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;
  const mode = getSyncMode() === 'offline' ? 'client' : 'backend';
  const base = getSyncUrl();
  await Promise.allSettled(links.map((link) => fetchTitle(link, mode, base)));
}

/**
 * Retry title resolution for every link still missing one — but only when
 * auto-title is enabled, so leaving it off keeps bare links bare.
 */
export async function retryMissingTitles(): Promise<void> {
  if ((await getUserSettings())?.auto_title === false) return;
  const links = await all<Link>('links');
  const missing = links.filter((l) => !l.title_fetched);
  if (missing.length > 0) await fetchTitles(missing);
}
