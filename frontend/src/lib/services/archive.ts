/**
 * Yearly archival (see yearly-archival.md): move cold slushed links out of
 * the hot `links` store into a local-only `archived_links` store so hot
 * paths deserialize fewer rows.
 *
 * Archiving hard-deletes from `links` (real perf win) and copies the row to
 * `archived_links`. The server keeps the full history, so nothing is lost;
 * the sync cursor never re-pulls an aged-out row. Archival is deterministic
 * (a function of slushed_at age), so every device converges independently.
 */
import { getDB } from '../db/db';
import { all, put } from '../db/repo';
import { getUserSettings } from './settings';
import { isTestMode } from '../testMode';
import type { Link } from '../db/types';

const ARCHIVE_STORE = 'archived_links';
const LAST_RUN_KEY = 'readerr-archive-last-run';
const AUTO_INTERVAL_MS = 24 * 60 * 60 * 1000; // at most once/day

/** ISO cutoff: links slushed before this are archivable. */
function cutoffIso(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - Math.max(1, Math.round(months)));
  return d.toISOString();
}

function isArchivable(link: Link, cutoff: string): boolean {
  // Slushed and old — never a favourite (favouriting clears slushed_at, but
  // guard anyway so the archive can never swallow a favourite).
  return !!link.slushed_at && !link.favourite && link.slushed_at < cutoff;
}

/** How many live links would archival move right now. */
export async function archivableCount(months: number): Promise<number> {
  const cutoff = cutoffIso(months);
  return (await all<Link>('links')).filter((l) => isArchivable(l, cutoff)).length;
}

/** How many links are currently archived. */
export async function archivedCount(): Promise<number> {
  const db = await getDB();
  return db.count(ARCHIVE_STORE);
}

/**
 * Move every archivable link into the archive. Returns how many moved.
 * Related rows (notes, joins, week_links) stay in place, keyed by link_id.
 */
export async function archiveNow(months: number): Promise<number> {
  const cutoff = cutoffIso(months);
  const links = await all<Link>('links');
  const toMove = links.filter((l) => isArchivable(l, cutoff));
  if (toMove.length === 0) return 0;
  const db = await getDB();
  const tx = db.transaction(['links', ARCHIVE_STORE], 'readwrite');
  for (const link of toMove) {
    tx.objectStore(ARCHIVE_STORE).put(link);
    tx.objectStore('links').delete(link.id); // hard delete: shrinks the hot store
  }
  await tx.done;
  if (typeof localStorage !== 'undefined') localStorage.setItem(LAST_RUN_KEY, String(Date.now()));
  return toMove.length;
}

/** Move an archived link back into the active set. */
export async function unarchive(link: Link): Promise<void> {
  const db = await getDB();
  await put('links', { ...link }); // re-stamps updated_at so it re-syncs
  await db.delete(ARCHIVE_STORE, link.id);
}

/** Archived links, newest-slushed first (the archive view reads this).
 * Tombstones are hidden: a pulled delete for an archived link lands on the cold
 * copy (see the archive-aware pull routing in sync.ts) and must not show here. */
export async function listArchived(): Promise<Link[]> {
  const db = await getDB();
  const rows = (await db.getAll(ARCHIVE_STORE)) as Link[];
  return rows
    .filter((l) => !l.deleted_at)
    .sort((a, b) => ((a.slushed_at ?? '') < (b.slushed_at ?? '') ? 1 : -1));
}

/**
 * Run archival automatically when the mode is on, throttled to once/day.
 * Safe to call on every app load. Returns how many were moved (0 if
 * disabled, throttled, or nothing was due).
 */
export async function maybeAutoArchive(): Promise<number> {
  if (isTestMode()) return 0; // harness: no background writes on page load
  const settings = await getUserSettings();
  if (!settings?.archive_enabled) return 0;
  const last = Number(localStorage.getItem(LAST_RUN_KEY) ?? 0);
  if (Date.now() - last < AUTO_INTERVAL_MS) return 0;
  return archiveNow(settings.archive_after_months ?? 24);
}
