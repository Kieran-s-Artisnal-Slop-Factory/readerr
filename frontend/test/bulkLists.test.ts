/**
 * Bulk resource-list membership (`addLinksToList` / `removeLinksFromList`),
 * the service behind the bulk panel's "Resource lists" op-group.
 *
 * The thing worth pinning is the junction invariant: `resource_list_links` is
 * logically one row per (list, link) pair but keyed by a random UUID, so a
 * bulk add that doesn't check what's already there mints duplicates the sync
 * harness catches as `resource_list_links-pair`. A batch is the easiest place
 * to get that wrong, because the same link can arrive twice inside one call.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { byIndex, get, put, withSyncFields } from '../src/lib/db/repo';
import { getDB } from '../src/lib/db/db';
import { STORES } from '../src/lib/db/types';
import {
  addLinksToList,
  addToList,
  createResourceList,
  listMembers,
  removeLinksFromList,
} from '../src/lib/services/resourceLists';
import type { Link, ResourceListLink } from '../src/lib/db/types';

beforeEach(async () => {
  const db = await getDB();
  const names = Object.keys(STORES);
  const tx = db.transaction(names, 'readwrite');
  for (const n of names) tx.objectStore(n).clear();
  await tx.done;
});

let n = 0;
function makeLink(is_resource = false): Promise<Link> {
  n++;
  return put<Link>(
    'links',
    withSyncFields({
      url: `https://e/${n}`,
      title: `link ${n}`,
      title_fetched: true,
      added_at: new Date().toISOString(),
      read_at: null,
      favourite: false,
      is_resource,
      slushed_at: null,
      priority: null,
    }) as Link
  );
}

/** Live membership rows, duplicates included — the invariant's raw view. */
async function joins(listId: string): Promise<ResourceListLink[]> {
  return byIndex<ResourceListLink>('resource_list_links', 'list_id', listId);
}

describe('addLinksToList', () => {
  it('adds every selected link once and reports the count', async () => {
    const list = await createResourceList('CLI tools');
    const links = [await makeLink(), await makeLink(), await makeLink()];

    expect(await addLinksToList(list.id, links)).toBe(3);
    const members = await listMembers(list.id);
    expect(members.map((m) => m.link.id)).toEqual(links.map((l) => l.id));
    // Positions are contiguous from zero, so the list keeps a stable order.
    expect(members.map((m) => m.entry.position)).toEqual([0, 1, 2]);
  });

  it('marks every added link a resource — membership IS resource-hood', async () => {
    const list = await createResourceList('CLI tools');
    const links = [await makeLink(), await makeLink()];
    await addLinksToList(list.id, links);
    for (const l of links) {
      expect((await get<Link>('links', l.id))?.is_resource).toBe(true);
    }
  });

  it('does not duplicate a pair for a link already in the list', async () => {
    const list = await createResourceList('CLI tools');
    const a = await makeLink();
    const b = await makeLink();
    await addToList(list.id, a);

    // The bulk selection includes the link that is already a member.
    expect(await addLinksToList(list.id, [a, b])).toBe(1);
    expect(await joins(list.id)).toHaveLength(2);
    expect((await listMembers(list.id)).map((m) => m.link.id)).toEqual([a.id, b.id]);
  });

  it('does not duplicate a pair for a link listed twice in ONE batch', async () => {
    const list = await createResourceList('CLI tools');
    const a = await makeLink();
    // Not reachable through the checkbox UI, but the helper is the invariant's
    // last line of defence and a caller could hand it anything.
    expect(await addLinksToList(list.id, [a, a])).toBe(1);
    expect(await joins(list.id)).toHaveLength(1);
  });

  it('still flags a link that was already a member but not yet a resource', async () => {
    const list = await createResourceList('CLI tools');
    const link = await makeLink();
    // A membership minted without the flag (an older client, a merge).
    await put(
      'resource_list_links',
      withSyncFields({ list_id: list.id, link_id: link.id, position: 0 })
    );

    expect(await addLinksToList(list.id, [link])).toBe(0);
    expect((await get<Link>('links', link.id))?.is_resource).toBe(true);
  });

  it('collapses a pair forked across devices instead of adding a third row', async () => {
    const list = await createResourceList('CLI tools');
    const link = await makeLink();
    // Two devices formed the same pair before syncing: two rows, one pair.
    for (const position of [0, 0]) {
      await put(
        'resource_list_links',
        withSyncFields({ list_id: list.id, link_id: link.id, position })
      );
    }
    expect(await joins(list.id)).toHaveLength(2);

    expect(await addLinksToList(list.id, [link])).toBe(0);
    // The deduping read healed the fork; nothing new was minted.
    expect(await joins(list.id)).toHaveLength(1);
  });

  it('appends after existing members rather than reusing their positions', async () => {
    const list = await createResourceList('CLI tools');
    const first = await makeLink();
    await addToList(list.id, first);
    const rest = [await makeLink(), await makeLink()];
    await addLinksToList(list.id, rest);
    expect((await listMembers(list.id)).map((m) => m.entry.position)).toEqual([0, 1, 2]);
  });

  it('is a no-op for an empty selection', async () => {
    const list = await createResourceList('CLI tools');
    expect(await addLinksToList(list.id, [])).toBe(0);
    expect(await joins(list.id)).toHaveLength(0);
  });
});

describe('removeLinksFromList', () => {
  it('drops only the selected links, leaving the rest of the list intact', async () => {
    const list = await createResourceList('CLI tools');
    const [a, b, c] = [await makeLink(), await makeLink(), await makeLink()];
    await addLinksToList(list.id, [a, b, c]);

    expect(await removeLinksFromList(list.id, [a, c])).toBe(2);
    expect((await listMembers(list.id)).map((m) => m.link.id)).toEqual([b.id]);
  });

  it('leaves the resource flag alone — the link is still reference material', async () => {
    const list = await createResourceList('CLI tools');
    const link = await makeLink();
    await addLinksToList(list.id, [link]);
    await removeLinksFromList(list.id, [link]);
    expect((await get<Link>('links', link.id))?.is_resource).toBe(true);
  });

  it('ignores links that were never in the list', async () => {
    const list = await createResourceList('CLI tools');
    const member = await makeLink();
    const stranger = await makeLink();
    await addLinksToList(list.id, [member]);
    expect(await removeLinksFromList(list.id, [stranger])).toBe(0);
    expect((await listMembers(list.id)).map((m) => m.link.id)).toEqual([member.id]);
  });

  it('does not touch another list holding the same link', async () => {
    const a = await createResourceList('A');
    const b = await createResourceList('B');
    const link = await makeLink();
    await addLinksToList(a.id, [link]);
    await addLinksToList(b.id, [link]);

    await removeLinksFromList(a.id, [link]);
    expect(await listMembers(a.id)).toHaveLength(0);
    expect((await listMembers(b.id)).map((m) => m.link.id)).toEqual([link.id]);
  });
});
