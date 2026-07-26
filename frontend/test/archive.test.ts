/**
 * Yearly archival ↔ sync interactions (services/archive.ts + the archive-aware
 * bits of sync.ts). Archiving hard-deletes a link into the local-only
 * `archived_links` store; these tests pin the behaviours that keep that cold
 * partition from resurrecting or stranding data.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDB } from '../src/lib/db/db';
import { STORES } from '../src/lib/db/types';
import { archiveNow, listArchived } from '../src/lib/services/archive';
import { resetLocalSyncState } from '../src/lib/sync';
import type { Link } from '../src/lib/db/types';

const OLD = '2020-01-01T00:00:00.000Z';

function link(id: string, over: Partial<Link> = {}): Link {
  return {
    id,
    updated_at: OLD,
    deleted_at: null,
    server_seq: 5,
    url: `https://e/${id}`,
    title: id,
    title_fetched: true,
    added_at: OLD,
    read_at: null,
    favourite: false,
    is_resource: false,
    slushed_at: OLD,
    priority: null,
    ...over,
  };
}

beforeEach(async () => {
  const db = await getDB();
  const names = [...Object.keys(STORES), 'archived_links', 'sync_meta'];
  const tx = db.transaction(names, 'readwrite');
  for (const n of names) tx.objectStore(n).clear();
  await tx.done;
});

describe('archive', () => {
  it('moves an old slushed link into the cold store, hard-deleting from links', async () => {
    const db = await getDB();
    await db.put('links', link('a'));
    const moved = await archiveNow(1);
    expect(moved).toBe(1);
    expect(await db.get('links', 'a')).toBeUndefined();
    expect(await db.get('archived_links', 'a')).toBeTruthy();
  });

  it('listArchived hides tombstoned rows (a pulled delete for an archived link)', async () => {
    const db = await getDB();
    await db.put('archived_links', link('a'));
    await db.put('archived_links', link('b', { deleted_at: '2026-07-01T00:00:00.000Z' }));
    const shown = await listArchived();
    expect(shown.map((l) => l.id)).toEqual(['a']);
  });

  it('resetLocalSyncState moves archived links back into the hot store so they re-push', async () => {
    const db = await getDB();
    // One hot link and one archived link, both carrying a foreign server_seq.
    await db.put('links', link('hot', { server_seq: 7 }));
    await db.put('archived_links', link('cold', { server_seq: 9 }));
    await db.put('sync_meta', { key: 'lastPushAt', value: '2026-01-01T00:00:00.000Z' });
    await db.put('sync_meta', { key: 'lastPullSeq', value: 42 });

    await resetLocalSyncState();

    // The archived link is back in `links` (so a from-scratch re-push includes
    // it) and out of the cold store; both rows have their foreign seq cleared.
    const cold = (await db.get('links', 'cold')) as Link | undefined;
    expect(cold, 'archived link moved back into links').toBeTruthy();
    expect(cold!.server_seq).toBeNull();
    expect(await db.get('archived_links', 'cold')).toBeUndefined();
    expect(((await db.get('links', 'hot')) as Link).server_seq).toBeNull();

    // Cursors dropped so the next sync re-pushes everything and re-pulls from 0.
    expect(await db.get('sync_meta', 'lastPushAt')).toBeUndefined();
    expect(await db.get('sync_meta', 'lastPullSeq')).toBeUndefined();
  });
});
