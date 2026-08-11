/**
 * The two page-load perf paths (performance.md): backlog suggestions read
 * through indexes instead of scanning the whole links table, and chip
 * recency comes from the local label_usage cache instead of scanning all of
 * link_tags. Each has an ordering-correctness check against the old
 * whole-table implementation as oracle, plus a guard that fails if the
 * full-table read ever comes back.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { all, put, withSyncFields } from '../src/lib/db/repo';
import { getDB } from '../src/lib/db/db';
import { STORES } from '../src/lib/db/types';
import { suggestLinks } from '../src/lib/services/weeks';
import { assignTag, tagsByRecentUse } from '../src/lib/services/links';
import type { Link, Tag } from '../src/lib/db/types';

beforeEach(async () => {
  const db = await getDB();
  // label_usage and sync_meta live outside STORES but carry per-test state
  // (the backfill flag) — clear them too or tests bleed into each other.
  const names = [...Object.keys(STORES), 'label_usage', 'sync_meta'];
  const tx = db.transaction(names, 'readwrite');
  for (const n of names) tx.objectStore(n).clear();
  await tx.done;
});

let n = 0;
function makeLink(over: Partial<Link> = {}): Promise<Link> {
  n++;
  return put<Link>(
    'links',
    withSyncFields({
      url: `https://e/${n}`,
      title: `link ${n}`,
      title_fetched: true,
      added_at: `2026-01-${String((n % 27) + 1).padStart(2, '0')}T00:00:${String(n % 60).padStart(2, '0')}Z`,
      read_at: null,
      favourite: false,
      is_resource: false,
      slushed_at: null,
      priority: null,
      ...over,
    }) as Link
  );
}

/** Fail the test if `store` is ever read wholesale while fn runs. */
async function forbidGetAll<T>(store: string, fn: () => Promise<T>): Promise<T> {
  const db = await getDB();
  const real = db.getAll.bind(db);
  (db as unknown as { getAll: unknown }).getAll = (s: string, ...rest: unknown[]) => {
    if (s === store) throw new Error(`whole-table getAll('${store}') is back on a hot path`);
    return real(s as never, ...(rest as []));
  };
  try {
    return await fn();
  } finally {
    (db as unknown as { getAll: unknown }).getAll = real;
  }
}

describe('suggestLinks (indexed path)', () => {
  async function seedMixedBacklog(): Promise<Link[]> {
    const rows: Link[] = [];
    rows.push(await makeLink({ priority: 3, added_at: '2026-01-05T00:00:00Z' }));
    rows.push(await makeLink({ priority: 1, added_at: '2026-01-20T00:00:00Z' }));
    rows.push(await makeLink({ added_at: '2026-01-01T00:00:00Z' })); // null = 3, oldest
    rows.push(await makeLink({ priority: 2, added_at: '2026-01-10T00:00:00Z' }));
    rows.push(await makeLink({ added_at: '2026-01-03T00:00:00Z' }));
    rows.push(await makeLink({ priority: 1, added_at: '2026-01-25T00:00:00Z' }));
    // Ineligible in every way:
    rows.push(await makeLink({ read_at: '2026-02-01T00:00:00Z', added_at: '2026-01-02T00:00:00Z' }));
    rows.push(await makeLink({ slushed_at: '2026-02-01T00:00:00Z', added_at: '2026-01-02T01:00:00Z' }));
    rows.push(await makeLink({ is_resource: true, priority: 1, added_at: '2026-01-02T02:00:00Z' }));
    return rows;
  }

  it('matches the pooled implementation exactly (oracle)', async () => {
    await seedMixedBacklog();
    const pool = await all<Link>('links');
    for (const count of [1, 3, 6, 20]) {
      const pooled = await suggestLinks(new Set(), [], count, pool);
      const indexed = await suggestLinks(new Set(), [], count);
      expect(indexed.map((l) => l.id), `count=${count}`).toEqual(pooled.map((l) => l.id));
    }
  });

  it('respects exclusions and orders priority-then-oldest', async () => {
    const rows = await seedMixedBacklog();
    const exclude = new Set([rows[1].id]); // drop the first priority-1
    const got = await suggestLinks(exclude, [], 4);
    expect(got.map((l) => l.id)).toEqual([
      rows[5].id, // priority 1
      rows[3].id, // priority 2
      rows[2].id, // null (3), oldest added
      rows[4].id, // null (3), next oldest
    ]);
  });

  it('splits the quota across focus tags without a pool', async () => {
    const rows = await seedMixedBacklog();
    const tag = await put<Tag>('tags', withSyncFields({ name: 'focus', notes_md: '' }) as Tag);
    await assignTag(rows[0].id, tag.id);
    await assignTag(rows[2].id, tag.id);
    const pool = await all<Link>('links');
    const pooled = await suggestLinks(new Set(), [tag.id], 3, pool);
    const indexed = await suggestLinks(new Set(), [tag.id], 3);
    expect(indexed.map((l) => l.id)).toEqual(pooled.map((l) => l.id));
    // The tagged pair leads (oldest-first within the tag), then general fill.
    expect(indexed.slice(0, 2).map((l) => l.id).sort()).toEqual([rows[0].id, rows[2].id].sort());
  });

  it('never reads the whole links table without a pool', async () => {
    await seedMixedBacklog();
    const got = await forbidGetAll('links', () => suggestLinks(new Set(), [], 3));
    expect(got).toHaveLength(3);
  });
});

describe('tagsByRecentUse (label_usage cache)', () => {
  const iso = (day: number) => `2026-03-${String(day).padStart(2, '0')}T00:00:00Z`;

  async function seedTagWithJoin(name: string, usedDay: number): Promise<Tag> {
    const tag = await put<Tag>('tags', withSyncFields({ name, notes_md: '' }) as Tag);
    const link = await makeLink();
    const db = await getDB();
    await db.put('link_tags', {
      id: `join-${name}`,
      link_id: link.id,
      tag_id: tag.id,
      updated_at: iso(usedDay),
      deleted_at: null,
      server_seq: null,
    });
    return tag;
  }

  it('backfills once from existing joins, preserving the old ordering', async () => {
    const older = await seedTagWithJoin('older', 1);
    const newer = await seedTagWithJoin('newer', 20);
    const unused = await put<Tag>('tags', withSyncFields({ name: 'unused', notes_md: '' }) as Tag);

    const first = await tagsByRecentUse();
    expect(first.map((t) => t.id)).toEqual([newer.id, older.id, unused.id]);

    // After the backfill, ordering must not read link_tags at all.
    const again = await forbidGetAll('link_tags', () => tagsByRecentUse());
    expect(again.map((t) => t.id)).toEqual([newer.id, older.id, unused.id]);
  });

  it('a fresh assignment moves its tag to the front', async () => {
    const a = await seedTagWithJoin('a', 5);
    const b = await seedTagWithJoin('b', 10);
    expect((await tagsByRecentUse()).map((t) => t.id)).toEqual([b.id, a.id]);

    await assignTag((await makeLink()).id, a.id); // stamps recency now
    expect((await tagsByRecentUse()).map((t) => t.id)).toEqual([a.id, b.id]);
  });
});
