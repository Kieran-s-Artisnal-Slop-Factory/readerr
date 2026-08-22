/**
 * Series (services/series.ts): a link that is a folder of other links.
 *
 * What's pinned here is everything the design leans on — ordering that two
 * devices can agree on without coordinating, membership that can't duplicate
 * or self-reference, deletion that leaves no edge pointing at a dead link, and
 * creation that reuses a link you already had instead of capturing it twice.
 */
import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDB } from '../src/lib/db/db';
import { STORES } from '../src/lib/db/types';
import { all, byIndex, put, withSyncFields } from '../src/lib/db/repo';
import {
  SERIES_URL_PREFIX,
  addPart,
  createSeries,
  deleteSeries,
  detachFromSeries,
  edgesOf,
  isSeries,
  markSeriesRead,
  movePart,
  partIdsOf,
  partsOf,
  progressOf,
  pruneDeadEdges,
  removePart,
  reorderParts,
  seriesForLink,
} from '../src/lib/services/series';
import type { Link, Note, SeriesLink, Week, WeekLink } from '../src/lib/db/types';

const NOW = '2026-08-01T00:00:00.000Z';

beforeAll(() => {
  // repo writes reach sync.ts, which reads localStorage; Node has none.
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, String(v)),
    removeItem: (k: string) => void storage.delete(k),
    clear: () => storage.clear(),
  });
});

beforeEach(async () => {
  const db = await getDB();
  const names = [...Object.keys(STORES), 'archived_links', 'sync_meta', 'label_usage'];
  const tx = db.transaction(names, 'readwrite');
  for (const n of names) tx.objectStore(n).clear();
  await tx.done;
});

function linkRow(over: Partial<Link> = {}): Link {
  return withSyncFields({
    url: `https://example.com/${Math.random().toString(36).slice(2)}`,
    title: 'A link',
    title_fetched: true,
    added_at: NOW,
    read_at: null,
    favourite: false,
    is_resource: false,
    slushed_at: null,
    priority: null,
    ...over,
  }) as Link;
}

/** A series link + n parts, wired up in order. */
async function seedSeries(count = 3): Promise<{ series: Link; parts: Link[] }> {
  const series = await put<Link>('links', linkRow({ title: 'Async Rust', is_series: true }));
  const parts: Link[] = [];
  for (let i = 1; i <= count; i++) {
    const link = await put<Link>(
      'links',
      linkRow({ title: `Part ${i}`, url: `https://example.com/part-${i}` })
    );
    parts.push(link);
    await addPart(series, link, i);
  }
  return { series, parts };
}

function edgeRow(seriesId: string, linkId: string, position: number, id?: string): SeriesLink {
  const row = withSyncFields({ series_id: seriesId, link_id: linkId, position }) as SeriesLink;
  return id ? { ...row, id } : row;
}

