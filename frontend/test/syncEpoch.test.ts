/**
 * Sync-epoch guard (client half of the counter-restart fix). The pull cursor
 * is only meaningful within one lifetime of the server's seq counter; after a
 * /sync/reset (or a swapped server database) a row re-accepted at a low seq
 * sits below every old cursor and is invisible forever — in production this
 * left the current week's row stranded at seq 2 while entries pointed at it,
 * blanking the reading list on other devices. When the epoch the server
 * reports differs from the one we stored, the client must drop its local sync
 * bookkeeping and resync from zero; when it matches, cursors must be left
 * alone.
 */
import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDB } from '../src/lib/db/db';
import { STORES } from '../src/lib/db/types';
import { syncNow } from '../src/lib/sync';
import type { Week } from '../src/lib/db/types';

interface SeedRow {
  id: string;
  updated_at: string;
  [key: string]: unknown;
}
interface SyncRow extends SeedRow {
  server_seq: number | null;
}

/** Fake backend mirroring sync.go: LWW push, seq counter, stats with epoch. */
function makeFakeServer(epoch: string) {
  const tables = new Map<string, Map<string, SyncRow>>();
  let seq = 0;

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes('/sync/stats')) {
      return json({ latestSeq: seq, epoch: server.epoch });
    }
    if (url.includes('/sync/push')) {
      const body = JSON.parse(String(init?.body)) as { rows: Record<string, SyncRow[]> };
      const accepted: { table: string; id: string; server_seq: number }[] = [];
      for (const [table, rows] of Object.entries(body.rows ?? {})) {
        const t = tables.get(table) ?? new Map<string, SyncRow>();
        tables.set(table, t);
        for (const row of rows) {
          const existing = t.get(row.id);
          if (existing && row.updated_at <= existing.updated_at) continue;
          seq++;
          t.set(row.id, { ...row, server_seq: seq });
          accepted.push({ table, id: row.id, server_seq: seq });
        }
      }
      return json({ accepted, latestSeq: seq, epoch: server.epoch });
    }
    if (url.includes('/sync/pull')) {
      const since = Number(new URL(url).searchParams.get('since') ?? 0);
      let entries: { table: string; row: SyncRow }[] = [];
      for (const [table, t] of tables) {
        for (const row of t.values()) {
          if ((row.server_seq as number) > since) entries.push({ table, row });
        }
      }
      entries.sort((a, b) => (a.row.server_seq as number) - (b.row.server_seq as number));
      const rows: Record<string, SyncRow[]> = {};
      let latest = since;
      for (const e of entries) {
        (rows[e.table] ??= []).push(e.row);
        latest = Math.max(latest, e.row.server_seq as number);
      }
      return json({ rows, latestSeq: latest, epoch: server.epoch });
    }
    return new Response('not found', { status: 404 });
  };

  const server = {
    epoch,
    handler,
    /** Place a row on the server directly, at a chosen seq. */
    seed(table: string, row: SeedRow, atSeq: number) {
      const t = tables.get(table) ?? new Map<string, SyncRow>();
      tables.set(table, t);
      t.set(row.id, { ...row, server_seq: atSeq });
      seq = Math.max(seq, atSeq);
    },
    bumpSeq(to: number) {
      seq = Math.max(seq, to);
    },
  };
  return server;
}

const weekRow = (id: string, weekStart: string): SeedRow => ({
  id,
  week_start: weekStart,
  closed_at: null,
  updated_at: '2026-07-01T00:00:00.000Z',
  deleted_at: null,
});

async function setMeta(key: string, value: unknown) {
  await (await getDB()).put('sync_meta', { key, value });
}
async function getMeta<T>(key: string): Promise<T | undefined> {
  const row = (await (await getDB()).get('sync_meta', key)) as { value: T } | undefined;
  return row?.value;
}

beforeAll(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, String(v)),
    removeItem: (k: string) => void storage.delete(k),
    clear: () => storage.clear(),
  });
  vi.stubGlobal('window', { dispatchEvent: () => {} });
  localStorage.setItem('readerr-sync-url', 'http://fake.test');
  localStorage.setItem('readerr-sync-mode', 'sync');
});

beforeEach(async () => {
  const db = await getDB();
  const names = [...Object.keys(STORES), 'sync_meta'];
  const tx = db.transaction(names, 'readwrite');
  for (const n of names) tx.objectStore(n).clear();
  await tx.done;
});

describe('server epoch guard', () => {
  it('resyncs from zero when the epoch changed, recovering rows below the old cursor', async () => {
    const db = await getDB();
    // This device thinks it synced long ago against the OLD counter.
    const local: Week = {
      ...(weekRow('local-week', '2026-07-13') as unknown as Week),
      server_seq: 900,
    };
    await db.put('weeks', local);
    await setMeta('serverEpoch', 'epoch-old');
    await setMeta('lastPullSeq', 1000);
    await setMeta('lastPushAt', '2026-07-02T00:00:00.000Z');

    // The restarted server holds a week accepted at seq 2 — far below the
    // device's stale cursor — plus a counter already past it.
    const server = makeFakeServer('epoch-new');
    server.seed('weeks', weekRow('missing-week', '2026-07-20'), 2);
    server.bumpSeq(50);
    vi.stubGlobal('fetch', server.handler);

    const result = await syncNow();
    expect(result.ok).toBe(true);

    // The invisible row is finally pulled…
    const pulled = (await db.get('weeks', 'missing-week')) as Week | undefined;
    expect(pulled).toBeDefined();
    expect(pulled!.week_start).toBe('2026-07-20');

    // …the full local dataset re-pushed (its old seq belonged to the dead
    // counter), and the new epoch remembered.
    expect(result.pushed).toBeGreaterThanOrEqual(1);
    expect(await getMeta<string>('serverEpoch')).toBe('epoch-new');
  });

  it('leaves cursors alone when the epoch is unchanged', async () => {
    const db = await getDB();
    await setMeta('serverEpoch', 'epoch-same');
    await setMeta('lastPullSeq', 1000);
    await setMeta('lastPushAt', '2026-07-02T00:00:00.000Z');

    const server = makeFakeServer('epoch-same');
    server.seed('weeks', weekRow('below-cursor', '2026-07-20'), 2);
    server.bumpSeq(1000);
    vi.stubGlobal('fetch', server.handler);

    const result = await syncNow();
    expect(result.ok).toBe(true);

    // Same counter lifetime: the cursor stands, so a row below it is (by
    // design) not re-fetched and nothing is spuriously re-pushed.
    expect(await db.get('weeks', 'below-cursor')).toBeUndefined();
    expect(result.pushed).toBe(0);
    expect((await getMeta<number>('lastPullSeq'))! >= 1000).toBe(true);
  });

  it('adopts the epoch on first contact without resetting anything', async () => {
    const server = makeFakeServer('epoch-first');
    vi.stubGlobal('fetch', server.handler);

    const result = await syncNow();
    expect(result.ok).toBe(true);
    expect(await getMeta<string>('serverEpoch')).toBe('epoch-first');
  });
});
