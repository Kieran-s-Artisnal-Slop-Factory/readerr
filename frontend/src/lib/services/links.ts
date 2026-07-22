/**
 * Link assignment and query helpers over the join tables. All deletes are
 * soft (tombstoned join rows) so they sync.
 */
import { all, byIndex, dedupePairs, get, put, softDelete, softDeleteMany, withSyncFields } from '../db/repo';
import { dedupeLinkTopics, nextRefNumber } from './topics';
import { addLinkToWeek, currentWeekStart, ensureOpenWeek, pendingWeeksForLink, setLinkWeek } from './weeks';
import { remapFocusTags as remapSettingsFocusTags } from './settings';
import { remapFocusTags as remapPlansFocusTags } from './plans';
import type { Link, LinkTag, LinkTopic, SyncFields, Tag, Topic } from '../db/types';

/** The (link, tag) pair a join row stands for — its logical identity. */
const tagPairKey = (j: LinkTag): string => `${j.link_id} ${j.tag_id}`;

/**
 * Collapse duplicate (link, tag) joins to one per pair (see dedupePairs).
 * Every read of link_tags runs through here so a tag assigned to a link on
 * two devices never surfaces as a doubled chip or an inflated tag count.
 * link_topics has its own twin (dedupeLinkTopics) that also keeps footnote
 * numbers stable.
 */
async function dedupeLinkTags(rows: LinkTag[]): Promise<LinkTag[]> {
  return dedupePairs('link_tags', rows, tagPairKey);
}

/**
 * Tags ordered by most-recent assignment to a link (the join row's
 * updated_at), newest first; never-assigned tags follow, newest-created
 * first. Used by the capture box so the tags you reach for most stay near
 * the top when the list is long enough to paginate.
 */
export async function tagsByRecentUse(): Promise<Tag[]> {
  // Name-merge before the pair-dedupe below reads link_tags: reconcile
  // re-points stray joins onto the survivor, then dedupeLinkTags collapses
  // any exact (link, tag) pair duplicates that remain.
  await reconcileTags();
  const [tags, joins] = await Promise.all([
    all<Tag>('tags'),
    all<LinkTag>('link_tags').then(dedupeLinkTags),
  ]);
  const lastUse = new Map<string, string>();
  for (const j of joins) {
    const prev = lastUse.get(j.tag_id);
    if (!prev || j.updated_at > prev) lastUse.set(j.tag_id, j.updated_at);
  }
  return tags.sort((a, b) => rankRecent(a, b, lastUse));
}

export async function topicsByRecentUse(): Promise<Topic[]> {
  await reconcileTopics(); // name-merge before dedupeLinkTopics reads the joins
  const [topics, joins] = await Promise.all([
    all<Topic>('topics'),
    all<LinkTopic>('link_topics').then(dedupeLinkTopics),
  ]);
  const lastUse = new Map<string, string>();
  for (const j of joins) {
    const prev = lastUse.get(j.topic_id);
    if (!prev || j.updated_at > prev) lastUse.set(j.topic_id, j.updated_at);
  }
  return topics.sort((a, b) => rankRecent(a, b, lastUse));
}

/** Sort by last assignment desc, then by own updated_at desc, then name. */
function rankRecent(
  a: SyncFields & { name: string },
  b: SyncFields & { name: string },
  lastUse: Map<string, string>
): number {
  const ua = lastUse.get(a.id);
  const ub = lastUse.get(b.id);
  if (ua && ub) return ua < ub ? 1 : ua > ub ? -1 : 0;
  if (ua) return -1; // used beats never-used
  if (ub) return 1;
  if (a.updated_at !== b.updated_at) return a.updated_at < b.updated_at ? 1 : -1;
  return a.name.localeCompare(b.name);
}

