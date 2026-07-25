/**
 * CRUD helpers over IndexedDB. All reads filter tombstones; all writes stamp
 * updated_at (the LWW conflict-resolution field). Rows are never hard
 * deleted — softDelete sets deleted_at so deletions can sync in Phase 3.
 */
import { getDB } from './db';
import { healsAllowed } from '../testMode';
import { requestSync } from '../sync';
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

/**
 * Tombstones included. Only for the rare read that must see deleted rows —
 * notably issuing a topic's next footnote number, which counts removed
 * references so a number is never handed out twice.
 */
export async function byIndexWithDeleted<T extends SyncFields>(
  store: StoreName,
  index: string,
  value: IDBValidKey
): Promise<T[]> {
  return (await (await getDB()).getAllFromIndex(store, index, value)) as T[];
}

/**
 * Rows must survive IndexedDB's structured clone, but Svelte 5 `$state`
 * values are Proxies, which structured clone rejects — so a component
 * passing reactive state into a row (e.g. an array of selected tag ids)
 * made `put` reject with DataCloneError, silently in fire-and-forget
 * handlers. Rows are JSON-shaped by design (they sync as JSON), so a JSON
 * round-trip both strips reactivity and guarantees clonability.
 */
function toPlain<T>(row: T): T {
  return JSON.parse(JSON.stringify(row)) as T;
}

/** Insert or update, stamping updated_at. Returns the stamped row. */
export async function put<T extends SyncFields>(store: StoreName, row: T): Promise<T> {
  const stamped = toPlain({ ...row, updated_at: nowIso() });
  await (await getDB()).put(store, stamped);
  requestSync(); // debounced: propagate this change without waiting for auto-sync
  return stamped;
}

/**
 * Persist a reconcile-fold survivor WITHOUT restamping updated_at.
 *
 * repo.put() stamps updated_at = now, which is correct for a user edit but
 * catastrophic for a fold: a device folding stale local duplicates would write
 * old content under a fresh timestamp that then beats another device's
 * genuinely newer edit under LWW (silent, permanent data loss — the widest
 * such channel in the audit). This preserves the row's own updated_at (the
 * real time its content was last edited), so the fold orders correctly under
 * LWW and can only ever LOSE to a genuinely newer edit, never clobber it.
 *
 * The tradeoff: a folded survivor's preserved timestamp usually sits BELOW the
 * push watermark, so the watermark scan (sync.ts) would never send it — and the
 * merged content (which may live only on a stray about to be tombstoned) would
 * be lost instead. So the row is recorded in `pendingRepush`; the next push
 * re-sends it by id regardless of the watermark, then clears the record. The
 * server LWW-accepts it only if it is genuinely newer, so this both delivers
 * merged content and cannot resurrect stale data.
 */
export async function putReconciled<T extends SyncFields>(store: StoreName, row: T): Promise<T> {
  const plain = toPlain(row); // preserves updated_at — deliberately NOT restamped
  const db = await getDB();
  await db.put(store, plain);
  await recordPendingRepush(db, store, plain.id);
  requestSync();
  return plain;
}

/** Note a fold-reset row so the next push re-sends it (see putReconciled). */
async function recordPendingRepush(
  db: Awaited<ReturnType<typeof getDB>>,
  store: StoreName,
  id: string
): Promise<void> {
  if (!db.objectStoreNames.contains('sync_meta')) return;
  const ref = `${store}:${id}`;
  const existing = (await db.get('sync_meta', 'pendingRepush')) as
    | { key: string; value: string[] }
    | undefined;
  const set = new Set(existing?.value ?? []);
  if (set.has(ref)) return;
  set.add(ref);
  await db.put('sync_meta', { key: 'pendingRepush', value: [...set] });
}

export async function bulkPut<T extends SyncFields>(store: StoreName, rows: T[]): Promise<T[]> {
  const db = await getDB();
  const tx = db.transaction(store, 'readwrite');
  const stamped = rows.map((r) => toPlain({ ...r, updated_at: nowIso() }));
  for (const row of stamped) tx.store.put(row);
  await tx.done;
  if (stamped.length) requestSync();
  return stamped;
}

export async function softDelete(store: StoreName, id: string): Promise<void> {
  const db = await getDB();
  const row = (await db.get(store, id)) as SyncFields | undefined;
  if (!row || row.deleted_at) return;
  await db.put(store, { ...row, deleted_at: nowIso(), updated_at: nowIso() });
  requestSync();
}

export async function softDeleteMany(store: StoreName, ids: string[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(store, 'readwrite');
  const now = nowIso();
  let deleted = 0;
  for (const id of ids) {
    const row = (await tx.store.get(id)) as SyncFields | undefined;
    if (row && !row.deleted_at) {
      tx.store.put({ ...row, deleted_at: now, updated_at: now });
      deleted++;
    }
  }
  await tx.done;
  if (deleted) requestSync();
}

/**
 * Collapse logical-duplicate rows in a join table to one row per pair.
 *
 * Junction tables (link_tags, link_topics, resource_list_links) are
 * conceptually "one row per (left, right) pair" but keyed by a random UUID,
 * so two devices that form the same pair before syncing each mint a separate
 * row. Row-level LWW never merges different ids, so both go live — duplicate
 * chips and inflated counts. This picks a device-independent survivor per
 * pair (the smallest id, so every client agrees without coordinating) and
 * tombstones the rest. The choice is deterministic, so each device converges
 * on the same row exactly as the settings/plans/weeks singletons do (see the
 * "logical singletons keyed by UUID" note in docs/dev/data-model.md).
 *
 * `rows` must be a COMPLETE set of live rows for every pair it contains —
 * true of `all(store)` and of any `byIndex` on one side of the pair, since
 * the index returns every live row on that axis. `mergeSurvivor` folds any
 * duplicate-carried state onto the survivor before the strays drop (return
 * the row to persist, or null to leave it as is); link_topics uses it to keep
 * the lowest footnote number so citations stay stable.
 *
 * Runs on read and heals in place: with no duplicates it writes nothing, and
 * once a pair has collapsed its tombstoned strays never resurface, so later
 * reads are a cheap in-memory grouping.
 */
export async function dedupePairs<T extends SyncFields>(
  store: StoreName,
  rows: T[],
  keyOf: (row: T) => string,
  mergeSurvivor?: (survivor: T, duplicates: T[]) => T | null
): Promise<T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  const survivors: T[] = [];
  const strays: string[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      survivors.push(group[0]);
      continue;
    }
    // Smallest id wins — a fixed, device-independent choice, so two clients
    // deduping the same pair keep the same row without coordinating.
    const [survivor, ...duplicates] = [...group].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    );
    const merged = mergeSurvivor ? mergeSurvivor(survivor, duplicates) : null;
    if (!healsAllowed()) {
      // Test mode: reads stay reads. Same survivor choice, nothing persisted.
      survivors.push(merged ?? survivor);
      continue;
    }
    // Re-put the survivor to re-deliver it (and any merged state) to devices
    // whose pull cursor passed its original seq — but via putReconciled, which
    // PRESERVES updated_at instead of stamping now. Stamping now let a stale
    // fold clobber a concurrent edit under LWW; the pendingRepush rescue still
    // gets the row to the server. Only fires on a fold.
    const kept = await putReconciled(store, merged ?? survivor);
    survivors.push(kept);
    for (const dup of duplicates) strays.push(dup.id);
  }

  if (strays.length) await softDeleteMany(store, strays);
  return survivors;
}
