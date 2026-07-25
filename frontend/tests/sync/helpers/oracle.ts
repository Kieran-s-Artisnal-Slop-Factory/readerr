/**
 * The three-way oracle: every convergence assertion checks device A's raw
 * IndexedDB, device B's raw IndexedDB, AND the server — the server twice
 * (what /sync/pull SERVES and what sqlite STORES, cross-checked), because a
 * server that mangles a field and then serves the mangled value back makes
 * A and B "agree" on corrupted data. Checking A↔B alone can never see that.
 *
 * Plus the whole-DB isolation diff: after a case mutates one thing, the
 * total delta across every store on a device must be EXACTLY the intended
 * change. Collateral damage (a reconciler restamping rows, a pull clobbering
 * an unrelated field) is where real data loss hides.
 */
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { BackendHandle } from './backend';
import type { Device } from './devices';
import { hook, type SyncRow } from './hook';
import { diffStore, formatDiffs, type RowDiff } from './compare';
import { normalizeStoredRow, TABLES } from './meta';

export type DbState = Record<string, SyncRow[]>;

export class ConvergenceError extends Error {}

export interface ThreeWaySnapshot {
  a: DbState;
  b: DbState;
  /** rows as /sync/pull serves them (since=0), keyed by store */
  served: Record<string, Record<string, unknown>[]>;
  /** raw sqlite rows normalized to wire shape via the harness's OWN metadata */
  stored: Record<string, Record<string, unknown>[]>;
  latestSeq: number;
}

export async function snapshotThreeWay(
  backend: BackendHandle,
  deviceA: Device,
  deviceB: Device
): Promise<ThreeWaySnapshot> {
  const [a, b, servedRes, storedRaw] = await Promise.all([
    hook(deviceA).rawDumpAll(),
    hook(deviceB).rawDumpAll(),
    backend.pullAll(),
    backend.dumpSqlite(),
  ]);
  const stored: Record<string, Record<string, unknown>[]> = {};
  for (const store of Object.keys(TABLES)) {
    stored[store] = (storedRaw[store] ?? []).map((r) => normalizeStoredRow(store, r));
  }
  const served: Record<string, Record<string, unknown>[]> = {};
  for (const store of Object.keys(TABLES)) {
    served[store] = (servedRes.rows[store] ?? []) as Record<string, unknown>[];
  }
  return { a, b, served, stored, latestSeq: servedRes.latestSeq };
}

/**
 * Assert all four legs agree on every store, tombstones and server_seq
 * included. Throws ConvergenceError naming the leg and the per-field diffs.
 */