/**
 * Tags and topics are logical singletons keyed by lower(name) but stored
 * under a random UUID, so two offline devices that each first-create the tag
 * "AI" (or the topic "History") mint separate rows that row-level LWW can
 * never merge — both go live as duplicates and their join rows scatter across
 * the two ids. reconcileTags / reconcileTopics converge them the same way
 * getUserSettings converges the settings singleton and reconcilePlans /
 * reconcileOpenWeeks converge their tables: group the live rows by
 * lower(name), and for every group of more than one
 *
 *   - keep the smallest-id row as the survivor (ids are identical on every
 *     device, so both converge on the same winner with no coordination),
 *   - carry the freshest non-empty prose (tags.notes_md / topics.body_md)
 *     onto it,
 *   - re-point the join rows (link_tags / link_topics) that referenced a
 *     stray onto the survivor, deduping collisions, and
 *   - soft-delete the strays.
 *
 * This is the widest-fanning member of that family: the survivor owns join
 * rows in two tables AND is referenced by focus_tag_ids arrays. It runs at
 * the top of the read paths that surface these rows (tagsByRecentUse /
 * topicsByRecentUse and the tag/topic index + detail pages) — crucially
 * BEFORE the per-pair join dedupe (dedupeLinkTags / dedupeLinkTopics), which
 * keys off the re-pointed (link_id, survivor) pair. A group of one — the
 * common case — writes nothing. See the "readerr-singleton-uuid-divergence"
 * note and docs/dev/data-model.md.
 */
export async function reconcileTags(): Promise<void> {
  const remap = new Map<string, string>();
  for (const group of groupByLowerName(await all<Tag>('tags'))) {
    if (group.length < 2) continue;
    const survivor = smallestId(group);
    const strays = group.filter((t) => t.id !== survivor.id);
    const notes_md = freshestProse(group, (t) => t.notes_md);
    if (notes_md !== survivor.notes_md) await put('tags', { ...survivor, notes_md });
    await repointTagJoins(survivor.id, group.map((t) => t.id));
    for (const s of strays) remap.set(s.id, survivor.id);
    await softDeleteMany('tags', strays.map((s) => s.id));
  }
  // A merged tag may have been a focus tag for suggestions — point those at
  // the survivor too (settings singleton + every plan). No-ops when nothing merged.
  if (remap.size > 0) {
    await remapSettingsFocusTags(remap);
    await remapPlansFocusTags(remap);
  }
}

export async function reconcileTopics(): Promise<void> {
  for (const group of groupByLowerName(await all<Topic>('topics'))) {
    if (group.length < 2) continue;
    const survivor = smallestId(group);
    const strays = group.filter((t) => t.id !== survivor.id);
    const body_md = freshestProse(group, (t) => t.body_md);
    if (body_md !== survivor.body_md) await put('topics', { ...survivor, body_md });
    await repointTopicJoins(survivor.id, group.map((t) => t.id));
    await softDeleteMany('topics', strays.map((s) => s.id));
  }
}

/** Group rows by lower(name) — the case-insensitive identity we dedupe on. */
function groupByLowerName<T extends { name: string }>(rows: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = row.name.toLowerCase();
    const g = groups.get(key);
    if (g) g.push(row);
    else groups.set(key, [row]);
  }
  return [...groups.values()];
}

/** The device-independent survivor: smallest id wins (ids match across devices). */
function smallestId<T extends { id: string }>(rows: T[]): T {
  return rows.reduce((best, r) => (r.id < best.id ? r : best));
}

/**
 * Prose to carry onto the survivor: newest non-empty value by updated_at, so a
 * merge never drops a written note for an empty duplicate that merely happens
 * to have been touched more recently. All-empty stays empty.
 */
function freshestProse<T extends SyncFields>(rows: T[], pick: (r: T) => string): string {
  const written = rows.filter((r) => pick(r).trim() !== '');
  const pool = written.length > 0 ? written : rows;
  return pick(pool.reduce((best, r) => (r.updated_at > best.updated_at ? r : best)));
}

