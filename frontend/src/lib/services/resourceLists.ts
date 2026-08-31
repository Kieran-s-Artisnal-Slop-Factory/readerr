/**
 * Resource lists: named groupings of resource links (e.g. "CLI tools"),
 * each with an overview document and plain-format exports. Adding a link to
 * a list flags it as a resource — lists are the organizational layer over
 * the flat ⚒ resources view.
 */
import {
  all,
  byIndex,
  dedupePairs,
  get,
  put,
  softDelete,
  softDeleteMany,
  withSyncFields,
} from '../db/repo';
import type { Link, ResourceList, ResourceListLink } from '../db/types';

/** The (list, link) pair a membership row stands for — its logical identity. */
const listPairKey = (j: ResourceListLink): string => `${j.list_id} ${j.link_id}`;

/**
 * Collapse duplicate (list, link) memberships to one per pair (see
 * dedupePairs). Every read of resource_list_links runs through here so a link
 * added to the same list on two devices shows once and counts once; the
 * smallest-id survivor keeps its position, which is device-independent too.
 */
async function dedupeListLinks(rows: ResourceListLink[]): Promise<ResourceListLink[]> {
  return dedupePairs('resource_list_links', rows, listPairKey);
}

export async function listResourceLists(): Promise<ResourceList[]> {
  return (await all<ResourceList>('resource_lists')).sort((a, b) => a.name.localeCompare(b.name));
}

export async function createResourceList(name: string): Promise<ResourceList> {
  return put('resource_lists', withSyncFields({ name, description_md: '' }));
}

/** Tombstone the list and its memberships (the links themselves stay). */
export async function deleteResourceList(listId: string): Promise<void> {
  const joins = await byIndex<ResourceListLink>('resource_list_links', 'list_id', listId);
  await softDeleteMany('resource_list_links', joins.map((j) => j.id));
  await softDelete('resource_lists', listId);
}

export interface ListMember {
  entry: ResourceListLink;
  link: Link;
}

export async function listMembers(listId: string): Promise<ListMember[]> {
  const joins = await dedupeListLinks(
    await byIndex<ResourceListLink>('resource_list_links', 'list_id', listId)
  );
  const members: ListMember[] = [];
  for (const entry of joins) {
    const link = await get<Link>('links', entry.link_id);
    if (link) members.push({ entry, link });
  }
  return members.sort((a, b) => a.entry.position - b.entry.position);
}

/** Resource-list twin of ensureTagIdsByName: resolve names, creating new lists. */
export async function ensureListIdsByName(names: string[]): Promise<string[]> {
  const lists = await all<ResourceList>('resource_lists');
  const byName = new Map(lists.map((l) => [l.name.toLowerCase(), l.id]));
  const ids: string[] = [];
  for (const name of names) {
    let id = byName.get(name.toLowerCase());
    if (!id) {
      id = (await createResourceList(name)).id;
      byName.set(name.toLowerCase(), id);
    }
    ids.push(id);
  }
  return ids;
}

/**
 * Add many links to one list in a single pass — the bulk-panel entry point.
 *
 * The membership index is read ONCE for the whole batch, not once per link:
 * a fifty-link selection used to mean fifty `byIndex` scans of
 * resource_list_links (the hot-path lesson in docs/dev/performance.md).
 * `present` then carries the already-a-member set forward across the batch,
 * so a link listed twice in one selection, or already in the list from
 * another device, still produces exactly one (list, link) pair — the
 * invariant the sync harness checks as `resource_list_links-pair`.
 *
 * Membership implies resource-hood, so every link that isn't flagged gets
 * flagged, whether or not the pair itself is new.
 *
 * Returns how many memberships were actually created.
 */
export async function addLinksToList(listId: string, links: Link[]): Promise<number> {
  // Deduped read: a pair already forked across devices collapses here rather
  // than tricking the membership check below into adding a third row.
  const joins = await dedupeListLinks(
    await byIndex<ResourceListLink>('resource_list_links', 'list_id', listId)
  );
  const present = new Set(joins.map((j) => j.link_id));
  let position = joins.reduce((max, j) => Math.max(max, j.position), -1) + 1;
  let added = 0;
  for (const link of links) {
    if (!present.has(link.id)) {
      present.add(link.id);
      await put(
        'resource_list_links',
        withSyncFields({ list_id: listId, link_id: link.id, position: position++ })
      );
      added++;
    }
    if (!link.is_resource) {
      await put('links', { ...link, is_resource: true });
    }
  }
  return added;
}

/** Add a link to a list; the link becomes a resource if it wasn't one. */
export async function addToList(listId: string, link: Link): Promise<void> {
  await addLinksToList(listId, [link]);
}

/**
 * Drop many links from one list. The links keep their resource flag —
 * `is_resource` says "this is reference material", which staying true of a
 * link you took out of one list is the honest reading (and matches
 * removeFromList, which has never cleared it either).
 *
 * Returns how many memberships were removed.
 */
export async function removeLinksFromList(listId: string, links: Link[]): Promise<number> {
  const joins = await dedupeListLinks(
    await byIndex<ResourceListLink>('resource_list_links', 'list_id', listId)
  );
  const wanted = new Set(links.map((l) => l.id));
  const doomed = joins.filter((j) => wanted.has(j.link_id)).map((j) => j.id);
  if (doomed.length) await softDeleteMany('resource_list_links', doomed);
  return doomed.length;
}

export async function removeFromList(entryId: string): Promise<void> {
  await softDelete('resource_list_links', entryId);
}

/** Per-list member counts for the Resources index. */
export async function listMemberCounts(): Promise<Map<string, number>> {
  const joins = await dedupeListLinks(await all<ResourceListLink>('resource_list_links'));
  const counts = new Map<string, number>();
  for (const j of joins) {
    counts.set(j.list_id, (counts.get(j.list_id) ?? 0) + 1);
  }
  return counts;
}

// ===== Exports =====

export type ListExportFormat = 'md' | 'txt' | 'csv' | 'json';

function csvField(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serialize a list's members in the requested plain format. */
export function serializeList(
  list: ResourceList,
  members: ListMember[],
  format: ListExportFormat
): { content: string; mime: string; extension: string } {
  const links = members.map((m) => m.link);
  switch (format) {
    case 'md':
      return {
        content: links.map((l) => `- [${l.title}](${l.url})`).join('\n') + '\n',
        mime: 'text/markdown',
        extension: 'md',
      };
    case 'txt':
      return {
        content: links.map((l) => l.url).join('\n') + '\n',
        mime: 'text/plain',
        extension: 'txt',
      };
    case 'csv':
      return {
        content:
          ['title,url', ...links.map((l) => `${csvField(l.title)},${csvField(l.url)}`)].join('\n') +
          '\n',
        mime: 'text/csv',
        extension: 'csv',
      };
    case 'json':
      return {
        content: JSON.stringify(
          {
            name: list.name,
            description: list.description_md,
            links: links.map((l) => ({ title: l.title, url: l.url })),
          },
          null,
          2
        ),
        mime: 'application/json',
        extension: 'json',
      };
  }
}

export function downloadList(
  list: ResourceList,
  members: ListMember[],
  format: ListExportFormat
): void {
  const { content, mime, extension } = serializeList(list, members, format);
  const safe = list.name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'resource-list';
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safe}.${extension}`;
  a.click();
  URL.revokeObjectURL(url);
}