export function assertThreeWayConverged(
  snap: ThreeWaySnapshot,
  opts: { stores?: string[] } = {}
): void {
  const stores = opts.stores ?? Object.keys(TABLES);
  const legs: [string, (s: string) => Record<string, unknown>[], (s: string) => Record<string, unknown>[]][] = [
    ['A ↔ server(served)', (s) => snap.a[s] ?? [], (s) => snap.served[s] ?? []],
    ['server(served) ↔ server(stored)', (s) => snap.served[s] ?? [], (s) => snap.stored[s] ?? []],
    ['A ↔ B', (s) => snap.a[s] ?? [], (s) => snap.b[s] ?? []],
    ['B ↔ server(served)', (s) => snap.b[s] ?? [], (s) => snap.served[s] ?? []],
  ];
  for (const [label, left, right] of legs) {
    const failures = new Map<string, RowDiff[]>();
    for (const store of stores) {
      const diffs = diffStore(left(store), right(store));
      if (diffs.length) failures.set(store, diffs);
    }
    if (failures.size) {
      throw new ConvergenceError(`converged state check failed on leg ${label}\n${formatDiffs(label, failures)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Whole-DB isolation diff
// ---------------------------------------------------------------------------

export interface DeltaEntry {
  store: string;
  id: string;
  kind: 'added' | 'removed' | 'changed';
  changedFields: string[];
}

export async function dbSnapshot(device: Device): Promise<DbState> {
  return hook(device).rawDumpAll();
}

export function dbDelta(before: DbState, after: DbState): DeltaEntry[] {
  const out: DeltaEntry[] = [];
  const stores = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const store of stores) {
    const b = new Map((before[store] ?? []).map((r) => [r.id, r]));
    const a = new Map((after[store] ?? []).map((r) => [r.id, r]));
    for (const [id, row] of a) {
      const prev = b.get(id);
      if (!prev) {
        out.push({ store, id, kind: 'added', changedFields: [] });
      } else {
        const keys = new Set([...Object.keys(prev), ...Object.keys(row)]);
        const changed = [...keys].filter((k) => !Object.is(normalize(prev[k]), normalize(row[k])) && JSON.stringify(prev[k]) !== JSON.stringify(row[k]));
        if (changed.length) out.push({ store, id, kind: 'changed', changedFields: changed.sort() });
      }
    }
    for (const id of b.keys()) {
      if (!a.has(id)) out.push({ store, id, kind: 'removed', changedFields: [] });
    }
  }
  return out.sort((x, y) => x.store.localeCompare(y.store) || String(x.id).localeCompare(String(y.id)));
}

function normalize(v: unknown): unknown {
  return v === undefined ? '__undefined__' : v;
}

export interface AllowedChange {
  store: string;
  /** exact id, or '*' when the id is minted by the action under test */
  id: string;
  kind: 'added' | 'removed' | 'changed';
  /** for 'changed': the ONLY fields allowed to differ (updated_at/server_seq implied) */
  fields?: string[];
}

/**
 * Assert the device's entire delta is exactly the allowed list — no
 * unrelated row touched, no extra field changed. updated_at and server_seq
 * ride along with any allowed change (they are how sync works), but never
 * justify a change on a row that isn't in the allow-list at all.
 */
export function assertIsolatedDelta(delta: DeltaEntry[], allowed: AllowedChange[], label = ''): void {
  const problems: string[] = [];
  const matched = new Set<AllowedChange>();
  for (const entry of delta) {
    const rule = allowed.find(
      (r) =>
        r.store === entry.store &&
        (r.id === '*' || r.id === entry.id) &&
        r.kind === entry.kind &&
        !matched.has(r)
    );
    if (!rule) {
      problems.push(
        `unexpected ${entry.kind} on ${entry.store}/${entry.id}` +
          (entry.changedFields.length ? ` (fields: ${entry.changedFields.join(', ')})` : '')
      );
      continue;
    }
    if (rule.id !== '*') matched.add(rule);
    if (entry.kind === 'changed' && rule.fields) {
      const allowedFields = new Set([...rule.fields, 'updated_at', 'server_seq']);
      const extra = entry.changedFields.filter((f) => !allowedFields.has(f));
      if (extra.length) {
        problems.push(`${entry.store}/${entry.id}: unexpected field changes: ${extra.join(', ')}`);
      }
    }
  }
  for (const rule of allowed) {
    const hit = delta.some(
      (e) => e.store === rule.store && (rule.id === '*' || e.id === rule.id) && e.kind === rule.kind
    );
    if (!hit) problems.push(`expected ${rule.kind} on ${rule.store}/${rule.id} did not happen`);
  }
  expect(problems, `isolation diff ${label}`).toEqual([]);
}

// ---------------------------------------------------------------------------
// Wire capture
// ---------------------------------------------------------------------------

export interface WireRecord {
  kind: 'push' | 'pull';
  url: string;
  requestBody: unknown;
  responseBody: unknown;
  status: number;
}

/** Record every /sync/push and /sync/pull for a page. Call before syncing. */
export async function captureWire(page: Page): Promise<{ records: WireRecord[]; stop: () => Promise<void> }> {
  const records: WireRecord[] = [];
  const handler = async (route: import('@playwright/test').Route) => {
    const req = route.request();
    const url = req.url();
    const kind: 'push' | 'pull' = url.includes('/sync/push') ? 'push' : 'pull';
    const requestBody = kind === 'push' ? safeJson(req.postData()) : null;
    const response = await route.fetch();
    const text = await response.text();
    records.push({
      kind,
      url,
      requestBody,
      responseBody: safeJson(text),
      status: response.status(),
    });
    await route.fulfill({ response, body: text });
  };
  await page.route('**/sync/push', handler);
  await page.route('**/sync/pull*', handler);
  return {
    records,
    stop: async () => {
      await page.unroute('**/sync/push', handler);
      await page.unroute('**/sync/pull*', handler);
    },
  };
}

function safeJson(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
