/**
 * Per-link note documents: exactly one row per link, created lazily on first
 * edit. Like user_settings and plans, a note is a logical singleton stored
 * under a random UUID, so two devices editing the same link's note before
 * syncing each mint a separate row — and row-level LWW never merges different
 * ids, so the reader (`notes[0]`) picked one non-deterministically and the
 * other device's writing silently vanished from view. getNote collapses any
 * such duplicates into the smallest-id row (device-independent → both devices
 * converge), keeps the freshest body, and tombstones the strays.
 */
import { byIndex, putReconciled, softDeleteMany } from '../db/repo';
import { healsAllowed } from '../testMode';
import type { Note } from '../db/types';

/**
 * Freshest row wins its body (row-level LWW on updated_at). Ties break on id
 * so two devices pick the same winner from the same rows.
 */
function freshest(rows: Note[]): Note {
  // Code-unit comparison (not localeCompare) so every device — regardless of
  // its locale collation — breaks ties on the same row as the server's byte
  // order; localeCompare would let da/nb devices pick a different survivor.
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return [...rows].sort((a, b) => {
    const t = cmp(b.updated_at ?? '', a.updated_at ?? '');
    return t !== 0 ? t : cmp(a.id, b.id);
  })[0];
}

/**
 * The canonical note for a link, collapsing any duplicate rows. Returns null
 * when the link has no note yet. Idempotent: a single note is returned as-is
 * with no write.
 */
export async function getNote(linkId: string): Promise<Note | null> {
  const rows = await byIndex<Note>('notes', 'link_id', linkId);
  if (rows.length <= 1) return rows[0] ?? null;

  const survivor = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
  const best = freshest(rows);
  // Test mode: return the folded view without persisting it (explicit heal
  // via window.__readerr.healNoteNow).
  if (!healsAllowed()) return { ...survivor, body_md: best.body_md };
  // Carry the freshest body onto the survivor under the freshest body's REAL
  // updated_at (putReconciled preserves it instead of stamping now) — stamping
  // now let a fold of stale content clobber another device's newer edit. The
  // pendingRepush rescue still delivers this to devices whose pull cursor
  // passed the survivor's original seq.
  const canonical = await putReconciled('notes', {
    ...survivor,
    body_md: best.body_md,
    updated_at: best.updated_at,
  });
  const strays = rows.filter((r) => r.id !== survivor.id).map((r) => r.id);
  await softDeleteMany('notes', strays);
  return canonical;
}
