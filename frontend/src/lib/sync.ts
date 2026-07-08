/**
 * Client sync loop.
 *
 * Push: send rows never accepted by the server (server_seq == null) or
 * modified since the last push (updated_at > lastPushAt); the server applies
 * last-write-wins and returns assigned server_seq values, which are written
 * back without touching updated_at.
 *
 * Pull: request rows with server_seq above our stored high-water mark and
 * apply them under LWW (tombstones simply overwrite — reads filter them).
 *
 * The server base URL defaults to same-origin (the Go backend serves the
 * built frontend in production) and can be overridden in Settings for a
 * separately-hosted frontend or development.
 */
import { getDB } from './db/db';
import { STORES } from './db/types';
import type { SyncFields } from './db/types';

const SYNC_URL_KEY = 'readerr-sync-url';
const AUTO_SYNC_AT_KEY = 'readerr-last-auto-sync';
const SESSION_SYNC_KEY = 'readerr-session-synced';
const AUTO_SYNC_INTERVAL_MS = 15 * 60 * 1000;

/** Fired on window whenever a sync attempt finishes (detail: SyncResult). */
export const SYNC_EVENT = 'readerr-sync';

export interface SyncResult {
  ok: boolean;
  pushed: number;
  pulled: number;
  error?: string;
}

export function getSyncUrl(): string {
  return localStorage.getItem(SYNC_URL_KEY) ?? '';
}

const SYNC_MODE_KEY = 'readerr-sync-mode';

/**
 * 'offline' disables background sync entirely (chosen in onboarding).
 * Absent/anything else means 'sync' — an empty URL then syncs same-origin,
 * which is the correct default when the Go backend serves the frontend.
 */
export function getSyncMode(): 'offline' | 'sync' {
  return localStorage.getItem(SYNC_MODE_KEY) === 'offline' ? 'offline' : 'sync';
}

export function setSyncMode(mode: 'offline' | 'sync'): void {
  localStorage.setItem(SYNC_MODE_KEY, mode);
}

export function setSyncUrl(url: string): void {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (trimmed) localStorage.setItem(SYNC_URL_KEY, trimmed);
  else localStorage.removeItem(SYNC_URL_KEY);
}

/** Map an HTTP failure to a user-facing message; full details go to the console. */
async function describeHttpError(phase: string, res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  const detail = `${res.status} ${res.statusText || 'error'}`;
  console.error(`[readerr sync] ${phase} failed: ${detail}`, body || '(no response body)');
  if (res.status >= 500) {
    return `Server experiencing errors, please contact your administrator with the following details: ${detail}`;
  }
  return `Cannot reach the sync server — check the server URL in Settings (${detail})`;
}

function describeNetworkError(phase: string, err: unknown): string {
  console.error(`[readerr sync] ${phase} failed:`, err);
  return 'Cannot reach the sync server — check the server URL and that the server is running.';
}

/** Probe a server URL ( /healthz ) with the same error mapping as sync. */
export async function testConnection(url: string): Promise<{ ok: boolean; message: string }> {
  const base = url.trim().replace(/\/+$/, '');
  let res: Response;
  try {
    res = await fetch(`${base}/healthz`);
  } catch (err) {
    return { ok: false, message: describeNetworkError('connection test', err) };
  }
  if (!res.ok) return { ok: false, message: await describeHttpError('connection test', res) };
  return { ok: true, message: 'Connected to sync server successfully.' };
}

async function getMeta<T>(key: string): Promise<T | undefined> {
  const row = (await (await getDB()).get('sync_meta', key)) as { value: T } | undefined;
  return row?.value;
}

async function setMeta(key: string, value: unknown): Promise<void> {
  await (await getDB()).put('sync_meta', { key, value });
}

export interface SyncStatus {
  lastSyncAt: string | null;
  lastError: string | null;
}

export async function getSyncStatus(): Promise<SyncStatus> {
  return {
    lastSyncAt: (await getMeta<string>('lastSyncAt')) ?? null,
    lastError: (await getMeta<string | null>('lastError')) ?? null,
  };
}

