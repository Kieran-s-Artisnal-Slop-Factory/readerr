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
import { all, byIndex, bulkPut, get, patch, put, withSyncFields } from '../db/repo';
import type { Link, ResourceListLink, StripMode } from '../db/types';
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
import { addToList, ensureListIdsByName } from './resourceLists';
import { getUserSettings } from './settings';
import {
  currentWeekStart,
  pendingWeeksForLink,
  reviewLink,
  setLinkWeek,
  weekHistoryForLink,
  weekStartPlus,
} from './weeks';
import { getSyncMode, getSyncUrl } from '../sync';
import { isTestMode } from '../testMode';

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
  /^via$/i,
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
 * Does a query-param name match a user-defined strip entry? Entries are
 * case-insensitive names; a trailing * matches a prefix (`sess*`).
 */
function matchesExtraParam(key: string, extraParams: string[]): boolean {
  const k = key.toLowerCase();
  return extraParams.some((raw) => {
    const entry = raw.trim().toLowerCase();
    if (!entry) return false;
    if (entry.endsWith('*')) return entry.length > 1 && k.startsWith(entry.slice(0, -1));
    return k === entry;
  });
}

/**
 * Clean a URL per the strip mode. 'trackers' removes the known tracking
 * params plus any user-defined extras (Settings → Link handling; a YouTube
 * ?v= survives); 'all' drops the whole query string — except on whitelisted
 * domains, which fall back to trackers+extras cleaning so their meaningful
 * params survive.
 */
export function cleanUrl(
  url: string,
  mode: StripMode,
  whitelist: string[] = [],
  extraParams: string[] = []
): string {
  if (mode === 'off') return url;
  try {
    const u = new URL(url);
    if (mode === 'all' && !hostWhitelisted(u.hostname, whitelist)) {
      u.search = '';
    } else {
      for (const key of [...u.searchParams.keys()]) {
        if (TRACKING_PARAMS.some((re) => re.test(key)) || matchesExtraParam(key, extraParams)) {
          u.searchParams.delete(key);
        }
      }
    }
    return u.toString();
  } catch {
    return url;
  }
}

export interface BulkStripResult {
  /** Links whose URL was rewritten. */
  changed: number;
  /** Links left alone because the cleaned URL belongs to another link. */
  collided: number;
}

/**
 * Apply the CURRENT strip settings to every stored link's URL — capture only
 * cleans NEW pastes, so links saved before stripping was enabled keep their
 * tracking junk until this runs (Settings → Link handling → "Run stripping on
 * existing links"). Only the url field is written, via patch, so concurrent
 * pulled edits survive. A cleaned URL that another live link already owns is
 * skipped: rewriting it would leave two rows for one URL and capture's dedupe
 * would pick between them arbitrarily. Archived (cold-store) links are not
 * touched — they're frozen history.
 */
