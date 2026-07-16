/**
 * Quick-paste capture: turn a blob of pasted text into backlog links.
 *
 * Capture is instant and fully offline — links are stored immediately with
 * title = url and title_fetched = false. Titles are then resolved
 * fire-and-forget through the backend's GET /title endpoint (it can read
 * cross-origin pages the browser can't). In offline-only mode there's no
 * backend and a browser fetch is CORS-blocked for nearly every site, so
 * title fetching is skipped entirely. Rows that still have title_fetched =
 * false are retried by retryMissingTitles() on backlog mount — the whole
 * retry mechanism, no queue needed.
 */
import { all, byIndex, bulkPut, get, put, withSyncFields } from '../db/repo';
import type { Link, StripMode } from '../db/types';
import { parseLineOptions, splitLineOptions, type LineOptions } from './captureDsl';
import {
  assignTag,
  assignTopic,
  ensureTagIdsByName,
  ensureTopicIdsByName,
  markLinkDone,
  tagsForLink,
  topicsForLink,
} from './links';
import { getUserSettings } from './settings';
import { currentWeekStart, reviewLink, setLinkWeek, weekHistoryForLink, weekStartPlus } from './weeks';
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
  /** Existing links that had capture options merged into them. */
  merged: Link[];
  /** Non-empty lines that don't parse as http(s) URLs. */
  invalid: string[];
  /** DSL tokens that didn't parse (unknown command, bad value). */
  badOptions: string[];
}

export interface ParsedLine {
  url: string;
  /** Provided by markdown-format lines; null means "fetch it". */
  title: string | null;
  /** Per-line !option overrides (see captureDsl.ts). */
  opts: LineOptions;
}

/**
 * Parse pasted text, one link per line. Whitespace is stripped and three
 * formats are accepted (bullets compose with the others), each optionally
 * followed by per-line !options (see captureDsl.ts):
 *   - plain URL:       https://example.com
 *   - bullet pointed:  - https://example.com
 *   - markdown:        [Title](https://example.com)
 *   - with options:    [Title](https://example.com) !tags=[a,b] !done
 */
export function parseUrls(text: string): {
  entries: ParsedLine[];
  invalid: string[];
  badOptions: string[];
} {
  const entries: ParsedLine[] = [];
  const invalid: string[] = [];
  const badOptions: string[] = [];

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
    // TODO: Add ordered lists

    const { link, optionsText } = splitLineOptions(trimmed);
    const md = link.match(/^\[(.+)\]\((\S+)\)$/);
    const url = toHttpUrl(md ? md[2] : link);
    if (!url) {
      invalid.push(trimmed);
      continue;
    }
    const { opts, bad } = parseLineOptions(optionsText);
    badOptions.push(...bad);
    entries.push({ url, title: md ? md[1].trim() : null, opts });
  }
  return { entries, invalid, badOptions };
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
  /** Flag every captured link as a resource. */
  isResource?: boolean;
  /** Favourite every captured link (merges into existing links too). */
  favourite?: boolean;
  /** Priority 1–3; omitted = unset (treated as 3 everywhere). */
  priority?: number;
}

/**
 * Re-capturing a URL that already exists merges the capture options into
 * the existing link instead of just skipping it: tags/topics are appended,
 * favourite/resource only ever upgrade (a re-capture never clears a flag),
 * and a selected week adds the link as a 'review' entry — unless the link
 * already has an entry (reading or review) in that week. Returns the
 * updated link, or null when nothing needed to change.
 */
