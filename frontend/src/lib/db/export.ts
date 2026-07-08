/**
 * JSON backup export/import. Complements sync as the user-held backup.
 * Exports include tombstoned rows (it's a full copy of the store, not a
 * view). Import is a full REPLACE: clear every store, then load.
 *
 * Envelope format: {schemaVersion, exportedAt, data: {storeName: rows[]}}
 */
import { getDB, DB_VERSION } from './db';
import { STORES } from './types';

export interface ExportEnvelope {
  schemaVersion: number;
  exportedAt: string;
  data: Record<string, unknown[]>;
}

export async function exportData(): Promise<ExportEnvelope> {
  const db = await getDB();
  const data: Record<string, unknown[]> = {};
  for (const name of Object.keys(STORES)) {
    data[name] = await db.getAll(name);
  }
  return {
    schemaVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    data,
  };
}

/** Trigger a browser download of the backup file. */
export async function downloadExport(): Promise<void> {
  const envelope = await exportData();
  const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `readerr-backup-${envelope.exportedAt.slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Wipe every store, including sync bookkeeping. Escape hatch — the caller is
 * responsible for confirming with the user first.
 */
export async function clearAllData(): Promise<void> {
  const db = await getDB();
  const names = [...Object.keys(STORES), 'sync_meta'];
  const tx = db.transaction(names, 'readwrite');
  for (const name of names) {
    tx.objectStore(name).clear();
  }
  await tx.done;
}

export interface ImportResult {
  rows: number;
}

/** Load a backup: clear the known stores, then put every row. */
export async function importData(envelope: ExportEnvelope): Promise<ImportResult> {
  if (
    typeof envelope !== 'object' ||
    typeof envelope.schemaVersion !== 'number' ||
    typeof envelope.data !== 'object'
  ) {
    throw new Error('Not a valid Readerr backup file');
  }
  if (envelope.schemaVersion > DB_VERSION) {
    throw new Error(
      `Backup is from a newer app version (schema v${envelope.schemaVersion}, app has v${DB_VERSION})`
    );
  }

  const known = new Set(Object.keys(STORES));
  const names = Object.keys(envelope.data).filter((n) => known.has(n));

  const db = await getDB();
  const tx = db.transaction(names, 'readwrite');
  let rows = 0;
  for (const name of names) {
    const store = tx.objectStore(name);
    store.clear();
    for (const row of envelope.data[name] ?? []) {
      store.put(row);
      rows++;
    }
  }
  await tx.done;

  return { rows };
}
