/**
 * The sync-harness hook: window.__readerr, installed from Layout.astro on
 * every page but ONLY when test mode is on (see testMode.ts) — it never
 * exists for real users. The harness drives sync explicitly and reads raw
 * database state through this object instead of scraping the UI.
 *
 * rawDump / rawDumpAll deliberately bypass repo.all(): the oracle needs to
 * see tombstones and server_seq to catch resurrection and cursor bugs, which
 * the tombstone-filtering reads would launder away.
 */
import { getDB } from './db/db';
import { STORES } from './db/types';
import type { SyncFields, StoreName } from './db/types';
import { put as repoPut, softDelete } from './db/repo';
import { syncNow } from './sync';
import { isTestMode, withHeals } from './testMode';
import { getUserSettings, saveUserSettings } from './services/settings';
import { reconcileOpenWeeks, ensureOpenWeek, autoCloseStaleWeeks, closeWeek } from './services/weeks';
import { reconcilePlans } from './services/plans';
import { getNote } from './services/notes';
import { reconcileTags, reconcileTopics } from './services/links';
import { captureLinks } from './services/capture';
import { importData, exportData, wipeLocalData } from './db/export';
import { archiveNow, unarchive, listArchived } from './services/archive';
import { resetLocalSyncState } from './sync';
import type { Link, Week } from './db/types';

async function rawDump(store: string): Promise<unknown[]> {
  return (await getDB()).getAll(store);
}

async function rawDumpAll(): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const store of Object.keys(STORES)) out[store] = await rawDump(store);
  return out;
}

export function installTestHook(): void {
  if (!isTestMode() || typeof window === 'undefined') return;
  (window as unknown as { __readerr: unknown }).__readerr = {
    // --- raw state (tombstones + server_seq included) ---
    rawDump,
    rawDumpAll,
    rawGet: async (store: string, id: string) => (await getDB()).get(store, id),
    /** Direct IDB put — no updated_at stamping. Sabotage / fixture writes. */
    rawPut: async (store: string, row: SyncFields) => {
      await (await getDB()).put(store, row);
    },
    /** Hard delete — bypasses tombstoning. Sabotage only. */
    rawDelete: async (store: string, id: string) => {
      await (await getDB()).delete(store, id);
    },
    // --- Tier-2 writes through the real repo (stamps updated_at) ---
    repoPut: async (store: StoreName, row: SyncFields) => repoPut(store, row),
    softDeleteNow: async (store: StoreName, id: string) => softDelete(store, id),
    // --- sync bookkeeping ---
    getCursors: async () => {
      const db = await getDB();
      const meta = async (key: string) =>
        ((await db.get('sync_meta', key)) as { value: unknown } | undefined)?.value ?? null;
      return {
        lastPushAt: await meta('lastPushAt'),
        lastPullSeq: await meta('lastPullSeq'),
        lastSyncAt: await meta('lastSyncAt'),
        lastError: await meta('lastError'),
        serverEpoch: await meta('serverEpoch'),
      };
    },
    setMeta: async (key: string, value: unknown) => {
      await (await getDB()).put('sync_meta', { key, value });
    },
    deleteMeta: async (key: string) => {
      await (await getDB()).delete('sync_meta', key);
    },
    // --- explicit sync (returns the SyncResult; never fire-and-forget) ---
    syncNow,
    // --- real capture pipeline (Tier-1-adjacent service path) ---
    captureNow: (text: string) => withHeals(() => captureLinks(text)),
    // --- yearly archival (local-only cold store) ---
    archiveNow: (months: number) => archiveNow(months),
    unarchiveNow: (link: Link) => unarchive(link),
    listArchivedNow: () => listArchived(),
    resetLocalSyncStateNow: () => resetLocalSyncState(),
    // --- reconcilers, run FOR REAL (heal writes enabled) on demand ---
    healSettingsNow: () => withHeals(() => getUserSettings()),
    saveSettingsNow: (changes: Parameters<typeof saveUserSettings>[0]) =>
      withHeals(() => saveUserSettings(changes)),
    reconcileOpenWeeksNow: () => withHeals(() => reconcileOpenWeeks()),
    reconcilePlansNow: () => withHeals(() => reconcilePlans()),
    healNoteNow: (linkId: string) => withHeals(() => getNote(linkId)),
    reconcileTagsNow: () => withHeals(() => reconcileTags()),
    reconcileTopicsNow: () => withHeals(() => reconcileTopics()),
    // --- week lifecycle, invoked deliberately by tests ---
    ensureOpenWeekNow: () => withHeals(() => ensureOpenWeek()),
    autoCloseStaleWeeksNow: () => withHeals(() => autoCloseStaleWeeks()),
    closeWeekNow: async (weekId: string) => {
      const week = (await (await getDB()).get('weeks', weekId)) as Week | undefined;
      if (!week) throw new Error(`closeWeekNow: no week ${weekId}`);
      return withHeals(() => closeWeek(week));
    },
  };
  // Backup/restore service, exposed separately so lifecycle tests exercise the
  // real export.ts code paths.
  (window as unknown as { __readerrExport: unknown }).__readerrExport = {
    importData,
    exportData,
    wipeLocalData,
  };
}
