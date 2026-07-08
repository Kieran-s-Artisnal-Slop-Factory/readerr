/**
 * Link assignment and query helpers over the join tables. All deletes are
 * soft (tombstoned join rows) so they sync.
 */
import { all, byIndex, get, put, softDelete, withSyncFields } from '../db/repo';
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

export async function toggleRead(link: Link): Promise<Link> {
  return put('links', { ...link, read_at: link.read_at ? null : new Date().toISOString() });
}

export async function toggleFavourite(link: Link): Promise<Link> {
  return put('links', { ...link, favourite: !link.favourite });
}

export async function toggleResource(link: Link): Promise<Link> {
  return put('links', { ...link, is_resource: !link.is_resource });
}

/** Hostname for compact display next to titles. */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