async function mergeIntoExisting(link: Link, assign?: CaptureAssign): Promise<Link | null> {
  if (!assign) return null;
  let changed = false;

  // Append labels the link doesn't already carry.
  const tagIds = new Set((await tagsForLink(link.id)).map((t) => t.id));
  for (const tagId of assign.tagIds ?? []) {
    if (tagIds.has(tagId)) continue;
    await assignTag(link.id, tagId);
    changed = true;
  }
  const topicIds = new Set((await topicsForLink(link.id)).map((t) => t.id));
  for (const topicId of assign.topicIds ?? []) {
    if (topicIds.has(topicId)) continue;
    await assignTopic(link.id, topicId); // also rescues from the slush
    changed = true;
  }
  // assignTopic may have rewritten the links row — work from the fresh one.
  if (changed) link = (await get<Link>('links', link.id)) ?? link;

  // Flags only upgrade; an explicit priority replaces the existing one.
  const priorityChange = assign.priority != null && assign.priority !== (link.priority ?? 3);
  if (
    (assign.favourite && !link.favourite) ||
    (assign.isResource && !link.is_resource) ||
    priorityChange
  ) {
    link = await put('links', {
      ...link,
      favourite: link.favourite || !!assign.favourite,
      // Favouriting rescues from the slush archive (as toggleFavourite does).
      slushed_at: assign.favourite ? null : link.slushed_at,
      is_resource: link.is_resource || !!assign.isResource,
      priority: priorityChange ? assign.priority! : link.priority,
    });
    changed = true;
  }

  // A selected week the link was never part of adds it for another look.
  if (assign.weekStart) {
    const history = await weekHistoryForLink(link.id);
    const already = history.some((h) => h.week.week_start === assign.weekStart);
    if (!already) {
      link = await reviewLink(link, assign.weekStart);
      changed = true;
    }
  }

  return changed ? link : null;
}

/**
 * The per-link settings a line resolves to: the batch (UI) assign with any
 * per-line DSL options layered on top. Line tags/topics MERGE with the UI
 * selection (false excludes it); flags and the week override it.
 */
async function effectiveAssign(
  assign: CaptureAssign | undefined,
  opts: LineOptions
): Promise<CaptureAssign> {
  const tagIds =
    opts.tags === false
      ? []
      : opts.tags
        ? [...new Set([...(assign?.tagIds ?? []), ...(await ensureTagIdsByName(opts.tags))])]
        : (assign?.tagIds ?? []);
  const topicIds =
    opts.topics === false
      ? []
      : opts.topics
        ? [...new Set([...(assign?.topicIds ?? []), ...(await ensureTopicIdsByName(opts.topics))])]
        : (assign?.topicIds ?? []);
  const weekStart =
    opts.week === false
      ? null
      : opts.week !== undefined
        ? weekStartPlus(currentWeekStart(), opts.week)
        : (assign?.weekStart ?? null);
  return {
    tagIds,
    topicIds,
    weekStart,
    markDone: opts.done ?? assign?.markDone ?? false,
    favourite: opts.favourite ?? assign?.favourite ?? false,
    isResource: opts.resource ?? assign?.isResource ?? false,
    priority: opts.priority ?? assign?.priority,
  };
}

/**
 * Store pasted URLs as backlog links, skipping duplicates. Any tag/topic
 * ids in `assign` are attached to every newly captured link; per-line
 * !options adjust individual lines (see captureDsl.ts).
 */
