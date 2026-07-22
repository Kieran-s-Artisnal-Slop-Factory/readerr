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
import { byIndex, put, softDeleteMany } from '../db/repo';
import type { Note } from '../db/types';

/**
 * Freshest row wins its body (row-level LWW on updated_at). Ties break on id
 * so two devices pick the same winner from the same rows.
 */
function freshest(rows: Note[]): Note {
  return [...rows].sort((a, b) => {
    const t = (b.updated_at ?? '').localeCompare(a.updated_at ?? '');
    return t !== 0 ? t : a.id.localeCompare(b.id);
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

  const survivor = [...rows].sort((a, b) => a.id.localeCompare(b.id))[0];
  const best = freshest(rows);
  // Only rewrite the survivor when a stray held the newer body, so a converged
  // note doesn't churn updated_at (and re-sync) every time the link is opened.
  const canonical =
    best.id === survivor.id ? survivor : await put('notes', { ...survivor, body_md: best.body_md });
  const strays = rows.filter((r) => r.id !== survivor.id).map((r) => r.id);
  await softDeleteMany('notes', strays);
  return canonical;
}
