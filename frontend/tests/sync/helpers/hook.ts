/**
 * Typed wrappers over window.__readerr (src/lib/testHook.ts) for driving a
 * device from test code. Every sync is explicit and awaited — never a
 * timeout; the returned SyncResult is asserted directly.
 */
import type { Page } from '@playwright/test';
import type { Device } from './devices';

export interface SyncResult {
  ok: boolean;
  pushed: number;
  pulled: number;
  error?: string;
}

export interface Cursors {
  lastPushAt: string | null;
  lastPullSeq: number | null;
  lastSyncAt: string | null;
  lastError: string | null;
  serverEpoch: string | null;
}

export interface SyncRow {
  id: string;
  updated_at: string;
  deleted_at: string | null;
  server_seq: number | null;
  [key: string]: unknown;
}

type HookWindow = Window & {
  __readerr: {
    rawDump(store: string): Promise<SyncRow[]>;
    rawDumpAll(): Promise<Record<string, SyncRow[]>>;
    rawGet(store: string, id: string): Promise<SyncRow | undefined>;
    rawPut(store: string, row: unknown): Promise<void>;
    rawDelete(store: string, id: string): Promise<void>;
    repoPut(store: string, row: unknown): Promise<SyncRow>;
    softDeleteNow(store: string, id: string): Promise<void>;
    getCursors(): Promise<Cursors>;
    setMeta(key: string, value: unknown): Promise<void>;
    deleteMeta(key: string): Promise<void>;
    syncNow(): Promise<SyncResult>;
    captureNow(text: string, assign?: Record<string, unknown>): Promise<{ added: SyncRow[] }>;
    archiveNow(months: number): Promise<number>;
    unarchiveNow(link: unknown): Promise<void>;
    listArchivedNow(): Promise<SyncRow[]>;
    resetLocalSyncStateNow(): Promise<void>;
    healSettingsNow(): Promise<SyncRow | null>;
    saveSettingsNow(changes: Record<string, unknown>): Promise<SyncRow>;
    reconcileOpenWeeksNow(): Promise<void>;
    reconcilePlansNow(): Promise<SyncRow[]>;
    healNoteNow(linkId: string): Promise<SyncRow | null>;
    reconcileTagsNow(): Promise<void>;
    reconcileTopicsNow(): Promise<void>;
    reconcileTagParentsNow(): Promise<void>;
    setTagParentsNow(childId: string, parentIds: string[]): Promise<void>;
    ensureOpenWeekNow(): Promise<SyncRow>;
    autoCloseStaleWeeksNow(): Promise<unknown>;
    closeWeekNow(weekId: string): Promise<unknown>;
    setEntryDoneNow(entry: unknown, done: boolean): Promise<SyncRow>;
    toggleFavouriteNow(link: unknown): Promise<SyncRow>;
  };
};

function pageOf(target: Device | Page): Page {
  return 'page' in target ? (target as Device).page : (target as Page);
}