describe('membership', () => {
  it('orders parts by position, and breaks a tie on id', async () => {
    const series = await put<Link>('links', linkRow({ is_series: true }));
    const a = await put<Link>('links', linkRow({ title: 'A' }));
    const b = await put<Link>('links', linkRow({ title: 'B' }));
    const c = await put<Link>('links', linkRow({ title: 'C' }));
    // Two devices both appended at 4 — the id decides, identically everywhere.
    await put('series_links', edgeRow(series.id, a.id, 4, 'edge-zzz'));
    await put('series_links', edgeRow(series.id, b.id, 4, 'edge-aaa'));
    await put('series_links', edgeRow(series.id, c.id, 1, 'edge-mmm'));

    const parts = await partsOf(series.id);
    expect(parts.map((p) => p.link.title)).toEqual(['C', 'B', 'A']);
    // The displayed number is the reader's 1..n, not the stored position.
    expect(parts.map((p) => p.number)).toEqual([1, 2, 3]);
  });

  it('refuses a duplicate, a self-membership, and a nested series', async () => {
    const { series, parts } = await seedSeries(1);
    expect(await addPart(series, parts[0])).toMatchObject({ link_id: parts[0].id });
    expect(await edgesOf(series.id)).toHaveLength(1); // no second edge

    expect(await addPart(series, series)).toBeNull();
    const other = await put<Link>('links', linkRow({ is_series: true }));
    expect(await addPart(series, other)).toBeNull();
    expect(await edgesOf(series.id)).toHaveLength(1);
  });

  it('drops a self-edge on read rather than recursing on it', async () => {
    const series = await put<Link>('links', linkRow({ is_series: true }));
    // Only reachable by two devices racing — the writer refuses it.
    await put('series_links', edgeRow(series.id, series.id, 1));
    expect(await edgesOf(series.id)).toEqual([]);
    expect(await partsOf(series.id)).toEqual([]);
  });

  it('collapses a duplicated (series, link) pair, keeping the lowest position', async () => {
    const series = await put<Link>('links', linkRow({ is_series: true }));
    const link = await put<Link>('links', linkRow());
    await put('series_links', edgeRow(series.id, link.id, 2, 'edge-aaa'));
    await put('series_links', edgeRow(series.id, link.id, 7, 'edge-zzz'));

    const edges = await edgesOf(series.id);
    expect(edges).toHaveLength(1);
    expect(edges[0].id).toBe('edge-aaa'); // smallest id survives
    expect(edges[0].position).toBe(2);
  });

  it('removing a part keeps the link and tombstones only the edge', async () => {
    const { series, parts } = await seedSeries(2);
    await removePart(series.id, parts[0].id);
    expect((await partsOf(series.id)).map((p) => p.link.id)).toEqual([parts[1].id]);
    expect(await all<Link>('links')).toHaveLength(3); // series + both parts
    // Tombstone, not hard delete — the removal has to sync.
    expect(await (await getDB()).count('series_links')).toBe(2);
  });

  it('finds the series a link belongs to', async () => {
    const { series, parts } = await seedSeries(2);
    expect((await seriesForLink(parts[1].id)).map((s) => s.id)).toEqual([series.id]);
    expect(await seriesForLink(series.id)).toEqual([]);
  });
});

describe('ordering', () => {
  it('reorder rewrites the whole run to 1..n', async () => {
    const { series, parts } = await seedSeries(3);
    await reorderParts(series.id, [parts[2].id, parts[0].id, parts[1].id]);
    const edges = await edgesOf(series.id);
    expect(edges.map((e) => e.position)).toEqual([1, 2, 3]);
    expect(edges.map((e) => e.link_id)).toEqual([parts[2].id, parts[0].id, parts[1].id]);
  });

  it('a part the caller forgot to name keeps its place at the end', async () => {
    const { series, parts } = await seedSeries(3);
    await reorderParts(series.id, [parts[1].id]);
    expect((await edgesOf(series.id)).map((e) => e.link_id)).toEqual([
      parts[1].id,
      parts[0].id,
      parts[2].id,
    ]);
  });

  it('movePart shifts one place and stops at the ends', async () => {
    const { series, parts } = await seedSeries(3);
    await movePart(series.id, parts[2].id, -1);
    expect((await partsOf(series.id)).map((p) => p.link.id)).toEqual([
      parts[0].id,
      parts[2].id,
      parts[1].id,
    ]);
    await movePart(series.id, parts[0].id, -1); // already first: no-op
    expect((await partsOf(series.id)).map((p) => p.link.id)).toEqual([
      parts[0].id,
      parts[2].id,
      parts[1].id,
    ]);
  });
});

describe('progress and read state', () => {
  it('counts read parts and only calls it complete when there are any', async () => {
    const { series, parts } = await seedSeries(2);
    expect(progressOf(await partsOf(series.id))).toMatchObject({ read: 0, total: 2, complete: false });

    await put('links', { ...parts[0], read_at: NOW });
    expect(progressOf(await partsOf(series.id))).toMatchObject({ read: 1, complete: false });
    await put('links', { ...parts[1], read_at: NOW });
    expect(progressOf(await partsOf(series.id))).toMatchObject({ read: 2, complete: true });

    const empty = await put<Link>('links', linkRow({ is_series: true }));
    expect(progressOf(await partsOf(empty.id)).complete).toBe(false);
  });

  it('marking the series read leaves the parts alone', async () => {
    const { series, parts } = await seedSeries(2);
    const updated = await markSeriesRead(series);
    expect(updated?.read_at).toBeTruthy();
    const after = await partsOf(series.id);
    expect(after.every((p) => !p.link.read_at)).toBe(true);
    expect(parts).toHaveLength(2);
  });
});

