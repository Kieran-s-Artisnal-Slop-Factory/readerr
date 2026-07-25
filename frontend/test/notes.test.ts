/**
 * Convergent dedupe for per-link notes (services/notes.ts). A note is a
 * logical singleton (one row per link) keyed by a random UUID, so two devices
 * editing the same link's note offline mint separate rows that row-level LWW
 * never merges. getNote folds each such pair into the smallest-id row, keeps
 * the freshest body, and tombstones the stray — the same fix as reconcilePlans.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { all, get } from '../src/lib/db/repo';
import { getDB } from '../src/lib/db/db';
import { STORES } from '../src/lib/db/types';
import { getNote } from '../src/lib/services/notes';
import type { Note } from '../src/lib/db/types';

beforeEach(async () => {
  const db = await getDB();
  const names = Object.keys(STORES);
  const tx = db.transaction(names, 'readwrite');
  for (const n of names) tx.objectStore(n).clear();
  await tx.done;
});

/**
 * Write a note row VERBATIM (bypassing repo.put, which would stamp a fresh
 * updated_at) so tests can pin the id and the LWW timestamp — the two things
 * convergence hinges on.
 */
async function seedNote(id: string, over: Partial<Note> = {}): Promise<Note> {
  const row: Note = {
    updated_at: '2024-01-01T00:00:00.000Z',
    deleted_at: null,
    server_seq: null,
    link_id: 'link-1',
    body_md: '',
    ...over,
    id, // pin the id last, even if `over` carries one
  };
  await (await getDB()).put('notes', row);
  return row;
}

describe('getNote', () => {
  it('returns null when the link has no note', async () => {
    expect(await getNote('link-1')).toBeNull();
  });

  it('returns the sole note unchanged (no updated_at churn)', async () => {
    await seedNote('note-a', { body_md: 'hello', updated_at: '2024-06-02T00:00:00.000Z' });

    const note = await getNote('link-1');
    expect(note?.id).toBe('note-a');
    expect(note?.body_md).toBe('hello');
    expect(note?.updated_at).toBe('2024-06-02T00:00:00.000Z');
  });

  it('collapses duplicate notes into the smallest-id row, freshest body winning', async () => {
    await seedNote('note-a', { updated_at: '2024-06-01T00:00:00.000Z', body_md: 'stale from device A' });
    await seedNote('note-b', { updated_at: '2024-06-05T00:00:00.000Z', body_md: 'fresh from device B' });

    const note = await getNote('link-1');
    expect(note?.id).toBe('note-a'); // smallest id survives (device-independent)
    expect(note?.body_md).toBe('fresh from device B'); // freshest body wins

    const live = await all<Note>('notes');
    expect(live).toHaveLength(1);
    expect(await get<Note>('notes', 'note-b')).toBeUndefined(); // stray tombstoned
    const raw = (await (await getDB()).get('notes', 'note-b')) as Note;
    expect(raw.deleted_at).not.toBeNull();
  });

  it('preserves the survivor content and its real timestamp when it is already freshest', async () => {
    await seedNote('note-a', { updated_at: '2024-06-05T00:00:00.000Z', body_md: 'keep me' });
    await seedNote('note-b', { updated_at: '2024-06-01T00:00:00.000Z', body_md: 'drop me' });

    const note = await getNote('link-1');
    expect(note?.id).toBe('note-a');
    expect(note?.body_md).toBe('keep me');
    // The fold must NOT stamp now — it preserves the freshest content's real
    // updated_at, so a stale fold can never clobber a genuinely newer edit.
    // Re-delivery to cursor-passed devices rides the pendingRepush rescue, not
    // a timestamp bump.
    expect(note!.updated_at).toBe('2024-06-05T00:00:00.000Z');
    expect(await all<Note>('notes')).toHaveLength(1);

    // …and a converged single note is returned as-is, with no churn.
    const again = await getNote('link-1');
    expect(again?.updated_at).toBe(note?.updated_at);
  });

  it('never merges notes belonging to different links', async () => {
    await seedNote('note-a', { link_id: 'link-1', body_md: 'one' });
    await seedNote('note-b', { link_id: 'link-2', body_md: 'two' });

    expect((await getNote('link-1'))?.body_md).toBe('one');
    expect((await getNote('link-2'))?.body_md).toBe('two');
    expect(await all<Note>('notes')).toHaveLength(2);
  });
});
