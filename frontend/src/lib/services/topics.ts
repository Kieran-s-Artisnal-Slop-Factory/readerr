/**
 * Topic footnote references.
 *
 * A topic's links are numbered so the document can cite them with the usual
 * markdown footnote syntax — `[^3]` in the prose resolves to reference 3.
 * Numbers are issued once and stored on the link_topics join, never
 * recomputed from position: a number is one past the highest the topic has
 * EVER issued (tombstoned joins counted), so unassigning a link leaves a
 * hole rather than sliding every later citation down by one.
 *
 * The definitions (`[^1]: <url>`) are never written into body_md — the
 * document stays exactly what was typed, and the numbered list is generated
 * at render/export time from these rows.
 *
 * Joins created before ref_number existed carry 0. They're numbered lazily,
 * in creation order, the first time the topic is read — which also catches
 * legacy rows arriving later from another device's sync.
 */
import { byIndex, byIndexWithDeleted, get, put } from '../db/repo';
import type { Link, LinkTopic } from '../db/types';

/** One past the highest number this topic has ever issued. */
export async function nextRefNumber(topicId: string): Promise<number> {
  const joins = await byIndexWithDeleted<LinkTopic>('link_topics', 'topic_id', topicId);
  return joins.reduce((max, j) => Math.max(max, j.ref_number ?? 0), 0) + 1;
}

export interface TopicReference {
  join: LinkTopic;
  link: Link;
  /** The footnote number — cite it in the document as `[^n]`. */
  number: number;
}

/**
 * A topic's referenced links in footnote order, numbering any unnumbered
 * join on the way (see the module note). Joins whose link is gone are
 * skipped but keep their number reserved.
 */
export async function topicReferences(topicId: string): Promise<TopicReference[]> {
  const joins = await byIndex<LinkTopic>('link_topics', 'topic_id', topicId);
  // Oldest first so backfilled numbers follow the order links were added.
  const unnumbered = joins
    .filter((j) => !j.ref_number)
    .sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  let next = await nextRefNumber(topicId);
  const numbered = new Map<string, LinkTopic>();
  for (const join of unnumbered) {
    numbered.set(join.id, await put('link_topics', { ...join, ref_number: next++ }));
  }

  const refs: TopicReference[] = [];
  for (const join of joins) {
    const row = numbered.get(join.id) ?? join;
    const link = await get<Link>('links', row.link_id);
    if (link) refs.push({ join: row, link, number: row.ref_number });
  }
  return refs.sort((a, b) => a.number - b.number);
}