describe('the hiding rule', () => {
  it('reports the part ids of the series on a page, and nothing when there are none', async () => {
    const { series, parts } = await seedSeries(2);
    const loose = await put<Link>('links', linkRow({ title: 'Standalone' }));

    const hidden = await partIdsOf([series, ...parts, loose]);
    expect([...hidden].sort()).toEqual([parts[0].id, parts[1].id].sort());
    expect(hidden.has(loose.id)).toBe(false);
    // A page without the series hides nothing — the parts are ordinary links.
    expect(await partIdsOf([...parts, loose])).toEqual(new Set());
  });
});

describe('deletion', () => {
  it('deleting a series takes its edges but keeps the parts', async () => {
    const { series, parts } = await seedSeries(2);
    await deleteSeries(series);
    expect(await all<Link>('links')).toHaveLength(2);
    expect(await all<SeriesLink>('series_links')).toEqual([]);
    expect((await all<Link>('links')).map((l) => l.id).sort()).toEqual(
      parts.map((p) => p.id).sort()
    );
  });

  it('detaching a link removes every edge naming it', async () => {
    const { series, parts } = await seedSeries(2);
    await detachFromSeries(parts[0].id);
    expect((await edgesOf(series.id)).map((e) => e.link_id)).toEqual([parts[1].id]);
  });

  it('pruneDeadEdges clears edges whose link is already gone', async () => {
    const { series, parts } = await seedSeries(2);
    // A device that deleted the link without detaching it first.
    await put('links', { ...parts[0], deleted_at: NOW });
    expect(await pruneDeadEdges()).toBe(1);
    expect((await edgesOf(series.id)).map((e) => e.link_id)).toEqual([parts[1].id]);
  });
});

describe('createSeries', () => {
  it('creates the series link, its parts, and the edges in order', async () => {
    const result = await createSeries({
      title: 'Async Rust',
      descriptionMd: 'Five parts.',
      overviewUrl: 'https://example.com/async-rust',
      parts: [
        { url: 'https://example.com/p1', title: 'Part 1 [intro]' },
        { url: 'https://example.com/p2', title: 'Part 2' },
      ],
    });

    expect(isSeries(result.series)).toBe(true);
    expect(result.series.url).toBe('https://example.com/async-rust');
    expect(result.series.title_fetched).toBe(true);
    expect(result.parts.map((p) => p.link.title)).toEqual(['Part 1 [intro]', 'Part 2']);
    expect(result.parts.map((p) => p.edge.position)).toEqual([1, 2]);
    // The description is the series' note, not a column on the row.
    const notes = await byIndex<Note>('notes', 'link_id', result.series.id);
    expect(notes[0].body_md).toBe('Five parts.');
  });

  it('synthesises a URL when there is no overview page', async () => {
    const result = await createSeries({ title: 'No landing page', parts: [] });
    expect(result.series.url.startsWith(SERIES_URL_PREFIX)).toBe(true);
    expect(result.series.url).toBe(`${SERIES_URL_PREFIX}${result.series.id}`);
  });

  it('reuses a link already in the library instead of capturing it twice', async () => {
    await put<Link>('links', linkRow({ url: 'https://example.com/p1', title: 'Already saved' }));
    const result = await createSeries({
      title: 'Series',
      parts: [{ url: 'https://example.com/p1', title: 'Part 1' }],
    });
    expect(result.reused).toBe(1);
    // One series link + the one pre-existing part; nothing duplicated.
    expect(await all<Link>('links')).toHaveLength(2);
    expect(result.parts[0].link.title).toBe('Already saved');
  });

  it('schedules parts into their weeks and tags the series', async () => {
    const tagId = crypto.randomUUID();
    await put('tags', { ...withSyncFields({ name: 'rust', notes_md: '' }), id: tagId });
    const result = await createSeries({
      title: 'Series',
      tagIds: [tagId],
      weekStart: '2026-08-17',
      parts: [{ url: 'https://example.com/p1', weekStart: '2026-08-24' }],
    });

    const weeks = await all<Week>('weeks');
    expect(weeks.map((w) => w.week_start).sort()).toEqual(['2026-08-17', '2026-08-24']);
    const entries = await all<WeekLink>('week_links');
    expect(entries).toHaveLength(2);
    expect(entries.some((e) => e.link_id === result.series.id)).toBe(true);
    expect(await byIndex('link_tags', 'link_id', result.series.id)).toHaveLength(1);
  });

  it('refuses a series with no title', async () => {
    await expect(createSeries({ title: '   ', parts: [] })).rejects.toThrow(/title/i);
  });
});
