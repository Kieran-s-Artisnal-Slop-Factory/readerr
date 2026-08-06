/**
 * Stats page maths (services/stats.ts): the per-origin roll-up and the
 * variability metric — the share of links coming from outside your top N
 * domains. The metric is a pure function of the origin rows so the page can
 * re-rank instantly when N changes; these tests pin the ranking, the tie
 * break, and the degenerate cases (no links, fewer domains than the window).
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDB } from '../src/lib/db/db';
import { STORES } from '../src/lib/db/types';
import { originStats, variability, type OriginStats } from '../src/lib/services/stats';
import type { Link, LinkTopic } from '../src/lib/db/types';

const NOW = '2026-01-01T00:00:00.000Z';

function link(id: string, url: string, over: Partial<Link> = {}): Link {
  return {
    id,
    updated_at: NOW,
    deleted_at: null,
    server_seq: 1,
    url,
    title: id,
    title_fetched: true,
    added_at: NOW,
    read_at: null,
    favourite: false,
    is_resource: false,
    slushed_at: null,
    priority: null,
    ...over,
  };
}

/** Just enough of an OriginStats row for the variability maths. */
function origin(name: string, links: number): OriginStats {
  return { origin: name, links, resources: 0, slushed: 0, favourites: 0, inTopics: 0 };
}

beforeEach(async () => {
  const db = await getDB();
  const names = [...Object.keys(STORES), 'archived_links', 'sync_meta'];
  const tx = db.transaction(names, 'readwrite');
  for (const n of names) tx.objectStore(n).clear();
  await tx.done;
});

describe('originStats', () => {
  it('groups by hostname (www stripped) and counts each outcome', async () => {
    const db = await getDB();
    await db.put('links', link('a', 'https://www.youtube.com/watch?v=1', { favourite: true }));
    await db.put('links', link('b', 'https://youtube.com/watch?v=2', { slushed_at: NOW }));
    await db.put('links', link('c', 'https://go.dev/blog', { is_resource: true }));
    await db.put('link_topics', {
      id: 'lt-1',
      updated_at: NOW,
      deleted_at: null,
      server_seq: 1,
      link_id: 'c',
      topic_id: 't-1',
      ref_number: 1,
    } satisfies LinkTopic);

    const rows = await originStats();
    expect(rows.map((r) => r.origin)).toEqual(['youtube.com', 'go.dev']);
    expect(rows[0]).toMatchObject({ links: 2, favourites: 1, slushed: 1, inTopics: 0 });
    expect(rows[1]).toMatchObject({ links: 1, resources: 1, inTopics: 1 });
  });

  it('sorts by link count, then origin name', async () => {
    const db = await getDB();
    await db.put('links', link('a', 'https://zebra.com/1'));
    await db.put('links', link('b', 'https://alpha.com/1'));
    await db.put('links', link('c', 'https://busy.com/1'));
    await db.put('links', link('d', 'https://busy.com/2'));

    expect((await originStats()).map((r) => r.origin)).toEqual([
      'busy.com',
      'alpha.com',
      'zebra.com',
    ]);
  });
});

describe('variability', () => {
  it('scores the share of links outside the top N domains', () => {
    // The worked example from the TODO: 1,200 links, 980 in the top three.
    const rows = [
      origin('youtube.com', 500),
      origin('medium.com', 300),
      origin('twitter.com', 180),
      origin('go.dev', 120),
      origin('sqlite.org', 100),
    ];
    const v = variability(rows, 3);
    expect(v.totalLinks).toBe(1200);
    expect(v.topLinks).toBe(980);
    expect(v.otherLinks).toBe(220);
    expect(v.score).toBeCloseTo(18.333, 3);
    expect(v.topOrigins).toEqual(['youtube.com', 'medium.com', 'twitter.com']);
  });

  it('widens with N — more domains in the window means less left outside', () => {
    const rows = [origin('a.com', 50), origin('b.com', 30), origin('c.com', 20)];
    expect(variability(rows, 1).score).toBeCloseTo(50);
    expect(variability(rows, 2).score).toBeCloseTo(20);
    expect(variability(rows, 3).score).toBeCloseTo(0);
  });

  it('defaults to a top-3 window', () => {
    const rows = [origin('a.com', 10), origin('b.com', 10), origin('c.com', 10), origin('d.com', 10)];
    expect(variability(rows).topN).toBe(3);
    expect(variability(rows).score).toBeCloseTo(25);
  });

  it('ranks unsorted input itself, breaking ties on origin name', () => {
    // Same counts: 'apple' and 'banana' must win the window over 'cherry',
    // matching the order the origins table shows.
    const rows = [origin('cherry.com', 5), origin('banana.com', 5), origin('apple.com', 5)];
    const v = variability(rows, 2);
    expect(v.topOrigins).toEqual(['apple.com', 'banana.com']);
    expect(v.otherLinks).toBe(5);
  });

  it('is 0% when the window covers every domain you have', () => {
    const v = variability([origin('a.com', 7)], 3);
    expect(v.score).toBe(0);
    expect(v.topOrigins).toEqual(['a.com']);
  });

  it('is 0% rather than NaN with no links at all', () => {
    expect(variability([], 3).score).toBe(0);
    expect(variability([origin('a.com', 0)], 3).score).toBe(0);
  });

  it('clamps a nonsense window to at least one domain', () => {
    const rows = [origin('a.com', 60), origin('b.com', 40)];
    expect(variability(rows, 0).topN).toBe(1);
    expect(variability(rows, 0).score).toBeCloseTo(40);
    expect(variability(rows, -5).score).toBeCloseTo(40);
  });

  it('reads straight off originStats output', async () => {
    const db = await getDB();
    for (let i = 0; i < 8; i++) await db.put('links', link(`y${i}`, `https://youtube.com/${i}`));
    for (let i = 0; i < 2; i++) await db.put('links', link(`g${i}`, `https://go.dev/${i}`));
    const v = variability(await originStats(), 1);
    expect(v.score).toBeCloseTo(20);
  });
});
