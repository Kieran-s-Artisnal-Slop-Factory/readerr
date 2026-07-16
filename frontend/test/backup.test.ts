/**
 * Backup round-trip tests (next-tasks #3.1): for a selection of backup
 * fixtures — a trimmed real v5 export, a kitchen-sink v7 export exercising
 * every store, and a minimal early-schema export — ensure each
 *
 *   1. imports in the frontend (full replace),
 *   2. then syncs completely to the backend (an in-memory fake that mirrors
 *      sync.go's LWW + seq assignment + pull limit semantics), and
 *   3. lands the same number of links, tags, topics, favourites, resources,
 *      plans, and settings on both sides.
 *
 * This also pins the import↔sync interplay: imported rows keep historical
 * updated_at (and may carry a source device's server_seq), so they only
 * push because importData drops the push cursor.
 */
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { importData, type ExportEnvelope } from '../src/lib/db/export';
import { getDB } from '../src/lib/db/db';
import { STORES } from '../src/lib/db/types';
import { syncNow } from '../src/lib/sync';
import type { Link, Plan, UserSettings } from '../src/lib/db/types';

const FIXTURES = [
  'readerr-backup-example.json',
  'backup-kitchen-sink.json',
  'backup-minimal.json',
];

const load = (name: string): ExportEnvelope =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

/** In-memory stand-in for the Go backend: LWW push, seq counter, paged pull. */
function makeFakeServer() {
  const tables = new Map<string, Map<string, Record<string, unknown>>>();
  let seq = 0;

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes('/sync/push')) {
      const body = JSON.parse(String(init?.body)) as { rows: Record<string, SyncRow[]> };
      const accepted: { table: string; id: string; server_seq: number }[] = [];
      for (const [table, rows] of Object.entries(body.rows ?? {})) {
        const t = tables.get(table) ?? new Map();
        tables.set(table, t);
        for (const row of rows) {
          const existing = t.get(row.id);
          // LWW: only strictly newer rows replace existing ones.
          if (existing && row.updated_at <= (existing.updated_at as string)) continue;
          seq++;
          t.set(row.id, { ...row, server_seq: seq });
          accepted.push({ table, id: row.id, server_seq: seq });
        }
      }
      return json({ accepted, latestSeq: seq });
    }
    if (url.includes('/sync/pull')) {
      const u = new URL(url);
      const since = Number(u.searchParams.get('since') ?? 0);
      const limit = Number(u.searchParams.get('limit') ?? 0);
      let entries: { table: string; row: Record<string, unknown> }[] = [];
      for (const [table, t] of tables) {
        for (const row of t.values()) {
          if ((row.server_seq as number) > since) entries.push({ table, row });
        }
      }
      entries.sort((a, b) => (a.row.server_seq as number) - (b.row.server_seq as number));
      if (limit > 0) entries = entries.slice(0, limit);
      const rows: Record<string, unknown[]> = {};
      let latest = since;
      for (const e of entries) {
        (rows[e.table] ??= []).push(e.row);
        latest = Math.max(latest, e.row.server_seq as number);
      }
      return json({ rows, latestSeq: latest });
    }
    return new Response('not found', { status: 404 });
  };

  return {
    handler,
    count: (table: string) => tables.get(table)?.size ?? 0,
    rows: <T>(table: string) => [...(tables.get(table)?.values() ?? [])] as T[],
  };
}

interface SyncRow {
  id: string;
  updated_at: string;
  [key: string]: unknown;
}

beforeAll(() => {
  // sync.ts touches localStorage (URL/mode, sync-log counters) and window
  // (the sync CustomEvent) — neither exists in Node.
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

for (const name of FIXTURES) {
  describe(`backup fixture ${name}`, () => {
    it('imports, matches counts locally, and syncs everything to the backend', async () => {
      const fixture = load(name);
      const fx = (store: string) => fixture.data[store] ?? [];
      const server = makeFakeServer();
      vi.stubGlobal('fetch', server.handler);

      const db = await getDB();
      await db.delete('sync_meta', 'lastPullSeq'); // isolate fixtures from each other

      // 1. The backup imports as a full replace.
      const result = await importData(fixture);
      expect(result.mode).toBe('replaced');

      // 3a. Frontend counts match the fixture exactly.
      for (const store of ['links', 'tags', 'topics', 'plans', 'user_settings']) {
        expect(await db.count(store), `IDB count of ${store}`).toBe(fx(store).length);
      }
      const links = (await db.getAll('links')) as Link[];
      const fxLinks = fx('links') as Link[];
      expect(links.filter((l) => l.favourite).length).toBe(fxLinks.filter((l) => l.favourite).length);
      expect(links.filter((l) => l.is_resource).length).toBe(fxLinks.filter((l) => l.is_resource).length);

      // 2. Everything the fixture holds pushes to the backend — including
      //    rows that carry a source device's server_seq and old updated_at.
      const sync = await syncNow();
      expect(sync.ok).toBe(true);
      const expectedPush = Object.keys(STORES).reduce((n, s) => n + fx(s).length, 0);
      expect(sync.pushed, 'rows accepted by the backend').toBe(expectedPush);

      // 3b. Backend counts and flags match the fixture.
      for (const store of ['links', 'tags', 'topics', 'plans', 'user_settings']) {
        expect(server.count(store), `server count of ${store}`).toBe(fx(store).length);
      }
      const sLinks = server.rows<Link>('links');
      expect(sLinks.filter((l) => l.favourite).length).toBe(fxLinks.filter((l) => l.favourite).length);
      expect(sLinks.filter((l) => l.is_resource).length).toBe(fxLinks.filter((l) => l.is_resource).length);

      // 3c. Settings and plans land intact, not just in count.
      const fxSettings = (fx('user_settings') as UserSettings[])[0];
      if (fxSettings) {
        const sSettings = server.rows<UserSettings>('user_settings')[0];
        expect(sSettings.id).toBe(fxSettings.id);
        expect(sSettings.articles_per_week).toBe(fxSettings.articles_per_week);
      }
      const fxPlans = fx('plans') as Plan[];
      const sPlans = server.rows<Plan>('plans');
      expect(sPlans.map((p) => p.starts_on).sort()).toEqual(fxPlans.map((p) => p.starts_on).sort());
    });
  });
}
