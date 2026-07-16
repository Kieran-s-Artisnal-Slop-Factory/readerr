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
import { recordSyncEvent } from './services/syncLog';

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

/**
 * Human-readable message for the status codes worth explaining; anything
 * else falls back to the raw status number + reason phrase.
 */
export function describeStatus(status: number, statusText: string): string {
  switch (status) {
    case 400:
      return "The server rejected the request as invalid (400). This usually means the app and server versions don't match — update both to the same version.";
    case 403:
      return 'The server refused access (403). Check that this URL is the readerr sync server and that any proxy or firewall in front of it allows you through.';
    case 404:
      return "No sync server was found at that URL (404). Double-check the address and port — a plain web server or wrong path returns this. It should point at readerr's backend root.";
    case 502:
      return "The server is unreachable through its proxy (502 Bad Gateway). The readerr backend is probably down or restarting behind the reverse proxy — try again shortly.";
    case 503:
      return 'The server is temporarily unavailable (503). It may be starting up, overloaded, or in maintenance — try again in a moment.';
    default: {
      const reason = statusText || 'error';
      if (status >= 500) {
        return `The server returned an error (${status} ${reason}). Contact whoever runs it with these details.`;
      }
      return `The server returned ${status} ${reason}. Check the sync server URL in Settings.`;
    }
  }
}

/** Map an HTTP failure to a user-facing message; full details go to the console. */
async function describeHttpError(phase: string, res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  console.error(
    `[readerr sync] ${phase} failed: ${res.status} ${res.statusText || 'error'}`,
    body || '(no response body)'
  );
  return describeStatus(res.status, res.statusText);
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

/**
 * Has the server ever accepted data? (GET /sync/stats; latestSeq > 0.)
 * null = the probe failed (old backend without the endpoint, or unreachable).
 */
export async function serverHasData(url = getSyncUrl()): Promise<boolean | null> {
  try {
    const res = await fetch(`${url.trim().replace(/\/+$/, '')}/sync/stats`);
    if (!res.ok) return null;
    const json = (await res.json()) as { latestSeq?: number };
    return (json.latestSeq ?? 0) > 0;
  } catch {
    return null;
  }
}

/** Wipe everything on the server (POST /sync/reset). Throws on failure. */
export async function resetServer(url = getSyncUrl()): Promise<void> {
  const base = url.trim().replace(/\/+$/, '');
  let res: Response;
  try {
    res = await fetch(`${base}/sync/reset`, { method: 'POST' });
  } catch (err) {
    throw new Error(describeNetworkError('server reset', err));
  }
  if (!res.ok) throw new Error(await describeHttpError('server reset', res));
}

/**
 * Forget everything this device knows about its previous sync server: null
 * every row's server_seq (they were assigned by the OLD server's counter)
 * and drop the push/pull cursors, so the next sync pushes the full local
 * dataset and pulls the new server from zero. updated_at is untouched —
 * this is bookkeeping, not an edit.
 */
export async function resetLocalSyncState(): Promise<void> {
  const db = await getDB();
  for (const store of Object.keys(STORES)) {
    const tx = db.transaction(store, 'readwrite');
    let cursor = await tx.store.openCursor();
    while (cursor) {
      const row = cursor.value as SyncFields;
      if (row.server_seq != null) {
        row.server_seq = null;
        void cursor.update(row);
      }
      cursor = await cursor.continue();
    }
    await tx.done;
  }
  await db.delete('sync_meta', 'lastPushAt');
  await db.delete('sync_meta', 'lastPullSeq');
}

/** Any real local content? (The settings row alone doesn't count.) */
export async function localHasData(): Promise<boolean> {
  const db = await getDB();
  for (const store of ['links', 'tags', 'topics', 'notes', 'weeks']) {
    if ((await db.count(store)) > 0) return true;
  }
  return false;
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

/** Rows per push request — LWW makes multi-request pushes safe (§scaling). */
const PUSH_CHUNK = 2000;
/** Rows per pull page; the client loops until a short page arrives. */
const PULL_LIMIT = 5000;

export async function syncNow(): Promise<SyncResult> {
  try {
    const db = await getDB();
    const base = getSyncUrl();

    // ---- push (dirty rows via the per-store updated_at index, so the scan
    // cost tracks changes since the last push, not history — scaling.md §4)
    const lastPushAt = (await getMeta<string>('lastPushAt')) ?? '';
    const range = lastPushAt ? IDBKeyRange.lowerBound(lastPushAt, true) : undefined;
    const dirty: { store: string; row: SyncFields }[] = [];
    let maxPushedUpdatedAt = lastPushAt;
    // STORES order puts parents before children, and chunk boundaries keep
    // that order, so a child never lands in an earlier request than its parent.
    for (const store of Object.keys(STORES)) {
      const rows = (await db.getAllFromIndex(store, 'updated_at', range)) as SyncFields[];
      for (const row of rows) {
        dirty.push({ store, row });
        if (row.updated_at > maxPushedUpdatedAt) maxPushedUpdatedAt = row.updated_at;
      }
    }

    // Send in bounded batches. Accepted seqs are written back per batch (those
    // rows really are on the server); lastPushAt only advances once every
    // batch has landed, so a mid-push failure just re-sends the remainder —
    // idempotent under LWW.
    let accepted = 0;
    for (let offset = 0; offset === 0 || offset < dirty.length; offset += PUSH_CHUNK) {
      const batch = dirty.slice(offset, offset + PUSH_CHUNK);
      const rows: Record<string, SyncFields[]> = {};
      for (const { store, row } of batch) (rows[store] ??= []).push(row);

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
      accepted += pushJson.accepted.length;
    }
    await setMeta('lastPushAt', maxPushedUpdatedAt);

    // ---- pull, one bounded page at a time; the cursor advances per page so
    // an interrupted first sync resumes where it stopped.
    let pulled = 0;
    for (;;) {
      const since = (await getMeta<number>('lastPullSeq')) ?? 0;
      let pullRes: Response;
      try {
        pullRes = await fetch(`${base}/sync/pull?since=${since}&limit=${PULL_LIMIT}`);
      } catch (err) {
        throw new Error(describeNetworkError('pull', err));
      }
      if (!pullRes.ok) throw new Error(await describeHttpError('pull', pullRes));
      const pullJson = (await pullRes.json()) as {
        rows: Record<string, SyncFields[]>;
        latestSeq: number;
      };

      let received = 0;
      for (const [store, incoming] of Object.entries(pullJson.rows ?? {})) {
        if (!(store in STORES)) continue;
        for (const row of incoming) {
          received++;
          const local = (await db.get(store, row.id)) as SyncFields | undefined;
          // LWW: apply unless we hold something strictly newer (which the next
          // push will send).
          if (!local || row.updated_at >= local.updated_at) {
            await db.put(store, row);
            pulled++;
          }
        }
      }
      const latest = pullJson.latestSeq ?? since;
      await setMeta('lastPullSeq', latest);
      // A short page means we're caught up; a stuck cursor means an old
      // backend that ignores limit and returned everything at once.
      if (received < PULL_LIMIT || latest <= since) break;
    }
    await setMeta('lastSyncAt', new Date().toISOString());
    await setMeta('lastError', null);
    const result = { ok: true, pushed: accepted, pulled };
    void recordSyncEvent(result);
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
    void recordSyncEvent({
      ...result,
      error: message,
      // Offline failures are implicit — the 'explicit' tracking mode skips them.
      offline: typeof navigator !== 'undefined' && !navigator.onLine,
    });
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
