/**
 * Upgrading an EXISTING database, not creating a fresh one.
 *
 * Fresh installs get the current `STORES` map in migration v1 and skip the
 * rest, so every migration after v1 only ever runs on a database that already
 * holds someone's library — which is exactly the path no test covered. These
 * build a v9 database (the shape shipped before the inbox and series), fill it
 * with rows, and then open it the way the app does, asserting that the new
 * stores appear and nothing that was already there moved.
 *
 * v9 is not an arbitrary choice: it is the version the live backup used for
 * the v0.3.0 upgrade check (`readerr-backup-2026-08-22.json`, schemaVersion 9).
 */
import 'fake-indexeddb/auto';
import { openDB, deleteDB, type IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB_NAME, DB_VERSION } from '../src/lib/db/db';
import type { Link, Tag } from '../src/lib/db/types';

/** The synced stores as they existed at IDB v9, with their v9 indexes. */
const V9_STORES: Record<string, string[]> = {
  user_settings: [],
  plans: ['starts_on'],
  links: ['url', 'added_at'],
  tags: [],
  link_tags: ['link_id', 'tag_id'],
  tag_parents: ['child_id', 'parent_id'],
  topics: [],
  link_topics: ['link_id', 'topic_id'],
  notes: ['link_id'],
  excerpts: ['link_id'],
  resource_lists: [],
  resource_list_links: ['list_id', 'link_id'],
  weeks: ['week_start'],
  week_links: ['week_id', 'link_id'],
};

const NOW = '2026-08-01T00:00:00.000Z';

/** Build the pre-inbox, pre-series database and put real rows in it. */
async function seedV9Database(): Promise<void> {
  const db = await openDB(DB_NAME, 9, {
    upgrade(database) {
      for (const [name, indexes] of Object.entries(V9_STORES)) {
        const store = database.createObjectStore(name, { keyPath: 'id' });
        for (const index of indexes) store.createIndex(index, index, { multiEntry: false });
        // v7 added updated_at everywhere; v9 databases have it.
        store.createIndex('updated_at', 'updated_at', { multiEntry: false });
        // …and v9 added the backlog suggester's compound index.
        if (name === 'links') {
          store.createIndex('priority_added', ['priority', 'added_at'], { multiEntry: false });
        }
      }
      database.createObjectStore('sync_meta', { keyPath: 'key' });
      const archived = database.createObjectStore('archived_links', { keyPath: 'id' });
      archived.createIndex('added_at', 'added_at', { multiEntry: false });
      archived.createIndex('slushed_at', 'slushed_at', { multiEntry: false });
      const log = database.createObjectStore('sync_log', { keyPath: 'id' });
      log.createIndex('at', 'at', { multiEntry: false });
      database.createObjectStore('label_usage', { keyPath: 'id' });
    },
  });

  const sync = { updated_at: NOW, deleted_at: null, server_seq: 7 };
  await db.put('links', {
    id: 'link-1',
    url: 'https://example.com/a',
    title: 'A captured link',
    title_fetched: true,
    added_at: NOW,
    read_at: null,
    favourite: true,
    is_resource: false,
    slushed_at: null,
    priority: 2,
    ...sync,
    // NOTE: no is_series — the column did not exist at v9.
  });
  await db.put('tags', { id: 'tag-1', name: 'rust', notes_md: '', ...sync });
  await db.put('link_tags', { id: 'lt-1', link_id: 'link-1', tag_id: 'tag-1', ...sync });
  await db.put('sync_meta', { key: 'lastPullSeq', value: 7 });
  db.close();
}

/**
 * Every connection a test opens, closed before the next one deletes the
 * database — fake-indexeddb blocks (and then aborts the pending upgrade)
 * while an older connection is still open, exactly as a browser does.
 */
const opened: IDBPDatabase[] = [];

/** Open the database the way the app does, on a fresh module registry. */
async function openApp(): Promise<IDBPDatabase> {
  // getDB caches its connection promise per module instance; resetting the
  // registry is what makes "open the same database again" honest.
  vi.resetModules();
  const db = await (await import('../src/lib/db/db')).getDB();
  opened.push(db);
  return db;
}

beforeEach(async () => {
  await deleteDB(DB_NAME);
});

afterEach(async () => {
  for (const db of opened.splice(0)) db.close();
  await deleteDB(DB_NAME);
});

describe('upgrading a v9 database to the current one', () => {
  it('adds the new stores without disturbing the old rows', async () => {
    await seedV9Database();

    const db = await openApp();

    expect(db.version).toBe(DB_VERSION);
    // Everything the inbox and series added, and nothing missing.
    for (const store of ['feeds', 'feed_items', 'series_links', 'feed_state']) {
      expect(db.objectStoreNames.contains(store), `${store} created`).toBe(true);
    }
    for (const store of Object.keys(V9_STORES)) {
      expect(db.objectStoreNames.contains(store), `${store} kept`).toBe(true);
    }

    // The rows are untouched, including the sync trio a pull depends on.
    const link = (await db.get('links', 'link-1')) as Link;
    expect(link).toMatchObject({ title: 'A captured link', favourite: true, priority: 2 });
    expect(link.server_seq).toBe(7);
    expect((await db.get('tags', 'tag-1')) as Tag).toMatchObject({ name: 'rust' });
    expect(await db.count('link_tags')).toBe(1);
    // Local-only stores survive too — the archive is real user data.
    expect(db.objectStoreNames.contains('archived_links')).toBe(true);
    expect(((await db.get('sync_meta', 'lastPullSeq')) as { value: number }).value).toBe(7);
  });

  it('gives the new stores their indexes, so the inbox and series can read', async () => {
    await seedV9Database();
    const db = await openApp();

    const tx = db.transaction(['feeds', 'feed_items', 'series_links'], 'readonly');
    expect([...tx.objectStore('feeds').indexNames].sort()).toEqual(['feed_url', 'updated_at']);
    expect([...tx.objectStore('feed_items').indexNames].sort()).toEqual([
      'feed_id',
      'guid',
      'updated_at',
    ]);
    expect([...tx.objectStore('series_links').indexNames].sort()).toEqual([
      'link_id',
      'series_id',
      'updated_at',
    ]);
    await tx.done;
  });

  it('treats a link written before is_series existed as not a series', async () => {
    await seedV9Database();
    await openApp(); // upgrade first
    const { isSeries } = await import('../src/lib/services/series');
    const { all } = await import('../src/lib/db/repo');
    const links = await all<Link>('links');
    expect(links).toHaveLength(1);
    // undefined, not false — the reader must not trust the field's presence.
    expect(links[0].is_series).toBeUndefined();
    expect(isSeries(links[0])).toBe(false);
  });

  it('is idempotent: opening the upgraded database again changes nothing', async () => {
    await seedV9Database();
    const first = await openApp();
    const version = first.version;
    const stores = [...first.objectStoreNames].sort();
    first.close();

    const second = await openApp();
    expect(second.version).toBe(version);
    expect([...second.objectStoreNames].sort()).toEqual(stores);
    expect(await second.count('links')).toBe(1);
  });
});

describe('a fresh install', () => {
  it('creates every store the upgrade path produces', async () => {
    const fresh = await openApp();
    for (const store of ['feeds', 'feed_items', 'series_links', 'feed_state', 'links']) {
      expect(fresh.objectStoreNames.contains(store), `${store} on a fresh install`).toBe(true);
    }
    expect(fresh.version).toBe(DB_VERSION);
  });
});