/** Group join rows by link_id, each bucket sorted by id ascending. */
function byLinkId<T extends SyncFields & { link_id: string }>(joins: T[]): T[][] {
  const buckets = new Map<string, T[]>();
  for (const j of joins) {
    const b = buckets.get(j.link_id);
    if (b) b.push(j);
    else buckets.set(j.link_id, [j]);
  }
  for (const b of buckets.values()) b.sort((a, z) => (a.id < z.id ? -1 : a.id > z.id ? 1 : 0));
  return [...buckets.values()];
}

/**
 * Move every live link_tags row pointing at any id in the group onto the
 * survivor. Rows that then duplicate a (link_id, survivor) pair collapse to
 * the smallest-id one (device-independent), the rest tombstoned. (The
 * downstream dedupeLinkTags is a belt-and-suspenders pass for pairs created
 * concurrently on the survivor itself.)
 */
async function repointTagJoins(survivorId: string, groupIds: string[]): Promise<void> {
  const joins = (
    await Promise.all(groupIds.map((id) => byIndex<LinkTag>('link_tags', 'tag_id', id)))
  ).flat();
  for (const [keeper, ...losers] of byLinkId(joins)) {
    if (keeper.tag_id !== survivorId) await put('link_tags', { ...keeper, tag_id: survivorId });
    await softDeleteMany('link_tags', losers.map((l) => l.id));
  }
}

/**
 * Topic twin of repointTagJoins, with the footnote-number bookkeeping
 * link_tags lacks. A reference the survivor already carries keeps the
 * survivor's number, so `[^n]` citations in the kept document stay valid; a
 * reference only the strays had is appended with a fresh number (one past the
 * survivor's highest ever, tombstones counted — exactly what assignTopic
 * issues), so the survivor's numbering stays unique and monotonic rather than
 * inheriting a stray topic's independent 1, 2, 3….
 */
async function repointTopicJoins(survivorId: string, groupIds: string[]): Promise<void> {
  const joins = (
    await Promise.all(groupIds.map((id) => byIndex<LinkTopic>('link_topics', 'topic_id', id)))
  ).flat();
  let next = await nextRefNumber(survivorId);
  const used = new Set<number>();
  // Stable link_id order so both devices append fresh numbers identically.
  const buckets = byLinkId(joins).sort((a, z) => (a[0].link_id < z[0].link_id ? -1 : 1));
  for (const rows of buckets) {
    const [keeper, ...losers] = rows; // min-id keeper survives, rest tombstoned
    const onSurvivor = rows.find((r) => r.topic_id === survivorId);
    let ref: number;
    if (onSurvivor) {
      // The survivor already references this link — keep its footnote number so
      // the kept document's `[^n]` stays valid (fall back to the lowest a
      // duplicate carried if the survivor's own row was never numbered).
      ref = onSurvivor.ref_number > 0 ? onSurvivor.ref_number : lowestRef(rows);
    } else {
      // A reference only the strays had: append it with a fresh number.
      ref = 0;
    }
    if (ref <= 0 || used.has(ref)) ref = next++;
    used.add(ref);
    if (keeper.topic_id !== survivorId || keeper.ref_number !== ref) {
      await put('link_topics', { ...keeper, topic_id: survivorId, ref_number: ref });
    }
    await softDeleteMany('link_topics', losers.map((l) => l.id));
  }
}

/** Lowest assigned (positive) footnote number among rows, or 0 if none. */
function lowestRef(rows: LinkTopic[]): number {
  const positive = rows.map((r) => r.ref_number).filter((n) => n > 0);
  return positive.length > 0 ? Math.min(...positive) : 0;
}

export async function tagsForLink(linkId: string): Promise<Tag[]> {
  const joins = await dedupeLinkTags(await byIndex<LinkTag>('link_tags', 'link_id', linkId));
  const tags = await Promise.all(joins.map((j) => get<Tag>('tags', j.tag_id)));
  return tags.filter((t): t is Tag => !!t);
}

export async function topicsForLink(linkId: string): Promise<Topic[]> {
  const joins = await dedupeLinkTopics(await byIndex<LinkTopic>('link_topics', 'link_id', linkId));
  const topics = await Promise.all(joins.map((j) => get<Topic>('topics', j.topic_id)));
  return topics.filter((t): t is Topic => !!t);
}

