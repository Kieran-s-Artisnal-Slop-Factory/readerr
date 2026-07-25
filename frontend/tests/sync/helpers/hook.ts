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
    captureNow(text: string): Promise<{ added: unknown[] }>;
    healSettingsNow(): Promise<SyncRow | null>;
    saveSettingsNow(changes: Record<string, unknown>): Promise<SyncRow>;
    reconcileOpenWeeksNow(): Promise<void>;
    reconcilePlansNow(): Promise<SyncRow[]>;
    healNoteNow(linkId: string): Promise<SyncRow | null>;
    reconcileTagsNow(): Promise<void>;
    reconcileTopicsNow(): Promise<void>;
    ensureOpenWeekNow(): Promise<SyncRow>;
    autoCloseStaleWeeksNow(): Promise<unknown>;
    closeWeekNow(weekId: string): Promise<unknown>;
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
    captureNow: (text: string) =>
      page.evaluate((t) => (window as unknown as HookWindow).__readerr.captureNow(t), text),
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
    ensureOpenWeekNow: () =>
      page.evaluate(() => (window as unknown as HookWindow).__readerr.ensureOpenWeekNow()),
    autoCloseStaleWeeksNow: () =>
      page.evaluate(() => (window as unknown as HookWindow).__readerr.autoCloseStaleWeeksNow()),
    closeWeekNow: (weekId: string) =>
      page.evaluate((w) => (window as unknown as HookWindow).__readerr.closeWeekNow(w), weekId),
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