export async function stripExistingLinks(): Promise<BulkStripResult> {
  const settings = await getUserSettings();
  const mode = settings?.strip_query_params ?? 'off';
  const result: BulkStripResult = { changed: 0, collided: 0 };
  if (mode === 'off') return result;
  const whitelist = settings?.strip_whitelist ?? [];
  const extraParams = settings?.strip_extra_params ?? [];
  const links = await all<Link>('links');
  const byUrl = new Map(links.map((l) => [l.url, l]));
  for (const link of links) {
    const next = cleanUrl(link.url, mode, whitelist, extraParams);
    if (next === link.url) continue;
    const owner = byUrl.get(next);
    if (owner && owner.id !== link.id) {
      result.collided++;
      continue;
    }
    await patch<Link>('links', link.id, () => ({ url: next }));
    byUrl.delete(link.url);
    byUrl.set(next, link);
    result.changed++;
  }
  return result;
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
  /** Resource lists to add every captured link to (implies isResource). */
  listIds?: string[];
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

  // List memberships the link doesn't already hold. The flags block above has
  // already upgraded is_resource (listIds implies it via effectiveAssign), so
  // addToList only inserts the membership row.
  for (const listId of assign.listIds ?? []) {
    const joins = await byIndex<ResourceListLink>('resource_list_links', 'list_id', listId);
    if (joins.some((j) => j.link_id === link.id)) continue;
    await addToList(listId, link);
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

  // Marking done comes LAST, mirroring the fresh-capture path: markLinkDone's
  // slush check must see the labels assigned above, and its week handling must
  // see the week assigned above.
  //
  // Re-capturing an already-saved URL with ✓ (or !done) used to ignore the flag
  // entirely — the link joined the chosen week and sat there unread, which is
  // the "comes into the reading week not marked read" bug.
  //
  // Only act when there is something to do: an unread link, or one sitting
  // un-ticked in an open week (the case above). A link already read with
  // nothing pending is left alone rather than being re-filed into the current
  // week — that would rewrite reading history and churn the row for a sync push.
  if (assign.markDone) {
    const pending = await pendingWeeksForLink(link.id);
    if (!link.read_at || pending.some(({ entry }) => !entry.done_at)) {
      // slush=false: done from capture never slushes immediately (week-close
      // still can), same as the fresh path.
      link = await markLinkDone(link, false);
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
  const listIds =
    opts.list === false
      ? []
      : opts.list
        ? [...new Set([...(assign?.listIds ?? []), ...(await ensureListIdsByName(opts.list))])]
        : (assign?.listIds ?? []);
  const weekStart =
    opts.week === false
      ? null
      : opts.week !== undefined
        ? weekStartPlus(currentWeekStart(), opts.week)
        : (assign?.weekStart ?? null);
  return {
    tagIds,
    topicIds,
    listIds,
    weekStart,
    markDone: opts.done ?? assign?.markDone ?? false,
    favourite: opts.favourite ?? assign?.favourite ?? false,
    // A resource list only holds resources, so membership implies the flag —
    // even over an explicit !resource=false on the same line.
    isResource: listIds.length > 0 || (opts.resource ?? assign?.isResource ?? false),
    priority: opts.priority ?? assign?.priority,
  };
}

/**
 * Store pasted URLs as backlog links. A duplicate URL isn't re-added: its
 * line's options merge onto the existing link (mergeIntoExisting), and it
 * reports in `duplicates` — plus `merged` when something actually changed.
 * The labels, lists, week, flags, and priority in `assign` apply to every
 * captured link; per-line !options override them line by line (captureDsl.ts).
 */
export async function captureLinks(text: string, assign?: CaptureAssign): Promise<CaptureResult> {
  const { entries, invalid, badOptions } = parseUrls(text);
  const settings = await getUserSettings();
  const batchStrip = assign?.stripMode ?? settings?.strip_query_params ?? 'off';
  const settingsStrip = settings?.strip_query_params ?? 'off';
  const whitelist = settings?.strip_whitelist ?? [];
  const extraParams = settings?.strip_extra_params ?? [];
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
    const url = cleanUrl(rawUrl, stripMode, whitelist, extraParams);
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
    // The row was created with is_resource already true (listIds implies it),
    // so addToList only inserts the membership.
    for (const listId of eff.listIds ?? []) await addToList(listId, link);
    if (eff.weekStart) await setLinkWeek(link.id, eff.weekStart);
    // Done from capture doesn't slush immediately (week-close still can).
    if (eff.markDone) await markLinkDone(link, false);
  }
  // The loop above rewrote these rows (markLinkDone sets read_at, a topic
  // assignment can clear slushed_at), so the bulkPut snapshots are stale.
  // Callers RENDER these rows — the capture box lists them under "Just Added" —
  // so returning the snapshots showed a link captured with ✓ as still unread.
  const stored = await Promise.all(
    added.map(async (l) => (await get<Link>('links', l.id)) ?? l)
  );
  // Only chase titles when auto-title is on (default true); otherwise bare
  // links keep their URL as the title.
  const autoTitle = assign?.autoTitle ?? settings?.auto_title ?? true;
  if (autoTitle) void fetchTitles(stored.filter((l) => !l.title_fetched));
  return { added: stored, duplicates, merged, invalid, badOptions };
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
 *
 * `link` is captured before the fetch and this is the app's LONGEST-lived stale
 * row: three attempts plus network latency, fanned out across the whole
 * untitled backlog. A sync pull will land remote edits inside that window, so
 * the result is written onto the CURRENT row and touches only the title fields
 * (audit §7.1/D10) — a whole-row write here reverted the other device's edits
 * and won LWW globally. A link deleted mid-fetch is skipped, not resurrected.
 *
 * A row that already reads title_fetched is left alone: another device (or the
 * user, via renameLink) has since settled an authoritative title, and that is
 * exactly the flag that means "stop fetching over this".
 */
async function fetchTitle(link: Link, base: string): Promise<void> {
  for (let attempt = 0; attempt < TITLE_ATTEMPTS; attempt++) {
    try {
      const title = await fetchTitleViaBackend(link.url, base);
      if (title) {
        await patch<Link>('links', link.id, (current) =>
          current.title_fetched ? null : { title, title_fetched: true }
        );
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
  // Harness: a title landing seconds after a capture would re-stamp links
  // mid-test; tests that want titles call the backend explicitly.
  if (isTestMode()) return;
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
