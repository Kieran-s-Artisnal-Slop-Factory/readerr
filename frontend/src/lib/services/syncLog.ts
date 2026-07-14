/**
 * Sync history (Settings → Sync → History): every sync attempt can be
 * logged to the local-only `sync_log` store, with knobs for what to keep —
 * which errors to track, how long to keep events, and whether successes are
 * logged at all (off by default; background sync runs often and success
 * rows add up fast). Aggregate counters (errors, successes, last synced)
 * live in localStorage so the stat line works even with event logging off.
 * Nothing here syncs or appears in backups.
 */
import { getDB } from '../db/db';

export type SyncErrorTracking = 'all' | 'explicit' | 'none';

export interface SyncLogPrefs {
  /** Which failures to log: everything, only non-offline ones, or none. */
  errorTracking: SyncErrorTracking;
  /** Events older than this many days are pruned. */
  retentionDays: number;
  /** Also log successful syncs (high volume — off by default). */
  trackSuccess: boolean;
}

export const DEFAULT_SYNC_LOG_PREFS: SyncLogPrefs = {
  errorTracking: 'all',
  retentionDays: 30,
  trackSuccess: false,
};

const PREFS_KEY = 'readerr-sync-log-prefs';
const STATS_KEY = 'readerr-sync-log-stats';

export function getSyncLogPrefs(): SyncLogPrefs {
  try {
    const stored = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<SyncLogPrefs>;
    return { ...DEFAULT_SYNC_LOG_PREFS, ...stored };
  } catch {
    return { ...DEFAULT_SYNC_LOG_PREFS };
  }
}

export function saveSyncLogPrefs(prefs: SyncLogPrefs): void {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

export interface SyncLogStats {
  errors: number;
  successes: number;
  lastSyncedAt: string | null;
}

export function getSyncLogStats(): SyncLogStats {
  try {
    const stored = JSON.parse(localStorage.getItem(STATS_KEY) ?? '{}') as Partial<SyncLogStats>;
    return { errors: 0, successes: 0, lastSyncedAt: null, ...stored };
  } catch {
    return { errors: 0, successes: 0, lastSyncedAt: null };
  }
}

export interface SyncLogEvent {
  id: string;
  /** UTC ISO 8601 of the attempt. */
  at: string;
  ok: boolean;
  pushed: number;
  pulled: number;
  /** Failure message; '' on success. */
  error: string;
  /** The device was offline — an implicit, expected failure. */
  offline: boolean;
}

/**
 * Record a sync attempt. The aggregate counters always update; whether an
 * event row is stored depends on the prefs.
 */
export async function recordSyncEvent(evt: {
  ok: boolean;
  pushed: number;
  pulled: number;
  error?: string;
  offline?: boolean;
}): Promise<void> {
  const stats = getSyncLogStats();
  if (evt.ok) {
    stats.successes++;
    stats.lastSyncedAt = new Date().toISOString();
  } else {
    stats.errors++;
  }
  localStorage.setItem(STATS_KEY, JSON.stringify(stats));

  const prefs = getSyncLogPrefs();
  const shouldLog = evt.ok
    ? prefs.trackSuccess
    : prefs.errorTracking === 'all' || (prefs.errorTracking === 'explicit' && !evt.offline);
  if (!shouldLog) return;

  const db = await getDB();
  await db.put('sync_log', {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    ok: evt.ok,
    pushed: evt.pushed,
    pulled: evt.pulled,
    error: evt.error ?? '',
    offline: !!evt.offline,
  } satisfies SyncLogEvent);
  void pruneSyncLog();
}

/** Every logged event, newest first. */
export async function listSyncEvents(): Promise<SyncLogEvent[]> {
  const db = await getDB();
  const rows = (await db.getAll('sync_log')) as SyncLogEvent[];
  return rows.sort((a, b) => (a.at < b.at ? 1 : -1));
}

/** Delete events older than the retention window. */
export async function pruneSyncLog(): Promise<void> {
  const days = Math.max(1, getSyncLogPrefs().retentionDays || 30);
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const db = await getDB();
  const tx = db.transaction('sync_log', 'readwrite');
  let cursor = await tx.store.index('at').openCursor(IDBKeyRange.upperBound(cutoff));
  while (cursor) {
    cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}

/** Wipe the event log (the aggregate counters stay). */
export async function clearSyncLog(): Promise<void> {
  await (await getDB()).clear('sync_log');
}
