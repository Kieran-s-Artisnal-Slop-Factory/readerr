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
];

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