export async function linksForTag(tagId: string): Promise<Link[]> {
  const joins = await dedupeLinkTags(await byIndex<LinkTag>('link_tags', 'tag_id', tagId));
  const links = await Promise.all(joins.map((j) => get<Link>('links', j.link_id)));
  return links.filter((l): l is Link => !!l);
}

export async function linksForTopic(topicId: string): Promise<Link[]> {
  const joins = await dedupeLinkTopics(await byIndex<LinkTopic>('link_topics', 'topic_id', topicId));
  const links = await Promise.all(joins.map((j) => get<Link>('links', j.link_id)));
  return links.filter((l): l is Link => !!l);
}

/**
 * Resolve tag names to ids (case-insensitive), creating any that don't
 * exist yet — the capture DSL names tags by text, and a typo'd new name is
 * still a valid new tag, same as the capture box's inline create.
 */
export async function ensureTagIdsByName(names: string[]): Promise<string[]> {
  const tags = await all<Tag>('tags');
  const byName = new Map(tags.map((t) => [t.name.toLowerCase(), t.id]));
  const ids: string[] = [];
  for (const name of names) {
    let id = byName.get(name.toLowerCase());
    if (!id) {
      id = (await put('tags', withSyncFields({ name, notes_md: '' }))).id;
      byName.set(name.toLowerCase(), id);
    }
    ids.push(id);
  }
  return ids;
}

/** Topic-name twin of ensureTagIdsByName. */
export async function ensureTopicIdsByName(names: string[]): Promise<string[]> {
  const topics = await all<Topic>('topics');
  const byName = new Map(topics.map((t) => [t.name.toLowerCase(), t.id]));
  const ids: string[] = [];
  for (const name of names) {
    let id = byName.get(name.toLowerCase());
    if (!id) {
      id = (await put('topics', withSyncFields({ name, body_md: '' }))).id;
      byName.set(name.toLowerCase(), id);
    }
    ids.push(id);
  }
  return ids;
}

export async function assignTag(linkId: string, tagId: string): Promise<void> {
  const existing = await byIndex<LinkTag>('link_tags', 'link_id', linkId);
  if (existing.some((j) => j.tag_id === tagId)) return;
  await put('link_tags', withSyncFields({ link_id: linkId, tag_id: tagId }));
}

export async function unassignTag(linkId: string, tagId: string): Promise<void> {
  const joins = await byIndex<LinkTag>('link_tags', 'link_id', linkId);
  for (const j of joins.filter((j) => j.tag_id === tagId)) {
    await softDelete('link_tags', j.id);
  }
}

export async function assignTopic(linkId: string, topicId: string): Promise<void> {
  const existing = await byIndex<LinkTopic>('link_topics', 'link_id', linkId);
  if (existing.some((j) => j.topic_id === topicId)) return;
  // A fresh footnote number, never one a removed reference already used.
  const ref_number = await nextRefNumber(topicId);
  await put('link_topics', withSyncFields({ link_id: linkId, topic_id: topicId, ref_number }));
  // Referencing a link in a topic rescues it from the slush archive.
  const link = await get<Link>('links', linkId);
  if (link?.slushed_at) await put('links', { ...link, slushed_at: null });
}

export async function unassignTopic(linkId: string, topicId: string): Promise<void> {
  const joins = await byIndex<LinkTopic>('link_topics', 'link_id', linkId);
  for (const j of joins.filter((j) => j.topic_id === topicId)) {
    await softDelete('link_topics', j.id);
  }
}

/** Live-link count per tag id (for the tags index page). */
export async function tagLinkCounts(): Promise<Map<string, number>> {
  const joins = await dedupeLinkTags(await all<LinkTag>('link_tags'));
  return countBy(joins, (j) => j.tag_id);
}

/** Live-link count per topic id (for the topics index page). */
export async function topicLinkCounts(): Promise<Map<string, number>> {
  const joins = await dedupeLinkTopics(await all<LinkTopic>('link_topics'));
  return countBy(joins, (j) => j.topic_id);
}

