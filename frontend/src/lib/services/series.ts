/**
 * Series: a link that is a folder of other links.
 *
 * The whole design rests on one decision (docs/dev/experiments & plans/series.md
 * §2.1): **a series IS a link**, flagged `is_series`, with one `series_links`
 * edge per member. Everything a link can do — favourite, tag, topic, note,
 * schedule into a reading week, prioritise, search — a series does for free,
 * and the sync engine gains exactly one junction table it already knows how to
 * handle (`dedupePairs`, tombstones, LWW).
 *
 * Consequences the rest of this file keeps honest:
 *   - `position` is a hint, never an identity: reads sort by (position, id) so
 *     two devices that both wrote "4" still agree on the order;
 *   - progress (`2/5`) is computed from the parts, never stored — a counter is
 *     one more field for LWW to lose;
 *   - the series' own `read_at` and a part's `read_at` mean different things,
 *     and finishing the parts only ever *offers* to close the series.
 */
import {
  all,
  byIndex,
  bulkPut,
  dedupePairs,
  get,
  patch,
  put,
  softDelete,
  softDeleteMany,
  withSyncFields,
} from '../db/repo';
import { assignTag, assignTopic } from './links';
import { captureLinks } from './capture';
import { setLinkWeek } from './weeks';
import type { Link, SeriesLink } from '../db/types';

/**
 * A series with no overview page still needs a URL: `links.url` is NOT NULL
 * and is capture's de-duplication key, so two blank ones would collide. A
 * synthesised `series:<uuid>` is unique, survives `cleanUrl` untouched (it
 * isn't http), and is recognisable — the UI renders it as plain text rather
 * than a dead link.
 */
export const SERIES_URL_PREFIX = 'series:';

/** True for a link that is a series, tolerating rows written before the flag. */
export function isSeries(link: Pick<Link, 'is_series'>): boolean {
  return link.is_series === true;
}

/** Does this URL stand in for "no overview page"? */
export function isSyntheticSeriesUrl(url: string): boolean {
  return url.startsWith(SERIES_URL_PREFIX);
}

/** The (series, link) pair an edge stands for — its logical identity. */
const pairKey = (e: SeriesLink): string => `${e.series_id} ${e.link_id}`;

/**
 * Collapse duplicate (series, link) edges to one (see repo.dedupePairs), and
 * keep the LOWEST position of the group, so two devices that appended the same
 * part at different numbers land on the same one. Must be handed a complete
 * set of live rows for the pairs it covers — one series' edges, or the whole
 * store; a pair never spans series.
 */
async function dedupeEdges(rows: SeriesLink[]): Promise<SeriesLink[]> {
  return dedupePairs('series_links', rows, pairKey, (survivor, duplicates) => {
    const group = [survivor, ...duplicates];
    const lowest = Math.min(...group.map((e) => e.position));
    if (lowest === survivor.position) return null;
    // Carry the group's freshest timestamp with the merged value, or the fold
    // loses to the server's older copy of this same row under LWW.
    return {
      ...survivor,
      position: lowest,
      updated_at: group.reduce((m, e) => (e.updated_at > m ? e.updated_at : m), survivor.updated_at),
    };
  });
}

/** Device-independent order: position first, id as the tie-break. */
const byPosition = (a: SeriesLink, b: SeriesLink): number =>
  a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Live edges of one series, de-duplicated and ordered. Self-edges (a series
 * listed as its own part — only reachable by two devices racing, since the
 * writers refuse it) are dropped on read rather than trusted: they would
 * otherwise recurse forever in the UI.
 */
export async function edgesOf(seriesId: string): Promise<SeriesLink[]> {
  const rows = await byIndex<SeriesLink>('series_links', 'series_id', seriesId);
  const edges = await dedupeEdges(rows);
  return edges.filter((e) => e.link_id !== e.series_id).sort(byPosition);
}

export interface SeriesPart {
  link: Link;
  edge: SeriesLink;
  /** 1-based display number — the position the reader sees, not the stored one. */
  number: number;
}

/**
 * The parts of a series, in order. An edge whose link is gone (deleted on
 * another device, tombstone arrived first) is skipped rather than rendered as
 * a hole — the edge is cleaned up by `removeMissingParts` when something
 * actually writes.
 */
export async function partsOf(seriesId: string): Promise<SeriesPart[]> {
  const edges = await edgesOf(seriesId);
  const parts: SeriesPart[] = [];
  for (const edge of edges) {
    const link = await get<Link>('links', edge.link_id);
    if (link) parts.push({ link, edge, number: parts.length + 1 });
  }
  return parts;
}

