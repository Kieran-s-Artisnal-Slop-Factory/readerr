/**
 * CRUD helpers over IndexedDB. All reads filter tombstones; all writes stamp
 * updated_at (the LWW conflict-resolution field). Rows are never hard
 * deleted — softDelete sets deleted_at so deletions can sync in Phase 3.
 */
import { getDB } from './db';
import type { StoreName, SyncFields } from './types';

export const newId = (): string => crypto.randomUUID();
export const nowIso = (): string => new Date().toISOString();

/** Attach generated id + sync fields to a new entity. */
export function withSyncFields<T extends object>(fields: T): T & SyncFields {
  return {
    id: newId(),
    updated_at: nowIso(),
    deleted_at: null,
    server_seq: null,
    ...fields,
  };
}

export async function all<T extends SyncFields>(store: StoreName): Promise<T[]> {
  const rows = (await (await getDB()).getAll(store)) as T[];
  return rows.filter((r) => !r.deleted_at);
}

export async function get<T extends SyncFields>(
  store: StoreName,
  id: string
): Promise<T | undefined> {
  const row = (await (await getDB()).get(store, id)) as T | undefined;
  return row && !row.deleted_at ? row : undefined;
}

export async function byIndex<T extends SyncFields>(
  store: StoreName,
  index: string,
  value: IDBValidKey
): Promise<T[]> {
  const rows = (await (await getDB()).getAllFromIndex(store, index, value)) as T[];
  return rows.filter((r) => !r.deleted_at);
}

/** Insert or update, stamping updated_at. Returns the stamped row. */
export async function put<T extends SyncFields>(store: StoreName, row: T): Promise<T> {
  const stamped = { ...row, updated_at: nowIso() };
  await (await getDB()).put(store, stamped);
  return stamped;
}

export async function bulkPut<T extends SyncFields>(store: StoreName, rows: T[]): Promise<T[]> {
  const db = await getDB();
  const tx = db.transaction(store, 'readwrite');
  const stamped = rows.map((r) => ({ ...r, updated_at: nowIso() }));
  for (const row of stamped) tx.store.put(row);
  await tx.done;
  return stamped;
}

export async function softDelete(store: StoreName, id: string): Promise<void> {
  const db = await getDB();
  const row = (await db.get(store, id)) as SyncFields | undefined;
  if (!row || row.deleted_at) return;
  await db.put(store, { ...row, deleted_at: nowIso(), updated_at: nowIso() });
}

export async function softDeleteMany(store: StoreName, ids: string[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(store, 'readwrite');
  const now = nowIso();
  for (const id of ids) {
    const row = (await tx.store.get(id)) as SyncFields | undefined;
    if (row && !row.deleted_at) {
      tx.store.put({ ...row, deleted_at: now, updated_at: now });
    }
  }
  await tx.done;
}
