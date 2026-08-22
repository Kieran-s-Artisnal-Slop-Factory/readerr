/**
 * A server older than the app must not silently erase the app's newest fields.
 *
 * Found against the real library during the v0.3.0 upgrade check: a v0.3.0
 * client pushed a series to a backend that predated `links.is_series`, the
 * server stored the row without the column it had never heard of, and the
 * write-back of that same row came home short — so the flag went `undefined`
 * on the device that created the series, and the series became an ordinary
 * link. Nothing errored; the data just quietly stopped being a series.
 *
 * The rule these pin down: a pulled row is MERGED over the local one. Every
 * key the server sends wins (explicit nulls included, or clearing a field
 * elsewhere would stop propagating); keys the server omits keep whatever the
 * client already had.
 */
import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDB } from '../src/lib/db/db';
import { STORES } from '../src/lib/db/types';
import { syncNow } from '../src/lib/sync';
import type { Link } from '../src/lib/db/types';

const NOW = '2026-08-22T12:00:00.000Z';
const LATER = '2026-08-22T13:00:00.000Z';

/**
 * A backend that only knows the columns it was built with — exactly what an
 * un-rebuilt server is. Anything else in a pushed row is dropped on the floor,
 * and the row it serves back is short by those columns.
 */
function makeOldServer(knownColumns: string[]) {
  const stored = new Map<string, Record<string, unknown>>();
  let seq = 0;
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

  const strip = (row: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const key of knownColumns) if (key in row) out[key] = row[key];
    return out;
  };

  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes('/sync/stats')) return json({ latestSeq: seq, epoch: 'old-server' });
    if (url.includes('/sync/push')) {
      const body = JSON.parse(String(init?.body)) as { rows: Record<string, Record<string, unknown>[]> };
      const accepted: { table: string; id: string; server_seq: number }[] = [];
      for (const [table, rows] of Object.entries(body.rows ?? {})) {
        // An old server iterates ITS OWN table list, so a table it doesn't
        // know is ignored rather than rejected.
        if (table !== 'links') continue;
        for (const row of rows) {
          seq++;
          const id = row.id as string;
          stored.set(id, { ...strip(row), server_seq: seq });
          accepted.push({ table, id, server_seq: seq });
        }
      }
      return json({ accepted, latestSeq: seq, epoch: 'old-server' });
    }
    if (url.includes('/sync/pull')) {
      const since = Number(new URL(url).searchParams.get('since') ?? 0);
      const rows = [...stored.values()].filter((r) => (r.server_seq as number) > since);
      return json({ rows: { links: rows }, latestSeq: seq, epoch: 'old-server' });
    }
    return new Response('not found', { status: 404 });
  };

  return { handler, stored };
}

/** Every links column a pre-series backend knew about. */
const PRE_SERIES_COLUMNS = [
  'id',
  'url',
  'title',
  'title_fetched',
  'added_at',
  'read_at',
  'favourite',
  'is_resource',
  'slushed_at',
  'priority',
  'updated_at',
  'deleted_at',
  'server_seq',
];

function seriesLink(over: Partial<Link> = {}): Link {
  return {
    id: 'series-1',
    updated_at: NOW,
    deleted_at: null,
    server_seq: null,
    url: 'series:series-1',
    title: 'Async Rust, from the ground up',
    title_fetched: true,
    added_at: NOW,
    read_at: null,
    favourite: false,
    is_resource: false,
    slushed_at: null,
    priority: null,
    is_series: true,
    ...over,
  } as Link;
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
  localStorage.setItem('readerr-sync-url', 'http://old.test');
  localStorage.setItem('readerr-sync-mode', 'sync');
});

beforeEach(async () => {
  const db = await getDB();
  const names = [...Object.keys(STORES), 'archived_links', 'sync_meta'];
  const tx = db.transaction(names, 'readwrite');
  for (const n of names) tx.objectStore(n).clear();
  await tx.done;
});

describe('syncing against a server that predates a column', () => {
  it('keeps is_series when the server hands the row back without it', async () => {
    const server = makeOldServer(PRE_SERIES_COLUMNS);
    vi.stubGlobal('fetch', server.handler);
    const db = await getDB();
    await db.put('links', seriesLink());

    const result = await syncNow();
    expect(result.ok, result.error).toBe(true);
    expect(result.pushed).toBe(1);

    // The server really did drop it — this is the situation, not a mock quirk.
    expect(server.stored.get('series-1')).not.toHaveProperty('is_series');

    // …and the client kept it anyway.
    const local = (await db.get('links', 'series-1')) as Link;
    expect(local.is_series).toBe(true);
    expect(local.server_seq).toBe(1); // the write-back still applied
  });

  it('still applies every field the server does send, nulls included', async () => {
    const server = makeOldServer(PRE_SERIES_COLUMNS);
    vi.stubGlobal('fetch', server.handler);
    const db = await getDB();
    await db.put('links', seriesLink({ read_at: NOW, favourite: true }));
    await syncNow();

    // Another device clears read_at and the title changes, at a newer time.
    const onServer = server.stored.get('series-1')!;
    server.stored.set('series-1', {
      ...onServer,
      read_at: null,
      title: 'Renamed elsewhere',
      updated_at: LATER,
      server_seq: 99,
    });
    await db.put('sync_meta', { key: 'lastPullSeq', value: 1 });

    const result = await syncNow();
    expect(result.ok, result.error).toBe(true);

    const local = (await db.get('links', 'series-1')) as Link;
    expect(local.title).toBe('Renamed elsewhere'); // sent → wins
    expect(local.read_at).toBeNull(); // explicit null → wins
    expect(local.favourite).toBe(true); // sent as true → unchanged
    expect(local.is_series).toBe(true); // never sent → survives
  });

  it('leaves a brand-new row from the server exactly as sent', async () => {
    const server = makeOldServer(PRE_SERIES_COLUMNS);
    vi.stubGlobal('fetch', server.handler);
    server.stored.set('remote-1', {
      id: 'remote-1',
      url: 'https://example.com/a',
      title: 'From another device',
      title_fetched: true,
      added_at: NOW,
      read_at: null,
      favourite: false,
      is_resource: false,
      slushed_at: null,
      priority: null,
      updated_at: NOW,
      deleted_at: null,
      server_seq: 5,
    });

    const result = await syncNow();
    expect(result.ok, result.error).toBe(true);
    const local = (await getDB()).get('links', 'remote-1');
    expect(await local).toMatchObject({ title: 'From another device' });
    // Nothing local to merge with, so nothing invented either.
    expect((await (await getDB()).get('links', 'remote-1')) as Link).not.toHaveProperty('is_series');
  });

  it('ignores tables the old server has never heard of, without failing the sync', async () => {
    const server = makeOldServer(PRE_SERIES_COLUMNS);
    vi.stubGlobal('fetch', server.handler);
    const db = await getDB();
    await db.put('links', seriesLink());
    await db.put('series_links', {
      id: 'edge-1',
      updated_at: NOW,
      deleted_at: null,
      server_seq: null,
      series_id: 'series-1',
      link_id: 'part-1',
      position: 1,
    });

    const result = await syncNow();
    // The sync succeeds; the edge simply stays local (server_seq null) until
    // the backend is rebuilt, and the next push sends it again.
    expect(result.ok, result.error).toBe(true);
    const edge = (await db.get('series_links', 'edge-1')) as { server_seq: number | null };
    expect(edge.server_seq).toBeNull();
  });
});
