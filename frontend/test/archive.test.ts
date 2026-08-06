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

/**
 * A link archived before its first successful push leaves `links` — the only
 * store the push scans — so without a record of it, it lives on this device
 * alone forever. archiveNow queues those ids; the push drains the queue from
 * the cold store.
 */
describe('never-pushed archived links', () => {
  const queued = async (): Promise<string[]> =>
    (((await (await getDB()).get('sync_meta', 'pendingArchivedPush')) as
      | { value: string[] }
      | undefined)?.value ?? []);

  it('queues a link the server has never seen', async () => {
    const db = await getDB();
    await db.put('links', link('never-pushed', { server_seq: null }));
    expect(await archiveNow(1)).toBe(1);
    expect(await queued()).toEqual(['never-pushed']);
  });

  it('does not queue a link the server already has', async () => {
    const db = await getDB();
    await db.put('links', link('already-there', { server_seq: 12 }));
    expect(await archiveNow(1)).toBe(1);
    expect(await queued()).toEqual([]);
  });

  it('queues only the stranded ids from a mixed batch, without duplicating', async () => {
    const db = await getDB();
    await db.put('links', link('cold-known', { server_seq: 3 }));
    await db.put('links', link('cold-new', { server_seq: null }));
    await archiveNow(1);
    // A second run over the same data must not re-add the id.
    await db.put('links', link('cold-new-2', { server_seq: null }));
    await archiveNow(1);
    expect((await queued()).sort()).toEqual(['cold-new', 'cold-new-2']);
  });

  it('leaves the queue alone when nothing is archivable', async () => {
    const db = await getDB();
    await db.put('links', link('recent', { slushed_at: new Date().toISOString() }));
    expect(await archiveNow(1)).toBe(0);
    expect(await queued()).toEqual([]);
  });

  it('resetLocalSyncState drops the queue — the rows are hot again', async () => {
    const db = await getDB();
    await db.put('links', link('cold-new', { server_seq: null }));
    await archiveNow(1);
    expect(await queued()).toHaveLength(1);

    await resetLocalSyncState();

    expect(await db.get('links', 'cold-new'), 'moved back into the hot store').toBeTruthy();
    expect(await queued(), 'queue cleared — the normal scan covers it now').toEqual([]);
  });
});