export function hook(target: Device | Page) {
  const page = pageOf(target);
  return {
    rawDump: (store: string) =>
      page.evaluate((s) => (window as unknown as HookWindow).__readerr.rawDump(s), store),
    rawDumpAll: () =>
      page.evaluate(() => (window as unknown as HookWindow).__readerr.rawDumpAll()),
    rawGet: (store: string, id: string) =>
      page.evaluate(
        ([s, i]) => (window as unknown as HookWindow).__readerr.rawGet(s, i),
        [store, id] as const
      ),
    rawPut: (store: string, row: unknown) =>
      page.evaluate(
        ([s, r]) => (window as unknown as HookWindow).__readerr.rawPut(s as string, r),
        [store, row] as const
      ),
    rawDelete: (store: string, id: string) =>
      page.evaluate(
        ([s, i]) => (window as unknown as HookWindow).__readerr.rawDelete(s, i),
        [store, id] as const
      ),
    repoPut: (store: string, row: unknown) =>
      page.evaluate(
        ([s, r]) => (window as unknown as HookWindow).__readerr.repoPut(s as string, r),
        [store, row] as const
      ),
    softDelete: (store: string, id: string) =>
      page.evaluate(
        ([s, i]) => (window as unknown as HookWindow).__readerr.softDeleteNow(s, i),
        [store, id] as const
      ),
    getCursors: () =>
      page.evaluate(() => (window as unknown as HookWindow).__readerr.getCursors()),
    setMeta: (key: string, value: unknown) =>
      page.evaluate(
        ([k, v]) => (window as unknown as HookWindow).__readerr.setMeta(k as string, v),
        [key, value] as const
      ),
    deleteMeta: (key: string) =>
      page.evaluate((k) => (window as unknown as HookWindow).__readerr.deleteMeta(k), key),
    syncNow: () => page.evaluate(() => (window as unknown as HookWindow).__readerr.syncNow()),
    captureNow: (text: string, assign?: Record<string, unknown>) =>
      page.evaluate(
        ([t, a]) =>
          (window as unknown as HookWindow).__readerr.captureNow(
            t as string,
            a as Record<string, unknown> | undefined
          ),
        [text, assign] as const
      ),
    archiveNow: (months: number) =>
      page.evaluate((m) => (window as unknown as HookWindow).__readerr.archiveNow(m), months),
    unarchiveNow: (link: unknown) =>
      page.evaluate((l) => (window as unknown as HookWindow).__readerr.unarchiveNow(l), link),
    listArchivedNow: () =>
      page.evaluate(() => (window as unknown as HookWindow).__readerr.listArchivedNow()),
    resetLocalSyncStateNow: () =>
      page.evaluate(() => (window as unknown as HookWindow).__readerr.resetLocalSyncStateNow()),
    healSettingsNow: () =>
      page.evaluate(() => (window as unknown as HookWindow).__readerr.healSettingsNow()),
    saveSettingsNow: (changes: Record<string, unknown>) =>
      page.evaluate(
        (c) => (window as unknown as HookWindow).__readerr.saveSettingsNow(c),
        changes
      ),
    reconcileOpenWeeksNow: () =>
      page.evaluate(() => (window as unknown as HookWindow).__readerr.reconcileOpenWeeksNow()),
    reconcilePlansNow: () =>
      page.evaluate(() => (window as unknown as HookWindow).__readerr.reconcilePlansNow()),
    healNoteNow: (linkId: string) =>
      page.evaluate((l) => (window as unknown as HookWindow).__readerr.healNoteNow(l), linkId),
    reconcileTagsNow: () =>
      page.evaluate(() => (window as unknown as HookWindow).__readerr.reconcileTagsNow()),
    reconcileTopicsNow: () =>
      page.evaluate(() => (window as unknown as HookWindow).__readerr.reconcileTopicsNow()),
    reconcileTagParentsNow: () =>
      page.evaluate(() => (window as unknown as HookWindow).__readerr.reconcileTagParentsNow()),
    setTagParentsNow: (childId: string, parentIds: string[]) =>
      page.evaluate(
        ([c, p]) =>
          (window as unknown as HookWindow).__readerr.setTagParentsNow(c as string, p as string[]),
        [childId, parentIds] as const
      ),
    ensureOpenWeekNow: () =>
      page.evaluate(() => (window as unknown as HookWindow).__readerr.ensureOpenWeekNow()),
    autoCloseStaleWeeksNow: () =>
      page.evaluate(() => (window as unknown as HookWindow).__readerr.autoCloseStaleWeeksNow()),
    closeWeekNow: (weekId: string) =>
      page.evaluate((w) => (window as unknown as HookWindow).__readerr.closeWeekNow(w), weekId),
    /** Real setEntryDone() — pass a stale snapshot to test §7.1 staleness. */
    setEntryDoneNow: (entry: unknown, done: boolean) =>
      page.evaluate(
        ([e, d]) => (window as unknown as HookWindow).__readerr.setEntryDoneNow(e, d as boolean),
        [entry, done] as const
      ),
    /** Real toggleFavourite() — pass a stale snapshot to test §7.1 staleness. */
    toggleFavouriteNow: (link: unknown) =>
      page.evaluate(
        (l) => (window as unknown as HookWindow).__readerr.toggleFavouriteNow(l),
        link
      ),
  };
}

/** A minimal valid link row for Tier-2 fixtures (id/updated_at stamped by repoPut). */
export function linkFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const n = Math.floor(Math.random() * 1e9);
  return {
    id: crypto.randomUUID(),
    updated_at: new Date().toISOString(),
    deleted_at: null,
    server_seq: null,
    url: `https://example.com/article-${n}`,
    title: `Article ${n}`,
    title_fetched: false,
    added_at: new Date().toISOString(),
    read_at: null,
    favourite: false,
    is_resource: false,
    slushed_at: null,
    priority: null,
    ...overrides,
  };
}
