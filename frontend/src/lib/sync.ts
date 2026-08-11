/**
 * Client sync loop.
 *
 * Push: send rows modified since the last push (each store's updated_at
 * index, above the lastPushAt watermark), plus two by-id rescues for rows
 * that sit below it: fold-reset rows queued in pendingRepush, and archived
 * links the server has never seen. The server applies last-write-wins and
 * returns assigned server_seq values, which are written back without
 * touching updated_at.
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
import { isTestMode } from './testMode';

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
  // No configured URL means same-origin. The base the app was built with is
  // the correct same-origin prefix: '' at the root (the Go backend serving its
  // own frontend), '/readerr' on GitHub Pages, '/alice/readerr' behind muxerr,
  // whose sentinel base is rewritten per user at serve time. BASE_URL always
  // ends in '/', which the leading-slash paths at every call site supply.
  return localStorage.getItem(SYNC_URL_KEY) ?? import.meta.env.BASE_URL.replace(/\/+$/, '');
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
function describeStatus(status: number, statusText: string): string {
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
  // Archived links live only in the local-only cold partition and are absent
  // from `links`, so a from-scratch re-push (which scans `links`) would strand
  // them on the new server. Move them back into the hot store first — their
  // server_seq is nulled by the loop below and they re-push; the next archive
  // run re-archives them locally.
  const archived = (await db.getAll('archived_links')) as SyncFields[];
  if (archived.length) {
    const tx = db.transaction(['links', 'archived_links'], 'readwrite');
    for (const link of archived) {
      tx.objectStore('links').put(link);
      tx.objectStore('archived_links').delete(link.id);
    }
    await tx.done;
  }
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
  // Every cold row is back in `links` and will re-push with the rest, so the
  // never-pushed-archived queue below has nothing left to point at.
  await db.delete('sync_meta', PENDING_ARCHIVED_KEY);
}

// ---------------------------------------------------------------------------
// Never-pushed archived links
// ---------------------------------------------------------------------------

/**
 * Archiving HARD-deletes a link out of `links` into the local-only
 * `archived_links` store, and the push scan below only walks the synced
 * stores — so a link archived before its first successful push has no route
 * to the server at all, and stays on one device until resetLocalSyncState
 * happens to move it back. Reachable whenever a device is offline past the
 * archive window, and trivially reachable by seeding a library with archival
 * enabled.
 *
 * The fix is this queue: archiveNow records the ids it moves that the server
 * has never seen, and the push sends them from the cold store. Keeping a list
 * (rather than scanning `archived_links` each sync for server_seq === null)
 * is the whole point — the cold store is where a huge library goes to stop
 * being read, and re-reading it every sync would undo that.
 */
const PENDING_ARCHIVED_KEY = 'pendingArchivedPush';
const ARCHIVED_BACKFILL_KEY = 'archivedPushBackfillDone';

/** Queue archived links that have never reached the server. */
export async function notePendingArchivedPush(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const queued = new Set((await getMeta<string[]>(PENDING_ARCHIVED_KEY)) ?? []);
  for (const id of ids) queued.add(id);
  await setMeta(PENDING_ARCHIVED_KEY, [...queued]);
}

/**
 * The queue, after a ONE-TIME sweep for links stranded before this existed —
 * a device that archived while offline already has cold rows nobody recorded.
 * The flag makes it a single scan in the lifetime of the database.
 */