/** The series a link belongs to (usually none, occasionally more than one). */
export async function seriesForLink(linkId: string): Promise<Link[]> {
  const edges = await byIndex<SeriesLink>('series_links', 'link_id', linkId);
  const out: Link[] = [];
  for (const edge of edges) {
    if (edge.series_id === linkId) continue; // self-edge, see edgesOf
    const link = await get<Link>('links', edge.series_id);
    if (link) out.push(link);
  }
  return out;
}

export interface SeriesProgress {
  read: number;
  total: number;
  /** Every part read (and there is at least one). */
  complete: boolean;
}

/** Progress across parts — computed on read, never stored. */
export function progressOf(parts: SeriesPart[]): SeriesProgress {
  const read = parts.filter((p) => !!p.link.read_at).length;
  return { read, total: parts.length, complete: parts.length > 0 && read === parts.length };
}

/**
 * The part ids belonging to any series in `links` — what a list uses to avoid
 * showing a part twice, once nested under its series and once as a row of its
 * own (series.md §4). One indexed read per series on the page; no scan, and
 * nothing at all when the page holds no series.
 */
export async function partIdsOf(links: Link[]): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const link of links) {
    if (!isSeries(link)) continue;
    for (const edge of await edgesOf(link.id)) ids.add(edge.link_id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** One past the highest position currently in the series. */
async function nextPosition(seriesId: string): Promise<number> {
  const edges = await edgesOf(seriesId);
  return edges.reduce((max, e) => Math.max(max, e.position), 0) + 1;
}

/**
 * Add an existing link to a series. Refuses the two shapes v1 doesn't allow —
 * a series inside itself, and a series as a part of another series (the
 * plan's non-goal; readers stay cycle-tolerant anyway). Adding a link that is
 * already a part is a no-op, not a second edge.
 */
export async function addPart(
  series: Link,
  link: Link,
  position?: number
): Promise<SeriesLink | null> {
  if (link.id === series.id) return null;
  if (isSeries(link)) return null;
  const existing = (await edgesOf(series.id)).find((e) => e.link_id === link.id);
  if (existing) return existing;
  return put<SeriesLink>(
    'series_links',
    withSyncFields({
      series_id: series.id,
      link_id: link.id,
      position: position ?? (await nextPosition(series.id)),
    })
  );
}

/** Remove a part from a series. The link itself stays — it was a real capture. */
export async function removePart(seriesId: string, linkId: string): Promise<void> {
  const edges = await edgesOf(seriesId);
  const ids = edges.filter((e) => e.link_id === linkId).map((e) => e.id);
  if (ids.length) await softDeleteMany('series_links', ids);
}

/**
 * Rewrite the whole run of positions in the given link order (1..n).
 *
 * The entire run is rewritten rather than the moved row alone: positions are
 * only a hint, and rewriting them all is what makes the common case converge
 * to a clean 1..n instead of accumulating ties. A concurrent reorder on
 * another device degrades to "one of the two orders wins" — never to a lost
 * or duplicated part.
 */
export async function reorderParts(seriesId: string, orderedLinkIds: string[]): Promise<void> {
  const edges = await edgesOf(seriesId);
  const byLink = new Map(edges.map((e) => [e.link_id, e]));
  const rows: SeriesLink[] = [];
  let position = 1;
  for (const linkId of orderedLinkIds) {
    const edge = byLink.get(linkId);
    if (!edge) continue;
    byLink.delete(linkId);
    if (edge.position !== position) rows.push({ ...edge, position });
    position++;
  }
  // Anything the caller didn't name keeps its relative order at the end.
  for (const edge of [...byLink.values()].sort(byPosition)) {
    if (edge.position !== position) rows.push({ ...edge, position });
    position++;
  }
  if (rows.length) await bulkPut('series_links', rows);
}

/** Move one part up or down by one place. */
export async function movePart(
  seriesId: string,
  linkId: string,
  delta: -1 | 1
): Promise<void> {
  const order = (await edgesOf(seriesId)).map((e) => e.link_id);
  const from = order.indexOf(linkId);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= order.length) return;
  order.splice(to, 0, ...order.splice(from, 1));
  await reorderParts(seriesId, order);
}

export interface NewSeriesPart {
  url: string;
  title?: string;
  /** Monday 'YYYY-MM-DD', or '' / null for "not scheduled". */
  weekStart?: string | null;
  tagIds?: string[];
  topicIds?: string[];
}

export interface NewSeries {
  title: string;
  descriptionMd?: string;
  /** The landing page, if there is one; blank synthesises `series:<uuid>`. */
  overviewUrl?: string;
  tagIds?: string[];
  topicIds?: string[];
  weekStart?: string | null;
  parts: NewSeriesPart[];
}

export interface CreatedSeries {
  series: Link;
  parts: SeriesPart[];
  /** Parts whose URL was already in the library — merged, not duplicated. */
  reused: number;
}

/**
 * Create a series and its parts in one pass.
 *
 * Parts go through the ordinary capture pipeline, so URL cleaning, duplicate
 * merging, auto-titles, and week scheduling behave exactly as they do
 * everywhere else — a part you already had becomes a member of the series
 * instead of a second copy of the link.
 */
export async function createSeries(input: NewSeries): Promise<CreatedSeries> {
  const title = input.title.trim();
  if (!title) throw new Error('A series needs a title.');

  const id = crypto.randomUUID();
  const overview = (input.overviewUrl ?? '').trim();
  const series = await put<Link>('links', {
    ...withSyncFields({
      url: overview || `${SERIES_URL_PREFIX}${id}`,
      title,
      // The title is the user's own, so nothing should fetch over it — and a
      // synthesised series: URL is not fetchable in the first place.
      title_fetched: true,
      added_at: new Date().toISOString(),
      read_at: null,
      favourite: false,
      is_resource: false,
      slushed_at: null,
      priority: null,
      is_series: true,
    }),
    id,
  });

  for (const tagId of input.tagIds ?? []) await assignTag(series.id, tagId);
  for (const topicId of input.topicIds ?? []) await assignTopic(series.id, topicId);
  if (input.weekStart) await setLinkWeek(series.id, input.weekStart);
  // The description is the series' note document — the same place a link's
  // prose always lives, so it never fights the row's flag toggles under LWW.
  if (input.descriptionMd?.trim()) {
    await put('notes', withSyncFields({ link_id: series.id, body_md: input.descriptionMd.trim() }));
  }

  let reused = 0;
  let position = 1;
  for (const part of input.parts) {
    const url = part.url.trim();
    if (!url) continue;
    const result = await captureLinks(`[${captureSafeTitle(part.title || url)}](${url})`, {
      weekStart: part.weekStart || null,
      tagIds: part.tagIds ?? [],
      topicIds: part.topicIds ?? [],
    });
    let link = result.added[0] ?? null;
    if (link && part.title && link.title !== part.title) {
      // The capture DSL can't carry square brackets; restore the real title.
      link = (await patch<Link>('links', link.id, () => ({
        title: part.title!,
        title_fetched: true,
      }))) ?? link;
    }
    if (!link) {
      // The URL was already in the library: capture merged into it.
      const [existing] = await byIndex<Link>('links', 'url', url);
      link = existing ?? null;
      if (link) reused++;
    }
    if (!link) continue;
    await addPart(series, link, position++);
  }

  return { series, parts: await partsOf(series.id), reused };
}

/**
 * A title the capture DSL can carry: `[Title](url)` has no escape for square
 * brackets, and a newline would split one capture into two. createSeries
 * restores the exact title immediately afterwards, so this only has to parse.
 */
function captureSafeTitle(title: string): string {
  return title.replace(/\s+/g, ' ').replace(/[[\]]/g, '').trim() || title.trim();
}

/**
 * Delete a series: its edges go with it (a live edge pointing at a tombstoned
 * link is the referential violation the sync harness checks for), the parts
 * stay — they are links the user captured in their own right.
 */
export async function deleteSeries(series: Link): Promise<void> {
  const edges = await byIndex<SeriesLink>('series_links', 'series_id', series.id);
  await softDeleteMany('series_links', edges.map((e) => e.id));
  await softDelete('links', series.id);
}

/**
 * Detach a link from every series it belongs to — call before deleting a
 * link, for the same referential reason as deleteSeries.
 */
export async function detachFromSeries(linkId: string): Promise<void> {
  const edges = await byIndex<SeriesLink>('series_links', 'link_id', linkId);
  await softDeleteMany('series_links', edges.map((e) => e.id));
}

/**
 * Mark the series itself read (what the "all parts done" prompt calls). The
 * parts are untouched: their read state is theirs, and the series' own is the
 * separate statement "I'm finished with this".
 */
export async function markSeriesRead(series: Link, read = true): Promise<Link | undefined> {
  return patch<Link>('links', series.id, (current) => ({
    read_at: read ? (current.read_at ?? new Date().toISOString()) : null,
  }));
}

/**
 * Drop edges whose link or series no longer exists. Cheap self-healing for
 * the case where a link was deleted on another device by code that predates
 * `detachFromSeries` — run from the series page, which is where a hole shows.
 */
export async function pruneDeadEdges(): Promise<number> {
  const liveLinks = new Set((await all<Link>('links')).map((l) => l.id));
  const dead = (await all<SeriesLink>('series_links')).filter(
    (e) => !liveLinks.has(e.series_id) || !liveLinks.has(e.link_id)
  );
  if (dead.length) await softDeleteMany('series_links', dead.map((e) => e.id));
  return dead.length;
}
