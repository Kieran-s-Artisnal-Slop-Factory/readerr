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
  // v5 — the archive store (see yearly-archival.md). Local-only: NOT in
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
  // v7 — updated_at index on every synced store (scaling.md §4): push asks
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
];

/** Local-only stores that live in IndexedDB but never sync or appear in STORES. */
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
