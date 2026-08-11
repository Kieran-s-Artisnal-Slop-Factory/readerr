/**
 * Resource-list capture: the capture box's list chips (CaptureAssign.listIds)
 * and the per-line !list DSL both add captured links to resource lists,
 * creating named lists on demand — and membership always implies the
 * resource flag, even over an explicit !resource=false.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { all } from '../src/lib/db/repo';
import { getDB } from '../src/lib/db/db';
import { STORES } from '../src/lib/db/types';
import { captureLinks } from '../src/lib/services/capture';
import {
  createResourceList,
  listMembers,
  listResourceLists,
} from '../src/lib/services/resourceLists';
import type { ResourceList } from '../src/lib/db/types';

beforeEach(async () => {
  const db = await getDB();
  const names = Object.keys(STORES);
  const tx = db.transaction(names, 'readwrite');
  for (const n of names) tx.objectStore(n).clear();
  await tx.done;
});

describe('capture with resource lists', () => {
  it('adds captured links to the selected lists and flags them resources', async () => {
    const list = await createResourceList('CLI tools');
    const { added } = await captureLinks('https://example.com/tool', { listIds: [list.id] });
    expect(added).toHaveLength(1);
    expect(added[0].is_resource).toBe(true);
    const members = await listMembers(list.id);
    expect(members.map((m) => m.link.id)).toEqual([added[0].id]);
  });

  it('creates a named list from the !list DSL and implies the resource flag', async () => {
    const { added } = await captureLinks('https://example.com/app !list=[reading apps]');
    expect(added[0].is_resource).toBe(true);
    const lists = await listResourceLists();
    expect(lists.map((l) => l.name)).toEqual(['reading apps']);
    expect((await listMembers(lists[0].id)).map((m) => m.link.id)).toEqual([added[0].id]);
  });

  it('membership wins over an explicit !resource=false on the same line', async () => {
    const { added } = await captureLinks('https://example.com/x !r=false !l=[tools]');
    expect(added[0].is_resource).toBe(true);
  });

  it('!l=[] excludes the UI-selected list for that line only', async () => {
    const list = await createResourceList('tools');
    const { added } = await captureLinks(
      'https://example.com/one\nhttps://example.com/two !l=[]',
      { listIds: [list.id] }
    );
    const memberIds = (await listMembers(list.id)).map((m) => m.link.id);
    const one = added.find((l) => l.url.endsWith('/one'))!;
    const two = added.find((l) => l.url.endsWith('/two'))!;
    expect(memberIds).toEqual([one.id]);
    // The excluded line is a plain capture — not flagged by the batch's list.
    expect(two.is_resource).toBe(false);
  });

  it('re-capturing an existing link merges it into the list without duplicating', async () => {
    const { added } = await captureLinks('https://example.com/tool');
    expect(added[0].is_resource).toBe(false);

    const { merged } = await captureLinks('https://example.com/tool !l=[tools]');
    expect(merged).toHaveLength(1);
    expect(merged[0].is_resource).toBe(true);

    const lists = await listResourceLists();
    const members = await listMembers(lists[0].id);
    expect(members.map((m) => m.link.id)).toEqual([added[0].id]);

    // A second identical re-capture changes nothing (no duplicate membership).
    const again = await captureLinks('https://example.com/tool !l=[tools]');
    expect(again.merged).toHaveLength(0);
    expect((await listMembers(lists[0].id)).length).toBe(1);
    expect((await all<ResourceList>('resource_lists')).length).toBe(1);
  });

  it('deduplicates list names case-insensitively instead of minting twins', async () => {
    await captureLinks('https://example.com/a !l=[Tools]');
    await captureLinks('https://example.com/b !l=[tools]');
    const lists = await listResourceLists();
    expect(lists).toHaveLength(1);
    expect((await listMembers(lists[0].id)).length).toBe(2);
  });
});