/** Tally rows by a chosen key — one entry per row (duplicates removed upstream). */
function countBy<T>(rows: T[], key: (row: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(key(row), (counts.get(key(row)) ?? 0) + 1);
  }
  return counts;
}

/**
 * Tags for just the given links (scaling.md phase A: list pages resolve
 * labels for the visible page only — ~100 indexed lookups — instead of
 * building whole-database maps).
 */
export async function tagsForLinks(links: Link[]): Promise<Map<string, Tag[]>> {
  const map = new Map<string, Tag[]>();
  const cache = new Map<string, Tag | undefined>();
  for (const link of links) {
    const joins = await dedupeLinkTags(await byIndex<LinkTag>('link_tags', 'link_id', link.id));
    const tags: Tag[] = [];
    for (const j of joins) {
      if (!cache.has(j.tag_id)) cache.set(j.tag_id, await get<Tag>('tags', j.tag_id));
      const tag = cache.get(j.tag_id);
      if (tag) tags.push(tag);
    }
    map.set(link.id, tags);
  }
  return map;
}

/** Topics for just the given links (same rationale as tagsForLinks). */
export async function topicsForLinks(links: Link[]): Promise<Map<string, Topic[]>> {
  const map = new Map<string, Topic[]>();
  const cache = new Map<string, Topic | undefined>();
  for (const link of links) {
    const joins = await dedupeLinkTopics(await byIndex<LinkTopic>('link_topics', 'link_id', link.id));
    const topics: Topic[] = [];
    for (const j of joins) {
      if (!cache.has(j.topic_id)) cache.set(j.topic_id, await get<Topic>('topics', j.topic_id));
      const topic = cache.get(j.topic_id);
      if (topic) topics.push(topic);
    }
    map.set(link.id, topics);
  }
  return map;
}

/** All live tag assignments as a link_id → Tag[] map (for list pages). */
export async function tagsByLinkMap(): Promise<Map<string, Tag[]>> {
  const [joins, tags] = await Promise.all([
    all<LinkTag>('link_tags').then(dedupeLinkTags),
    all<Tag>('tags'),
  ]);
  const tagById = new Map(tags.map((t) => [t.id, t]));
  const byLink = new Map<string, Tag[]>();
  for (const j of joins) {
    const tag = tagById.get(j.tag_id);
    if (tag) byLink.set(j.link_id, [...(byLink.get(j.link_id) ?? []), tag]);
  }
  return byLink;
}

/** All live topic assignments as a link_id → Topic[] map (for list pages). */
export async function topicsByLinkMap(): Promise<Map<string, Topic[]>> {
  const [joins, topics] = await Promise.all([
    all<LinkTopic>('link_topics').then(dedupeLinkTopics),
    all<Topic>('topics'),
  ]);
  const topicById = new Map(topics.map((t) => [t.id, t]));
  const byLink = new Map<string, Topic[]>();
  for (const j of joins) {
    const topic = topicById.get(j.topic_id);
    if (topic) byLink.set(j.link_id, [...(byLink.get(j.link_id) ?? []), topic]);
  }
  return byLink;
}

/**
 * Mark a link done: it becomes part of the reading history. The link joins
 * the current week if it isn't queued for one already, its week entries
 * complete, and — unless it's favourited or referenced in a topic — it goes
 * straight to the slush archive. Pass slush=false to skip that immediate
 * slushing (the week-close pass still slushes unremarked links later).
 */
export async function markLinkDone(link: Link, slush = true): Promise<Link> {
  const now = new Date().toISOString();
  let pending = await pendingWeeksForLink(link.id);
  // Done now counts for the current week — a queued future-week assignment
  // moves here rather than completing a week that hasn't started.
  const today = currentWeekStart();
  if (pending.length === 0 || pending.every(({ week }) => week.week_start > today)) {
    if (pending.length > 0) {
      await setLinkWeek(link.id, today);
    } else {
      const week = await ensureOpenWeek();
      await addLinkToWeek(week.id, link.id);
    }
    pending = await pendingWeeksForLink(link.id);
  }
  for (const { entry } of pending) {
    if (!entry.done_at) await put('week_links', { ...entry, done_at: now });
  }
  const topics = await topicsForLink(link.id);
  const unremarked = slush && !link.favourite && topics.length === 0;
  return put('links', {
    ...link,
    read_at: link.read_at ?? now,
    slushed_at: unremarked ? (link.slushed_at ?? now) : link.slushed_at,
  });
}

