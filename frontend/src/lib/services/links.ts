/**
 * Link assignment and query helpers over the join tables. All deletes are
 * soft (tombstoned join rows) so they sync.
 */
import { all, byIndex, get, put, softDelete, withSyncFields } from '../db/repo';
import { addLinkToWeek, currentWeekStart, ensureOpenWeek, pendingWeeksForLink, setLinkWeek } from './weeks';
import type { Link, LinkTag, LinkTopic, SyncFields, Tag, Topic } from '../db/types';

export async function tagsForLink(linkId: string): Promise<Tag[]> {
  const joins = await byIndex<LinkTag>('link_tags', 'link_id', linkId);
  const tags = await Promise.all(joins.map((j) => get<Tag>('tags', j.tag_id)));
  return tags.filter((t): t is Tag => !!t);
}

export async function topicsForLink(linkId: string): Promise<Topic[]> {
  const joins = await byIndex<LinkTopic>('link_topics', 'link_id', linkId);
  const topics = await Promise.all(joins.map((j) => get<Topic>('topics', j.topic_id)));
  return topics.filter((t): t is Topic => !!t);
}

export async function linksForTag(tagId: string): Promise<Link[]> {
  const joins = await byIndex<LinkTag>('link_tags', 'tag_id', tagId);
  const links = await Promise.all(joins.map((j) => get<Link>('links', j.link_id)));
  return links.filter((l): l is Link => !!l);
}

export async function linksForTopic(topicId: string): Promise<Link[]> {
  const joins = await byIndex<LinkTopic>('link_topics', 'topic_id', topicId);
  const links = await Promise.all(joins.map((j) => get<Link>('links', j.link_id)));
  return links.filter((l): l is Link => !!l);
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
  await put('link_topics', withSyncFields({ link_id: linkId, topic_id: topicId }));
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
  return joinCounts<LinkTag>('link_tags', (j) => j.tag_id);
}

/** Live-link count per topic id (for the topics index page). */
export async function topicLinkCounts(): Promise<Map<string, number>> {
  return joinCounts<LinkTopic>('link_topics', (j) => j.topic_id);
}

async function joinCounts<T extends SyncFields & { link_id: string }>(
  store: 'link_tags' | 'link_topics',
  key: (j: T) => string
): Promise<Map<string, number>> {
  const joins = await all<T>(store);
  const counts = new Map<string, number>();
  for (const j of joins) {
    counts.set(key(j), (counts.get(key(j)) ?? 0) + 1);
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
    const joins = await byIndex<LinkTag>('link_tags', 'link_id', link.id);
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
    const joins = await byIndex<LinkTopic>('link_topics', 'link_id', link.id);
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
  const [joins, tags] = await Promise.all([all<LinkTag>('link_tags'), all<Tag>('tags')]);
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
  const [joins, topics] = await Promise.all([all<LinkTopic>('link_topics'), all<Topic>('topics')]);
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
 * straight to the slush archive.
 */
export async function markLinkDone(link: Link): Promise<Link> {
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
  const unremarked = !link.favourite && topics.length === 0;
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