export async function syncNow(): Promise<SyncResult> {
  try {
    const db = await getDB();
    const base = getSyncUrl();

    // ---- push
    const lastPushAt = (await getMeta<string>('lastPushAt')) ?? '';
    const rows: Record<string, SyncFields[]> = {};
    let pushed = 0;
    let maxPushedUpdatedAt = lastPushAt;
    for (const store of Object.keys(STORES)) {
      const all = (await db.getAll(store)) as SyncFields[];
      const dirty = all.filter((r) => r.server_seq == null || r.updated_at > lastPushAt);
      if (dirty.length > 0) {
        rows[store] = dirty;
        pushed += dirty.length;
        for (const r of dirty) {
          if (r.updated_at > maxPushedUpdatedAt) maxPushedUpdatedAt = r.updated_at;
        }
      }
    }

    let pushRes: Response;
    try {
      pushRes = await fetch(`${base}/sync/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows }),
      });
    } catch (err) {
      throw new Error(describeNetworkError('push', err));
    }
    if (!pushRes.ok) throw new Error(await describeHttpError('push', pushRes));
    const pushJson = (await pushRes.json()) as {
      accepted: { table: string; id: string; server_seq: number }[];
    };

    // Record assigned seqs without touching updated_at (not a user edit).
    for (const acc of pushJson.accepted) {
      const row = (await db.get(acc.table, acc.id)) as SyncFields | undefined;
      if (row) {
        row.server_seq = acc.server_seq;
        await db.put(acc.table, row);
      }
    }
    await setMeta('lastPushAt', maxPushedUpdatedAt);

    // ---- pull
    const since = (await getMeta<number>('lastPullSeq')) ?? 0;
    let pullRes: Response;
    try {
      pullRes = await fetch(`${base}/sync/pull?since=${since}`);
    } catch (err) {
      throw new Error(describeNetworkError('pull', err));
    }
    if (!pullRes.ok) throw new Error(await describeHttpError('pull', pullRes));
    const pullJson = (await pullRes.json()) as {
      rows: Record<string, SyncFields[]>;
      latestSeq: number;
    };

    let pulled = 0;
    for (const [store, incoming] of Object.entries(pullJson.rows ?? {})) {
      if (!(store in STORES)) continue;
      for (const row of incoming) {
        const local = (await db.get(store, row.id)) as SyncFields | undefined;
        // LWW: apply unless we hold something strictly newer (which the next
        // push will send).
        if (!local || row.updated_at >= local.updated_at) {
          await db.put(store, row);
          pulled++;
        }
      }
    }
    await setMeta('lastPullSeq', pullJson.latestSeq ?? since);
    await setMeta('lastSyncAt', new Date().toISOString());
    await setMeta('lastError', null);
    const result = { ok: true, pushed: pushJson.accepted.length, pulled };
    window.dispatchEvent(new CustomEvent(SYNC_EVENT, { detail: result }));
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await setMeta('lastError', message);
    } catch {
      // storage unavailable — nothing else to do
    }
    const result = { ok: false, pushed: 0, pulled: 0, error: message };
    window.dispatchEvent(new CustomEvent(SYNC_EVENT, { detail: result }));
    return result;
  }
}

/**
 * Background sync, safe to call on every page load: always runs once when
 * the app is opened (per browser session), then at most every 15 minutes as
 * the user navigates.
 */
export function maybeAutoSync(): void {
  if (typeof navigator === 'undefined' || !navigator.onLine) return;
  if (getSyncMode() === 'offline') return;
  const syncedThisSession = sessionStorage.getItem(SESSION_SYNC_KEY) === '1';
  const last = Number(localStorage.getItem(AUTO_SYNC_AT_KEY) ?? 0);
  if (syncedThisSession && Date.now() - last < AUTO_SYNC_INTERVAL_MS) return;
  sessionStorage.setItem(SESSION_SYNC_KEY, '1');
  localStorage.setItem(AUTO_SYNC_AT_KEY, String(Date.now()));
  void syncNow();
}
