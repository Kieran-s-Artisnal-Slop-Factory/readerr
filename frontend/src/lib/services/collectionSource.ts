/**
 * Turning what's in the database into an `ExportableCollection`.
 *
 * `collectionExport.ts` knows how to WRITE a collection; this module knows how
 * to BUILD one, for each surface that has something to export. Keeping the two
 * apart is what lets the tag export and the resource-list export share every
 * line of the file-writing side while each fetches its own data.
 *
 * Everything here reads in bulk — one pass for tags, one for reading weeks —
 * rather than per link, because these run over whole sections of the library
 * (docs/dev/performance.md).
 */
import { byIndex, get } from '../db/repo';
import {
  linksFromChildTags,
  linksTaggedDirectly,
  tagsForLinks,
} from './links';
import { childrenOf } from './tagTree';
import { listMembers, listResourceLists } from './resourceLists';
import { pendingWeekByLink } from './weeks';
import { tagsForTopic, topicReferences, topicsForTag } from './topics';
import type { CollectionRow, CollectionTopic, ExportableCollection } from './collectionExport';
import type { Link, LinkTopic, ResourceList, Tag, Topic } from '../db/types';

/** Attach each link's tags and reading week — the two non-link columns. */
async function toRows(links: Link[]): Promise<CollectionRow[]> {
  const [tagMap, weekMap] = await Promise.all([tagsForLinks(links), pendingWeekByLink()]);
  return links.map((link) => ({
    link,
    tags: tagMap.get(link.id) ?? [],
    weekStart: weekMap.get(link.id) ?? '',
  }));
}

/** A topic plus the metadata every export prints beside it. */
async function toTopicEntries(topics: Topic[]): Promise<CollectionTopic[]> {
  const entries: CollectionTopic[] = [];
  for (const topic of topics) {
    entries.push({
      topic,
      refs: await topicReferences(topic.id),
      tags: await tagsForTopic(topic.id),
    });
  }
  return entries.sort((a, b) => a.topic.name.localeCompare(b.topic.name));
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/**
 * Everything a tag exports: its own links, the links that reach it through a
 * nested child tag, and the topics carrying it.
 *
 * A link tagged BOTH directly and via a child appears only in "Links" —
 * `linksFromChildTags` already excludes the direct set, so the two sections
 * never repeat a row.
 */
export async function collectionForTag(tag: Tag): Promise<ExportableCollection> {
  const [direct, inherited, children, topics] = await Promise.all([
    linksTaggedDirectly(tag.id),
    linksFromChildTags(tag.id),
    childrenOf(tag.id),
    topicsForTag(tag.id),
  ]);
  const directRows = await toRows(direct);
  const inheritedRows = await toRows(inherited.map((row) => row.link));
  const favourites = [...directRows, ...inheritedRows].filter((r) => r.link.favourite).length;

  return {
    title: tag.name,
    aboutMd: tag.notes_md ?? '',
    stats: [
      { key: 'child_tags', label: 'Child tags', value: children.map((c) => c.name).sort() },
      { key: 'links_direct', label: 'Links', value: directRows.length },
      { key: 'links_from_children', label: 'From child tags', value: inheritedRows.length },
      { key: 'favourites', label: 'Favourites', value: favourites },
      { key: 'topics', label: 'Topics', value: topics.length },
    ],
    sections: [
      { title: 'Links', rows: directRows },
      ...(inheritedRows.length > 0
        ? [
            {
              title: 'From child tags',
              note: `Links that reach ${tag.name} through a nested tag. Anything tagged ${tag.name} directly is in the section above instead, never in both.`,
              rows: inheritedRows,
            },
          ]
        : []),
    ],
    topics: await toTopicEntries(topics),
  };
}

// ---------------------------------------------------------------------------
// Resource lists
// ---------------------------------------------------------------------------

/**
 * A resource list as the same shape, so it writes through the same code. Its
 * topics are whichever topics reference one of its links — the list's own
 * long-form context, the twin of a tag's tagged topics.
 */
export async function collectionForList(list: ResourceList): Promise<ExportableCollection> {
  const members = await listMembers(list.id);
  const rows = await toRows(members.map((m) => m.link));
  const topics = await topicsReferencing(rows.map((r) => r.link.id));

  return {
    title: list.name,
    aboutMd: list.description_md ?? '',
    stats: [
      { key: 'links', label: 'Links', value: rows.length },
      { key: 'favourites', label: 'Favourites', value: rows.filter((r) => r.link.favourite).length },
      { key: 'read', label: 'Read', value: rows.filter((r) => r.link.read_at).length },
      { key: 'topics', label: 'Topics', value: topics.length },
    ],
    sections: [{ title: 'Links', rows }],
    topics: await toTopicEntries(topics),
  };
}

/** Topics that reference any of the given links, de-duplicated. */
async function topicsReferencing(linkIds: string[]): Promise<Topic[]> {
  const seen = new Map<string, Topic>();
  for (const linkId of linkIds) {
    for (const join of await byIndex<LinkTopic>('link_topics', 'link_id', linkId)) {
      if (seen.has(join.topic_id)) continue;
      const topic = await get<Topic>('topics', join.topic_id);
      if (topic && !topic.deleted_at) seen.set(topic.id, topic);
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Every list at once (the mass export)
// ---------------------------------------------------------------------------

export async function allListCollections(): Promise<
  { list: ResourceList; collection: ExportableCollection }[]
> {
  const out: { list: ResourceList; collection: ExportableCollection }[] = [];
  for (const list of await listResourceLists()) {
    out.push({ list, collection: await collectionForList(list) });
  }
  return out;
}
