/**
 * Per-origin statistics (#7): for every domain you've captured from, how
 * many links and resources it produced and where they ended up — slush,
 * favourites, topics. Tags are deliberately ignored.
 */
import { all } from '../db/repo';
import { domainOf } from './links';
import type { Link, LinkTopic } from '../db/types';

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