export async function toggleRead(link: Link): Promise<Link> {
  if (!link.read_at) return markLinkDone(link);
  // Back to unread: leave the slush archive and un-complete any open week
  // entries (stamped history on closed weeks stays untouched).
  const pending = await pendingWeeksForLink(link.id);
  for (const { entry } of pending) {
    if (entry.done_at) await put('week_links', { ...entry, done_at: null });
  }
  return put('links', { ...link, read_at: null, slushed_at: null });
}

export async function toggleFavourite(link: Link): Promise<Link> {
  const favourite = !link.favourite;
  return put('links', {
    ...link,
    favourite,
    // Favouriting rescues a link from the slush archive.
    slushed_at: favourite ? null : link.slushed_at,
  });
}

export async function toggleResource(link: Link): Promise<Link> {
  return put('links', { ...link, is_resource: !link.is_resource });
}

/** A link's priority: 1 (highest) to 3; links never given one are 3. */
export function effectivePriority(link: Link): number {
  return link.priority ?? 3;
}

/**
 * List ordering: priority first (1 → 3), newest capture within a priority.
 * Pass a different tiebreak timestamp for lists not ordered by capture time
 * (e.g. the slush orders by slushed_at).
 */
export function comparePriority(
  a: Link,
  b: Link,
  timeOf: (l: Link) => string = (l) => l.added_at
): number {
  const byPriority = effectivePriority(a) - effectivePriority(b);
  if (byPriority !== 0) return byPriority;
  return timeOf(a) < timeOf(b) ? 1 : timeOf(a) > timeOf(b) ? -1 : 0;
}

export type ListOrder = 'newest' | 'oldest';

/**
 * List ordering with a direction, for the newest/oldest toggle.
 *
 * Priority stays ahead of the toggle: flipping to 'oldest' reverses the
 * time tiebreak *within* a priority band, it doesn't drag priority-3 links
 * above priority-1 ones. Negating comparePriority would have inverted both,
 * which would quietly undo the triage order the backlog depends on.
 */
export function compareByOrder(
  order: ListOrder,
  timeOf: (l: Link) => string = (l) => l.added_at
): (a: Link, b: Link) => number {
  return (a, b) => {
    const byPriority = effectivePriority(a) - effectivePriority(b);
    if (byPriority !== 0) return byPriority;
    const at = timeOf(a);
    const bt = timeOf(b);
    const newestFirst = at < bt ? 1 : at > bt ? -1 : 0;
    return order === 'newest' ? newestFirst : -newestFirst;
  };
}

/**
 * The flag filters offered above a link list. Shared so Backlog, Favourites
 * and the Reading List's Done card label them identically; Favourites drops
 * 'favourite' since every row there already is one.
 */
export const FLAG_FILTERS = [
  { value: 'favourite', label: 'Favourites' },
  { value: 'resource', label: 'Resources' },
] as const;

/** Does a link satisfy the active flag filters? */
export function matchesFlagFilters(link: Link, filters: string[]): boolean {
  if (filters.includes('favourite') && !link.favourite) return false;
  if (filters.includes('resource') && !link.is_resource) return false;
  return true;
}

/** Case-insensitive match on title, URL, or any tag name (list-page search). */
export function matchesSearch(link: Link, tags: Tag[], query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    link.title.toLowerCase().includes(q) ||
    link.url.toLowerCase().includes(q) ||
    tags.some((t) => t.name.toLowerCase().includes(q))
  );
}

/** Hostname for compact display next to titles. */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
