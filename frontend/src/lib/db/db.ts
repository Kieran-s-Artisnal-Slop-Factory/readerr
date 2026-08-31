/**
 * IndexedDB connection + versioned migrations.
 *
 * The schema is versioned from day one: MIGRATIONS is an ordered list of
 * upgrade functions, one per version, run in sequence from the client's
 * current version inside onupgradeneeded. Never edit an existing migration
 * once shipped — append a new one. These must change in lockstep with
 * backend/sql/schema.sql.
 */
import { openDB, type IDBPDatabase, type IDBPTransaction } from 'idb';
import { STORES } from './types';

export const DB_NAME = 'readerr';

type Migration = (
  db: IDBPDatabase,
  tx: IDBPTransaction<unknown, string[], 'versionchange'>
) => void;

const MIGRATIONS: Migration[] = [
  // v1 — create every object store and its indexes from the STORES map.
  (db) => {
    for (const [name, def] of Object.entries(STORES)) {
      const store = db.createObjectStore(name, { keyPath: 'id' });
      for (const idx of def.indexes) {
        store.createIndex(idx.name, idx.name, { multiEntry: idx.multiEntry ?? false });
      }
    }
  },
  // v2 — sync bookkeeping (cursor, timestamps). Deliberately NOT in STORES:
  // it is never synced or included in backups.
  (db) => {
    db.createObjectStore('sync_meta', { keyPath: 'key' });
  },
  // v3 — scheduled triage plans. Guarded because fresh installs already get
  // the store from the v1 STORES loop.
  (db) => {
    if (!db.objectStoreNames.contains('plans')) {
      const store = db.createObjectStore('plans', { keyPath: 'id' });
      store.createIndex('starts_on', 'starts_on', { multiEntry: false });
    }
  },
  // v4 — resource lists (same guard rationale as v3).
  (db) => {
    if (!db.objectStoreNames.contains('resource_lists')) {
      db.createObjectStore('resource_lists', { keyPath: 'id' });
      const joins = db.createObjectStore('resource_list_links', { keyPath: 'id' });
      joins.createIndex('list_id', 'list_id', { multiEntry: false });
      joins.createIndex('link_id', 'link_id', { multiEntry: false });
    }
  },
  // v5 — the archive store (see services/archive.ts). Local-only: NOT in
  // STORES, so it never syncs; archived links are hard-moved here out of the
  // hot `links` store. Mirrors the links shape.
  (db) => {
    if (!db.objectStoreNames.contains('archived_links')) {
      const store = db.createObjectStore('archived_links', { keyPath: 'id' });
      store.createIndex('added_at', 'added_at', { multiEntry: false });
      store.createIndex('slushed_at', 'slushed_at', { multiEntry: false });
    }
  },
  // v6 — sync history log (Settings → Sync). Local diagnostics: never
  // synced, and deliberately not in LOCAL_STORES either — logs are ephemeral
  // telemetry, not data worth backing up.
  (db) => {
    if (!db.objectStoreNames.contains('sync_log')) {
      const store = db.createObjectStore('sync_log', { keyPath: 'id' });
      store.createIndex('at', 'at', { multiEntry: false });
    }
  },
  // v7 — updated_at index on every synced store: push asks
  // "what changed since lastPushAt" with an IDBKeyRange instead of scanning
  // whole stores, so its cost tracks edits, not history.
  (_db, tx) => {
    for (const name of Object.keys(STORES)) {
      const store = tx.objectStore(name);
      if (!store.indexNames.contains('updated_at')) {
        store.createIndex('updated_at', 'updated_at', { multiEntry: false });
      }
    }
  },
  // v8 — tag_parents: nest a tag under one or more parent tags. Guarded
  // because fresh installs already get the store from the v1 STORES loop; the
  // updated_at index is created here too, since the v7 loop above has already
  // run for existing databases and will not revisit a store added later.
  (db) => {
    if (!db.objectStoreNames.contains('tag_parents')) {
      const store = db.createObjectStore('tag_parents', { keyPath: 'id' });
      store.createIndex('child_id', 'child_id', { multiEntry: false });
      store.createIndex('parent_id', 'parent_id', { multiEntry: false });
      store.createIndex('updated_at', 'updated_at', { multiEntry: false });
    }
  },
  // v9 — two page-load reads stop scanning whole tables (performance.md):
  //   - label_usage: local-only recency per tag/topic id for the capture
  //     box's chip ordering, replacing a whole link_tags/link_topics scan.
  //     Derived data — never synced or backed up, rebuilt by a one-time
  //     backfill (links.ts labelUsageMap) when absent.
  //   - links.priority_added: compound [priority, added_at] index for backlog
  //     suggestions. Rows with priority NULL are deliberately absent (IDB
  //     doesn't index null); suggestLinks serves them from the existing
  //     added_at index and merges the two streams.
  (db, tx) => {
    if (!db.objectStoreNames.contains('label_usage')) {
      db.createObjectStore('label_usage', { keyPath: 'id' });
    }
    const links = tx.objectStore('links');
    if (!links.indexNames.contains('priority_added')) {
      links.createIndex('priority_added', ['priority', 'added_at'], { multiEntry: false });
    }
  },
  // v10 — the inbox: subscribed feeds (`feeds`) and the entries they produce
  // (`feed_items`), both synced. Guarded because fresh installs already get
  // them from the v1 STORES loop; their updated_at indexes are created here
  // too, since the v7 loop has already run for existing databases and will
  // not revisit a store added later.
  //
  // `feed_state` is LOCAL-ONLY and deliberately outside STORES: per-device
  // fetch bookkeeping (last checked, last result) that must never travel, so
  // the daily refresh writes nothing that syncs. Derived, like label_usage,
  // so it isn't in LOCAL_STORES (backups) either — a restored backup simply
  // re-checks every feed once.
  (db, tx) => {
    if (!db.objectStoreNames.contains('feeds')) {
      const feeds = db.createObjectStore('feeds', { keyPath: 'id' });
      feeds.createIndex('feed_url', 'feed_url', { multiEntry: false });
      feeds.createIndex('updated_at', 'updated_at', { multiEntry: false });
    } else if (!tx.objectStore('feeds').indexNames.contains('feed_url')) {
      tx.objectStore('feeds').createIndex('feed_url', 'feed_url', { multiEntry: false });
    }
    if (!db.objectStoreNames.contains('feed_items')) {
      const items = db.createObjectStore('feed_items', { keyPath: 'id' });
      items.createIndex('feed_id', 'feed_id', { multiEntry: false });
      items.createIndex('guid', 'guid', { multiEntry: false });
      items.createIndex('updated_at', 'updated_at', { multiEntry: false });
    } else if (!tx.objectStore('feed_items').indexNames.contains('guid')) {
      tx.objectStore('feed_items').createIndex('guid', 'guid', { multiEntry: false });
    }
    if (!db.objectStoreNames.contains('feed_state')) {
      db.createObjectStore('feed_state', { keyPath: 'id' });
    }
  },
  // v11 — series: `series_links` edges pointing a series link at its parts.
  // Guarded because fresh installs already get the store from the v1 STORES
  // loop; the updated_at index is created here too, since the v7 loop has
  // already run for existing databases.
  //
  // `links.is_series` needs no migration: IndexedDB is schemaless per record,
  // so the flag simply appears on rows that carry it and reads `undefined` on
  // older ones (which `isSeries()` treats as false) — the same handling
  // `priority` got.
  (db) => {
    if (!db.objectStoreNames.contains('series_links')) {
      const store = db.createObjectStore('series_links', { keyPath: 'id' });
      store.createIndex('series_id', 'series_id', { multiEntry: false });
      store.createIndex('link_id', 'link_id', { multiEntry: false });
      store.createIndex('updated_at', 'updated_at', { multiEntry: false });
    }
  },
  // v12 — topic tags: `topic_tags` edges pointing a topic at its tags.
  // Guarded because fresh installs already get the store from the v1 STORES
  // loop; the updated_at index is created here too, since the v7 loop has
  // already run for existing databases and never revisits a later store.
  //
  // `topics.status` needs no migration: IndexedDB is schemaless per record,
  // so the field simply appears on rows that carry it and reads `undefined`
  // on older ones (which `topicStatus()` treats as ''), the same handling
  // `priority` and `is_series` got.
  (db) => {
    if (!db.objectStoreNames.contains('topic_tags')) {
      const store = db.createObjectStore('topic_tags', { keyPath: 'id' });
      store.createIndex('topic_id', 'topic_id', { multiEntry: false });
      store.createIndex('tag_id', 'tag_id', { multiEntry: false });
      store.createIndex('updated_at', 'updated_at', { multiEntry: false });
    }
  },
];

/**
 * Local-only stores that never sync or appear in STORES but hold real user
 * data — a full backup must still carry them. sync_meta, sync_log, and
 * label_usage are deliberately absent: cursors, telemetry, and derived
 * caches rebuild themselves and aren't worth backing up.
 */
export const LOCAL_STORES = ['archived_links'];

export const DB_VERSION = MIGRATIONS.length;

let dbPromise: Promise<IDBPDatabase> | null = null;

export function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, _newVersion, tx) {
        for (let v = oldVersion; v < MIGRATIONS.length; v++) {
          MIGRATIONS[v](db, tx);
        }
      },
    });
  }
  return dbPromise;
}