async function archivedAwaitingPush(): Promise<string[]> {
  const db = await getDB();
  if (!(await getMeta<boolean>(ARCHIVED_BACKFILL_KEY))) {
    const stranded: string[] = [];
    if ((await db.count('archived_links')) > 0) {
      let cursor = await db.transaction('archived_links').store.openCursor();
      while (cursor) {
        const row = cursor.value as SyncFields;
        if (row.server_seq == null) stranded.push(row.id);
        cursor = await cursor.continue();
      }
    }
    await notePendingArchivedPush(stranded);
    await setMeta(ARCHIVED_BACKFILL_KEY, true);
  }
  return (await getMeta<string[]>(PENDING_ARCHIVED_KEY)) ?? [];
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

/**
 * Guard against a restarted server seq counter. The pull cursor is only
 * meaningful within one lifetime of the counter — after a /sync/reset or a
 * fresh server database, rows re-accepted at low seqs would sit below our
 * high-water mark and never be pulled (an open week stuck at seq 2 while the
 * counter is in the thousands silently blanks the reading list on every
 * other device). The server names each counter lifetime with an epoch id;
 * when it changes, drop all local sync bookkeeping so this sync pushes the
 * full dataset and pulls from zero. Old backends without the epoch (probe
 * fails or omits it) skip the check — no worse than before.
 */
async function checkServerEpoch(base: string): Promise<void> {
  let epoch: string | undefined;
  try {
    const res = await fetch(`${base}/sync/stats`);
    if (!res.ok) return;
    epoch = ((await res.json()) as { epoch?: string }).epoch;
  } catch {
    return; // unreachable — the push right after will surface the real error
  }
  if (!epoch) return;
  const known = await getMeta<string>('serverEpoch');
  if (known && known !== epoch) {
    console.warn('[readerr sync] server epoch changed — resyncing from scratch');
    await resetLocalSyncState();
  }
  await setMeta('serverEpoch', epoch);
}

/** Rows per push request — LWW makes multi-request pushes safe. */
const PUSH_CHUNK = 2000;
/** Rows per pull page; the client loops until a short page arrives. */
const PULL_LIMIT = 5000;

/**
 * True while a sync is applying rows. On-read reconcilers (notably
 * reconcileOpenWeeks and pruneUnfinishedEntries) check this and defer:
 * folding over a half-applied pull could tombstone a just-pulled week before
 * its child rows land, orphaning them. The next read after the sync settles
 * reconciles with complete data.
 */
let syncInProgress = false;
export function isSyncing(): boolean {
  return syncInProgress;
}

/**
 * Concurrent syncNow calls share one run: the week page awaits a sync before
 * auto-closing a stale week (audit D14) at the same moment Navbar fires its
 * session auto-sync, and two interleaved push/pull cycles would race each
 * other over the same cursors. Joining is right ONLY for callers that need
 * "a completed sync" and changed nothing themselves (the close gate, the
 * navbar auto-sync). A caller whose own preceding writes must be part of the
 * cycle — or that just reconfigured the server URL / cursors / local data —
 * must use syncFresh instead: an in-flight run captured the OLD sync state
 * at its start and would report a stale result as the caller's outcome.
 */
let inFlightSync: Promise<SyncResult> | null = null;

export function syncNow(): Promise<SyncResult> {
  if (inFlightSync) return inFlightSync;
  const run = doSync().finally(() => {
    inFlightSync = null;
  });
  inFlightSync = run;
  return run;
}

/**
 * A sync cycle guaranteed to START after this call. Any in-flight run is
 * waited out first — it read the server URL, cursors, and dirty rows before
 * the caller's changes existed — then a fresh cycle runs (or is joined, if
 * another one started meanwhile: that one also started after this call).
 * Used by requestSync (the debounced push MUST include the write that armed
 * it) and by the Settings/Onboarding server-migration flows.
 */
export async function syncFresh(): Promise<SyncResult> {
  const stale = inFlightSync;
  if (stale) await stale.catch(() => undefined);
  return syncNow();
}

/**
 * Has this device ever successfully talked to a sync server? True once a
 * sync completed (lastSyncAt) or a server answered the epoch probe
 * (serverEpoch — stamped even when the run later fails mid-cycle). The week
 * page uses this to tell "server temporarily unreachable" (defer stale-week
 * closes) from "this deployment has no server at all" (static hosting,
 * scratch installs — local state is the only truth, so closing locally is
 * safe and must not be held hostage to a sync that can never succeed).
 */
export async function hasEverReachedServer(): Promise<boolean> {
  return (
    (await getMeta<string>('lastSyncAt')) != null ||
    (await getMeta<string>('serverEpoch')) != null
  );
}

async function doSync(): Promise<SyncResult> {
  syncInProgress = true;
  try {
    const db = await getDB();
    const base = getSyncUrl();

    await checkServerEpoch(base);

    // ---- push (dirty rows via the per-store updated_at index, so the scan
    // cost tracks changes since the last push, not history)
    const lastPushAt = (await getMeta<string>('lastPushAt')) ?? '';
    const range = lastPushAt ? IDBKeyRange.lowerBound(lastPushAt, true) : undefined;

    // Fold-reset rows (putReconciled) carry their real, preserved content time,
    // which usually sits below the watermark — so the scan below would miss
    // them. Pull them in explicitly by id so merged content and re-delivered
    // survivors actually reach the server. Cleared after a successful push.
    const pendingRefs = (await getMeta<string[]>('pendingRepush')) ?? [];
    const pendingByStore = new Map<string, Set<string>>();
    for (const ref of pendingRefs) {
      const sep = ref.indexOf(':');
      if (sep < 0) continue;
      const store = ref.slice(0, sep);
      if (!(store in STORES)) continue;
      (pendingByStore.get(store) ?? pendingByStore.set(store, new Set()).get(store)!).add(
        ref.slice(sep + 1)
      );
    }

    // Links archived before they ever reached the server: absent from `links`,
    // so nothing below would find them. Sent as `links` rows from the cold
    // store — see archivedAwaitingPush.
    const archivedPending = await archivedAwaitingPush();
    // Whether this device has a cold store at all. Checked once per sync and
    // reused by the push write-back, the conflict adoption, and the pull
    // routing below, so the common no-archive path pays one count() and never
    // a per-row lookup.
    const hasArchive = (await db.count('archived_links')) > 0;

    const dirty: { store: string; row: SyncFields }[] = [];
    let maxPushedUpdatedAt = lastPushAt;
    // STORES order puts parents before children, and chunk boundaries keep
    // that order, so a child never lands in an earlier request than its parent.
    for (const store of Object.keys(STORES)) {
      const seen = new Set<string>();
      const rows = (await db.getAllFromIndex(store, 'updated_at', range)) as SyncFields[];
      for (const row of rows) {
        dirty.push({ store, row });
        seen.add(row.id);
        if (row.updated_at > maxPushedUpdatedAt) maxPushedUpdatedAt = row.updated_at;
      }
      // Fold-reset rows below the watermark: their old updated_at deliberately
      // does NOT advance maxPushedUpdatedAt.
      const pend = pendingByStore.get(store);
      if (pend) {
        for (const id of pend) {
          if (seen.has(id)) continue;
          const row = (await db.get(store, id)) as SyncFields | undefined;
          if (row) dirty.push({ store, row });
        }
      }
      // Queued cold links join their own store's group, so they keep the
      // parents-before-children ordering the chunking relies on. Like the
      // fold-reset rows they must not advance the watermark — an archived
      // link's updated_at is old by definition, and a failed push has to be
      // able to find them again. An id whose row is gone (unarchived since)
      // is simply skipped; the queue is cleared either way.
      if (store === 'links') {
        for (const id of archivedPending) {
          if (seen.has(id)) continue;
          const row = (await db.get('archived_links', id)) as SyncFields | undefined;
          if (row) {
            dirty.push({ store, row });
            seen.add(id);
          }
        }
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
      // The server folds duplicate open weeks only on the final chunk, when
      // every row of this push is committed — so a week and its week_links can't
      // be split across chunks and orphan the entries.
      const final = offset + PUSH_CHUNK >= dirty.length;

      let pushRes: Response;
      try {
        pushRes = await fetch(`${base}/sync/push`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rows, final }),
        });
      } catch (err) {
        throw new Error(describeNetworkError('push', err));
      }
      if (!pushRes.ok) throw new Error(await describeHttpError('push', pushRes));
      const pushJson = (await pushRes.json()) as {
        accepted: { table: string; id: string; server_seq: number }[];
        conflicts?: Record<string, SyncFields[]>;
      };

      // Record assigned seqs without touching updated_at (not a user edit).
      for (const acc of pushJson.accepted) {
        const row = (await db.get(acc.table, acc.id)) as SyncFields | undefined;
        if (row) {
          row.server_seq = acc.server_seq;
          await db.put(acc.table, row);
        } else if (hasArchive && acc.table === 'links') {
          // A cold link we just pushed: stamp the seq on the archived copy, or
          // it stays "never pushed" and the queue re-sends it forever.
          const cold = (await db.get('archived_links', acc.id)) as SyncFields | undefined;
          if (cold) {
            cold.server_seq = acc.server_seq;
            await db.put('archived_links', cold);
          }
        }
      }
      accepted += pushJson.accepted.length;

      // Adopt rows the server rejected under LWW (it holds an equal-or-newer
      // version): the client's cursor may already be past them, so a pull would
      // never re-deliver the winner. Applying under the same >= rule converges
      // a clock-skewed loser and resolves a millisecond tie onto the server's
      // incumbent (fixing the client >= / server <= asymmetry). The server's
      // row (existing) is always >= our pushed copy, so this can only advance
      // the local row, never regress it.
      for (const [store, rows2] of Object.entries(pushJson.conflicts ?? {})) {
        if (!(store in STORES)) continue;
        for (const row of rows2) {
          // Same rule the pull uses: a link this device has archived must be
          // adopted into the cold copy, never re-inserted into the hot store.
          // Only reachable now that cold links are pushed at all — before, the
          // server could not hand one back as a conflict.
          if (hasArchive && store === 'links') {
            const cold = (await db.get('archived_links', row.id)) as SyncFields | undefined;
            if (cold) {
              if (row.updated_at >= cold.updated_at) await db.put('archived_links', row);
              continue;
            }
          }
          const local = (await db.get(store, row.id)) as SyncFields | undefined;
          if (!local || row.updated_at >= local.updated_at) {
            await db.put(store, row);
          }
        }
      }
    }
    await setMeta('lastPushAt', maxPushedUpdatedAt);

    // Every fold-reset row we set out to re-send has now been pushed (accepted
    // if genuinely newer, else LWW-rejected because the server already holds an
    // equal-or-newer version — either way it is resolved). Drop exactly those
    // refs, keeping any a concurrent fold added mid-push.
    if (pendingRefs.length) {
      const current = (await getMeta<string[]>('pendingRepush')) ?? [];
      const handled = new Set(pendingRefs);
      await setMeta('pendingRepush', current.filter((r) => !handled.has(r)));
    }
    // Same for the cold links: every queued id was either accepted (seq
    // stamped on the archived copy above), LWW-rejected because the server
    // already holds it, or gone from the cold store entirely. All three mean
    // resolved. Ids queued by a concurrent archive run survive.
    if (archivedPending.length) {
      const current = (await getMeta<string[]>(PENDING_ARCHIVED_KEY)) ?? [];
      const handled = new Set(archivedPending);
      await setMeta(PENDING_ARCHIVED_KEY, current.filter((id) => !handled.has(id)));
    }

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

      // A link this device has archived lives in the local-only archived_links
      // partition, not `links`. If any links are archived, incoming `links`
      // edits for those ids must be routed to the cold copy — otherwise a full
      // re-pull or a remote edit resurrects the row into the hot store as a
      // duplicate, and a later unarchive of a stale cold copy clobbers the
      // newer server row. (hasArchive is the once-per-sync check above; a push
      // never creates cold rows, so it cannot have gone stale.)
      let received = 0;
      for (const [store, incoming] of Object.entries(pullJson.rows ?? {})) {
        if (!(store in STORES)) continue;
        for (const row of incoming) {
          received++;
          if (hasArchive && store === 'links') {
            const archived = (await db.get('archived_links', row.id)) as SyncFields | undefined;
            if (archived) {
              if (row.updated_at >= archived.updated_at) {
                await db.put('archived_links', row);
                pulled++;
              }
              continue; // never re-insert an archived link into the hot store
            }
          }
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
  } finally {
    syncInProgress = false;
  }
}

/**
 * Push local changes to the server shortly after a mutation, so an edit on one
 * device reaches the others in seconds instead of waiting for the next
 * navigation-gated, 15-minute-throttled auto-sync. Calls are debounced (a
 * burst of writes coalesces into one sync) and self-mutexed (never overlaps an
 * in-flight sync — a second request while one runs re-arms once it settles).
 *
 * Fire-and-forget from the repo write helpers; offline / offline-mode / a
 * failed sync are all handled inside syncNow, so this never throws at the call
 * site. In the sync test harness it stays dormant unless a device explicitly
 * opts in (localStorage 'readerr-test-bg-sync'), so snapshots stay
 * deterministic while the trigger itself remains testable.
 */
const REQUEST_SYNC_DEBOUNCE_MS = 800;
let requestSyncTimer: ReturnType<typeof setTimeout> | null = null;
let requestSyncInFlight = false;
let requestSyncPending = false;

export function requestSync(): void {
  if (typeof window === 'undefined') return;
  if (getSyncMode() === 'offline') return;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;
  if (isTestMode() && localStorage.getItem('readerr-test-bg-sync') !== '1') return;

  if (requestSyncInFlight) {
    requestSyncPending = true; // coalesce: run once more after the current sync
    return;
  }
  if (requestSyncTimer) clearTimeout(requestSyncTimer);
  requestSyncTimer = setTimeout(() => {
    requestSyncTimer = null;
    void runRequestedSync();
  }, REQUEST_SYNC_DEBOUNCE_MS);
}

async function runRequestedSync(): Promise<void> {
  requestSyncInFlight = true;
  requestSyncPending = false;
  try {
    // syncFresh, not syncNow: joining a run whose push scan predates the
    // write that armed this debounce would resolve without pushing it, and
    // nothing would re-arm — the edit would sit local until the next trigger.
    await syncFresh();
  } catch {
    // syncNow already records lastError; nothing to do at the trigger.
  } finally {
    requestSyncInFlight = false;
    // A write that arrived mid-sync re-arms the debounce so it isn't lost.
    if (requestSyncPending) requestSync();
  }
}

/**
 * Flush the debounced push when the page is going away: a write made in the
 * last 800ms has an armed timer that will never fire once the page dies —
 * exactly how a week closed Sunday night on flaky wifi stayed local-only for
 * days and then lost LWW to another device's stale close. Best-effort: an
 * interrupted push is idempotent and re-sends on the next load.
 */
function flushPendingSync(): void {
  if (!requestSyncTimer && !requestSyncPending) return;
  if (requestSyncTimer) {
    clearTimeout(requestSyncTimer);
    requestSyncTimer = null;
  }
  requestSyncPending = false;
  if (getSyncMode() === 'offline') return;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;
  if (isTestMode() && localStorage.getItem('readerr-test-bg-sync') !== '1') return;
  void syncFresh();
}

/**
 * Install the connectivity/lifecycle sync triggers (called once per page
 * from Navbar, alongside maybeAutoSync):
 *   - 'online': writes made while offline never armed the push debounce
 *     (requestSync bails on !onLine), so reconnecting is what retries them.
 *   - 'pagehide' / tab hidden: flush a still-debounced push immediately —
 *     in an MPA every navigation kills pending timers.
 * requestSync/flushPendingSync gate on sync mode and test mode themselves,
 * so page loads in the harness stay side-effect free.
 */
export function installSyncFlush(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('online', () => requestSync());
  window.addEventListener('pagehide', flushPendingSync);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPendingSync();
  });
}

/**
 * Background sync, safe to call on every page load: always runs once when
 * the app is opened (per browser session), then at most every 15 minutes as
 * the user navigates.
 */
export function maybeAutoSync(): void {
  // The harness drives every sync explicitly (via window.__readerr.syncNow);
  // an uncontrolled background sync would make snapshots nondeterministic.
  if (isTestMode()) return;
  if (typeof navigator === 'undefined' || !navigator.onLine) return;
  if (getSyncMode() === 'offline') return;
  const syncedThisSession = sessionStorage.getItem(SESSION_SYNC_KEY) === '1';
  const last = Number(localStorage.getItem(AUTO_SYNC_AT_KEY) ?? 0);
  if (syncedThisSession && Date.now() - last < AUTO_SYNC_INTERVAL_MS) return;
  sessionStorage.setItem(SESSION_SYNC_KEY, '1');
  localStorage.setItem(AUTO_SYNC_AT_KEY, String(Date.now()));
  void syncNow();
}