export async function captureLinks(text: string, assign?: CaptureAssign): Promise<CaptureResult> {
  const { entries, invalid, badOptions } = parseUrls(text);
  const settings = await getUserSettings();
  const batchStrip = assign?.stripMode ?? settings?.strip_query_params ?? 'off';
  const settingsStrip = settings?.strip_query_params ?? 'off';
  const whitelist = settings?.strip_whitelist ?? [];
  const duplicates: string[] = [];
  const merged: Link[] = [];
  const fresh: { row: Link; eff: CaptureAssign }[] = [];
  const seen = new Set<string>();

  for (const { url: rawUrl, title, opts } of entries) {
    // !clean=false keeps the URL raw; !clean forces cleaning on even when
    // the batch has it off (using the configured mode, else trackers).
    const stripMode =
      opts.clean === false
        ? 'off'
        : opts.clean === true
          ? batchStrip !== 'off'
            ? batchStrip
            : settingsStrip !== 'off'
              ? settingsStrip
              : 'trackers'
          : batchStrip;
    const url = cleanUrl(rawUrl, stripMode, whitelist);
    if (seen.has(url)) {
      duplicates.push(url); // dedupe within the paste itself
      continue;
    }
    seen.add(url);
    const eff = await effectiveAssign(assign, opts);
    const existing = await byIndex<Link>('links', 'url', url);
    if (existing.length > 0) {
      duplicates.push(url);
      // Not a new link, but the line's capture options still apply to it.
      const updated = await mergeIntoExisting(existing[0], eff);
      if (updated) merged.push(updated);
      continue;
    }
    fresh.push({
      eff,
      row: withSyncFields({
        url,
        // A markdown-supplied title is authoritative — don't fetch over it.
        title: title ?? url,
        title_fetched: title !== null,
        added_at: new Date().toISOString(),
        read_at: null,
        favourite: eff.favourite ?? false,
        is_resource: eff.isResource ?? false,
        slushed_at: null,
        priority: eff.priority ?? null,
      }),
    });
  }

  const added =
    fresh.length > 0 ? await bulkPut('links', fresh.map((f) => f.row)) : [];
  for (let i = 0; i < added.length; i++) {
    const link = added[i];
    const eff = fresh[i].eff; // bulkPut preserves order
    // Labels first: markLinkDone's slush check must see topic assignments.
    for (const tagId of eff.tagIds ?? []) await assignTag(link.id, tagId);
    for (const topicId of eff.topicIds ?? []) await assignTopic(link.id, topicId);
    if (eff.weekStart) await setLinkWeek(link.id, eff.weekStart);
    // Done from capture doesn't slush immediately (week-close still can).
    if (eff.markDone) await markLinkDone(link, false);
  }
  // Only chase titles when auto-title is on (default true); otherwise bare
  // links keep their URL as the title.
  const autoTitle = assign?.autoTitle ?? settings?.auto_title ?? true;
  if (autoTitle) void fetchTitles(added.filter((l) => !l.title_fetched));
  return { added, duplicates, merged, invalid, badOptions };
}

const TITLE_ATTEMPTS = 3;
const TITLE_RETRY_MS = 400;

/** Ask the backend's /title endpoint. Returns the title or null. */
async function fetchTitleViaBackend(url: string, base: string): Promise<string | null> {
  const res = await fetch(`${base}/title?url=${encodeURIComponent(url)}`);
  if (!res.ok) return null;
  const json = (await res.json()) as { ok: boolean; title?: string };
  return json.ok && json.title ? json.title : null;
}

/**
 * Resolve a title through the backend, retrying up to 3 times with 400ms
 * between attempts. On success the link row is updated; on failure the link
 * keeps its URL as the title (title_fetched stays false so a later pass can
 * try again).
 */
async function fetchTitle(link: Link, base: string): Promise<void> {
  for (let attempt = 0; attempt < TITLE_ATTEMPTS; attempt++) {
    try {
      const title = await fetchTitleViaBackend(link.url, base);
      if (title) {
        await put<Link>('links', { ...link, title, title_fetched: true });
        return;
      }
    } catch {
      // network/parse error — fall through to retry
    }
    if (attempt < TITLE_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, TITLE_RETRY_MS));
    }
  }
  // Silent failure made "auto-title isn't working" undiagnosable — say why
  // it stopped (the backend also logs each /title request and its outcome).
  console.warn(
    `[readerr] title fetch gave up for ${link.url} after ${TITLE_ATTEMPTS} attempts ` +
      `(server: ${base || 'same origin'}). It retries when the backlog next loads.`
  );
}

/**
 * Resolve titles for the given links (each retried; errors swallowed).
 * Titles are fetched through the backend, which can read cross-origin pages
 * the browser can't. In offline-only mode there's no backend, so we skip it
 * entirely — a direct browser fetch is blocked by CORS for nearly every site
 * and only clutters the console with failures.
 */
export async function fetchTitles(links: Link[]): Promise<void> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;
  if (getSyncMode() === 'offline') return;
  const base = getSyncUrl();
  await Promise.allSettled(links.map((link) => fetchTitle(link, base)));
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
